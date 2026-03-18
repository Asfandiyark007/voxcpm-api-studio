#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${ROOT_DIR}/build-wasm"
export EM_CACHE="${ROOT_DIR}/.emcache"

emcmake cmake -S "${ROOT_DIR}" -B "${BUILD_DIR}" \
  -DCMAKE_BUILD_TYPE=Release \
  -DVOXCPM_BUILD_EXAMPLES=OFF \
  -DVOXCPM_BUILD_BENCHMARK=OFF \
  -DVOXCPM_BUILD_TESTS=OFF \
  -DVOXCPM_BUILD_WASM=ON \
  -DVOXCPM_CUDA=OFF \
  -DVOXCPM_VULKAN=OFF \
  -DVOXCPM_NATIVE=OFF \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_OPENMP=OFF

cmake --build "${BUILD_DIR}" --target voxcpm_wasm -j"$(nproc)"
