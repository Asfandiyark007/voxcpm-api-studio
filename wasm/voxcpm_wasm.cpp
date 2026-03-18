#include "voxcpm/audio-vae.h"
#include "voxcpm/backend.h"
#include "voxcpm/context.h"
#include "voxcpm/tokenizer.h"
#include "voxcpm/voxcpm.h"
#include "voxcpm/weight-store.h"

#include <emscripten/emscripten.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <memory>
#include <random>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace voxcpm {
namespace {

struct PreparedInputs {
    std::vector<int32_t> full_text_tokens;
    std::vector<int32_t> text_mask;
    std::vector<int32_t> feat_mask;
    std::vector<float> feat;
    std::vector<float> prompt_feat;
    int prompt_audio_length = 0;
    bool has_prompt_audio = false;
};

struct WasmEngine {
    std::unique_ptr<VoxCPMBackend> backend;
    std::shared_ptr<VoxCPMWeightStore> store;
    VoxCPMRuntime runtime;
    AudioVAE audio_vae;
    VoxCPMTokenizer tokenizer;
    std::unique_ptr<ChineseCharSplitTokenizer> split_tokenizer;
    std::vector<float> last_waveform;
    std::string last_error;
    int last_sample_rate = 0;
};

[[noreturn]] void fail(const std::string& message) {
    throw std::runtime_error(message);
}

WasmEngine& require_engine(uintptr_t handle) {
    if (handle == 0) {
        fail("Invalid VoxCPM engine handle");
    }
    return *reinterpret_cast<WasmEngine*>(handle);
}

void fill_noise(std::vector<float>& noise, int patch_size, int feat_dim, std::mt19937& rng) {
    std::normal_distribution<float> dist(0.0f, 1.0f);
    noise.resize(static_cast<size_t>(patch_size) * static_cast<size_t>(feat_dim));
    for (float& value : noise) {
        value = dist(rng);
    }
}

std::vector<float> linear_resample(const std::vector<float>& input, int src_rate, int dst_rate) {
    if (src_rate == dst_rate || input.empty()) {
        return input;
    }

    const double scale = static_cast<double>(dst_rate) / static_cast<double>(src_rate);
    const size_t out_size = std::max<size_t>(1, static_cast<size_t>(std::llround(input.size() * scale)));
    std::vector<float> out(out_size, 0.0f);

    for (size_t i = 0; i < out_size; ++i) {
        const double src_pos = static_cast<double>(i) / scale;
        const size_t left = static_cast<size_t>(std::floor(src_pos));
        const size_t right = std::min(left + 1, input.size() - 1);
        const double frac = src_pos - static_cast<double>(left);
        out[i] = static_cast<float>((1.0 - frac) * input[left] + frac * input[right]);
    }

    return out;
}

std::vector<float> extract_prompt_features(AudioVAE& audio_vae,
                                           VoxCPMBackend& backend,
                                           std::vector<float> audio,
                                           int sample_rate,
                                           int patch_size,
                                           int feat_dim) {
    VoxCPMContext graph_ctx(ContextType::Graph, 32768, 262144);
    ggml_tensor* latent = audio_vae.encode(graph_ctx, backend, audio, sample_rate);
    if (!latent) {
        fail("Failed to build AudioVAE encode graph");
    }

    ggml_cgraph* graph = graph_ctx.new_graph();
    graph_ctx.build_forward(graph, latent);
    backend.reserve_compute_memory(graph, "wasm.audio_vae.encode");
    backend.alloc_graph(graph, "wasm.audio_vae.encode");
    const auto& preprocessed = audio_vae.last_preprocessed_audio();
    backend.tensor_set(audio_vae.last_input_tensor(), preprocessed.data(), 0, preprocessed.size() * sizeof(float));
    if (backend.compute(graph) != GGML_STATUS_SUCCESS) {
        fail("AudioVAE encode failed");
    }

    const int total_patches = static_cast<int>(latent->ne[0]);
    const int latent_dim = static_cast<int>(latent->ne[1]);
    if (latent_dim != feat_dim) {
        fail("Prompt latent dim mismatch");
    }
    if (total_patches % patch_size != 0) {
        fail("Prompt latent patches are not divisible by patch size");
    }

    std::vector<float> encoded(static_cast<size_t>(total_patches) * static_cast<size_t>(latent_dim));
    backend.tensor_get(latent, encoded.data(), 0, encoded.size() * sizeof(float));

    const int audio_length = total_patches / patch_size;
    std::vector<float> features(static_cast<size_t>(audio_length) * static_cast<size_t>(patch_size) * static_cast<size_t>(feat_dim), 0.0f);
    for (int t = 0; t < audio_length; ++t) {
        for (int p = 0; p < patch_size; ++p) {
            const int patch_index = t * patch_size + p;
            for (int d = 0; d < feat_dim; ++d) {
                const size_t src = static_cast<size_t>(d) * static_cast<size_t>(total_patches) + static_cast<size_t>(patch_index);
                const size_t dst = (static_cast<size_t>(t) * static_cast<size_t>(patch_size) + static_cast<size_t>(p)) * static_cast<size_t>(feat_dim) + static_cast<size_t>(d);
                features[dst] = encoded[src];
            }
        }
    }
    return features;
}

std::vector<float> decode_audio(AudioVAE& audio_vae,
                                VoxCPMBackend& backend,
                                const std::vector<float>& features,
                                int total_patches,
                                int feat_dim) {
    VoxCPMContext graph_ctx(ContextType::Graph, 32768, 262144);
    ggml_tensor* latent = graph_ctx.new_tensor_2d(GGML_TYPE_F32, total_patches, feat_dim);
    ggml_set_input(latent);
    ggml_tensor* audio = audio_vae.decode(graph_ctx, backend, latent);
    if (!audio) {
        fail("Failed to build AudioVAE decode graph");
    }

    ggml_cgraph* graph = graph_ctx.new_graph();
    graph_ctx.build_forward(graph, audio);
    backend.reserve_compute_memory(graph, "wasm.audio_vae.decode");
    backend.alloc_graph(graph, "wasm.audio_vae.decode");
    backend.tensor_set(latent, features.data(), 0, features.size() * sizeof(float));
    if (backend.compute(graph) != GGML_STATUS_SUCCESS) {
        fail("AudioVAE decode failed");
    }

    std::vector<float> waveform(static_cast<size_t>(ggml_nelements(audio)));
    backend.tensor_get(audio, waveform.data(), 0, waveform.size() * sizeof(float));
    return waveform;
}

void patch_major_to_latent(const std::vector<float>& frames,
                           int patch_size,
                           int feat_dim,
                           std::vector<float>& latent) {
    const size_t frame_stride = static_cast<size_t>(patch_size) * static_cast<size_t>(feat_dim);
    const int total_frames = static_cast<int>(frames.size() / frame_stride);
    const int total_patches = total_frames * patch_size;
    latent.assign(static_cast<size_t>(total_patches) * static_cast<size_t>(feat_dim), 0.0f);
    for (int frame = 0; frame < total_frames; ++frame) {
        for (int patch = 0; patch < patch_size; ++patch) {
            const int time_index = frame * patch_size + patch;
            for (int d = 0; d < feat_dim; ++d) {
                const size_t src = (static_cast<size_t>(frame) * static_cast<size_t>(patch_size) + static_cast<size_t>(patch)) * static_cast<size_t>(feat_dim) + static_cast<size_t>(d);
                const size_t dst = static_cast<size_t>(d) * static_cast<size_t>(total_patches) + static_cast<size_t>(time_index);
                latent[dst] = frames[src];
            }
        }
    }
}

std::vector<float> build_decode_feature_sequence(const std::vector<float>& prompt_feat,
                                                 int prompt_audio_length,
                                                 const std::vector<float>& generated_steps,
                                                 int streaming_prefix_len,
                                                 int patch_size,
                                                 int feat_dim,
                                                 int* prepended_context_frames) {
    const size_t frame_stride = static_cast<size_t>(patch_size) * static_cast<size_t>(feat_dim);
    int context_frames = 0;
    if (!prompt_feat.empty() && prompt_audio_length > 0 && streaming_prefix_len > 1) {
        context_frames = std::min(streaming_prefix_len - 1, prompt_audio_length);
    }

    std::vector<float> decode_frames;
    decode_frames.reserve(static_cast<size_t>(context_frames) * frame_stride + generated_steps.size());
    if (context_frames > 0) {
        const size_t context_offset = static_cast<size_t>(prompt_audio_length - context_frames) * frame_stride;
        decode_frames.insert(decode_frames.end(),
                             prompt_feat.begin() + static_cast<std::ptrdiff_t>(context_offset),
                             prompt_feat.end());
    }
    decode_frames.insert(decode_frames.end(), generated_steps.begin(), generated_steps.end());

    if (prepended_context_frames != nullptr) {
        *prepended_context_frames = context_frames;
    }
    return decode_frames;
}

PreparedInputs prepare_inputs(const char* text,
                              const char* prompt_text,
                              const float* prompt_audio,
                              int prompt_audio_len,
                              int prompt_audio_sample_rate,
                              ChineseCharSplitTokenizer& split_tokenizer,
                              AudioVAE& audio_vae,
                              VoxCPMBackend& backend,
                              int patch_size,
                              int feat_dim,
                              int patch_len) {
    PreparedInputs prepared;

    const std::string text_string = text ? text : "";
    const std::string prompt_text_string = prompt_text ? prompt_text : "";
    const bool has_prompt_audio = prompt_audio != nullptr && prompt_audio_len > 0;
    const std::string token_source = has_prompt_audio ? (prompt_text_string + text_string) : text_string;

    std::vector<int32_t> text_tokens = split_tokenizer.encode(token_source, false);
    text_tokens.push_back(101);
    prepared.full_text_tokens = text_tokens;

    if (!has_prompt_audio) {
        const int seq_len = static_cast<int>(text_tokens.size());
        prepared.feat.assign(static_cast<size_t>(seq_len) * static_cast<size_t>(patch_size) * static_cast<size_t>(feat_dim), 0.0f);
        prepared.text_mask.assign(static_cast<size_t>(seq_len), 1);
        prepared.feat_mask.assign(static_cast<size_t>(seq_len), 0);
        return prepared;
    }

    prepared.has_prompt_audio = true;
    std::vector<float> mono(prompt_audio, prompt_audio + prompt_audio_len);
    mono = linear_resample(mono, prompt_audio_sample_rate, audio_vae.config().sample_rate);
    if (mono.size() % static_cast<size_t>(patch_len) != 0) {
        const size_t padding = static_cast<size_t>(patch_len) - (mono.size() % static_cast<size_t>(patch_len));
        mono.insert(mono.begin(), padding, 0.0f);
    }

    prepared.prompt_feat = extract_prompt_features(audio_vae,
                                                   backend,
                                                   mono,
                                                   audio_vae.config().sample_rate,
                                                   patch_size,
                                                   feat_dim);
    prepared.prompt_audio_length =
        static_cast<int>(prepared.prompt_feat.size() / (static_cast<size_t>(patch_size) * static_cast<size_t>(feat_dim)));
    prepared.full_text_tokens.resize(text_tokens.size() + static_cast<size_t>(prepared.prompt_audio_length), 0);

    const int seq_len = static_cast<int>(prepared.full_text_tokens.size());
    prepared.feat.assign(static_cast<size_t>(seq_len) * static_cast<size_t>(patch_size) * static_cast<size_t>(feat_dim), 0.0f);
    std::copy(prepared.prompt_feat.begin(),
              prepared.prompt_feat.end(),
              prepared.feat.begin() + static_cast<std::ptrdiff_t>(text_tokens.size()) * patch_size * feat_dim);

    prepared.text_mask.assign(text_tokens.size(), 1);
    prepared.text_mask.resize(seq_len, 0);
    prepared.feat_mask.assign(text_tokens.size(), 0);
    prepared.feat_mask.resize(seq_len, 1);
    return prepared;
}

bool load_model(WasmEngine& engine, const char* model_path, int threads) {
    if (model_path == nullptr || model_path[0] == '\0') {
        fail("Model path must not be empty");
    }

    engine.last_error.clear();
    engine.last_waveform.clear();
    engine.backend = std::make_unique<VoxCPMBackend>(BackendType::CPU, std::max(1, threads));
    engine.store = std::make_shared<VoxCPMWeightStore>();
    if (!engine.store->load_from_file(model_path, *engine.backend)) {
        fail(std::string("Failed to load GGUF: ") + model_path);
    }
    if (!engine.runtime.load_from_store(engine.store, *engine.backend)) {
        fail("Failed to initialize VoxCPM runtime from GGUF");
    }
    if (!engine.audio_vae.load_from_store(engine.store)) {
        fail("Failed to initialize AudioVAE from GGUF");
    }
    if (!engine.tokenizer.load_from_store(*engine.store)) {
        fail("Failed to load tokenizer metadata from GGUF");
    }
    engine.split_tokenizer = std::make_unique<ChineseCharSplitTokenizer>(engine.tokenizer);
    engine.last_sample_rate = engine.audio_vae.config().sample_rate;
    return true;
}

bool infer(WasmEngine& engine,
           const char* text,
           const char* prompt_text,
           const float* prompt_audio,
           int prompt_audio_len,
           int prompt_audio_sample_rate,
           int inference_timesteps,
           float cfg_value,
           int seed,
           int max_decode_steps) {
    if (!engine.store || !engine.backend || !engine.split_tokenizer) {
        fail("Model is not loaded");
    }
    if (text == nullptr || text[0] == '\0') {
        fail("Input text must not be empty");
    }
    if (prompt_audio != nullptr && prompt_audio_len > 0 && prompt_audio_sample_rate <= 0) {
        fail("Prompt audio sample rate must be > 0");
    }

    constexpr int kStreamingPrefixLen = 3;
    const int patch_size = engine.runtime.config().patch_size;
    const int feat_dim = engine.runtime.config().feat_dim;
    const int patch_len = patch_size * engine.audio_vae.config().hop_length();

    const PreparedInputs prepared = prepare_inputs(text,
                                                   prompt_text,
                                                   prompt_audio,
                                                   prompt_audio_len,
                                                   prompt_audio_sample_rate,
                                                   *engine.split_tokenizer,
                                                   engine.audio_vae,
                                                   *engine.backend,
                                                   patch_size,
                                                   feat_dim,
                                                   patch_len);

    const int seq_len = static_cast<int>(prepared.full_text_tokens.size());
    VoxCPMDecodeState state = engine.runtime.prefill(prepared.full_text_tokens,
                                                     prepared.text_mask,
                                                     prepared.feat,
                                                     prepared.feat_mask,
                                                     seq_len,
                                                     kStreamingPrefixLen);

    const int target_text_token_count =
        std::max<int>(1, static_cast<int>(engine.split_tokenizer->tokenize(text).size()));
    const int natural_max_len = std::min(target_text_token_count * 6 + 10, 2000);
    const int max_len = max_decode_steps > 0 ? max_decode_steps : natural_max_len;
    constexpr int kMinLen = 2;

    std::mt19937 rng(seed == 0 ? 1337 : seed);
    std::vector<float> generated_steps;
    generated_steps.reserve(static_cast<size_t>(max_len) * static_cast<size_t>(patch_size) * static_cast<size_t>(feat_dim));
    std::vector<float> noise;
    for (int step = 0; step < max_len; ++step) {
        fill_noise(noise, patch_size, feat_dim, rng);
        VoxCPMDecodeResult result = engine.runtime.decode(std::move(state),
                                                          noise,
                                                          inference_timesteps,
                                                          cfg_value);
        generated_steps.insert(generated_steps.end(), result.output_0.begin(), result.output_0.end());
        state = std::move(result.output_1);
        if (step > kMinLen && result.output_2) {
            break;
        }
    }

    const int generated_frames = static_cast<int>(generated_steps.size() / (static_cast<size_t>(patch_size) * static_cast<size_t>(feat_dim)));
    int prepended_context_frames = 0;
    const std::vector<float> decode_frames = build_decode_feature_sequence(prepared.prompt_feat,
                                                                           prepared.prompt_audio_length,
                                                                           generated_steps,
                                                                           kStreamingPrefixLen,
                                                                           patch_size,
                                                                           feat_dim,
                                                                           &prepended_context_frames);
    const int total_frames = static_cast<int>(decode_frames.size() / (static_cast<size_t>(patch_size) * static_cast<size_t>(feat_dim)));
    const int total_patches = total_frames * patch_size;
    if (generated_frames == 0 || total_patches == 0) {
        fail("Model generated no audio patches");
    }

    std::vector<float> latent;
    patch_major_to_latent(decode_frames, patch_size, feat_dim, latent);
    engine.last_waveform = decode_audio(engine.audio_vae, *engine.backend, latent, total_patches, feat_dim);
    engine.last_sample_rate = engine.audio_vae.config().sample_rate;

    if (prepared.has_prompt_audio) {
        const size_t trim = static_cast<size_t>(patch_len) * static_cast<size_t>(prepended_context_frames);
        if (engine.last_waveform.size() > trim) {
            engine.last_waveform.erase(engine.last_waveform.begin(),
                                       engine.last_waveform.begin() + static_cast<std::ptrdiff_t>(trim));
        }
    }

    return true;
}

}  // namespace
}  // namespace voxcpm

