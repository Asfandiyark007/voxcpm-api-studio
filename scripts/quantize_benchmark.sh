#!/bin/bash

# VoxCPM Quantization and RTF Benchmark Script
# Usage: ./scripts/quantize_benchmark.sh

set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUILD_DIR="${PROJECT_ROOT}/build"
QUANTIZE_BIN="${BUILD_DIR}/examples/voxcpm_quantize"
TTS_BIN="${BUILD_DIR}/examples/voxcpm_tts"
OUTPUT_DIR="${PROJECT_ROOT}/models/quantized"
LOG_DIR="${PROJECT_ROOT}/logs"

# Models
declare -a MODELS=("voxcpm1.5.gguf" "voxcpm-0.5b.gguf")
declare -a QUANT_TYPES=("Q4_K" "Q8_0" "F16")

# TTS test parameters
PROMPT_AUDIO="${PROJECT_ROOT}/examples/dabin.wav"
PROMPT_TEXT="可哪怕位于堂堂超一品官职,在十 二郡一言九鼎的大柱国口干舌燥了,这少年还是没什么反应"
TEST_TEXT="测试一下，这是一个流式音频"
THREADS=8
TIMESTEPS=10
CFG_VALUE=2.0
BACKEND="cpu"

# Create directories
mkdir -p "${OUTPUT_DIR}"
mkdir -p "${LOG_DIR}"

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to extract timing and RTF from TTS output
extract_timing_info() {
    local log_file="$1"
    local field="$2"

    case "${field}" in
        "vae_encode")
            grep "AudioVAE encode:" "${log_file}" | awk '{print $3}' | sed 's/s$//' || echo "N/A"
            ;;
        "model_inference")
            grep "Model inference:" "${log_file}" | awk '{print $3}' | sed 's/s$//' || echo "N/A"
            ;;
        "vae_decode")
            grep "AudioVAE decode:" "${log_file}" | awk '{print $3}' | sed 's/s$//' || echo "N/A"
            ;;
        "total_time")
            grep "Total:" "${log_file}" | awk '{print $2}' | sed 's/s$//' || echo "N/A"
            ;;
        "rtf_model_only")
            grep "Without AudioVAE:" "${log_file}" | awk '{print $3}' || echo "N/A"
            ;;
        "rtf_without_encode")
            grep "Without AudioVAE Encode:" "${log_file}" | awk '{print $4}' || echo "N/A"
            ;;
        "rtf_full")
            grep "Full pipeline:" "${log_file}" | awk '{print $3}' || echo "N/A"
            ;;
        *)
            echo "N/A"
            ;;
    esac
}

# Function to get file size in MB
get_size_mb() {
    local file="$1"
    du -m "${file}" | cut -f1
}

# Function to format model name for output
format_model_name() {
    local model="$1"
    local quant="$2"
    local base_name=$(basename "${model}" .gguf)
    echo "${base_name}-${quant,,}.gguf"
}

# Check binaries exist
if [[ ! -x "${QUANTIZE_BIN}" ]]; then
    log_error "Quantize binary not found: ${QUANTIZE_BIN}"
    log_info "Please build the project first: cmake --build ${BUILD_DIR}"
    exit 1
fi

if [[ ! -x "${TTS_BIN}" ]]; then
    log_error "TTS binary not found: ${TTS_BIN}"
    log_info "Please build the project first: cmake --build ${BUILD_DIR}"
    exit 1
fi

# Summary file
SUMMARY_FILE="${LOG_DIR}/benchmark_summary_$(date +%Y%m%d_%H%M%S).txt"
TABLE_DATA_FILE="$(mktemp)"
trap 'rm -f "${TABLE_DATA_FILE}"' EXIT
echo "VoxCPM Quantization Benchmark Summary" > "${SUMMARY_FILE}"
echo "Date: $(date)" >> "${SUMMARY_FILE}"
echo "======================================" >> "${SUMMARY_FILE}"
echo "" >> "${SUMMARY_FILE}"

