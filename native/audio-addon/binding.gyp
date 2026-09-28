{
  "targets": [
    {
      "target_name": "orbit_audio",
      "sources": [
        "addon.cpp",
        "denoise.cpp",
        "wav.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "rnnoise/include"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "ORBIT_HAVE_RNNOISE"
      ],
      "conditions": [
        [
          "OS=='win'",
          {
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1,
                "RuntimeLibrary": 2,
                "AdditionalOptions": ["/EHsc"]
              }
            }
          }
        ],
        [
          "OS=='mac'",
          {
            "xcode_settings": {
              "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
              "CLANG_CXX_LIBRARY": "libc++"
            }
          }
        ]
      ],
      "libraries": [
        "rnnoise/build/librnnoise.a"
      ]
    }
  ]
}
