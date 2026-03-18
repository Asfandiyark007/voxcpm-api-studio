import { defineConfig } from '@rslib/core';

export default defineConfig({
  lib: [
    {
      format: 'esm',
      dts: true,
      bundle: true,
      source: {
        entry: {
          index: './src/index.ts',
        },
      },
      output: {
        target: 'web',
        distPath: {
          root: './dist',
        },
        copy: [
          {
            from: './src/wasm/generated/voxcpm_wasm.wasm',
            to: 'voxcpm_wasm.wasm',
          },
          {
            from: './src/wasm/generated/voxcpm_wasm.js',
            to: 'wasm/generated/voxcpm_wasm.js',
          },
          {
            from: './src/wasm/generated/voxcpm_wasm.wasm',
            to: 'wasm/generated/voxcpm_wasm.wasm',
          },
        ],
      },
    },
    {
      format: 'cjs',
      dts: false,
      bundle: true,
      source: {
        entry: {
          index: './src/index.ts',
        },
      },
      output: {
        target: 'web',
        distPath: {
          root: './dist',
        },
        copy: [
          {
            from: './src/wasm/generated/voxcpm_wasm.wasm',
            to: 'voxcpm_wasm.wasm',
          },
          {
            from: './src/wasm/generated/voxcpm_wasm.js',
            to: 'wasm/generated/voxcpm_wasm.js',
          },
          {
            from: './src/wasm/generated/voxcpm_wasm.wasm',
            to: 'wasm/generated/voxcpm_wasm.wasm',
          },
        ],
      },
    },
  ],
});