extern "C" {

EMSCRIPTEN_KEEPALIVE uintptr_t voxcpm_create_engine() {
    auto* engine = new voxcpm::WasmEngine();
    return reinterpret_cast<uintptr_t>(engine);
}

EMSCRIPTEN_KEEPALIVE void voxcpm_destroy_engine(uintptr_t handle) {
    delete reinterpret_cast<voxcpm::WasmEngine*>(handle);
}

EMSCRIPTEN_KEEPALIVE int voxcpm_load_model(uintptr_t handle, const char* model_path, int threads) {
    try {
        voxcpm::WasmEngine& engine = voxcpm::require_engine(handle);
        return voxcpm::load_model(engine, model_path, threads) ? 1 : 0;
    } catch (const std::exception& e) {
        if (handle != 0) {
            reinterpret_cast<voxcpm::WasmEngine*>(handle)->last_error = e.what();
        }
        return 0;
    }
}

EMSCRIPTEN_KEEPALIVE int voxcpm_infer(uintptr_t handle,
                                      const char* text,
                                      const char* prompt_text,
                                      const float* prompt_audio,
                                      int prompt_audio_len,
                                      int prompt_audio_sample_rate,
                                      int inference_timesteps,
                                      float cfg_value,
                                      int seed,
                                      int max_decode_steps) {
    try {
        voxcpm::WasmEngine& engine = voxcpm::require_engine(handle);
        engine.last_error.clear();
        engine.last_waveform.clear();
        return voxcpm::infer(engine,
                             text,
                             prompt_text,
                             prompt_audio,
                             prompt_audio_len,
                             prompt_audio_sample_rate,
                             inference_timesteps,
                             cfg_value,
                             seed,
                             max_decode_steps) ? 1 : 0;
    } catch (const std::exception& e) {
        if (handle != 0) {
            reinterpret_cast<voxcpm::WasmEngine*>(handle)->last_error = e.what();
        }
        return 0;
    }
}

EMSCRIPTEN_KEEPALIVE const float* voxcpm_get_audio_ptr(uintptr_t handle) {
    try {
        voxcpm::WasmEngine& engine = voxcpm::require_engine(handle);
        return engine.last_waveform.empty() ? nullptr : engine.last_waveform.data();
    } catch (const std::exception&) {
        return nullptr;
    }
}

EMSCRIPTEN_KEEPALIVE int voxcpm_get_audio_len(uintptr_t handle) {
    try {
        voxcpm::WasmEngine& engine = voxcpm::require_engine(handle);
        return static_cast<int>(engine.last_waveform.size());
    } catch (const std::exception&) {
        return 0;
    }
}

EMSCRIPTEN_KEEPALIVE int voxcpm_get_audio_sample_rate(uintptr_t handle) {
    try {
        voxcpm::WasmEngine& engine = voxcpm::require_engine(handle);
        return engine.last_sample_rate;
    } catch (const std::exception&) {
        return 0;
    }
}

EMSCRIPTEN_KEEPALIVE int voxcpm_get_required_prompt_sample_rate(uintptr_t handle) {
    try {
        voxcpm::WasmEngine& engine = voxcpm::require_engine(handle);
        return engine.audio_vae.config().sample_rate;
    } catch (const std::exception&) {
        return 24000;
    }
}

EMSCRIPTEN_KEEPALIVE const char* voxcpm_get_last_error(uintptr_t handle) {
    if (handle == 0) {
        return "Invalid VoxCPM engine handle";
    }
    return reinterpret_cast<voxcpm::WasmEngine*>(handle)->last_error.c_str();
}

}  // extern "C"
