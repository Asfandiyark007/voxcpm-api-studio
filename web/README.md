# Web Workspace

浏览器相关代码统一维护在 `web/` 目录下：

- `packages/voxcpm-web/`
  TypeScript 封装与 wasm 资源分发
- `playground/`
  React + Tailwind + TypeScript + Rsbuild 演示站（含 API 前端）

## API Frontend

Playground 现已包含 `VoxCPM.cpp API Studio`，用于连接本地 `voxcpm-server`：

- `GET /healthz`
- `POST/GET/DELETE /v1/voices`
- `POST /v1/audio/speech`
- 长文本模式（自动分段并拼接）

默认 API 基地址为 `/api`，开发时会通过 Rsbuild proxy 转发到 `http://127.0.0.1:8080`。

常用命令：

```bash
cd web
corepack pnpm install
corepack pnpm dev
```

其中 `pnpm dev` 会先调用仓库根目录下的 `scripts/build_wasm.sh`，再构建 `@voxcpm/web`，最后启动 playground。

只启动 playground：

```bash
cd web
corepack pnpm --filter voxcpm-playground dev
```

构建 playground：

```bash
cd web
corepack pnpm --filter voxcpm-playground build
```
