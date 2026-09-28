// denoise.h — RNNoise-based speech denoise core for the Orbit Voice Cleaner.
//
// Reference implementation for the native path. The JS side (ffmpegLocal.js)
// prefers this addon when it is compiled; otherwise the pure-JS spectral gate
// in modules/audio-engine.js is used. Both expose the same interface.
//
// RNNoise: https://github.com/xiph/rnnoise (BSD-3-Clause)
#pragma once

#include <string>
#include <vector>

namespace orbit_audio {

// Denoise every channel of the interleaved `samples` buffer.
//   samples    — interleaved float PCM in [-1, 1]
//   numSamples — total sample count (channels * frames)
//   channels   — 1 or 2 (each channel gets its own RNNoise state, per spec)
//   strength   — 0..1 dry/wet blend toward the RNNoise output
// Returns true on success.
bool denoise(float* samples, size_t numSamples, int channels, float strength);

}  // namespace orbit_audio