log_info "Starting VoxCPM quantization benchmark"
log_info "Models: ${MODELS[*]}"
log_info "Quantization types: ${QUANT_TYPES[*]}"
echo ""

append_table_row() {
    local model="$1"
    local quant="$2"
    local size_mb="$3"
    local compression="$4"
    local quant_time="$5"
    local total_time="$6"
    local rtf_without_audio_vae="$7"
    local rtf_without_audio_vae_encode="$8"
    local rtf_full="$9"
    printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
        "${model}" "${quant}" "${size_mb}" "${compression}" "${quant_time}" \
        "${total_time}" "${rtf_without_audio_vae}" "${rtf_without_audio_vae_encode}" "${rtf_full}" \
        >> "${TABLE_DATA_FILE}"
}

# Main loop
for model in "${MODELS[@]}"; do
    model_path="${PROJECT_ROOT}/models/${model}"

    if [[ ! -f "${model_path}" ]]; then
        log_warn "Model not found: ${model_path}"
        continue
    fi

    original_size=$(get_size_mb "${model_path}")
    log_info "Processing model: ${model} (${original_size} MB)"

    for quant_type in "${QUANT_TYPES[@]}"; do
        output_name=$(format_model_name "${model}" "${quant_type}")
        output_path="${OUTPUT_DIR}/${output_name}"
        output_wav="/tmp/test_${output_name%.gguf}.wav"
        log_file="${LOG_DIR}/${output_name%.gguf}.log"

        log_info "  Quantizing to ${quant_type}..."

        # Step 1: Quantize
        quant_start=$(date +%s.%N)
        "${QUANTIZE_BIN}" \
            --input "${model_path}" \
            --output "${output_path}" \
            --type "${quant_type}" \
            --threads 4 \
            2>&1 | tee "${log_file}"
        quant_end=$(date +%s.%N)
        quant_time=$(echo "${quant_end} - ${quant_start}" | bc)

        if [[ ! -f "${output_path}" ]]; then
            log_error "  Quantization failed for ${output_name}"
            continue
        fi

        quant_size=$(get_size_mb "${output_path}")
        log_info "  Quantization complete: ${quant_size} MB (took ${quant_time}s)"

        # Step 2: Run TTS inference
        log_info "  Running TTS inference..."
        tts_start=$(date +%s.%N)
        "${TTS_BIN}" \
            --prompt-audio "${PROMPT_AUDIO}" \
            --prompt-text "${PROMPT_TEXT}" \
            --text "${TEST_TEXT}" \
            --output "${output_wav}" \
            --model-path "${output_path}" \
            --threads "${THREADS}" \
            --inference-timesteps "${TIMESTEPS}" \
            --cfg-value "${CFG_VALUE}" \
            --backend "${BACKEND}" \
            2>&1 | tee -a "${log_file}"
        tts_end=$(date +%s.%N)
        tts_time=$(echo "${tts_end} - ${tts_start}" | bc)

        # Extract detailed timing info from TTS output
        vae_encode=$(extract_timing_info "${log_file}" "vae_encode")
        model_inference=$(extract_timing_info "${log_file}" "model_inference")
        vae_decode=$(extract_timing_info "${log_file}" "vae_decode")
        total_time=$(extract_timing_info "${log_file}" "total_time")
        rtf_model_only=$(extract_timing_info "${log_file}" "rtf_model_only")
        rtf_without_encode=$(extract_timing_info "${log_file}" "rtf_without_encode")
        rtf_full=$(extract_timing_info "${log_file}" "rtf_full")

        # Get audio duration if output exists
        if [[ -f "${output_wav}" ]]; then
            audio_duration=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${output_wav}" 2>/dev/null || echo "unknown")
        else
            audio_duration="failed"
        fi

        # Log results
        echo "" >> "${SUMMARY_FILE}"
        echo "Model: ${model} | Quant: ${quant_type}" >> "${SUMMARY_FILE}"
        echo "  Original size: ${original_size} MB" >> "${SUMMARY_FILE}"
        echo "  Quantized size: ${quant_size} MB" >> "${SUMMARY_FILE}"
        echo "  Compression ratio: $(echo "scale=2; ${original_size} / ${quant_size}" | bc)x" >> "${SUMMARY_FILE}"
        echo "  Quantization time: ${quant_time}s" >> "${SUMMARY_FILE}"
        echo "" >> "${SUMMARY_FILE}"
        echo "  === Inference Timing ===" >> "${SUMMARY_FILE}"
        echo "  AudioVAE encode:   ${vae_encode}s" >> "${SUMMARY_FILE}"
        echo "  Model inference:   ${model_inference}s" >> "${SUMMARY_FILE}"
        echo "  AudioVAE decode:   ${vae_decode}s" >> "${SUMMARY_FILE}"
        echo "  Total:             ${total_time}s" >> "${SUMMARY_FILE}"
        echo "  Audio duration:    ${audio_duration}s" >> "${SUMMARY_FILE}"
        echo "" >> "${SUMMARY_FILE}"
        echo "  === RTF (Real-Time Factor) ===" >> "${SUMMARY_FILE}"
        echo "  Without AudioVAE:        ${rtf_model_only}" >> "${SUMMARY_FILE}"
        echo "  Without AudioVAE Encode: ${rtf_without_encode}  (model + decode)" >> "${SUMMARY_FILE}"
        echo "  Full pipeline:          ${rtf_full}" >> "${SUMMARY_FILE}"

        append_table_row "${model}" "${quant_type}" "${quant_size}" "$(echo "scale=2; ${original_size} / ${quant_size}" | bc)x" \
            "${quant_time}" "${total_time}" "${rtf_model_only}" "${rtf_without_encode}" "${rtf_full}"

        log_info "  Done. RTF (Without AudioVAE Encode): ${rtf_without_encode}, Total: ${total_time}s"
        echo ""
    done

    # Baseline: run original F32 model and copy to quantized directory.
    f32_output_name=$(format_model_name "${model}" "F32")
    f32_output_path="${OUTPUT_DIR}/${f32_output_name}"
    f32_output_wav="/tmp/test_${f32_output_name%.gguf}.wav"
    f32_log_file="${LOG_DIR}/${f32_output_name%.gguf}.log"

    log_info "  Running F32 baseline inference..."
    cp "${model_path}" "${f32_output_path}"

    f32_tts_start=$(date +%s.%N)
    "${TTS_BIN}" \
        --prompt-audio "${PROMPT_AUDIO}" \
        --prompt-text "${PROMPT_TEXT}" \
        --text "${TEST_TEXT}" \
        --output "${f32_output_wav}" \
        --model-path "${f32_output_path}" \
        --threads "${THREADS}" \
        --inference-timesteps "${TIMESTEPS}" \
        --cfg-value "${CFG_VALUE}" \
        --backend "${BACKEND}" \
        2>&1 | tee "${f32_log_file}"
    f32_tts_end=$(date +%s.%N)
    f32_tts_time=$(echo "${f32_tts_end} - ${f32_tts_start}" | bc)

    f32_size=$(get_size_mb "${f32_output_path}")
    f32_vae_encode=$(extract_timing_info "${f32_log_file}" "vae_encode")
    f32_model_inference=$(extract_timing_info "${f32_log_file}" "model_inference")
    f32_vae_decode=$(extract_timing_info "${f32_log_file}" "vae_decode")
    f32_total_time=$(extract_timing_info "${f32_log_file}" "total_time")
    f32_rtf_model_only=$(extract_timing_info "${f32_log_file}" "rtf_model_only")
    f32_rtf_without_encode=$(extract_timing_info "${f32_log_file}" "rtf_without_encode")
    f32_rtf_full=$(extract_timing_info "${f32_log_file}" "rtf_full")

    if [[ -f "${f32_output_wav}" ]]; then
        f32_audio_duration=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${f32_output_wav}" 2>/dev/null || echo "unknown")
    else
        f32_audio_duration="failed"
    fi

    echo "" >> "${SUMMARY_FILE}"
    echo "Model: ${model} | Quant: F32 (baseline)" >> "${SUMMARY_FILE}"
    echo "  Original size: ${original_size} MB" >> "${SUMMARY_FILE}"
    echo "  Quantized size: ${f32_size} MB (copied original)" >> "${SUMMARY_FILE}"
    echo "  Compression ratio: 1.00x" >> "${SUMMARY_FILE}"
    echo "  Quantization time: N/A (copy only)" >> "${SUMMARY_FILE}"
    echo "  Copy + inference wall time: ${f32_tts_time}s" >> "${SUMMARY_FILE}"
    echo "" >> "${SUMMARY_FILE}"
    echo "  === Inference Timing ===" >> "${SUMMARY_FILE}"
    echo "  AudioVAE encode:   ${f32_vae_encode}s" >> "${SUMMARY_FILE}"
    echo "  Model inference:   ${f32_model_inference}s" >> "${SUMMARY_FILE}"
    echo "  AudioVAE decode:   ${f32_vae_decode}s" >> "${SUMMARY_FILE}"
    echo "  Total:             ${f32_total_time}s" >> "${SUMMARY_FILE}"
    echo "  Audio duration:    ${f32_audio_duration}s" >> "${SUMMARY_FILE}"
    echo "" >> "${SUMMARY_FILE}"
    echo "  === RTF (Real-Time Factor) ===" >> "${SUMMARY_FILE}"
    echo "  Without AudioVAE:        ${f32_rtf_model_only}" >> "${SUMMARY_FILE}"
    echo "  Without AudioVAE Encode: ${f32_rtf_without_encode}  (model + decode)" >> "${SUMMARY_FILE}"
    echo "  Full pipeline:          ${f32_rtf_full}" >> "${SUMMARY_FILE}"

    append_table_row "${model}" "F32(baseline)" "${f32_size}" "1.00x" \
        "N/A(copy)" "${f32_total_time}" "${f32_rtf_model_only}" "${f32_rtf_without_encode}" "${f32_rtf_full}"

    log_info "  F32 baseline done. RTF (Without AudioVAE Encode): ${f32_rtf_without_encode}, Total: ${f32_total_time}s"
    echo ""
