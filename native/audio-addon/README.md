# Orbit Audio Addon — native RNNoise denoiser (N-API)

Reference C++ implementation of the AI Voice Cleaner's native path. The
extension ships with a **pure-JS spectral-gate fallback** (`modules/audio-engine.js`)
so the whole feature works without compiling anything — the addon is an
optional upgrade that swaps in RNNoise's neural noise suppression.

## How the JS side finds it

`utils/ffmpegLocal.js` (`denoiseWav`) tries, in order:

1. `require('<extension>/native/audio-addon/build/Release/orbit_audio.node')`
   → calls `orbit_audio.denoiseWav(input, output, { strength, normalize })`
   → expects `{ success, error?, outputPath? }`.
2. If the require or the call fails, it falls back to the JS spectral gate.

So: **compile, drop the `.node` in place, reload the panel** — no code changes.

## Build

Prereqs: Node + node-gyp, and RNNoise vendored under `rnnoise/`:

```bash
# 1. Get RNNoise (BSD-3-Clause)
git clone https://github.com/xiph/rnnoise.git rnnoise
cd rnnoise && ./autogen.sh && ./configure --disable-shared && make && cd ..

# 2. Build the addon
npm install            # pulls node-addon-api + node-gyp
npm run build          # → build/Release/orbit_audio.node
```

If you skip step 1, the addon still compiles but `denoiseWav` returns
`success:false` and the JS fallback runs — the panel keeps working either way.
The `ORBIT_HAVE_RNNOISE` define in `binding.gyp` gates the neural code.

> The original product brief described a Premiere 26.2 Hybrid UXP addon
> (`require("orbit_audio.uxpaddon")`). This extension runs on **CEP +
> ExtendScript**, where the native boundary is the panel's Node context — an
> N-API `.node` module is the equivalent. The interface is kept identical
> (`denoiseWav(inputPath, outputPath, options) → {success, error}`) so a
> future Hybrid port only touches `ffmpegLocal.js`.

## Files

| File | Role |
|---|---|
| `addon.cpp` | N-API entry, `denoiseWav` binding, peak normalize (−1 dBFS) |
| `denoise.cpp/.h` | RNNoise frame loop, per-channel states, strength dry/wet blend |
| `wav.cpp/.h` | WAV read/write (16/24-bit PCM + 32-bit float) |
| `binding.gyp` | node-gyp build config |
| `package.json` | npm metadata (node-addon-api, node-gyp) |

## Interface contract

```js
const addon = require('./build/Release/orbit_audio.node');
const res = addon.denoiseWav('C:/Orbit/temp/input.wav', 'C:/Orbit/temp/out.wav', {
  strength: 0.8,   // 0 = original, 1 = full denoise
  normalize: true  // peak → −1 dBFS
});
// res → { success: true, outputPath } | { success: false, error }
```

RNNoise operates on 48 kHz mono 10 ms frames; the export step
(`FFmpegAPI.extractClipWav`) already writes 48 kHz WAV and stereo channels
are processed with independent RNNoise states (never shared).
