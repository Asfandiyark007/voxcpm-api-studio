# VoxCPM 零依赖构建改造计划（修订版）

## 用户目标
构建一个无动态链接库依赖的独立可执行文件（voxcpm-server），支持跨平台运行。

## 用户选择
- **HTTP**: 仅 HTTP（无需 OpenSSL）
- **平台**: Linux x86_64, Windows x86_64, macOS (Intel/ARM)
- **GPU**: 仅 CPU（无需 CUDA/Vulkan）

---

## 一、当前真实状态（评审报告核心发现）

### 1.1 默认构建 ≠ 零依赖

| 默认构建产物依赖 | 来源 |
|------------------|------|
| `libggml.so` | GGML 默认共享库构建 |
| `libggml-cpu.so` | GGML 默认共享库构建 |
| `libggml-base.so` | GGML 默认共享库构建 |
| `libstdc++.so.6` | C++ 运行时 |
| `libm.so.6` | 数学库 |
| `libgcc_s.so.1` | GCC 运行时 |
| `libc.so.6` | C 运行时 |
| **`libgomp.so.1`** | OpenMP（GGML 默认开启） |

**关键结论**: 默认构建结果不能被描述成"无依赖"或"只有 ggml 依赖"。

### 1.2 `GGML_STATIC=ON` ≠ 完全静态

即使设置 `GGML_STATIC=ON`，产物仍依赖：
- `libstdc++.so.6`
- `libm.so.6`
- `libgcc_s.so.1`
- `libc.so.6`

**需要额外配置**: `-static -static-libstdc++ -static-libgcc`

### 1.3 `libdl` 依赖无法简单裁掉

