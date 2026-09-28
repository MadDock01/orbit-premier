/**
 * motion-engine.js — Motion Engine (Keyframe Generator) core.
 *
 * PURE JavaScript — no Premiere API calls in here. The engine takes a preset
 * (from motion-presets.json) + user options and resolves it into concrete
 * keyframe values. The Premiere adapter (jsx/hostscript.jsx) is the only
 * layer that talks to the host.
 *
 * Resolution rules (from the v2.4 Motion Engine spec):
 *  • Duration — every preset frame is scaled by duration / preset.duration.
 *  • Intensity — scale animates around a 100% base (100 + (value − 100) × i)
 *    so 50% intensity never collapses the animation; position offsets scale
 *    linearly; opacity/rotation are untouched.
 *  • Direction — slide presets store ONE offset {x,y}; the direction buttons
 *    re-map it to left/right/up/down around the same distance.
 *  • IN/OUT — IN starts at the clip head; OUT is placed so the animation
 *    ends exactly at the clip tail.
 */
(function (global) {
  'use strict';

  function resolveValue(property, value, intensity) {
    if (property === 'scale' && typeof value === 'number') {
      var base = 100;
      return base + (value - base) * intensity;
    }
    if (property === 'position' && value && typeof value === 'object') {
      var ix = (typeof value.x === 'number' ? value.x : 0) * intensity;
      var iy = (typeof value.y === 'number' ? value.y : 0) * intensity;
      return { x: ix, y: iy, relative: true };
    }
    return value;
  }

  // Re-map a {x,y} offset to a single axis based on the direction button.
  // Keeps the distance so Left/Right/Up/Down feel identical.
  function resolveDirection(value, direction) {
    if (!value || typeof value !== 'object') return value;
    var x = typeof value.x === 'number' ? value.x : 0;
    var y = typeof value.y === 'number' ? value.y : 0;
    var dist = Math.max(Math.abs(x), Math.abs(y));
    if (!direction || direction === 'none') {
      return { x: x, y: y, relative: true };
    }
    var map = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
    var d = map[direction] || [0, 0];
    return { x: d[0] * dist, y: d[1] * dist, relative: true };
  }

  /**
   * Resolve a preset into { propertyName: [{ frame, value }] }.
   * options: { duration, intensity, direction }
   */
  function resolvePreset(preset, options) {
    options = options || {};
    var duration = options.duration || preset.duration || 12;
    var intensity = options.intensity == null ? 100 : options.intensity;
    var direction = options.direction || 'none';
    var durationScale = duration / (preset.duration || duration);
    var intensityScale = intensity / 100;
    var result = {};
    var props = preset.properties || {};
    for (var prop in props) {
      if (!props.hasOwnProperty(prop)) continue;
      result[prop] = props[prop].map(function (key) {
        var value = resolveValue(prop, key.value, intensityScale);
        if (prop === 'position') value = resolveDirection(value, direction);
        return {
          frame: Math.round(key.frame * durationScale),
          value: value
        };
      });
    }
    return result;
  }

  /**
   * Where the animation starts, in clip-relative frames.
   * mode 'in'  → frame 0 (clip head)
   * mode 'out' → clipDurationFrames − presetDuration (ends at the tail)
   */
  function resolveBaseFrame(mode, clipDurationFrames, presetDuration) {
    if (mode === 'out') {
      return Math.max(0, clipDurationFrames - presetDuration);
    }
    return 0;
  }

  /**
   * Combo presets define two phases: { in: {duration, properties},
   * out: {duration, properties} }. Returns { in: resolved, out: resolved }.
   */
  function resolveCombo(preset, options) {
    options = options || {};
    return {
      in:  preset.in  ? resolvePreset(preset.in, options) : null,
      out: preset.out ? resolvePreset(preset.out, options) : null
    };
  }

  var MotionEngine = {
    resolvePreset: resolvePreset,
    resolveCombo: resolveCombo,
    resolveBaseFrame: resolveBaseFrame,
    resolveValue: resolveValue,
    resolveDirection: resolveDirection
  };

  global.MotionEngine = MotionEngine;
})(window);
