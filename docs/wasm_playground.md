# VoxCPM WASM Playground

这个仓库现在包含一套面向浏览器的 VoxCPM 原型方案，分成三层：

- `wasm/`
  Emscripten 目标，负责把 `VoxCPMRuntime + AudioVAE + Tokenizer` 编译成 `voxcpm_wasm.js/.wasm`
- `web/packages/voxcpm-web/`
  TypeScript 封装，使用 `rslib` 打包
- `web/playground/`
  React + Tailwind + TypeScript + Rsbuild 的浏览器演示页面

## 设计选择

### 1. 当前使用 CPU + SIMD + pthread

参考 Emscripten 官方 SIMD 文档：

- `https://emscripten.org/docs/porting/simd.html`

当前方案使用：

- `-msimd128`
- `-pthread`
- `-sUSE_PTHREADS=1`
- `-sPTHREAD_POOL_SIZE`

也就是说它现在是浏览器侧多线程推理方案，结构上参考了 `third_party/SenseVoice.wasm`。  
这要求运行页面具备跨源隔离：

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

`web/playground` 的开发服务器已经加上这两个响应头。生产环境部署时也必须配置。

### 2. 模型文件与音频持久保存在 OPFS

当前实现会优先把浏览器内的持久化文件系统挂载到 OPFS，并在其下维护：

- `/persist/models`
- `/persist/audio`
- `/persist/downloads`

远程 GGUF 权重会直接下载到浏览器的文件系统里，而不是写入用户本地磁盘。下载过程中会先写入 `.part` 临时文件，并尝试通过 `Range` 请求进行断点续传。

推荐入口：

- Hugging Face 仓库：`https://huggingface.co/bluryar/VoxCPM-GGUF`
- 镜像直链：`https://hf-mirror.com/bluryar/VoxCPM-GGUF/resolve/main/voxcpm-0.5b-q4_k.gguf`

本地选择的 GGUF 文件仍然支持直接导入；远程下载完成后的权重可以从浏览器存储里快速切换加载。生成音频也会自动保存到浏览器文件系统中，文件名默认使用目标文本作为基底。

### 3. Prompt 音频在 JS 侧解码

浏览器里更适合用 Web Audio API 解码任意用户上传的音频文件，然后把单声道 `Float32Array` 传给 WASM。这样可以避免在 C++ 里再做一遍浏览器文件格式兼容。

## 目录说明

- `scripts/build_wasm.sh`
  使用 `emcmake` 构建 wasm 目标，并把生成物输出到 `web/packages/voxcpm-web/src/wasm/generated/`
- `web/packages/voxcpm-web/src/index.ts`
  TS 封装入口，提供 `VoxCpmSession`
- `web/playground/src/workers/voxcpm.worker.ts`
  把重型推理放到 Worker，避免阻塞 React 主线程
- `web/playground/src/App.tsx`
  演示 UI，内置 Hugging Face 下载引导、浏览器存储面板和断点续传下载入口

## 构建步骤

先进入 web workspace：

```bash
cd web
```

先准备依赖：

```bash
pnpm install
```

构建 wasm：

```bash
pnpm build:wasm
```

构建 TS 库：

```bash
pnpm build:web
```

启动 Playground：

```bash
pnpm --filter voxcpm-playground dev
```

## 当前限制

- 目前只接 CPU backend，没有接 WebGPU
- 浏览器内存压力仍然比较大，更适合 `voxcpm-0.5b-q4_k.gguf`
- 目前导出的是“整段推理后一次性返回音频”，还没有做流式回调
