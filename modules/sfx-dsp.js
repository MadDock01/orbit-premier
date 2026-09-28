/**
 * sfx-dsp.js — offline audio processing for the SFX library. Pure maths on
 * Float32 channel arrays, no Web Audio and no Premiere API, so
 * tests/sfx-regression.cjs can exercise every path directly.
 *
 * Everything here works on a "clip": { sampleRate, channels: [Float32Array...] }.
 * Samples are nominally -1..1; nothing clamps until encodeWav, so an
 * intermediate stage may exceed that range without losing information.
 */
(function (global) {
  'use strict';

  function clip(sampleRate, channels) { return { sampleRate: sampleRate, channels: channels }; }
  function lengthOf(c) { return c.channels.length ? c.channels[0].length : 0; }
  function mapChannels(c, fn) { return clip(c.sampleRate, c.channels.map(fn)); }

  function slice(c, fromSample, toSample) {
    var a = Math.max(0, Math.min(lengthOf(c), Math.round(fromSample)));
    var b = Math.max(a, Math.min(lengthOf(c), Math.round(toSample)));
    return mapChannels(c, function (ch) { return ch.slice(a, b); });
  }

  function gain(c, db) {
    if (!db) return mapChannels(c, function (ch) { return ch.slice(); });
    var k = Math.pow(10, db / 20);
    return mapChannels(c, function (ch) {
      var out = new Float32Array(ch.length);
      for (var i = 0; i < ch.length; i++) out[i] = ch[i] * k;
      return out;
    });
  }

  function reverse(c) {
    return mapChannels(c, function (ch) {
      var out = new Float32Array(ch.length), n = ch.length;
      for (var i = 0; i < n; i++) out[i] = ch[n - 1 - i];
      return out;
    });
  }

  function peak(c) {
    var p = 0;
    for (var ci = 0; ci < c.channels.length; ci++) {
      var ch = c.channels[ci];
      for (var i = 0; i < ch.length; i++) { var v = Math.abs(ch[i]); if (v > p) p = v; }
    }
    return p;
  }

  // Peak normalisation to a target in dBFS. Scales every channel by the SAME
  // factor so the stereo image does not shift.
  function normalize(c, targetDb) {
    var p = peak(c);
    if (!(p > 0)) return mapChannels(c, function (ch) { return ch.slice(); });
    var target = Math.pow(10, (targetDb === undefined ? -1 : targetDb) / 20);
    return gain(c, 20 * Math.log10(target / p));
  }

  // Equal-power fades: a linear ramp on amplitude sounds like it dips in the
  // middle, which is very audible on a short SFX tail.
  function fade(c, inMs, outMs) {
    var n = lengthOf(c), sr = c.sampleRate;
    var fi = Math.max(0, Math.min(n, Math.round((inMs || 0) / 1000 * sr)));
    var fo = Math.max(0, Math.min(n - fi, Math.round((outMs || 0) / 1000 * sr)));
    return mapChannels(c, function (ch) {
      var out = ch.slice(), i, k;
      for (i = 0; i < fi; i++) { k = i / fi; out[i] *= Math.sin(k * Math.PI / 2); }
      for (i = 0; i < fo; i++) { k = i / fo; out[n - 1 - i] *= Math.sin(k * Math.PI / 2); }
      return out;
    });
  }

  // Catmull-Rom resampling. `ratio` is output length / input length: 0.5 makes
  // it half as long, so it plays twice as fast AND an octave up. Linear
  // interpolation was audibly gritty on pitched material, cubic is not.
  function resample(c, ratio) {
    if (!(ratio > 0)) return mapChannels(c, function (ch) { return ch.slice(); });
    var n = lengthOf(c), outLen = Math.max(1, Math.round(n * ratio));
    return mapChannels(c, function (ch) {
      var out = new Float32Array(outLen);
      for (var i = 0; i < outLen; i++) {
        var pos = i / ratio, i1 = Math.floor(pos), t = pos - i1;
        var p0 = ch[Math.max(0, i1 - 1)], p1 = ch[Math.min(n - 1, i1)];
        var p2 = ch[Math.min(n - 1, i1 + 1)], p3 = ch[Math.min(n - 1, i1 + 2)];
        out[i] = 0.5 * ((2 * p1) + (-p0 + p2) * t +
          (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
          (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
      }
      return out;
    });
  }

  // Overlap-add time stretch with a cross-correlation search (WSOLA). Changes
  // duration WITHOUT moving pitch, which is what "lock pitch" needs: resampling
  // alone cannot separate the two. `ratio` is output length / input length.
  function timeStretch(c, ratio) {
    if (!(ratio > 0) || Math.abs(ratio - 1) < 1e-6) return mapChannels(c, function (ch) { return ch.slice(); });
    var sr = c.sampleRate, n = lengthOf(c);
    var frame = Math.max(128, Math.round(0.040 * sr));      // ~40ms
    var synthHop = Math.round(frame / 4);
    var analysisHop = Math.round(synthHop / ratio);
    var search = Math.max(1, Math.round(synthHop / 2));
    var outLen = Math.max(1, Math.round(n * ratio));

    var window = new Float32Array(frame);
    for (var w = 0; w < frame; w++) window[w] = 0.5 - 0.5 * Math.cos(2 * Math.PI * w / (frame - 1));

    // The alignment offset is chosen on the FIRST channel and reused for the
    // rest, otherwise the channels drift apart and the stereo image smears.
    var ref = c.channels[0];
    var outs = c.channels.map(function () { return new Float32Array(outLen + frame); });
    var norm = new Float32Array(outLen + frame);

    var analysis = 0, synth = 0, prevEnd = null;
    while (synth < outLen && analysis + frame < n) {
      var offset = 0;
      if (prevEnd) {
        var best = -Infinity;
        for (var s = -search; s <= search; s++) {
          var start = analysis + s;
          if (start < 0 || start + prevEnd.length >= n) continue;
          var acc = 0;
          for (var k = 0; k < prevEnd.length; k += 2) acc += ref[start + k] * prevEnd[k];
          if (acc > best) { best = acc; offset = s; }
        }
      }
      var from = Math.max(0, Math.min(n - frame, analysis + offset));
      for (var ci = 0; ci < c.channels.length; ci++) {
        var src = c.channels[ci], dst = outs[ci];
        for (var i = 0; i < frame; i++) dst[synth + i] += src[from + i] * window[i];
      }
      for (var j = 0; j < frame; j++) norm[synth + j] += window[j];
      prevEnd = ref.slice(from + synthHop, from + synthHop + search);
      analysis += analysisHop;
      synth += synthHop;
    }

    return clip(sr, outs.map(function (dst) {
      var out = new Float32Array(outLen);
      for (var i = 0; i < outLen; i++) out[i] = norm[i] > 1e-6 ? dst[i] / norm[i] : dst[i];
      return out;
    }));
  }

  /**
   * Applies the whole rack in a fixed order. Order matters: trim, then reverse,
   * then rate, then gain, then fades, then normalise last so nothing after it
   * can push the peak back over.
   * @param {object} c    clip
   * @param {object} opts {semitones, speed, lockPitch, reverse, gainDb, fadeInMs, fadeOutMs, normalize, normalizeDb}
   */
  function process(c, opts) {
    opts = opts || {};
    var out = mapChannels(c, function (ch) { return ch.slice(); });
    if (opts.reverse) out = reverse(out);

    var semis = Number(opts.semitones) || 0;
    var speed = Number(opts.speed) > 0 ? Number(opts.speed) : 1;
    var pitchRatio = Math.pow(2, semis / 12);

    if (opts.lockPitch) {
      // Resampling is the only thing that moves pitch, but it drags duration
      // with it, so the stretch afterwards has to undo THAT as well as apply
      // `speed`: target length is source/speed, and the resample already made
      // it source/pitchRatio. Compensating only when speed !== 1 left a pure
      // pitch shift half as long as the source.
      if (semis) out = resample(out, 1 / pitchRatio);
      var stretch = pitchRatio / speed;
      if (Math.abs(stretch - 1) > 1e-9) out = timeStretch(out, stretch);
    } else {
      // Linked, like a tape machine: one resample carries both.
      var ratio = 1 / (pitchRatio * speed);
      if (Math.abs(ratio - 1) > 1e-9) out = resample(out, ratio);
    }

    if (opts.gainDb) out = gain(out, Number(opts.gainDb));
    if (opts.fadeInMs || opts.fadeOutMs) out = fade(out, opts.fadeInMs, opts.fadeOutMs);
    if (opts.normalize) out = normalize(out, opts.normalizeDb === undefined ? -1 : opts.normalizeDb);
    return out;
  }

  /** Min/max pairs per bucket, for drawing a waveform without reading every sample. */
  function peaks(channel, buckets) {
    var out = new Float32Array(buckets * 2), step = channel.length / buckets;
    for (var b = 0; b < buckets; b++) {
      var from = Math.floor(b * step), to = Math.min(channel.length, Math.floor((b + 1) * step));
      var lo = 0, hi = 0;
      for (var i = from; i < to; i++) { var v = channel[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      out[b * 2] = lo; out[b * 2 + 1] = hi;
    }
    return out;
  }

  /**
   * 24-bit PCM WAV. 24-bit rather than 16 because normalising to -1 dBFS and
   * then fading leaves very low-level tails that 16-bit would quantise audibly;
   * rather than 32-bit float because some importers still refuse float WAVs.
   */
  function encodeWav(c) {
    var chans = c.channels, numCh = chans.length, n = lengthOf(c);
    var bytesPerSample = 3, blockAlign = numCh * bytesPerSample;
    var dataBytes = n * blockAlign;
    var buffer = new ArrayBuffer(44 + dataBytes), view = new DataView(buffer);
    function str(off, s) { for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
    str(12, 'fmt '); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);                       // PCM
    view.setUint16(22, numCh, true);
    view.setUint32(24, c.sampleRate, true);
    view.setUint32(28, c.sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 8 * bytesPerSample, true);
    str(36, 'data'); view.setUint32(40, dataBytes, true);

    var off = 44, MAX = 8388607;
    for (var i = 0; i < n; i++) {
      for (var ch = 0; ch < numCh; ch++) {
        var v = chans[ch][i];
        v = v > 1 ? 1 : (v < -1 ? -1 : v);             // clamp only at the edge
        var s = Math.round(v * MAX);
        view.setUint8(off, s & 0xff);
        view.setUint8(off + 1, (s >> 8) & 0xff);
        view.setUint8(off + 2, (s >> 16) & 0xff);
        off += 3;
      }
    }
    return buffer;
  }

  global.SfxDsp = {
    clip: clip, lengthOf: lengthOf, slice: slice,
    gain: gain, reverse: reverse, normalize: normalize, peak: peak, fade: fade,
    resample: resample, timeStretch: timeStretch, process: process,
    peaks: peaks, encodeWav: encodeWav
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.SfxDsp;
}(typeof window !== 'undefined' ? window : globalThis));
