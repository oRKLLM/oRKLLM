{
  "targets": [
    {
      "target_name": "orkllm_napi",
      "sources": [ "src/addon/orkllm_napi.cpp" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LIBRARY": "libc++",
        "MACOSX_DEPLOYMENT_TARGET": "10.7"
      },
      "msvs_settings": {
        "VCCLCompilerTool": { "ExceptionHandling": 1 }
      },
      "conditions": [
        [ "OS=='win'", {
          "defines": [ "_HAS_EXCEPTIONS=1" ]
        }]
      ]
    },
    {
      "target_name": "orkllm_llama_napi",
      "sources": [ "src/addon/orkllm_llama_napi.cpp" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!":    [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "cflags_cc":  [ "-std=c++17", "-O2" ],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LIBRARY": "libc++",
        "MACOSX_DEPLOYMENT_TARGET": "10.7",
        "OTHER_CPLUSPLUSFLAGS": [ "-std=c++17", "-O2" ]
      },
      "msvs_settings": {
        "VCCLCompilerTool": { "ExceptionHandling": 1 }
      },
      "conditions": [
        [ "OS=='win'", {
          "defines": [ "_HAS_EXCEPTIONS=1" ]
        }]
      ]
    },
    {
      "target_name": "kvcache_quant_napi",
      "sources": [ "src/addon/kvcache_quant_napi.cpp" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!":    [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "cflags_cc": [ "-std=c++17", "-O3" ],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LIBRARY": "libc++",
        "MACOSX_DEPLOYMENT_TARGET": "10.7",
        "OTHER_CPLUSPLUSFLAGS": [ "-std=c++17", "-O3" ]
      },
      "conditions": [
        [ "OS=='win'", {
          "defines": [ "_HAS_EXCEPTIONS=1" ]
        }],
        [ "target_arch=='arm64' and OS=='linux'", {
          "cflags_cc": [ "-std=c++17", "-O3",
            "<!@(test -f /usr/include/vulkan/vulkan.h && echo -DHAS_VULKAN=1 || echo '')" ],
          "libraries": [
            "<!@(test -f /usr/include/vulkan/vulkan.h && echo -lvulkan || echo '')"
          ]
        }],
        [ "target_arch!='arm64' or OS!='linux'", {
          "cflags_cc": [ "-std=c++17", "-O3" ]
        }]
      ]
    }
  ]
}
