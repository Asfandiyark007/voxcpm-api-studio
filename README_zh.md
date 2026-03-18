# VoxCPM.cpp

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

基于 `ggml` 构建的 VoxCPM 模型独立 C++ 推理项目。

- **GGUF 权重**：https://huggingface.co/bluryar/VoxCPM-GGUF
- VoxCPM 官方仓库：https://github.com/OpenBMB/VoxCPM

[English](README.md)

## 状态

此目录现作为 `VoxCPM.cpp` 独立仓库的根目录。

- `third_party/ggml` 作为供应商子树维护。
- `third_party/json`、`third_party/llama.cpp`、`third_party/whisper.cpp` 和 `third_party/SenseVoice.cpp` 仅作为本地参考，被仓库忽略。
- `CMakeLists.txt` 已支持在 `third_party/json` 缺失时通过 `FetchContent` 下载 `nlohmann_json`。

## 构建

### CPU 构建

```bash
cmake -B build
cmake --build build
```

### CUDA 构建

在配置阶段启用 ggml 的 CUDA backend：

```bash
cmake -B build-cuda -DVOXCPM_CUDA=ON
cmake --build build-cuda
```

如果你希望同时保留 CPU 和 CUDA 两套构建，建议使用不同的构建目录，例如 `build` 和 `build-cuda`。

## 推理用法

### 基础 CPU 推理

```bash
./build/examples/voxcpm_tts \
  --model-path ./models/quantized/voxcpm1.5-q8_0-audiovae-f16.gguf \
  --prompt-audio ./examples/tai_yi_xian_ren.wav \
  --prompt-text "对，这就是我，万人敬仰的太乙真人。" \
  --text "大家好，我现在正在大可奇奇体验AI科技。" \
  --output ./out.wav \
  --backend cpu \
  --threads 8
```

### 带 Prompt 的推理

```bash
./build/examples/voxcpm_tts \
  --model-path ./models/quantized/voxcpm1.5-q8_0-audiovae-f16.gguf \
  --prompt-audio ./examples/tai_yi_xian_ren.wav \
  --prompt-text "对，这就是我，万人敬仰的太乙真人。" \
  --text "大家好，我现在正在大可奇奇体验AI科技。" \
  --output ./out.wav \
  --backend cpu \
  --threads 8 \
  --inference-timesteps 10 \
  --cfg-value 2.0
```

### CUDA 推理

```bash
./build-cuda/examples/voxcpm_tts \
  --model-path ./models/quantized/voxcpm1.5-q8_0-audiovae-f16.gguf \
  --prompt-audio ./examples/tai_yi_xian_ren.wav \
  --prompt-text "对，这就是我，万人敬仰的太乙真人。" \
  --text "大家好，我现在正在大可奇奇体验AI科技。" \
  --output ./out.wav \
  --backend cuda \
  --threads 8 \
  --inference-timesteps 10 \
  --cfg-value 2.0
```

`voxcpm_tts` 当前支持 `--backend {cpu|cuda|vulkan|auto}`。

## Benchmark 脚本

### 导出量化权重

```bash
./scripts/export_quantized_weights.sh
```

这个脚本会导出：
- `Q4_K`
- `Q8_0`
- `F16`
- 对应的 `+AudioVAE-F16` 变体
- `F32` baseline 拷贝

并生成类似 `logs/quantized_weights_manifest_*.tsv` 的 manifest 文件。

### 对导出权重做 Benchmark

CPU：

```bash
./scripts/benchmark_exported_weights.sh \
  --weights-file ./logs/quantized_weights_manifest_*.tsv \
  --backend cpu
```

CUDA：

```bash
./scripts/benchmark_exported_weights.sh \
  --weights-file ./logs/quantized_weights_manifest_*.tsv \
  --backend cuda
```

如果不传 `--weights-file`，脚本会自动选取 `logs/` 下最新的 manifest。

## 测试

```bash
cd build
ctest --output-on-failure
```

测试模型/trace 路径配置和开源协作说明请见 [docs/TEST_SETUP.md](docs/TEST_SETUP.md)。

## ggml 维护

项目保持当前 `ggml` 导入和补丁流程的本地溯源：

- 上游：`https://github.com/ggerganov/ggml.git`
- 仓库拆分前的本地基础提交：`4773cde162a55f0d10a6a6d7c2ea4378e30e0b01`
- 当前本地补丁：`src/ggml-vulkan/ggml-vulkan.cpp` 中的 Vulkan 头文件兼容性调整

详见 `docs/ggml_subtree_maintenance_strategy.md`。

## TODO

