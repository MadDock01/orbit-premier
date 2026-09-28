/**
 * audio-engine.js — AI Voice Cleaner engine (pure JS).
 *
 * Architecture follows the Orbit family: pure engine → panel → host adapter.
 * This module has ZERO Premiere/CEP dependencies so it runs in a plain
 * browser (and is unit-testable):
 *
 *   • WAV read/write (16/24-bit PCM + 32-bit float, mono/stereo)
 *   • FFT / STFT (radix-2, Hann window, 75% overlap-add)
 *   • Spectral-gate denoiser — per-bin noise-floor estimate (minimum
 *     statistics over the first frames) + spectral subtraction shaped by
 *     `strength`, `mix` dry/wet blend, optional peak normalize
 *   • Native-addon hook — if a compiled `orbit_audio.node` (N-API, see
 *     native/audio-addon/) is available on `global.AudioNative`, that is
 *     preferred for the heavy lift; otherwise the JS gate runs.
 *
 * RNNoise note: the reference C++ addon in native/audio-addon/ wraps
 * RNNoise (48 kHz mono frames). The JS fallback below is a generic
 * spectral gate — same interface, no neural net.
 */
(function (global) {
  'use strict';

  var HAS_NODE = (function () {
    try { return typeof require !== 'undefined' && !!require('fs'); } catch (_) { return false; }
  })();

  // ── WAV I/O (pure) ───────────────────────────────────────────────────────
  // Reads a WAV file (RIFF) into { sampleRate, channels: Float32Array[] }.
  // Channels are de-interleaved and normalized to −1..1 (signed ints / float).
  function decodeWav(buffer) {
    if (!buffer || buffer.byteLength < 44) throw new Error('Not a WAV file.');
    var dv = new DataView(buffer);
    if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'RIFF') {
      throw new Error('Not a RIFF/WAV file.');
    }
    var fmtId = String.fromCharCode(dv.getUint8(8), dv.getUint8(9), dv.getUint8(10), dv.getUint8(11));
    if (fmtId !== 'WAVE') throw new Error('Not a WAVE file.');
    var offset = 12;
    var sampleRate = 48000, channels = 1, bits = 16, format = 1;
    var dataOffset = -1, dataLen = 0;
    while (offset + 8 <= buffer.byteLength) {
      var id = String.fromCharCode(dv.getUint8(offset), dv.getUint8(offset + 1), dv.getUint8(offset + 2), dv.getUint8(offset + 3));
      var size = dv.getUint32(offset + 4, true);
      if (id === 'fmt ') {
        format = dv.getUint16(offset + 8, true);
        channels = dv.getUint16(offset + 10, true);
        sampleRate = dv.getUint32(offset + 12, true);
        bits = dv.getUint16(offset + 22, true);
      } else if (id === 'data') {
        dataOffset = offset + 8;
        dataLen = size;
      }
      offset += 8 + size + (size & 1);
    }
    if (dataOffset < 0) throw new Error('WAV data chunk not found.');
    var isFloat = format === 3;
    var bytesPerSample = bits / 8;
    var frameCount = Math.floor(dataLen / (bytesPerSample * channels));
    var out = [];
    for (var c = 0; c < channels; c++) out.push(new Float32Array(frameCount));
    for (var i = 0; i < frameCount; i++) {
      for (var ch = 0; ch < channels; ch++) {
        var p = dataOffset + (i * channels + ch) * bytesPerSample;
        var v;
        if (isFloat) {
          v = dv.getFloat32(p, true);
        } else if (bits === 16) {
          v = dv.getInt16(p, true) / 32768;
        } else if (bits === 24) {
          var b0 = dv.getUint8(p), b1 = dv.getUint8(p + 1), b2 = dv.getUint8(p + 2);
          var n = (b2 << 16) | (b1 << 8) | b0;
          if (n & 0x800000) n -= 0x1000000;
          v = n / 8388608;
        } else if (bits === 32) {
          v = dv.getInt32(p, true) / 2147483648;
        } else {
          throw new Error('Unsupported WAV bit depth: ' + bits);
        }
        out[ch][i] = v;
      }
    }
    return { sampleRate: sampleRate, channels: out, bits: isFloat ? 32 : bits };
  }

  // Encodes Float32Array channels to a WAV ArrayBuffer.
  // bitDepth: 16 (PCM) or 32 (float). Default 32 — lossless for a clean
  // intermediate, and the final Premiere import accepts either.
  function encodeWav(channels, sampleRate, bitDepth) {
    if (!channels || !channels.length) throw new Error('No channels to encode.');
    var n = channels[0].length;
    var bits = bitDepth === 16 ? 16 : 32;
    var isFloat = bits === 32;
    var bytesPerSample = bits / 8;
    var dataLen = n * channels.length * bytesPerSample;
    var buf = new ArrayBuffer(44 + dataLen);
    var dv = new DataView(buf);
    function writeStr(o, s) { for (var i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); }
    writeStr(0, 'RIFF');
    dv.setUint32(4, 36 + dataLen, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, isFloat ? 3 : 1, true);
    dv.setUint16(22, channels.length, true);
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * channels.length * bytesPerSample, true);
    dv.setUint16(32, channels.length * bytesPerSample, true);
    dv.setUint16(34, bits, true);
    writeStr(36, 'data');
    dv.setUint32(40, dataLen, true);
    var o = 44;
    for (var i = 0; i < n; i++) {
      for (var c = 0; c < channels.length; c++) {
        var v = channels[c][i];
        if (isFloat) {
          dv.setFloat32(o, v, true);
        } else {
          var s16 = Math.max(-1, Math.min(1, v)) * 32767;
          dv.setInt16(o, Math.round(s16), true);
        }
        o += bytesPerSample;
      }
    }
    return buf;
  }

  // ── FFT (radix-2, iterative, in-place) ───────────────────────────────────
  // real/imag Float64Arrays of length n (power of two). Standard
  // bit-reversal + Cooley–Tukey butterflies.
  var _cosTable = {};
  var _sinTable = {};
  function _tables(n) {
    var half = n >> 1;
    if (_cosTable[half]) return;
    var c = new Float64Array(half), s = new Float64Array(half);
    for (var i = 0; i < half; i++) {
      var a = -2 * Math.PI * i / n;
      c[i] = Math.cos(a); s[i] = Math.sin(a);
    }
    _cosTable[half] = c; _sinTable[half] = s;
  }
  function fft(re, im) {
    var n = re.length;
    _tables(n);
    for (var i = 1, j = 0; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        var tr = re[i]; re[i] = re[j]; re[j] = tr;
        var ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (var size = 2; size <= n; size <<= 1) {
      var half = size >> 1;
      _tables(size); // ensure the table for this butterfly size exists
      var ctab = _cosTable[half], stab = _sinTable[half];
      for (var k = 0; k < n; k += size) {
        for (var m = 0; m < half; m++) {
          var wr = ctab[m], wi = stab[m];
          var j2 = k + m + half;
          var ar = re[j2] * wr - im[j2] * wi;
          var ai = re[j2] * wi + im[j2] * wr;
          re[j2] = re[k + m] - ar; im[j2] = im[k + m] - ai;
          re[k + m] += ar; im[k + m] += ai;
        }
      }
    }
  }
  function ifft(re, im) {
    var n = re.length;
    for (var i = 0; i < n; i++) im[i] = -im[i];
    fft(re, im);
    var inv = 1 / n;
    for (var j = 0; j < n; j++) { re[j] *= inv; im[j] = -im[j] * inv; }
  }

  // ── STFT helpers ─────────────────────────────────────────────────────────
  function makeHann(n) {
    var w = new Float64Array(n);
    for (var i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    return w;
  }

  // ── Spectral-gate denoiser ───────────────────────────────────────────────
  // Per-channel: STFT → per-bin noise floor (min-statistics warm-up frames,
  // then slow tracking) → gain per bin with over-subtraction shaped by
  // `strength` (0..1) → ISTFT overlap-add. Returns a NEW Float32Array.
  function denoiseChannel(samples, sampleRate, strength, onProgress) {
    var n = samples.length;
    var fftSize = 2048;
    var hop = 512;                 // 75% overlap — good for speech
    var win = makeHann(fftSize);
    // Zero-pad the tail by one frame so EVERY frame overlapping the signal
    // is full-length: a partial last frame breaks the constant-overlap-add
    // reconstruction and produces a spike at the clip end. The extra region
    // is never written to `out`.
    var padded = new Float64Array(n + fftSize);
    for (var p0 = 0; p0 < n; p0++) padded[p0] = samples[p0];
    var numFrames = Math.max(1, Math.floor((padded.length - fftSize) / hop) + 1);
    // How many frames the noise floor is estimated from. Capped so the cost
    // and the memory stay flat on a long clip: 240 frames is ~2.5 s of
    // material, which is plenty to characterise a steady noise floor.
    var MAX_PROFILE_FRAMES = 240;

    var noise = new Float64Array(fftSize / 2 + 1).fill(1e-6);
    var out = new Float64Array(n);
    var norm = new Float64Array(n);
    var re = new Float64Array(fftSize), im = new Float64Array(fftSize);
    var bins = fftSize / 2 + 1;

    // Noise-floor floor: keep a touch of the original under heavy gates so
    // music beds don't turn into pure digital mush.
    var floorGain = 1 - strength * 0.65;

    // ── Pass 1a: frame energies, in the time domain ─────────────────────
    // The noise profile used to come from the first 0.5 s, on the assumption
    // that a clip opens with room tone. When it opens on speech instead —
    // which is exactly what a tightly cut clip does — the profile WAS the
    // voice, and the subtraction then removed the voice: measured at 9.1 dB
    // of level gone from the speech itself.
    //
    // So the profile now comes from the quietest frames anywhere in the clip.
    // Energy is computed without an FFT, so this pass is cheap; only the
    // frames it selects get transformed.
    var energies = new Float64Array(numFrames);
    for (var ef = 0; ef < numFrames; ef++) {
      var eStart = ef * hop, acc = 0;
      // Every 4th sample: enough to rank frames, a quarter of the work.
      for (var es = 0; es < fftSize; es += 4) {
        var sv = padded[eStart + es] * win[es];
        acc += sv * sv;
      }
      energies[ef] = acc;
    }

    // ── Pass 1b: pick the quietest frames ───────────────────────────────
    var ranked = new Float64Array(energies);
    ranked.sort();
    // The quietest fifth of the clip, or every frame when there are few.
    var quietCut = ranked[Math.min(ranked.length - 1, Math.max(0, Math.floor(numFrames * 0.20)))];
    var profileFrames = [];
    for (var qf = 0; qf < numFrames && profileFrames.length < MAX_PROFILE_FRAMES; qf++) {
      if (energies[qf] <= quietCut) profileFrames.push(qf);
    }
    // A clip with no quiet passage at all (continuous speech, wall-to-wall
    // music) still needs a profile; fall back to the single quietest frames
    // rather than refusing to denoise.
    if (!profileFrames.length) {
      var order = [];
      for (var of0 = 0; of0 < numFrames; of0++) order.push(of0);
      order.sort(function (x, y) { return energies[x] - energies[y]; });
      profileFrames = order.slice(0, Math.min(MAX_PROFILE_FRAMES, order.length));
    }

    // ── Pass 1c: per-bin percentile over those frames ───────────────────
    // A percentile rather than a mean: even among quiet frames a breath or a
    // word tail can land in one, and the low tail of the distribution is the
    // noise.
    var profileCount = profileFrames.length;
    var profMags = new Float64Array(profileCount * bins);
    for (var pf = 0; pf < profileCount; pf++) {
      var pStart = profileFrames[pf] * hop;
      re.fill(0); im.fill(0);
      for (var pi = 0; pi < fftSize; pi++) re[pi] = padded[pStart + pi] * win[pi];
      fft(re, im);
      for (var pb = 0; pb < bins; pb++) {
        profMags[pf * bins + pb] = Math.sqrt(re[pb] * re[pb] + im[pb] * im[pb]);
      }
    }
    var pct = Math.max(0, Math.floor(profileCount * 0.30) - 1);
    var scratch = new Float64Array(profileCount);
    for (var b0 = 0; b0 < bins; b0++) {
      for (var w0 = 0; w0 < profileCount; w0++) scratch[w0] = profMags[w0 * bins + b0];
      scratch.sort();
      noise[b0] = Math.max(1e-9, scratch[pct]);
    }
    profMags = null; // free the buffer

    // ── Confidence in that profile ──────────────────────────────────────
    // If the quietest frames are barely quieter than the median frame, the
    // clip has no silence in it and the "noise" we just measured is mostly
    // programme. Subtracting it at full strength would take the voice with
    // it. Rather than refuse, back the subtraction off in proportion: a
    // clip with a real noise floor is untouched, one without degrades to
    // something mild instead of gutting the speech.
    var medianEnergy = ranked[Math.floor(numFrames / 2)] || 1e-12;
    var quietEnergy = ranked[Math.min(ranked.length - 1, Math.max(0, Math.floor(numFrames * 0.10)))] || 1e-12;
    // In dB, how far the quiet tail sits below the middle of the clip.
    var headroomDb = 10 * Math.log10(medianEnergy / Math.max(quietEnergy, 1e-12));
    // 12 dB or more of headroom → full confidence. 0 dB → a quarter.
    var confidence = Math.max(0.25, Math.min(1, headroomDb / 12));

    // ── Pass 2: spectral subtraction + overlap-add ──────────────────────
    // gain = max(0, 1 − α·nEst/|X|) — the classic Berouti over-subtraction.
    // Bins at/below the noise floor are driven toward zero (noise, hum),
    // bins well above it keep ~all their energy (speech harmonics). α is
    // 1 + 3·strength: strength 0 → plain subtraction (light), 1 → 4×
    // over-subtraction (deep), scaled by how much silence the clip actually
    // offered. floorGain keeps a sliver of the original so heavily-gated
    // music beds don't turn into pure digital silence.
    // `confidence` scales the over-subtraction, not `strength`: the user's
    // setting still means what it says, it is just applied more cautiously
    // when the clip gave us nothing clean to measure.
    var alpha = (1 + strength * 3) * confidence;
    for (var f3 = 0; f3 < numFrames; f3++) {
      var start3 = f3 * hop;
      var len3 = fftSize;
      re.fill(0); im.fill(0);
      for (var i3 = 0; i3 < len3; i3++) re[i3] = padded[start3 + i3] * win[i3];
      fft(re, im);
      // Real-signal FFT: bins 1..fftSize/2−1 have conjugate mirrors at
      // fftSize−b. Gain must be applied to BOTH halves or the ifft mixes a
      // gated bin with its ungated mirror and the gate is diluted ~2×.
      // DC (0) and Nyquist (fftSize/2) are real-only, applied once.
      for (var b3 = 1; b3 < bins - 1; b3++) {
        var mag3 = Math.sqrt(re[b3] * re[b3] + im[b3] * im[b3]);
        var nEst = noise[b3];
        var g = Math.max(0, 1 - alpha * nEst / (mag3 || 1e-9));
        g = floorGain + (1 - floorGain) * g; // keep a touch of the original
        re[b3] *= g; im[b3] *= g;
        var mirror = fftSize - b3;
        re[mirror] *= g; im[mirror] *= g;
      }
      // DC + Nyquist
      for (var bd = 0; bd < bins; bd += (bins - 1)) {
        var magd = Math.sqrt(re[bd] * re[bd] + im[bd] * im[bd]);
        var gd = Math.max(0, 1 - alpha * (noise[bd] || 1e-9) / (magd || 1e-9));
        gd = floorGain + (1 - floorGain) * gd;
        re[bd] *= gd; im[bd] *= gd;
      }
      ifft(re, im);
      for (var j = 0; j < fftSize && start3 + j < n; j++) {
        out[start3 + j] += re[j] * win[j];
        norm[start3 + j] += win[j] * win[j];
      }
      if (onProgress && (f3 % 40 === 0)) onProgress(f3 / numFrames);
    }
    for (var k = 0; k < n; k++) {
      out[k] = norm[k] > 1e-6 ? out[k] / norm[k] : 0;
    }
    // Edge fade: the STFT reconstruction divides by the (near-zero) window
    // at the very first/last samples, which can amplify leakage into a short
    // transient spike. A 10 ms fade on each edge removes it cleanly.
    var fade = Math.min(Math.floor(sampleRate * 0.01), Math.floor(n / 2));
    for (var fi = 0; fi < fade; fi++) {
      var fg = fi / fade;
      out[fi] *= fg;
      out[n - 1 - fi] *= fg;
    }
    return out;
  }

  function processChannels(channels, sampleRate, opts, onProgress) {
    opts = opts || {};
    var strength = Math.max(0, Math.min(1, Number(opts.strength) || 0.8));
    // `mix` is dry/wet: 0 = the original untouched, 1 = fully processed. The
    // guard used to read `Number(opts.mix) === 0 ? 1 : ...`, which mapped a
    // deliberate 0% straight to 100% — dragging Mix to fully dry gave fully
    // wet. Only a MISSING value should default to 1.
    var rawMix = Number(opts.mix);
    var mix = isFinite(rawMix) ? Math.max(0, Math.min(1, rawMix)) : 1;
    var out = [];
    var total = channels.length;
    channels.forEach(function (ch, idx) {
      var clean = denoiseChannel(ch, sampleRate, strength, function (p) {
        if (onProgress) onProgress((idx + p) / total);
      });
      if (mix < 1) {
        for (var i = 0; i < clean.length; i++) clean[i] = ch[i] * (1 - mix) + clean[i] * mix;
      }
      out.push(clean);
    });
    if (opts.normalize) normalizePeak(out);
    return out;
  }

  // Peak normalize to −1 dBFS (0.891), per spec Step 11.
  function normalizePeak(channels) {
    var peak = 0;
    channels.forEach(function (ch) {
      for (var i = 0; i < ch.length; i++) { var a = Math.abs(ch[i]); if (a > peak) peak = a; }
    });
    if (peak <= 0.00001) return;
    var gain = 0.891 / peak;
    channels.forEach(function (ch) { for (var i = 0; i < ch.length; i++) ch[i] *= gain; });
  }

  // ── High-level (browser-friendly) API ────────────────────────────────────
  function denoiseWavBuffer(inputBuffer, opts, onProgress) {
    var wav = decodeWav(inputBuffer);
    var clean = processChannels(wav.channels, wav.sampleRate, opts, onProgress);
    return encodeWav(clean, wav.sampleRate, opts.bitDepth === 16 ? 16 : 32);
  }

  // ── Native addon hook ────────────────────────────────────────────────────
  // `global.AudioNative` is set by ffmpegLocal.js when it can require the
  // compiled N-API addon (native/audio-addon/build/Release/orbit_audio.node).
  // Interface mirrors the C++ side: denoiseWav(inputPath, outputPath,
  // options) → { success, error }. `options` carries {strength, normalize,
  // onProgress}.
  function nativeAvailable() {
    return !!(global.AudioNative && typeof global.AudioNative.denoiseWav === 'function');
  }

  // ── Node-side convenience (only used inside CEP) ─────────────────────────
  // processFile(inputPath, outputPath, options, onProgress) — reads the
  // input WAV, runs the JS gate, writes the output WAV. The host adapter
  // (ffmpegLocal.js) calls this only when the native addon is unavailable.
  function processFile(inputPath, outputPath, opts, onProgress) {
    if (!HAS_NODE) return Promise.reject(new Error('processFile requires Node (CEP panel).'));
    var fs = require('fs');
    return new Promise(function (resolve, reject) {
      fs.readFile(inputPath, function (err, buf) {
        if (err) return reject(new Error('Cannot read ' + inputPath + ': ' + err.message));
        try {
          var outBuf = denoiseWavBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), opts, onProgress);
          fs.writeFile(outputPath, Buffer.from(outBuf), function (wErr) {
            if (wErr) return reject(new Error('Cannot write ' + outputPath + ': ' + wErr.message));
            resolve({ success: true, outputPath: outputPath });
          });
        } catch (e) {
          reject(new Error('Denoise failed: ' + e.message));
        }
      });
    });
  }

  // ── Public surface ───────────────────────────────────────────────────────
  global.AudioEngine = {
    decodeWav: decodeWav,
    encodeWav: encodeWav,
    denoiseChannel: denoiseChannel,
    processChannels: processChannels,
    denoiseWavBuffer: denoiseWavBuffer,
    normalizePeak: normalizePeak,
    nativeAvailable: nativeAvailable,
    processFile: processFile
  };

})(typeof window !== 'undefined' ? window : this);
