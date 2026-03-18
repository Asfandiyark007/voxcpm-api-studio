add_executable(voxcpm_wasm voxcpm_wasm.cpp)

target_link_libraries(voxcpm_wasm PRIVATE voxcpm)

target_include_directories(voxcpm_wasm PRIVATE ${CMAKE_SOURCE_DIR}/include)

target_compile_options(voxcpm_wasm PRIVATE
    -fwasm-exceptions
    -msimd128
    -matomics
    -mbulk-memory
    -pthread
    -sUSE_PTHREADS=1
)

target_link_options(voxcpm_wasm PRIVATE
    -fwasm-exceptions
    -msimd128
    -matomics
    -mbulk-memory
    -pthread
    -sUSE_PTHREADS=1
    -sPTHREAD_POOL_SIZE=Module.pthreadPoolSize||4
    -sPTHREAD_POOL_DELAY_LOAD=1
    -sSHARED_MEMORY=1
    -sALLOW_MEMORY_GROWTH=1
    -sMAXIMUM_MEMORY=4294967296
    -sINITIAL_MEMORY=536870912
    -sFORCE_FILESYSTEM=1
    -sFILESYSTEM=1
    -sWASMFS=1
    -sMALLOC=mimalloc
    -sEXPORT_ES6=1
    -sMODULARIZE=1
    -sEXPORT_NAME=createVoxCpmModule
    -sENVIRONMENT=web,worker
    -sEXPORTED_FUNCTIONS=["_malloc","_free","_voxcpm_create_engine","_voxcpm_destroy_engine","_voxcpm_load_model","_voxcpm_infer","_voxcpm_get_audio_ptr","_voxcpm_get_audio_len","_voxcpm_get_audio_sample_rate","_voxcpm_get_required_prompt_sample_rate","_voxcpm_get_last_error"]
    -sEXPORTED_RUNTIME_METHODS=["FS","UTF8ToString","stringToUTF8","lengthBytesUTF8","wasmMemory","PThread","OPFS","MEMFS"]
    -lopfs.js
    -lpthread.js
)

set_target_properties(voxcpm_wasm PROPERTIES
    OUTPUT_NAME "voxcpm_wasm"
    SUFFIX ".js"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/web/packages/voxcpm-web/src/wasm/generated"
)
