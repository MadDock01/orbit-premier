/**
 * beat-engine.js — Beat Sync Engine core.
 *
 * PURE JavaScript — no Premiere/FFmpeg calls. Takes a mono Float32Array
 * (from FFmpegAPI.decodePcm) and returns a tempo + beat grid:
 *
 *   1. Short-time energy per frame (rectangular window, ~64 ms hop)
 *   2. Onset envelope = positive half-wave energy difference, smoothed
 *   3. Autocorrelation over the 60–200 BPM lag range → tempo
 *      (with a mild preference for typical musical tempos ~100–140 BPM
 *       so octave ties resolve toward the musical answer)
 *   4. Beat grid anchored at the strongest onset, phase-refined
 *   5. Per-beat strength = normalized onset energy at that beat
 */
(function (global) {
  'use strict';

  function analyzeBeats(samples, sampleRate, opts) {
    opts = opts || {};
    var frameSize = opts.frameSize || 256;
    var frameHop  = opts.frameHop  || 256;   // non-overlapping 32 ms frames
                                             // @ 8 kHz: each sample belongs to
                                             // exactly one frame, so a click's
                                             // energy jump lands in the frame
                                             // that CONTAINS its start — onset
                                             // localization stays within one
                                             // 32 ms frame instead of spreading
    var bpmMin = opts.bpmMin || 60;
    var bpmMax = opts.bpmMax || 200;
    var duration = samples.length / sampleRate;

    if (samples.length < sampleRate * 0.5) {
      return { bpm: 0, beatPeriod: 0, beats: [], duration: duration };
    }

    // 1) Short-time energy per frame
    var frames = [];
    var i;
    for (i = 0; i + frameSize <= samples.length; i += frameHop) {
      var e = 0;
      for (var j = i; j < i + frameSize; j++) e += samples[j] * samples[j];
      frames.push(e / frameSize);
    }
    if (frames.length < 8) return { bpm: 0, beatPeriod: 0, beats: [], duration: duration };

    // 2) Onset envelope (positive diff, 3-tap smoothed)
    var diff = new Array(frames.length);
    diff[0] = 0;
    for (var k = 1; k < frames.length; k++) {
      var d = frames[k] - frames[k - 1];
      diff[k] = d > 0 ? d : 0;
    }
    var env = new Array(diff.length);
    for (var m = 0; m < diff.length; m++) {
      var a = m > 0 ? diff[m - 1] : 0;
      var c = m + 1 < diff.length ? diff[m + 1] : 0;
      env[m] = (a + diff[m] + c) / 3;
    }

    var onsetPeak = 0;
    for (var peakIndex = 0; peakIndex < diff.length; peakIndex++) onsetPeak = Math.max(onsetPeak, diff[peakIndex]);
    if (!(onsetPeak > 1e-12)) return { bpm: 0, beatPeriod: 0, beats: [], duration: duration };
    var frameDur = frameHop / sampleRate;
    var framesPerSec = 1 / frameDur;

    // 3) Autocorrelation over lag range → tempo.
    var lagMin = Math.max(2, Math.round(framesPerSec * 60 / bpmMax));
    var lagMax = Math.min(env.length - 1, Math.round(framesPerSec * 60 / bpmMin));
    function bpmOfLag(lag) { return 60 / (lag / framesPerSec); }

    // Fractional-lag autocorrelation with linear envelope interpolation, so
    // scores stay accurate between integer frames (a real period rarely lands
    // on the 32 ms grid). A mild musical-tempo preference (bell centered
    // ~118 BPM) breaks near-ties toward the musical answer.
    function envAt(x) {
      if (x < 0) return 0;
      var i = Math.floor(x);
      if (i >= env.length - 1) return 0;
      var f = x - i;
      return env[i] * (1 - f) + env[i + 1] * f;
    }
    function acScore(lag) {
      if (lag < 1 || lag >= env.length) return 0;
      var s = 0, cnt = 0;
      for (var t = 0; t + lag < env.length; t++) { s += env[t] * envAt(t + lag); cnt++; }
      if (!cnt) return 0;
      var bpm = bpmOfLag(lag);
      return (s / cnt) * (1 + 0.2 * Math.exp(-Math.pow((bpm - 122) / 55, 2)));
    }

    var bestLag = 0;
    var bestScore = -1;
    for (var lag = lagMin; lag <= lagMax; lag++) {
      var sc = acScore(lag);
      if (sc > bestScore) { bestScore = sc; bestLag = lag; }
    }

    // Parabolic interpolation around the integer peak → fractional lag.
    var refinedLag = bestLag;
    var y0 = acScore(bestLag - 1), y1 = acScore(bestLag), y2 = acScore(bestLag + 1);
    var denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) > 1e-12) {
      var delta = 0.5 * (y0 - y2) / denom;
      if (Math.abs(delta) < 1) refinedLag = bestLag + delta;
    }

    // Octave resolution: the autocorrelation sees every harmonic of the true
    // period, so the peak can land on a half/double tempo. Compare the three
    // octave candidates and keep the FASTEST one whose score is within 6% of
    // the best — a genuinely slow track scores clearly worse at double tempo
    // (no energy on the half-beats) and survives.
    var candidates = [refinedLag, refinedLag / 2, refinedLag * 2];
    var octBest = refinedLag, octBestScore = acScore(refinedLag);
    for (var ci = 0; ci < candidates.length; ci++) {
      if (candidates[ci] < lagMin || candidates[ci] > lagMax) continue;
      var sc2 = acScore(candidates[ci]);
      if (sc2 > octBestScore) { octBestScore = sc2; octBest = candidates[ci]; }
    }
    var winner = octBest;
    for (var cj = 0; cj < candidates.length; cj++) {
      var c = candidates[cj];
      if (c < lagMin || c > lagMax) continue;
      if (acScore(c) >= octBestScore * 0.94 && c < winner) winner = c;
    }
    refinedLag = winner;

    var bpm = refinedLag ? Math.round(bpmOfLag(refinedLag) * 10) / 10 : 0;
    if (!(bpm > 0)) return { bpm: 0, beatPeriod: 0, beats: [], duration: duration };

    var beatPeriodFrames = refinedLag;

    // 4) Grid-locked refinement. The raw autocorrelation peak is biased by
    //    the frame grid (triangular peak — a parabolic fit lands a hair off),
    //    which drifts the grid over a long track. Scan periods within ±8%
    //    of the estimate and score each by how well a grid anchored on the
    //    strongest onset lines up with the ONSET envelope. The smoothed `env`
    //    spreads its peak one frame backward (3-tap average), which would
    //    drag every beat ~half a frame early — so this phase uses the raw
    //    positive `diff` and only `env` for the tempo estimate above.
    var anchor = 0, anchorScore = -1;
    for (var q = 0; q < diff.length; q++) {
      if (diff[q] > anchorScore) { anchorScore = diff[q]; anchor = q; }
    }
    var bestPeriod = refinedLag;
    var bestPhase = anchor;
    var bestGridScore = -1;
    var scanMin = refinedLag * 0.92;
    var scanMax = refinedLag * 1.08;
    var STEPS = 80, PHASES = 8;
    for (var si = 0; si <= STEPS; si++) {
      var cand = scanMin + (scanMax - scanMin) * si / STEPS;
      if (cand < 2) continue;
      for (var ph = 0; ph < PHASES; ph++) {
        var first = anchor - cand * Math.ceil(anchor / cand) + ph * cand / PHASES;
        var score = 0, count = 0;
        for (var bt = first; bt < diff.length; bt += cand) {
          var idx = Math.round(bt);
          if (idx >= 0 && idx < diff.length) { score += diff[idx]; count++; }
        }
        if (count && score / count > bestGridScore) { bestGridScore = score / count; bestPeriod = cand; bestPhase = first; }
      }
    }
    if (bestGridScore > 0) {
      refinedLag = bestPeriod;
      bpm = Math.round(bpmOfLag(refinedLag) * 10) / 10;
    }
    var beatPeriodFrames = refinedLag;

    // 5) Beat list with normalized strength
    var maxEnv = 0;
    for (var e2 = 0; e2 < env.length; e2++) if (env[e2] > maxEnv) maxEnv = env[e2];
    if (maxEnv <= 0) maxEnv = 1;
    var beats = [];
    for (var bt2 = bestPhase; bt2 < env.length; bt2 += beatPeriodFrames) {
      var tSec = bt2 * frameDur;              // fractional — no frame snapping
      if (tSec < 0) continue;
      var idx2 = Math.round(bt2);             // strength readout may snap
      var strength = idx2 >= 0 && idx2 < env.length ? env[idx2] / maxEnv : 0;
      beats.push({ t: tSec, strength: Math.max(0, Math.min(1, strength)) });
    }

    return {
      bpm: bpm,
      beatPeriod: beatPeriodFrames * frameDur,
      beats: beats,
      duration: duration
    };
  }

  /**
   * Sample the beat grid for the action list.
   * opts: { interval (1|2|4), strength (0..100) }
   * Higher strength = keep only the loudest beats; 100 = keep every beat.
   */
  function filterBeats(beats, opts) {
    opts = opts || {};
    var interval = opts.interval || 1;
    var strength = opts.strength == null ? 0 : opts.strength;
    var minStrength = 0.45 * (1 - strength / 100) + 0.02;
    var out = [];
    for (var i = 0; i < beats.length; i++) {
      if (i % interval !== 0) continue;
      if (beats[i].strength < minStrength) continue;
      out.push({ t: beats[i].t, strength: beats[i].strength });
    }
    return out;
  }

  // Separate transient detector for speech consonants and percussion hits.
  function detectOnsets(samples, sampleRate, opts) {
    opts = opts || {};
    var frameSize = opts.frameSize || 256;
    var hop = opts.frameHop || 256;
    var energy = [], i, j;
    for (i = 0; i + frameSize <= samples.length; i += hop) {
      var e = 0;
      for (j = i; j < i + frameSize; j++) e += samples[j] * samples[j];
      energy.push(e / frameSize);
    }
    var env = new Array(energy.length), maxEnv = 0;
    env[0] = 0;
    for (i = 1; i < energy.length; i++) {
      env[i] = Math.max(0, energy[i] - energy[i - 1]);
      if (env[i] > maxEnv) maxEnv = env[i];
    }
    if (!maxEnv) return [];
    var frameDur = hop / sampleRate;
    var refractory = Math.max(1, Math.round(0.065 / frameDur));
    var last = -refractory;
    var out = [];
    for (i = 2; i < env.length - 2; i++) {
      var sum = 0, count = 0;
      var from = Math.max(0, i - 10), to = Math.min(env.length - 1, i + 10);
      for (j = from; j <= to; j++) {
        if (Math.abs(j - i) <= 1) continue;
        sum += env[j]; count++;
      }
      var localMean = count ? sum / count : 0;
      if (env[i] >= env[i - 1] && env[i] > env[i + 1] &&
          env[i] > localMean * 1.45 + maxEnv * 0.012) {
        var strength = Math.max(0, Math.min(1, env[i] / maxEnv));
        if (i - last < refractory && out.length) {
          if (strength > out[out.length - 1].strength) {
            out[out.length - 1] = { t: i * frameDur, strength: strength, type: 'onset' };
            last = i;
          }
        } else {
          out.push({ t: i * frameDur, strength: strength, type: 'onset' });
          last = i;
        }
      }
    }
    return out;
  }

  var analyzeTempoGrid = analyzeBeats;
  function analyzeBeatAndOnset(samples, sampleRate, opts) {
    var result = analyzeTempoGrid(samples, sampleRate, opts);
    result.onsets = detectOnsets(samples, sampleRate, opts);
    result.offset = result.beats && result.beats.length ? result.beats[0].t : 0;
    for (var i = 0; i < result.beats.length; i++) result.beats[i].type = 'beat';
    return result;
  }

  function nearestStrength(time, list) {
    if (!list || !list.length) return 0.5;
    var best = list[0], distance = Math.abs(best.t - time);
    for (var i = 1; i < list.length; i++) {
      var d = Math.abs(list[i].t - time);
      if (d < distance) { best = list[i]; distance = d; }
      if (list[i].t > time && d > distance) break;
    }
    return best.strength == null ? 0.5 : best.strength;
  }

  function buildBeatGrid(bpm, offset, duration, sourceBeats) {
    bpm = Number(bpm);
    duration = Math.max(0, Number(duration) || 0);
    offset = Number(offset) || 0;
    if (!(bpm > 0) || !duration) return [];
    var period = 60 / bpm;
    var first = offset;
    while (first > 0) first -= period;
    while (first + period <= 0) first += period;
    var out = [];
    for (var t = first; t <= duration + 0.0001; t += period) {
      if (t >= 0) out.push({ t: t, strength: nearestStrength(t, sourceBeats), type: 'beat' });
    }
    return out;
  }

  function seededRandom(seed) {
    var x = (Number(seed) || 1) >>> 0;
    return function () {
      x += 0x6D2B79F5;
      var t = x;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function selectEvents(analysis, opts) {
    analysis = analysis || { bpm: 0, duration: 0, beats: [], onsets: [] };
    opts = opts || {};
    var bpm = Number(opts.bpm) || Number(analysis.bpm) || 0;
    var offset = opts.offset == null ? (Number(analysis.offset) || 0) : (Number(opts.offset) || 0);
    var base = buildBeatGrid(bpm, offset, analysis.duration, analysis.beats);
    var subdivisions = Math.max(1, parseInt(opts.subdivisions, 10) || 1);
    var events = [], i, s;
    for (i = 0; i < base.length; i++) {
      events.push(base[i]);
      if (subdivisions > 1 && i + 1 < base.length) {
        var gap = (base[i + 1].t - base[i].t) / subdivisions;
        for (s = 1; s < subdivisions; s++) {
          var st = base[i].t + gap * s;
          events.push({ t: st, strength: nearestStrength(st, analysis.onsets), type: 'subdivision' });
        }
      }
    }
    if (opts.includeOnsets) {
      for (i = 0; i < (analysis.onsets || []).length; i++) events.push(analysis.onsets[i]);
    }
    events.sort(function (a, b) { return a.t - b.t || (a.type === 'beat' ? -1 : 1); });

    var deduped = [];
    for (i = 0; i < events.length; i++) {
      var prev = deduped.length ? deduped[deduped.length - 1] : null;
      if (prev && Math.abs(events[i].t - prev.t) < 0.025) {
        if (events[i].type === 'onset' && events[i].strength > prev.strength) {
          prev.strength = events[i].strength;
          prev.hasOnset = true;
        }
      } else deduped.push({ t: events[i].t, strength: events[i].strength, type: events[i].type });
    }

    var everyNth = Math.max(1, parseInt(opts.everyNth, 10) || 1);
    var strength = opts.strength == null ? 100 : Math.max(0, Math.min(100, Number(opts.strength)));
    var minStrength = 0.45 * (1 - strength / 100) + 0.02;
    var candidates = [];
    for (i = 0; i < deduped.length; i++) {
      if (i % everyNth === 0 && deduped[i].strength >= minStrength) candidates.push(deduped[i]);
    }

    var amount = Math.max(0, Math.min(100, opts.amount == null ? 100 : Number(opts.amount)));
    var chaos = Math.max(0, Math.min(100, opts.chaos == null ? 0 : Number(opts.chaos))) / 100;
    var wanted = Math.round(candidates.length * amount / 100);
    var rng = seededRandom(opts.seed);
    var ranked = candidates.map(function (event, index) {
      return { event: event, index: index, rank: (1 - event.strength) * (1 - chaos) + rng() * chaos };
    });
    ranked.sort(function (a, b) { return a.rank - b.rank || a.index - b.index; });
    var chosen = ranked.slice(0, wanted).map(function (row) { return row.event; });
    chosen.sort(function (a, b) { return a.t - b.t; });

    var minDistance = Math.max(0, Number(opts.minDistance) || 0);
    var selected = [];
    for (i = 0; i < chosen.length; i++) {
      if (!selected.length || chosen[i].t - selected[selected.length - 1].t >= minDistance - 0.0001) {
        selected.push({ t: chosen[i].t, strength: chosen[i].strength, type: chosen[i].type, selected: true });
      }
    }
    var selectedMap = {};
    for (i = 0; i < selected.length; i++) selectedMap[Math.round(selected[i].t * 1000)] = true;
    var all = deduped.map(function (event) {
      return {
        t: event.t,
        strength: event.strength,
        type: event.type,
        selected: !!selectedMap[Math.round(event.t * 1000)]
      };
    });
    return { all: all, selected: selected, bpm: bpm, offset: offset };
  }

  global.BeatEngine = {
    analyzeBeats: analyzeBeatAndOnset,
    detectOnsets: detectOnsets,
    buildBeatGrid: buildBeatGrid,
    selectEvents: selectEvents,
    filterBeats: filterBeats
  };
})(window);
