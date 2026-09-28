/**
 * punch-engine.js — Auto Punch / Smart Zoom engine core.
 *
 * PURE JavaScript — no Premiere / FFmpeg calls. Turns emphasis points into
 * a punch list and then into Motion-Scale keyframes:
 *
 *   transcript words ─┐
 *                      ├→ detectPoints → filter (threshold / gaps / pauses)
 *   volume peaks ──────┘                        ↓
 *                                      punch list [{t, zoom, reason}]
 *                                            ↓
 *                              buildScaleKeyframes → [{t, v}] (clip-relative s)
 *
 * The panel then maps those relative seconds onto each selected clip
 * (clip.start + t) and reuses the Motion Engine's keyframe adapter.
 */
(function (global) {
  'use strict';

  // ── Style presets ──────────────────────────────────────────────────────────
  // zoomLevels are ABSOLUTE percentages, cycled per punch (alternate mode).
  // minGapFrames is the minimum spacing between two punches at 30 fps —
  // the panel's Frequency slider scales it (Low ×1.6, Medium ×1.0, High ×0.6).
  var PRESETS = {
    subtle:  { label: 'Subtle',  zoomLevels: [104, 106],      durationFrames: 10, minGapFrames: 70 },
    youtube: { label: 'YouTube', zoomLevels: [107, 110],      durationFrames: 8,  minGapFrames: 45 },
    dynamic: { label: 'Dynamic', zoomLevels: [108, 112, 115], durationFrames: 6,  minGapFrames: 30 }
  };

  // Frequency slider → minGap multiplier (Low keeps punches apart, High packs them).
  var FREQ_SCALE = { low: 1.6, medium: 1.0, high: 0.6 };

  // ── Emphasis detection from transcript words ───────────────────────────────
  // words: [{ word, start, end, segIdx? }] with TIMELINE seconds (the shape
  // stored in localStorage['machicut_captions'].words).
  // Each word contributes its best single point; multiple reasons stack by
  // taking the max score.
  function detectWordPoints(words, opts) {
    opts = opts || {};
    var sentenceGap = opts.sentenceGap == null ? 0.55 : opts.sentenceGap;
    var pauseGap    = opts.pauseGap    == null ? 1.1  : opts.pauseGap;
    var keywordMin  = opts.keywordMin  == null ? 7    : opts.keywordMin;
    var longLen     = opts.longLen     == null ? 8    : opts.longLen;
    var points = [];
    if (!words || !words.length) return points;

    var prevEnd = null;
    var sentenceEnd = null;
    var i, w, gap, len, score, reason;

    for (i = 0; i < words.length; i++) {
      w = words[i];
      if (!w || !isFinite(w.start)) continue;
      var word = String(w.word || '').trim();
      if (!word) continue;
      var start = Number(w.start);
      var end   = Number(isFinite(w.end) ? w.end : start);
      if (end < start) end = start;
      gap = (prevEnd == null) ? 0 : (start - prevEnd);

      // Reset sentence tracker when a sentence clearly ended.
      if (sentenceEnd != null && start >= sentenceEnd) sentenceEnd = null;

      score = 0;
      reason = null;

      // 1) New sentence: first word, long gap, or punctuation right before.
      var prevWord = i > 0 ? String(words[i - 1].word || '').trim() : '';
      var prevEnds = /[.!?…:"]$/.test(prevWord) || (prevWord.length > 0 && /[.!?…:]$/.test(prevWord));
      if (sentenceEnd == null && (i === 0 || gap > sentenceGap || prevEnds)) {
        score = 0.8;
        reason = 'sentence_start';
        sentenceEnd = start + Math.max(0.25, (end - start) * 0.6);
      }

      // 2) Important word: long words, shouty ALL-CAPS, or emphasis punctuation.
      len = word.replace(/[^A-Za-z0-9\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF]/g, '').length;
      if (word.indexOf('!') >= 0 || (word === word.toUpperCase() && len >= 3 && /[A-Z]{3,}/.test(word))) {
        if (score < 0.9) { score = 0.9; reason = 'keyword'; }
      } else if (len >= keywordMin) {
        var kwScore = 0.75 + Math.min(0.15, (len - keywordMin) * 0.02);
        if (score < kwScore) { score = kwScore; reason = 'keyword'; }
      }

      // 3) Resume after a real pause — strong emphasis moment.
      if (gap > pauseGap) {
        if (score < 0.85) { score = 0.85; reason = 'pause_resume'; }
      }

      // 4) Long sentence: punch at the start of any very long run of words.
      //    (handled here so it can stack with sentence_start)
      if (i > 0 && score < 0.75) {
        var runLen = 1;
        for (var j = i - 1; j >= 0 && (start - Number(words[j].end || words[j].start)) < 0.4; j--) runLen++;
        if (runLen >= longLen) { score = 0.7; reason = 'long_sentence'; }
      }

      if (score > 0) {
        points.push({ time: start, score: Math.min(1, score), reason: reason });
      }
      prevEnd = end;
    }

    // Merge near-duplicate points (same timestamp from stacking rules).
    return dedupe(points);
  }

  // ── Emphasis detection from volume (RMS envelope) ──────────────────────────
  // samples: mono Float32Array (the panel feeds a decoded clip/track).
  // Returns local energy peaks above mean + σ, scored 0.7–1.0.
  function detectVolumePoints(samples, sampleRate, opts) {
    opts = opts || {};
    var win  = opts.window || 2048;
    var hop  = opts.hop    || 1024;
    if (!samples || samples.length < sampleRate * 0.4) return [];
    var rms = [];
    var i;
    for (i = 0; i + win <= samples.length; i += hop) {
      var sum = 0;
      for (var j = i; j < i + win; j++) sum += samples[j] * samples[j];
      rms.push(Math.sqrt(sum / win));
    }
    if (rms.length < 8) return [];

    // 3-tap smooth
    var env = rms.map(function (r, m) {
      return ((m > 0 ? rms[m - 1] : r) + r + (m + 1 < rms.length ? rms[m + 1] : r)) / 3;
    });

    var mean = 0;
    for (i = 0; i < env.length; i++) mean += env[i];
    mean /= env.length;
    var variance = 0;
    for (i = 0; i < env.length; i++) variance += (env[i] - mean) * (env[i] - mean);
    variance /= env.length;
    var std = Math.sqrt(variance);
    var floor = mean + 1.0 * std;
    var peak = mean + 3.0 * std;
    if (peak <= floor) return [];

    var points = [];
    for (i = 2; i < env.length - 2; i++) {
      if (env[i] > floor && env[i] >= env[i - 1] && env[i] >= env[i + 1]) {
        var rel = (env[i] - floor) / (peak - floor);
        points.push({
          time: i * hop / sampleRate,
          score: Math.min(1, 0.7 + 0.3 * Math.min(1, rel)),
          reason: 'volume'
        });
      }
    }
    return dedupe(points);
  }

  function dedupe(points) {
    if (!points.length) return points;
    var sorted = points.slice().sort(function (a, b) { return a.time - b.time; });
    var out = [sorted[0]];
    for (var i = 1; i < sorted.length; i++) {
      var prev = out[out.length - 1];
      if (sorted[i].time - prev.time < 0.08) {
        // Keep the higher-score point of the pair (or the earlier on a tie).
        if (sorted[i].score > prev.score) out[out.length - 1] = sorted[i];
      } else {
        out.push(sorted[i]);
      }
    }
    return out;
  }

  // ── Punch building ─────────────────────────────────────────────────────────
  // opts: {
  //   style ('subtle'|'youtube'|'dynamic'), frequency ('low'|'medium'|'high'),
  //   zoomAmount (base %, default 108), durationFrames (override, 0 = preset),
  //   minScore (0.75), avoidConsecutive (bool), respectPauses (bool),
  //   alternateZoom (bool), fps, words (optional, for pause awareness)
  // }
  function buildPunches(points, opts) {
    opts = opts || {};
    var preset = PRESETS[opts.style] || PRESETS.subtle;
    var fps = opts.fps || 30;
    var minScore = opts.minScore == null ? 0.75 : opts.minScore;
    var freqScale = FREQ_SCALE[opts.frequency] || 1.0;
    var minGap = (preset.minGapFrames * freqScale) / fps;
    var zoomBase = opts.zoomAmount == null ? 108 : Number(opts.zoomAmount);
    var levels = preset.zoomLevels.map(function (l) { return Math.round(100 + (l - 100) * zoomBase / 100); });
    var duration = (opts.durationFrames > 0) ? opts.durationFrames : preset.durationFrames;

    var words = opts.words || [];
    var cands = points.filter(function (p) { return p.score >= minScore; })
                      .sort(function (a, b) { return a.time - b.time; });

    var out = [];
    var zoomIdx = 0;
    var lastT = -Infinity;
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];

      // Respect pauses: never punch into a silent gap — the point must sit on
      // (or within 0.35 s of) an actual word when a transcript is available.
      if (opts.respectPauses && words.length) {
        var onWord = false;
        for (var w = 0; w < words.length; w++) {
          if (c.time >= Number(words[w].start) - 0.1 && c.time <= Number(words[w].end) + 0.35) { onWord = true; break; }
          if (Number(words[w].start) > c.time + 0.5) break;
        }
        if (!onWord) continue;
      }

      // Avoid consecutive: keep enough air between punches (prevents over-editing).
      if (opts.avoidConsecutive && (c.time - lastT) < minGap) continue;

      var zoom = opts.alternateZoom ? levels[zoomIdx % levels.length] : levels[0];
      // Crop-style pan: alternate the nudge direction per punch so the reframe
      // breathes instead of pushing one way. dir === null disables position.
      var pan = Number(opts.pan) || 0;
      var dir = pan > 0 ? ((zoomIdx % 2 === 0) ? { x: -pan, y: 0 } : { x: pan, y: 0 }) : null;
      out.push({ t: Math.round(c.time * 1000) / 1000, zoom: zoom, dir: dir, score: c.score, reason: c.reason });
      zoomIdx++;
      lastT = c.time;
    }
    return { punches: out, minGap: minGap, durationFrames: duration, levels: levels };
  }

  // ── Easing curves ──────────────────────────────────────────────────────────
  function easeOutCubic(p)    { return 1 - Math.pow(1 - p, 3); }
  function easeInOutCubic(p)  { return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; }

  // ── Scale + position keyframes from punches (clip-relative seconds) ────────
  // Pattern per punch: 100 → zoom (2f, eased-out = fast/snappy in) → hold →
  // 100 (3f, eased-in-out = gentle settle), plus an alternating position pan
  // (clip-relative px) riding the exact same ramps for a camera dolly feel.
  //
  // Returns { scale: [{t,v}], position: [{t,v:{x,y}}] } with t relative to the
  // CLIP START (the panel adds clip.start). position is [] when every punch
  // has dir === null (Pan = 0). Times clamp to [0, clipDuration].
  function buildPunchKeyframes(punches, fps, durationFrames, clipDuration, opts) {
    opts = opts || {};
    var ease = opts.ease !== false;          // false = raw linear ramps
    var inF = 2, outF = 3;
    var holdF = Math.max(1, (durationFrames || 10) - inF - outF);
    var dur = clipDuration || Infinity;
    var scale = [];
    var position = [];

    for (var i = 0; i < punches.length; i++) {
      var punch = punches[i];
      var rel = Math.max(0, Math.min(dur, punch.t));
      var start = Math.max(0, rel - inF / fps);
      var peak = Math.min(dur, start + inF / fps);
      var holdEnd = Math.min(dur, peak + holdF / fps);
      var end = Math.min(dur, holdEnd + outF / fps);
      if (end - start < 2 / fps) continue;         // clip too short for a punch

      var zoom = punch.zoom;
      var dir = punch.dir || null;
      function push(t, sv, ox, oy) {
        scale.push({ t: t, v: sv });
        if (dir) position.push({ t: t, v: { x: ox, y: oy } });
      }

      push(start, 100, 0, 0);
      if (ease && inF >= 2) {
        // Snappy in: fast start, decelerating into the zoom (ease-out).
        var pIn = easeOutCubic(1 / inF);
        push(start + 1 / fps, 100 + (zoom - 100) * pIn, dir ? dir.x * pIn : 0, dir ? dir.y * pIn : 0);
      }
      push(peak, zoom, dir ? dir.x : 0, dir ? dir.y : 0);
      if (holdEnd > peak) push(holdEnd, zoom, dir ? dir.x : 0, dir ? dir.y : 0);
      if (ease && outF >= 2) {
        // Gentle settle: ease-in-out back to 100.
        for (var k = 1; k < outF; k++) {
          var pOut = easeInOutCubic(k / outF);
          push(holdEnd + k / fps, zoom - (zoom - 100) * pOut, dir ? dir.x * (1 - pOut) : 0, dir ? dir.y * (1 - pOut) : 0);
        }
      }
      push(end, 100, 0, 0);
    }

    // Sort + dedupe timestamps (adjacent punches can collide at the same t —
    // later value wins).
    function settle(list) {
      list.sort(function (a, b) { return a.t - b.t; });
      var ded = [];
      for (var k2 = 0; k2 < list.length; k2++) {
        if (ded.length && Math.abs(ded[ded.length - 1].t - list[k2].t) < 0.001) {
          ded[ded.length - 1] = list[k2];
        } else {
          ded.push(list[k2]);
        }
      }
      return ded;
    }
    return { scale: settle(scale), position: settle(position) };
  }

  // Legacy alias — scale only.
  function buildScaleKeyframes(punches, fps, durationFrames, clipDuration, opts) {
    return buildPunchKeyframes(punches, fps, durationFrames, clipDuration, opts).scale;
  }

  global.PunchEngine = {
    presets: PRESETS,
    freqScale: FREQ_SCALE,
    detectWordPoints: detectWordPoints,
    detectVolumePoints: detectVolumePoints,
    buildPunches: buildPunches,
    buildPunchKeyframes: buildPunchKeyframes,
    buildScaleKeyframes: buildScaleKeyframes
  };
})(window);
