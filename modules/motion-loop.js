/**
 * motion-loop.js — keyframe looping. Pure maths, no Premiere API.
 *
 * This is After Effects' loopOut() / loopIn() for Premiere, which has no
 * expression engine at all. A loop unit (a run of keyframes) is repeated until
 * a target time, in one of three modes:
 *
 *   cycle     the unit's values repeat verbatim
 *   pingpong  the unit plays forward, then backward, then forward...
 *   offset    the unit's shape repeats but the net change accumulates, so the
 *             value keeps climbing instead of snapping back
 *
 * Direction 'in' is implemented by mirroring time, running the 'out' case and
 * mirroring back. Doing it that way means one code path carries the awkward
 * parts — the reversal in pingpong and the sign of the offset accumulation —
 * instead of two that have to agree.
 */
(function (global) {
  'use strict';

  var MAX_KEYS = 600;

  function isVector(v) { return v && v.length !== undefined && typeof v !== 'string'; }

  function addValue(a, b) {
    if (isVector(a)) {
      var out = [], n = Math.min(a.length, isVector(b) ? b.length : a.length);
      for (var i = 0; i < n; i++) out.push((Number(a[i]) || 0) + (Number(b[i]) || 0));
      return out;
    }
    return (Number(a) || 0) + (Number(b) || 0);
  }

  function subValue(a, b) {
    if (isVector(a)) {
      var out = [], n = Math.min(a.length, isVector(b) ? b.length : a.length);
      for (var i = 0; i < n; i++) out.push((Number(a[i]) || 0) - (Number(b[i]) || 0));
      return out;
    }
    return (Number(a) || 0) - (Number(b) || 0);
  }

  function scaleValue(v, k) {
    if (isVector(v)) {
      var out = [];
      for (var i = 0; i < v.length; i++) out.push((Number(v[i]) || 0) * k);
      return out;
    }
    return (Number(v) || 0) * k;
  }

  function copyValue(v) { return isVector(v) ? v.slice() : v; }

  // Builds the loop forwards from the end of the unit. Callers never invoke
  // this directly for 'in' — see loopOut()'s mirror below.
  function buildOut(times, values, type, until, maxKeys, epsilon) {
    var n = times.length;
    var first = times[0], last = times[n - 1];
    var span = last - first;
    var keys = [], capped = false, cycles = 0;
    if (!(span > 0) || !(until > last)) return { keys: keys, cycles: 0, capped: false };

    var delta = subValue(values[n - 1], values[0]);
    // Offsets of each key from the start of the unit, and the same reversed so
    // pingpong's return leg is a genuine mirror rather than a re-sort.
    var fwd = [], rev = [], i;
    for (i = 0; i < n; i++) fwd.push({ dt: times[i] - first, v: values[i] });
    for (i = 0; i < n; i++) rev.push({ dt: last - times[n - 1 - i], v: values[n - 1 - i] });

    var rep = 1;
    while (true) {
      var anchor = last + span * (rep - 1);
      if (anchor > until) break;
      var unit = (type === 'pingpong' && rep % 2 === 1) ? rev : fwd;
      var bump = null;
      if (type === 'offset') bump = scaleValue(delta, rep);
      else if (type === 'pingpong') {
        // A forward leg after a return leg starts from the unit's first value
        // again, so nothing accumulates; the value only ever travels between
        // the unit's own extremes.
        bump = null;
      }
      var wroteAny = false;
      // Index 0 lands exactly on the anchor, where the previous repetition's
      // last key already sits. For pingpong and offset that key carries the
      // same value, so skipping it is right. A CYCLE, though, snaps back to
      // the unit's first value there — skip it and the loop degenerates into
      // a flat hold. Premiere cannot stack two keys on one frame, so the reset
      // goes one frame later, which is the closest a keyframe can get to the
      // instantaneous jump loopOut("cycle") makes in After Effects.
      if (type === 'cycle' && epsilon > 0 && epsilon < unit[1].dt) {
        var resetT = anchor + epsilon;
        if (resetT <= until + 1e-9) {
          keys.push({ t: resetT, v: copyValue(unit[0].v) });
          wroteAny = true;
          if (keys.length >= maxKeys) capped = true;
        }
      }
      for (i = 1; !capped && i < unit.length; i++) {
        var t = anchor + unit[i].dt;
        if (t > until + 1e-9) break;
        var v = copyValue(unit[i].v);
        if (bump) v = addValue(v, bump);
        keys.push({ t: t, v: v });
        wroteAny = true;
        if (keys.length >= maxKeys) { capped = true; break; }
      }
      if (wroteAny) cycles++;
      if (capped || !wroteAny) break;
      rep++;
      if (rep > 5000) break;
    }
    return { keys: keys, cycles: cycles, capped: capped };
  }

  /**
   * @param {object} opts
   *   times     ascending key times of the loop unit, clip-relative seconds
   *   values    matching values (numbers or arrays)
   *   type      'cycle' | 'pingpong' | 'offset'
   *   direction 'out' (default) | 'in'
   *   until     clip-relative time to loop towards. For 'out' it must be after
   *             the unit; for 'in', before it.
   *   maxKeys   safety cap, default 600
   *   epsilon   frame duration in seconds, used for a cycle's snap-back key
   * @returns {{keys:Array, cycles:number, capped:boolean}} keys ascending in time
   */
  function buildLoop(opts) {
    opts = opts || {};
    var times = opts.times || [], values = opts.values || [];
    var maxKeys = Number(opts.maxKeys) > 0 ? Number(opts.maxKeys) : MAX_KEYS;
    var type = opts.type === 'pingpong' || opts.type === 'offset' ? opts.type : 'cycle';
    if (times.length < 2 || values.length !== times.length) return { keys: [], cycles: 0, capped: false };

    var epsilon = Number(opts.epsilon);
    if (!(epsilon > 0)) epsilon = 1 / 30;
    if (opts.direction !== 'in') {
      return buildOut(times, values, type, Number(opts.until), maxKeys, epsilon);
    }
    // Mirror time, loop "out" in mirrored space, mirror back. The reversal and
    // the offset sign both fall out of the mirror for free.
    var mt = [], mv = [], i;
    for (i = times.length - 1; i >= 0; i--) { mt.push(-times[i]); mv.push(values[i]); }
    var res = buildOut(mt, mv, type, -Number(opts.until), maxKeys, epsilon);
    var keys = [];
    for (i = res.keys.length - 1; i >= 0; i--) keys.push({ t: -res.keys[i].t, v: res.keys[i].v });
    return { keys: keys, cycles: res.cycles, capped: res.capped };
  }

  /** Picks the loop unit: the last N keys for 'out', the first N for 'in'. */
  function selectUnit(times, values, count, direction) {
    var n = times.length;
    if (!count || count >= n || count < 2) return { times: times.slice(), values: values.slice() };
    if (direction === 'in') return { times: times.slice(0, count), values: values.slice(0, count) };
    return { times: times.slice(n - count), values: values.slice(n - count) };
  }

  global.MotionLoop = {
    buildLoop: buildLoop,
    selectUnit: selectUnit,
    addValue: addValue,
    subValue: subValue,
    MAX_KEYS: MAX_KEYS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.MotionLoop;
}(typeof window !== 'undefined' ? window : globalThis));
