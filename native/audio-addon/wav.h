// wav.h — WAV I/O declarations for the Orbit Voice Cleaner addon.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace orbit_audio {

struct WavData {
  uint32_t sampleRate = 48000;
  uint16_t channels = 1;
  // Interleaved float samples in [-1, 1].
  std::vector<float> samples;
};

// Reads any supported WAV into interleaved float. Returns false on error.
bool readWav(const std::string& path, WavData* out);

// Writes interleaved float as 16-bit PCM WAV. Returns false on error.
bool writeWav(const std::string& path, const WavData& in);

}  // namespace orbit_audio