done

log_info "Benchmark complete!"
log_info "Summary saved to: ${SUMMARY_FILE}"
log_info "ASCII table:"
echo ""

awk -F '\t' '
BEGIN {
    headers[1]="Model"; headers[2]="Quant"; headers[3]="SizeMB"; headers[4]="Compression";
    headers[5]="QuantTime"; headers[6]="TotalTime"; headers[7]="RTF_wo_AudioVAE";
    headers[8]="RTF_wo_AudioVAE_Encode"; headers[9]="RTF_Full";
    for (i=1; i<=9; i++) w[i]=length(headers[i]);
}
{
    for (i=1; i<=9; i++) {
        cell[NR,i]=$i;
        if (length($i) > w[i]) w[i]=length($i);
    }
    n=NR;
}
END {
    sep="+";
    for (i=1; i<=9; i++) {
        for (j=0; j<w[i]+1; j++) sep=sep "-";
        sep=sep "+";
    }
    print sep;
    printf "|";
    for (i=1; i<=9; i++) printf " %-*s |", w[i], headers[i];
    printf "\n";
    print sep;
    for (r=1; r<=n; r++) {
        printf "|";
        for (i=1; i<=9; i++) printf " %-*s |", w[i], cell[r,i];
        printf "\n";
    }
    print sep;
}' "${TABLE_DATA_FILE}"

echo ""
cat "${SUMMARY_FILE}"
