/**
 * motion-curves.js — easing curves and keyframe baking. Pure maths, no
 * Premiere API, so tests/motion-regression.cjs can exercise it directly.
 *
 * Why baking: Premiere's ExtendScript exposes no bezier handles on a clip's
 * effect keyframes. setInterpolationTypeAtKey only chooses Linear / Bezier /
 * Hold, and the handles behind Bezier can be neither read nor written. So a
 * real ease — let alone a bounce or an elastic — has to be written into the
 * VALUES: replace the span between two keys with many linear keys that trace
 * the curve. Easify does the same thing on this host.
 */
(function (global) {
  'use strict';

  function clamp01(t) { return t < 0 ? 0 : (t > 1 ? 1 : t); }

  // Every curve maps progress 0..1 to eased 0..1. Curves that overshoot
  // deliberately leave that range: back and elastic go below 0 / above 1, which
  // is what makes them read as anticipation and snap.
  var SHAPES = {
    linear: function (t) { return t; },
    sine: function (t) { return 1 - Math.cos(t * Math.PI / 2); },
    quad: function (t) { return t * t; },
    cubic: function (t) { return t * t * t; },
    quart: function (t) { return t * t * t * t; },
    quint: function (t) { return t * t * t * t * t; },
    expo: function (t) { return t === 0 ? 0 : Math.pow(2, 10 * t - 10); },
    circ: function (t) { return 1 - Math.sqrt(Math.max(0, 1 - t * t)); },
    back: function (t, amount) {
      var s = 1.70158 * (amount === undefined ? 1 : amount);
      return t * t * ((s + 1) * t - s);
    },
    // amount tightens the period, so a higher strength wobbles more times
    // rather than louder. Amplitude is left alone: scaling it would break the
    // f(1) === 1 endpoint that every curve here has to keep.
    elastic: function (t, amount) {
      if (t === 0 || t === 1) return t;
      var period = 0.3 / Math.max(0.4, Math.min(2, amount === undefined ? 1 : amount));
      return -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * (2 * Math.PI) / period);
    }
  };

  // Bounce is defined as an ease-OUT (the classic four-segment curve) and
  // mirrored for the other directions. `decay` says how pronounced the bounces
  // are: 1 is the full classic curve, lower values settle sooner. It blends
  // toward a plain ease-out rather than scaling the curve, because scaling it
  // moved f(0) off zero — the clip would jump before it started moving.
  function bounceOut(t, decay) {
    var d = (decay === undefined || decay === null) ? 1 : Math.max(0, Math.min(1, decay));
    var n = 7.5625, s = 2.75, v, x = t;
    if (x < 1 / s) v = n * x * x;
    else if (x < 2 / s) { x -= 1.5 / s; v = n * x * x + 0.75; }
    else if (x < 2.5 / s) { x -= 2.25 / s; v = n * x * x + 0.9375; }
    else { x -= 2.625 / s; v = n * x * x + 0.984375; }
    var settled = 1 - (1 - t) * (1 - t);
    return settled + (v - settled) * d;
  }

  /**
   * Builds an easing function.
   * @param {string} shape  linear|sine|quad|cubic|quart|quint|expo|circ|back|elastic|bounce
   * @param {string} dir    in|out|inOut
   * @param {number} strength 0..1 — blends the curve against linear, so 0 is a
   *                  straight line and 1 is the full curve.
   * @param {number} decay  bounce only, 0.05..1
   */
  function easing(shape, dir, strength, decay) {
    var amount = (strength === undefined || strength === null) ? 1 : Math.max(0, Math.min(2, strength));
    var base;
    if (shape === 'bounce') {
      base = function (t) {
        if (dir === 'in') return 1 - bounceOut(1 - t, decay);
        if (dir === 'inOut') return t < 0.5
          ? (1 - bounceOut(1 - 2 * t, decay)) / 2
          : (1 + bounceOut(2 * t - 1, decay)) / 2;
        return bounceOut(t, decay);
      };
    } else {
      var fn = SHAPES[shape] || SHAPES.cubic;
      base = function (t) {
        if (dir === 'out') return 1 - fn(1 - t, amount);
        if (dir === 'inOut') return t < 0.5 ? fn(2 * t, amount) / 2 : 1 - fn(2 - 2 * t, amount) / 2;
        return fn(t, amount);
      };
    }
    // Every shape here satisfies f(0)=0 and f(1)=1, so blending against a
    // straight line preserves the endpoints and scales the character of the
    // curve. That makes strength mean one thing everywhere: 0 is linear, 1 is
    // the full curve. Above 1 the extra goes to `amount`, which widens back's
    // overshoot and tightens elastic's period rather than moving the ends.
    var blend = Math.max(0, Math.min(1, amount));
    return function (t) {
      var e = base(clamp01(t));
      return t + (e - t) * blend;
    };
  }

  function lerp(a, b, k) { return a + (b - a) * k; }

  // Values arriving from Premiere are either numbers or arrays (Position is
  // [x,y], colours are [a,r,g,b]). Interpolate component-wise and keep the
  // original shape so it can be written straight back.
  function mixValue(from, to, k) {
    if (from && from.length !== undefined && typeof from !== 'string') {
      var out = [], n = Math.min(from.length, to && to.length !== undefined ? to.length : from.length);
      for (var i = 0; i < n; i++) out.push(lerp(Number(from[i]) || 0, Number(to[i]) || 0, k));
      return out;
    }
    return lerp(Number(from) || 0, Number(to) || 0, k);
  }

  var MAX_KEYS = 600;

  /**
   * Bakes one eased span into concrete keyframes.
   * @param {object} span {from:{t,v}, to:{t,v}}
   * @param {object} opts {shape, dir, strength, decay, fps, intervalFrames}
   * @returns {{keys:Array, from:number, to:number, dropped:boolean}}
   */
  function bakeSpan(span, opts) {
    opts = opts || {};
    var fps = Number(opts.fps) > 0 ? Number(opts.fps) : 30;
    var step = Math.max(1, Math.round(Number(opts.intervalFrames) || 1)) / fps;
    var t0 = Number(span.from.t), t1 = Number(span.to.t);
    if (!(t1 > t0)) return { keys: [], from: t0, to: t1, dropped: true };
    var ease = easing(opts.shape, opts.dir, opts.strength, opts.decay);
    var count = Math.floor((t1 - t0) / step);
    var dropped = false;
    if (count > MAX_KEYS) { count = MAX_KEYS; step = (t1 - t0) / count; dropped = true; }
    var keys = [{ t: t0, v: span.from.v }];
    for (var i = 1; i < count; i++) {
      var t = t0 + step * i;
      keys.push({ t: t, v: mixValue(span.from.v, span.to.v, ease((t - t0) / (t1 - t0))) });
    }
    keys.push({ t: t1, v: span.to.v });
    return { keys: keys, from: t0, to: t1, dropped: dropped };
  }

  /**
   * Bakes every consecutive pair in a key list. `values` must line up with
   * `times`; both come from the host inspection call.
   */
  function bakeSeries(times, values, opts) {
    var out = [];
    for (var i = 0; i < times.length - 1; i++) {
      var span = bakeSpan({ from: { t: times[i], v: values[i] }, to: { t: times[i + 1], v: values[i + 1] } }, opts);
      // Drop the duplicated boundary key so spans join cleanly.
      out = out.concat(i === 0 ? span.keys : span.keys.slice(1));
    }
    return out;
  }

  var SHAPE_LIST = ['linear', 'sine', 'quad', 'cubic', 'quart', 'quint', 'expo', 'circ', 'back', 'elastic', 'bounce'];

  global.MotionCurves = {
    easing: easing,
    bakeSpan: bakeSpan,
    bakeSeries: bakeSeries,
    mixValue: mixValue,
    shapes: SHAPE_LIST,
    MAX_KEYS: MAX_KEYS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.MotionCurves;
}(typeof window !== 'undefined' ? window : globalThis));
