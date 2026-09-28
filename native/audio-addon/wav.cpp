// wav.cpp — minimal WAV reader/writer for the Orbit Voice Cleaner addon.
//
// Supports 16/24-bit PCM and 32-bit float, 1 or 2 channels. The JS export
// step (extractClipWav) always writes 16-bit PCM at 48 kHz, so the reader
// only needs to be robust for that, but float is handled for completeness.
#include "wav.h"

#include <cstring>
#include <fstream>
#include <sstream>

namespace orbit_audio {

namespace {

uint32_t ReadU32(const uint8_t* p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
         ((uint32_t)p[3] << 24);
}

uint16_t ReadU16(const uint8_t* p) {
  return (uint16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

void WriteU32(std::ofstream& f, uint32_t v) {
  uint8_t b[4] = {(uint8_t)(v & 0xff), (uint8_t)((v >> 8) & 0xff),
                  (uint8_t)((v >> 16) & 0xff), (uint8_t)((v >> 24) & 0xff)};
  f.write(reinterpret_cast<char*>(b), 4);
}

void WriteU16(std::ofstream& f, uint16_t v) {
  uint8_t b[2] = {(uint8_t)(v & 0xff), (uint8_t)((v >> 8) & 0xff)};
  f.write(reinterpret_cast<char*>(b), 2);
}

}  // namespace

bool readWav(const std::string& path, WavData* out) {
  if (!out) return false;
  std::ifstream f(path, std::ios::binary);
  if (!f) return false;

  uint8_t hdr[44];
  f.read(reinterpret_cast<char*>(hdr), 44);
  if (f.gcount() < 44) return false;
  if (std::memcmp(hdr, "RIFF", 4) != 0 || std::memcmp(hdr + 8, "WAVE", 4) != 0)
    return false;

  uint16_t format = ReadU16(hdr + 20);
  uint16_t channels = ReadU16(hdr + 22);
  uint32_t sampleRate = ReadU32(hdr + 24);
  uint16_t bits = ReadU16(hdr + 34);
  if (channels < 1 || channels > 2) return false;
  bool isFloat = (format == 3);

  // Find the data chunk (walk chunks in case fmt/data order differs).
  f.seekg(12);
  uint32_t dataLen = 0;
  while (f) {
    uint8_t chunk[8];
    f.read(reinterpret_cast<char*>(chunk), 8);
    if (f.gcount() < 8) break;
    uint32_t size = ReadU32(chunk + 4);
    if (std::memcmp(chunk, "data", 4) == 0) {
      dataLen = size;
      break;
    }
    f.seekg(size + (size & 1), std::ios::cur);
  }
  if (dataLen == 0) return false;

  int bytesPerSample = bits / 8;
  uint32_t frames = dataLen / (bytesPerSample * channels);
  if (frames == 0) return false;

  out->sampleRate = sampleRate;
  out->channels = channels;
  out->samples.assign((size_t)frames * channels, 0.0f);

  std::vector<uint8_t> buf(dataLen);
  f.read(reinterpret_cast<char*>(buf.data()), dataLen);
  if ((uint32_t)f.gcount() < dataLen) return false;

  for (uint32_t i = 0; i < frames; i++) {
    for (uint16_t c = 0; c < channels; c++) {
      size_t src = ((size_t)i * channels + c) * bytesPerSample;
      float v = 0.0f;
      if (isFloat && bytesPerSample == 4) {
        uint32_t raw = ReadU32(&buf[src]);
        float fv;
        std::memcpy(&fv, &raw, 4);
        v = fv;
      } else if (bytesPerSample == 2) {
        int16_t s = (int16_t)ReadU16(&buf[src]);
        v = s / 32768.0f;
      } else if (bytesPerSample == 3) {
        int32_t n = (int32_t)buf[src] | ((int32_t)buf[src + 1] << 8) |
                    ((int32_t)buf[src + 2] << 16);
        if (n & 0x800000) n |= ~0xffffff;
        v = n / 8388608.0f;
      } else {
        return false;
      }
      out->samples[(size_t)i * channels + c] = v;
    }
  }
  return true;
}

bool writeWav(const std::string& path, const WavData& in) {
  size_t frames = in.samples.size() / in.channels;
  if (frames == 0 || in.channels < 1 || in.channels > 2) return false;

  uint32_t bytesPerSample = 2;  // always write 16-bit PCM
  uint32_t dataLen = (uint32_t)(frames * in.channels * bytesPerSample);
  uint32_t sampleRate = in.sampleRate ? in.sampleRate : 48000;

  std::ofstream f(path, std::ios::binary | std::ios::trunc);
  if (!f) return false;

  f.write("RIFF", 4);
  WriteU32(f, 36 + dataLen);
  f.write("WAVE", 4);
  f.write("fmt ", 4);
  WriteU32(f, 16);
  WriteU16(f, 1);                    // PCM
  WriteU16(f, (uint16_t)in.channels);
  WriteU32(f, sampleRate);
  WriteU32(f, sampleRate * in.channels * bytesPerSample);
  WriteU16(f, (uint16_t)(in.channels * bytesPerSample));
  WriteU16(f, 16);
  f.write("data", 4);
  WriteU32(f, dataLen);

  for (size_t i = 0; i < in.samples.size(); i++) {
    float v = in.samples[i];
    if (v < -1.0f) v = -1.0f;
    if (v > 1.0f) v = 1.0f;
    int16_t s = (int16_t)(v * 32767.0f);
    WriteU16(f, (uint16_t)s);
  }
  return true;
}

}  // namespace orbit_audio
