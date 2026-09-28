// denoise.cpp — RNNoise processing loop.
//
// RNNoise works on 48 kHz mono frames of 480 samples (10 ms). The extension
// exports the selected clip to a 48 kHz WAV before this runs, so no
// resampling is needed here — per spec Step 12, resampling happens in the
// export step (extractClipWav in ffmpegLocal.js).
//
// Stereo clips get one DenoiseState per channel (spec Step 13) — states are
// never shared across channels.
#include "denoise.h"

#include <algorithm>
#include <cmath>

// RNNoise is an optional dependency. If you vendor it (e.g. as a git
// submodule under rnnoise/), uncomment the include and link librnnoise.
// Without it, this file still compiles and the addon reports success=false
// with a clear error so the JS fallback (spectral gate) takes over.
#ifdef ORBIT_HAVE_RNNOISE
#include "rnnoise.h"
#endif

namespace orbit_audio {

namespace {

constexpr int kFrameSize = 480;  // 10 ms at 48 kHz

#ifdef ORBIT_HAVE_RNNOISE
// Process one interleaved buffer of `numFrames` frames (one channel).
void processChannel(float* ch, size_t numFrames, float strength) {
  DenoiseState* state = rnnoise_create(nullptr);
  if (!state) return;

  float frame[kFrameSize];
  float original[kFrameSize];

  for (size_t i = 0; i + kFrameSize <= numFrames; i += kFrameSize) {
    for (int j = 0; j < kFrameSize; j++) {
      frame[j] = ch[i + j] * 32768.0f;
      original[j] = frame[j];
    }

    float vad = rnnoise_process_frame(state, frame, frame);
    (void)vad;  // could be surfaced later as a voice-activity signal

    for (int j = 0; j < kFrameSize; j++) {
      float clean = frame[j] / 32768.0f;
      float dry = original[j] / 32768.0f;
      ch[i + j] = dry * (1.0f - strength) + clean * strength;
    }
  }

  rnnoise_destroy(state);
}
#endif  // ORBIT_HAVE_RNNOISE

}  // namespace

bool denoise(float* samples, size_t numSamples, int channels, float strength) {
  if (!samples || numSamples == 0 || channels < 1) return false;
  strength = std::max(0.0f, std::min(1.0f, strength));

#ifdef ORBIT_HAVE_RNNOISE
  size_t frames = numSamples / channels;
  // De-interleave so each channel is contiguous (RNNoise wants one stream).
  std::vector<float> perChannel(frames);
  for (int c = 0; c < channels; c++) {
    for (size_t f = 0; f < frames; f++) {
      perChannel[f] = samples[f * channels + c];
    }
    processChannel(perChannel.data(), frames, strength);
    for (size_t f = 0; f < frames; f++) {
      samples[f * channels + c] = perChannel[f];
    }
  }
  return true;
#else
  (void)samples;
  (void)numSamples;
  (void)channels;
  (void)strength;
  return false;
#endif
}

}  // namespace orbit_audio