1. 准备添加一个 WASM 用例，让用户可以直接在网页上试用 VoxCPM 模型。
2. 继续优化推理性能。根据 `https://github.com/DakeQQ/Text-to-Speech-TTS-ONNX` 的报告，我们和它们当前展示的性能表现相比仍然有一段差距。
3. 添加一个 `voxcpm-server` 程序，提供 OpenAI 格式的接口服务。

## 预告

接下来我也计划为 `https://huggingface.co/fishaudio/s2-pro` 单独创建一个 GGML 推理仓库。

## 基准测试

### 模型大小与压缩比

| Model | Quant | Size (MB) | Compression |
|-------|-------|-----------|-------------|
| voxcpm1.5 | F32 | 3392 | 1.00x (基准) |
| voxcpm1.5 | F16 | 1700 | 1.99x |
| voxcpm1.5 | Q8_0 | 942 | 3.60x |
| voxcpm1.5 | Q4_K | 582 | 5.82x |
| voxcpm-0.5b | F32 | 2779 | 1.00x (基准) |
| voxcpm-0.5b | F16 | 1394 | 1.99x |
| voxcpm-0.5b | Q8_0 | 766 | 3.62x |
| voxcpm-0.5b | Q4_K | 477 | 5.82x |

### CPU 推理性能 (RTF - 越低越好)

| Model | Quant | Model Only | Without Encode | Full Pipeline |
|-------|-------|------------|----------------|---------------|
| voxcpm1.5 | Q4_K | 2.395 | 3.395 | 5.598 |
| voxcpm1.5 | **Q4_K+AudioVAE-F16** | **1.873** | **2.848** | 4.433 |
| voxcpm1.5 | **Q8_0** | 2.086 | 2.982 | **4.291** |
| voxcpm1.5 | Q8_0+AudioVAE-F16 | 2.285 | 3.321 | 5.248 |
| voxcpm1.5 | F16 | 3.257 | 4.366 | 6.263 |
| voxcpm1.5 | F16+AudioVAE-F16 | 2.980 | 3.915 | 5.374 |
| voxcpm1.5 | F32 | 4.820 | 5.737 | 7.494 |
| voxcpm-0.5b | **Q4_K** | **1.826** | **2.219** | **3.609** |
| voxcpm-0.5b | Q4_K+AudioVAE-F16 | 1.895 | 2.295 | 3.915 |
| voxcpm-0.5b | Q8_0 | 2.155 | 2.546 | 3.873 |
| voxcpm-0.5b | Q8_0+AudioVAE-F16 | 1.913 | 2.284 | 3.638 |
| voxcpm-0.5b | F16 | 2.558 | 2.931 | 4.086 |
| voxcpm-0.5b | F16+AudioVAE-F16 | 2.685 | 3.057 | 4.409 |
| voxcpm-0.5b | F32 | 3.691 | 4.055 | 5.260 |

### CUDA 推理性能 (RTF - 越低越好)

| Model | Variant | AudioVAE | Model Only | Without Encode | Full Pipeline | Total Time (s) |
|-------|---------|----------|------------|----------------|---------------|----------------|
| voxcpm1.5 | Q4_K | mixed | 0.342 | 0.432 | 0.622 | 2.189 |
| voxcpm1.5 | Q4_K+AudioVAE-F16 | f16 | 0.336 | 0.426 | 0.596 | 2.192 |
| voxcpm1.5 | Q8_0 | mixed | **0.320** | **0.411** | 0.596 | 2.002 |
| voxcpm1.5 | Q8_0+AudioVAE-F16 | f16 | **0.308** | **0.397** | **0.559** | 2.148 |
| voxcpm1.5 | F16 | mixed | 0.352 | 0.442 | 0.648 | 1.970 |
| voxcpm1.5 | F16+AudioVAE-F16 | f16 | 0.347 | 0.438 | 0.655 | **1.885** |
| voxcpm1.5 | F32 (baseline) | original | 0.414 | 0.503 | 0.686 | 2.305 |
| voxcpm-0.5b | Q4_K | mixed | 0.401 | 0.442 | **0.550** | 2.067 |
| voxcpm-0.5b | Q4_K+AudioVAE-F16 | f16 | 0.396 | 0.437 | 0.555 | 1.953 |
| voxcpm-0.5b | Q8_0 | mixed | 0.430 | 0.470 | 0.623 | **1.644** |
| voxcpm-0.5b | Q8_0+AudioVAE-F16 | f16 | 0.417 | 0.456 | 0.595 | 1.809 |
| voxcpm-0.5b | F16 | mixed | **0.390** | **0.428** | 0.567 | 1.678 |
| voxcpm-0.5b | F16+AudioVAE-F16 | f16 | 0.392 | 0.430 | 0.565 | 1.718 |
| voxcpm-0.5b | F32 (baseline) | original | 0.500 | 0.539 | 0.680 | 1.903 |

