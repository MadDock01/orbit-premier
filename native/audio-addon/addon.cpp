// addon.cpp — N-API entry point for the Orbit Voice Cleaner native addon.
//
// Build (after installing node-addon-api + node-gyp and vendoring RNNoise):
//   npm install -g node-gyp
//   node-gyp configure build        # outputs build/Release/orbit_audio.node
//
// The JS side (utils/ffmpegLocal.js) requires this file at
//   native/audio-addon/build/Release/orbit_audio.node
// and calls the same interface it exposes here:
//   orbitAudio.denoiseWav(inputPath, outputPath, { strength, normalize })
//     → { success, error }
//
// If RNNoise is not vendored, the addon compiles without it and returns
// success=false, so ffmpegLocal.js transparently falls back to the pure-JS
// spectral gate. Compile with -DORBIT_HAVE_RNNOISE (see binding.gyp) to
// enable the neural path.
#include <napi.h>

#include <algorithm>
#include <cmath>

#include "denoise.h"
#include "wav.h"

namespace {

// Peak normalize to -1 dBFS (0.891), per the product spec.
void Normalize(WavData* wav) {
  float peak = 0.0f;
  for (float s : wav->samples) peak = std::max(peak, std::abs(s));
  if (peak <= 0.00001f) return;
  float gain = 0.891f / peak;
  for (float& s : wav->samples) s *= gain;
}

Napi::Value DenoiseWav(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsString() || !info[1].IsString() ||
      !info[2].IsObject()) {
    Napi::TypeError::New(env, "denoiseWav(inputPath, outputPath, options)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string input = info[0].As<Napi::String>().Utf8Value();
  std::string output = info[1].As<Napi::String>().Utf8Value();
  Napi::Object options = info[2].As<Napi::Object>();

  double strength = 0.8;
  bool normalize = true;
  if (options.Has("strength")) strength = options.Get("strength").As<Napi::Number>().DoubleValue();
  if (options.Has("normalize")) normalize = options.Get("normalize").As<Napi::Boolean>().Value();

  WavData wav;
  if (!orbit_audio::readWav(input, &wav)) {
    Napi::Object err = Napi::Object::New(env);
    err.Set("success", Napi::Boolean::New(env, false));
    err.Set("error", Napi::String::New(env, "Failed to read input WAV: " + input));
    return err;
  }

  bool ok = orbit_audio::denoise(wav.samples.data(), wav.samples.size(),
                                 wav.channels, (float)strength);
  if (!ok) {
    Napi::Object err = Napi::Object::New(env);
    err.Set("success", Napi::Boolean::New(env, false));
    err.Set("error",
            Napi::String::New(env,
                              "Native denoise unavailable (RNNoise not "
                              "compiled in). JS fallback will be used."));
    return err;
  }

  if (normalize) Normalize(&wav);

  if (!orbit_audio::writeWav(output, wav)) {
    Napi::Object err = Napi::Object::New(env);
    err.Set("success", Napi::Boolean::New(env, false));
    err.Set("error", Napi::String::New(env, "Failed to write output WAV: " + output));
    return err;
  }

  Napi::Object res = Napi::Object::New(env);
  res.Set("success", Napi::Boolean::New(env, true));
  res.Set("outputPath", Napi::String::New(env, output));
  return res;
}

}  // namespace

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set(Napi::String::New(env, "denoiseWav"),
              Napi::Function::New(env, DenoiseWav));
  return exports;
}

NODE_API_MODULE(orbit_audio, Init)