当前 `ggml` 在 Linux 上始终链接 `dl`：
- [third_party/ggml/src/CMakeLists.txt:243](third_party/ggml/src/CMakeLists.txt#L243)
- 且 `ggml-backend-dl.cpp` 始终参与编译

**"CPU-only 就天然不需要 dl"在当前代码下并不成立。**

---

## 二、可行的目标定义

### 近期目标（推荐）

产出一个 CPU-only 的 `voxcpm-server`：
- **Linux**: 单个静态链接 ELF，`ldd` 显示"不是动态可执行文件"
- **Windows**: 单个 `.exe`，无需额外安装 DLL
- **macOS**: 单个可执行文件，不依赖额外第三方动态库

### 中期目标

把 `voxcpm` 整理成可安装、可导出的封装库：
- 安装头文件、静态库及依赖
- 导出 CMake package
- 明确 ABI/API 边界

---

## 三、必做改造项

### 3.1 新增构建选项

```cmake
# 新增选项
option(VOXCPM_SERVER      "Build HTTP server executable" OFF)
option(VOXCPM_CPU_ONLY    "Build CPU-only without GPU backends" OFF)
option(VOXCPM_STATIC      "Build fully static executable (Linux only)" OFF)
option(VOXCPM_PORTABLE    "Build portable release package" OFF)
```

### 3.2 发行构建统一配置

```cmake
# 当 VOXCPM_STATIC 或 VOXCPM_PORTABLE 时，强制以下配置
if(VOXCPM_STATIC OR VOXCPM_PORTABLE)
    set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
    set(GGML_STATIC ON CACHE BOOL "" FORCE)
    set(GGML_OPENMP OFF CACHE BOOL "" FORCE)  # 关键：禁用 OpenMP
    set(VOXCPM_VULKAN OFF CACHE BOOL "" FORCE)
    set(VOXCPM_NATIVE OFF CACHE BOOL "" FORCE)  # 关键：禁用本机优化以保证可移植性
endif()
```

### 3.3 平台级静态链接配置

```cmake
# Linux: 完全静态链接
if(VOXCPM_STATIC AND CMAKE_SYSTEM_NAME STREQUAL "Linux")
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -static -static-libstdc++ -static-libgcc")
endif()

# Windows MinGW: 静态运行时
if(VOXCPM_STATIC AND MINGW)
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -static -static-libgcc -static-libstdc++")
endif()

# Windows MSVC: 静态运行时
if(VOXCPM_STATIC AND MSVC)
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

# macOS: 不追求完全静态，但确保无额外第三方动态库
if(VOXCPM_PORTABLE AND APPLE)
    # 设置 rpath 和 install_name
    set(CMAKE_INSTALL_RPATH "@executable_path/../lib")
    set(CMAKE_BUILD_WITH_INSTALL_RPATH TRUE)
endif()
```

### 3.4 处理 libdl 依赖

**方案 A**: 在 `VOXCPM_CPU_ONLY=ON` 时，尝试裁剪 ggml 的 backend-dl 路径

**方案 B**: 接受静态链接时 `libdl.a` 被链入，不影响最终"单文件运行"目标

**推荐**: 先采用方案 B（风险低），后续再优化。

### 3.5 添加 HTTP Server

**方案**: 集成 `cpp-httplib`（header-only）

**新增文件**:
- `examples/server/server.cpp`
- `examples/server/httplib.h`

**API 设计**:
```
POST /tts       - 文本转语音
GET  /health    - 健康检查
GET  /models    - 列出已加载模型
POST /load      - 加载模型
```

---

## 四、强烈建议项

### 4.1 不要全局覆盖 CMAKE_EXE_LINKER_FLAGS

```cmake
# ❌ 不推荐
set(CMAKE_EXE_LINKER_FLAGS "-static" FORCE)

# ✅ 推荐：目标级配置
if(VOXCPM_STATIC)
    target_link_options(voxcpm-server PRIVATE
        $<$<PLATFORM_ID:Linux>:-static -static-libstdc++ -static-libgcc>
        $<$<AND:$<PLATFORM_ID:Windows>,$<CXX_COMPILER_ID:GNU>>:-static>
    )
endif()
```

### 4.2 为 Windows 分别处理 MinGW 和 MSVC

| 编译器 | 静态运行时配置 |
|--------|----------------|
| MinGW | `-static -static-libgcc -static-libstdc++` |
| MSVC | `/MT` (Release) 或 `/MTd` (Debug) |

### 4.3 macOS 目标要谨慎表述

- 无法完全静态链接系统库（系统库不支持静态链接）
- 现实目标：不依赖额外第三方动态库

---

## 五、具体改造步骤

### Step 1: 添加构建选项
**修改**: `CMakeLists.txt`
- 添加 `VOXCPM_SERVER`, `VOXCPM_CPU_ONLY`, `VOXCPM_STATIC`, `VOXCPM_PORTABLE` 选项
- 添加发行构建配置逻辑

### Step 2: 添加 cpp-httplib
**新建**: `examples/server/httplib.h`
- 从 https://github.com/yhirose/cpp-httplib 下载

### Step 3: 实现 server.cpp
**新建**: `examples/server/server.cpp`
- HTTP API 实现
- 模型加载/卸载
- TTS 推理

### Step 4: 添加平台级静态链接配置
**新建**: `cmake/StaticBuild.cmake`
- 平台判断和链接器配置

### Step 5: 添加构建脚本
**新建**: `scripts/build-release.sh`
- Linux 静态构建
- Windows 交叉编译
- macOS 构建

### Step 6: 添加 CI/CD
**新建**: `.github/workflows/release.yml`
- 自动构建三平台版本
- 创建 GitHub Release

---

## 六、验证方案

### Linux 静态构建验证
```bash
cmake -B build-release \
    -DVOXCPM_SERVER=ON \
    -DVOXCPM_STATIC=ON \
    -DVOXCPM_CPU_ONLY=ON \
    -DGGML_OPENMP=OFF \
    -DVOXCPM_NATIVE=OFF

cmake --build build-release

# 验证
ldd build-release/voxcpm-server
# 预期: "不是动态可执行文件" 或 "statically linked"
```

### Windows 构建验证
```bash
# MSVC 构建后，在纯净 Windows 环境验证
# voxcpm-server.exe 应可直接运行，无 DLL 依赖错误
```

### 功能验证
```bash
./voxcpm-server --model model.gguf --port 8080 &
curl -X POST http://localhost:8080/tts \
    -H "Content-Type: application/json" \
    -d '{"text":"测试语音合成"}' \
    -o test.wav
```

---

## 七、关键文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `CMakeLists.txt` | 修改 | 添加构建选项和静态链接配置 |
| `cmake/StaticBuild.cmake` | 新建 | 平台级静态链接工具链 |
| `examples/server/server.cpp` | 新建 | HTTP server 主程序 |
| `examples/server/httplib.h` | 新建 | HTTP 库（header-only） |
| `scripts/build-release.sh` | 新建 | 发布构建脚本 |
| `.github/workflows/release.yml` | 新建 | CI/CD 自动发布 |

---

## 八、风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| OpenMP 禁用影响性能 | 中 | 可在发布说明中提示用户按需开启 |
| libdl 静态链入 | 低 | 不影响"单文件运行"目标 |
| macOS 无法完全静态 | 低 | 目标调整为"无额外第三方依赖" |
| Windows MSVC 构建复杂 | 中 | 提供 vcpkg 或预编译环境 |

---

## 九、结论

**问题**: `voxcpm.cpp` 能不能做到无依赖封装？

| 目标 | 答案 |
|------|------|
| 默认构建是否零依赖 | ❌ 不是 |
| 单文件可执行程序是否可行 | ✅ 可以做到，Linux 已验证可行路径 |
| 作为完整对外封装库 | ⚠️ 当前不够，需补打包和依赖收口 |

**预计工作量**: 5-7 天（含跨平台测试）
