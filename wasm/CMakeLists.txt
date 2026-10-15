# =============================================================================
#  forza_net —— Emscripten (Wasm) 构建
#
#    emcmake cmake -S . -B build-wasm -DCMAKE_BUILD_TYPE=Release \
#        -DGLM_DIR=/e/g-truc-glm-8d1fd52
#    cmake --build build-wasm
#    # 产物：build-wasm/forza_net.js + forza_net.wasm
#
#  说明：GLM 是**头文件库**，CMake 没有 find_package(glm) 的标准包名保证，
#        所以用 GLM_DIR 显式指定"含 glm/ 子目录的父目录"。
# =============================================================================
cmake_minimum_required(VERSION 3.16)
project(forza_net CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "本工程是给 Emscripten 用的。请用 emcmake cmake ... 调用。")
endif()

set(GLM_DIR "" CACHE PATH "含 glm/ 子目录的父目录（例如 /e/g-truc-glm-8d1fd52）")
if(NOT GLM_DIR)
  message(FATAL_ERROR "请用 -DGLM_DIR=<含 glm/ 的父目录> 指定 GLM")
endif()

set(SRC
  bindings.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/../native/timesync/forza_time_sync.cpp
)

add_executable(forza_net ${SRC})

target_include_directories(forza_net PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/../native/rb_replicator   # NetworkRigidBodyReplicator（头文件库）
  ${CMAKE_CURRENT_SOURCE_DIR}/../native/timesync
  ${GLM_DIR}
)

# ---- 性能与体积旗标（规格要求）----
target_compile_options(forza_net PRIVATE
  -O3
  -flto
  -msimd128                 # SIMD128：让 GLM 的 vec3/vec4 走 128 位通道
  -fno-exceptions           # 热路径零异常开销；本项目所有热路径函数本就 noexcept
  -fno-rtti
)

# ---- 链接旗标 ----
#  INITIAL_MEMORY=64MB（规格要求）、ALLOW_MEMORY_GROWTH=1
#  DYNAMIC_EXECUTION=0 —— 关闭 eval/new Function（规格要求"关闭动态调用开销"），
#    同时让产物能过严格 CSP（本仓库的 index.html 就有 default-src 'none'）
#  FILESYSTEM=0 —— 不需要虚拟文件系统，省体积
#  MODULARIZE + EXPORT_ES6 —— 给前端 `import { default as createModule } from './forza_net.js'`
target_link_options(forza_net PRIVATE
  --bind
  -O3
  -flto
  -msimd128
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=createForzaNet
  -sENVIRONMENT=web,worker
  -sINITIAL_MEMORY=67108864
  -sALLOW_MEMORY_GROWTH=1
  -sDYNAMIC_EXECUTION=0
  -sFILESYSTEM=0
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32
  # 热路径是 extern "C" 的，必须显式导出，否则会被 LTO 当死代码删掉
  -sEXPORTED_FUNCTIONS=_forzaPushSnapshot,_forzaUpdate,_forzaVisualMatrixPtr,_forzaPhysicsMatrixPtr,_forzaClockOnPong,_forzaClockAdjustedDt,_forzaClockServerNow,_forzaClockWarp,_forzaClockReset,_forzaReplState,_forzaReplVisualError,_forzaSnapshotStride,_forzaSnapshotOffset,_malloc,_free
  -sASSERTIONS=0
)

set_target_properties(forza_net PROPERTIES OUTPUT_NAME "forza_net")