**RTF 定义：**
- **Model Only**：纯模型推理（prefill + decode loop），不含 AudioVAE
- **Without Encode**：模型 + AudioVAE decode（离线预计算 prompt 特征的部署场景）
- **Full Pipeline**：端到端完整流程，包含 AudioVAE encode + 模型 + decode

### 关键发现

#### CPU

1. **CPU 最优配置现在取决于模型和指标**：`voxcpm1.5 Q4_K+AudioVAE-F16` 在 model-only 和 without-encode 指标上最好，`voxcpm1.5 Q8_0` 在完整流水线指标上最好，而 `voxcpm-0.5b Q4_K` 仍然是整体最稳妥的 CPU 选择。
2. **1.5B 在 CPU 上明显受益于 AudioVAE-F16**：`Q4_K+AudioVAE-F16` 在 `voxcpm1.5` 上拿到了最好的 `Model Only` 和 `Without Encode` RTF，而 `Q8_0` 拿到了最好的完整流水线 RTF。
3. **0.5B 的 CPU 最优仍然是 Q4_K**：`voxcpm-0.5b Q4_K` 的整体 CPU RTF 最好，`Q8_0+AudioVAE-F16` 在完整流水线指标上非常接近。
4. **这台 CPU 上 F32 最慢**：无论是 `voxcpm1.5` 还是 `voxcpm-0.5b`，F32 baseline 都是最慢的 CPU 配置。

#### CUDA

1. **CUDA 明显快于 CPU**：在本轮测试中，完整流水线 RTF 从 CPU 的 `3.83-15.02` 下降到 CUDA 的 `0.55-0.69`。
2. **CUDA 下最佳配置取决于评价指标**：对 `voxcpm1.5`，`Q8_0+AudioVAE-F16` 的 RTF 最好，而 `F16+AudioVAE-F16` 的总耗时最短；对 `voxcpm-0.5b`，`Q4_K` 的完整流水线 RTF 最好，而 `Q8_0` 的总耗时最短。
3. **CUDA 不再明显偏爱 Q4_K**：和 CPU 不同，Q4_K 在 CUDA 上并不总是最快，`Q8_0` 和 `F16` 经常同样有竞争力，甚至更好。
4. **AudioVAE F16 在 CUDA 上有帮助**：把 AudioVAE 强制导出为 `F16` 后，多组 CUDA 测试结果变好，尤其是 `voxcpm1.5 Q8_0` 和 `voxcpm-0.5b Q8_0`。

### 部署建议

| 场景 | 推荐配置 |
|------|---------|
| 生产部署 | **voxcpm-0.5b Q4_K** (477 MB, RTF 3.609) |
| 平衡精度 | **voxcpm1.5 Q8_0** (942 MB, RTF 4.291) |
| 1.5B 离线 prompt 场景 | voxcpm1.5 Q4_K+AudioVAE-F16 (647 MB, Without Encode RTF 2.848) |
| 最高精度基线 | voxcpm1.5 F32 (3392 MB, RTF 7.494) |

### CUDA 部署建议

| 场景 | 推荐配置 |
|------|---------|
| 最低完整流水线 RTF | **voxcpm-0.5b Q4_K** (477 MB, RTF 0.550) |
| 1.5B 最佳延迟/RTF 平衡 | **voxcpm1.5 Q8_0+AudioVAE-F16** (984 MB, RTF 0.559) |
| 1.5B 较小且适合 CUDA 的模型 | voxcpm1.5 Q4_K+AudioVAE-F16 (647 MB, RTF 0.596) |
| 最高精度基线 | voxcpm1.5 F32 (3392 MB, RTF 0.686) |

**CPU 测试环境：**
- CPU：12th Gen Intel(R) Core(TM) i5-12600K
- 线程：8
- 后端：CPU
- 基准结果来源：`logs/benchmark_summary_cpu_20260318_092142.txt`

**CUDA 测试环境：**
- 后端：CUDA
- GPU：NVIDIA GeForce RTX 4060 Ti
- CUDA 设备：`CUDA0`
- Compute capability：8.9
- CUDA VMM：yes
- 主机 CPU：12th Gen Intel(R) Core(TM) i5-12600K
- 线程：8
- Inference timesteps：10
- CFG value：2.0
- 基准结果来源：`logs/benchmark_summary_cuda_20260318_092028.txt`
