# Web Workspace

浏览器相关代码统一维护在 `web/` 目录下：

- `packages/voxcpm-web/`
  TypeScript 封装与 wasm 资源分发
- `playground/`
  React + Tailwind + TypeScript + Rsbuild 演示站

常用命令：

```bash
cd web
pnpm install
pnpm dev
```

其中 `pnpm dev` 会先调用仓库根目录下的 `scripts/build_wasm.sh`，再构建 `@voxcpm/web`，最后启动 playground。
