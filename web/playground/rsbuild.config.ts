import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';

export default defineConfig({
  plugins: [pluginReact()],
  dev: {
    client: {
      overlay: false,
    },
  },
  source: {
    entry: {
      index: './src/main.tsx',
    },
  },
  html: {
    title: 'VoxCPM WASM Playground',
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      // 'Cross-Origin-Resource-Policy': 'same-origin',
    },
  },
});
