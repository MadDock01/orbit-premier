/**
 * motion-lab.js — the Motion rail.
 *
 * Two sections over one host surface:
 *   Presets — one-click animations for clips that have no keyframes yet.
 *             Resolved by MotionEngine from motion-presets.json, then written
 *             through motionBakeKeys.
 *   Easing  — re-curve keyframes that already exist. Premiere has no bezier
 *             handle API, so the curve is baked into the values by
 *             MotionCurves (see modules/motion-curves.js for why).
 *
 * Plus keyframe utilities: nudge, swap, clear.
 */
(function (global) {
  'use strict';

  var el = {};
  var state = { fps: 30, clips: [], selectedProps: {}, preset: null, presets: [] };

  function $(id) { return document.getElementById(id); }

  function host(name, args, timeout) {
    if (global.OrbitCore && global.OrbitCore.host) return global.OrbitCore.host.call(name, args || [], { timeout: timeout || 20000 });
    if (!global.CEP || typeof global.CEP.evalScript !== 'function') return Promise.reject(new Error('CEP bridge unavailable'));
    return global.CEP.evalScript(name, args || [], timeout || 20000);
  }

  function status(message, error, success) {
    if (!el.status) return;
    el.status.textContent = message || '';
    el.status.className = 'ml-status' + (error ? ' error' : (success ? ' success' : ''));
  }

  function busy(on) {
    var nodes = document.querySelectorAll('#motionView button, #motionView input, #motionView select');
    for (var i = 0; i < nodes.length; i++) nodes[i].disabled = !!on;
  }

  function num(input, fallback) {
    var v = Number(input && input.value);
    return isFinite(v) ? v : fallback;
  }

  // ── Curve preview ───────────────────────────────────────────────────────
  // A curve you cannot see is a curve you have to apply to understand. The
  // graph is the cheapest way to make strength and decay legible.
  function drawCurve() {
    if (!el.curve) return;
    var shape = el.shape ? el.shape.value : 'cubic';
    var dir = el.dir ? el.dir.value : 'out';
    var strength = num(el.strength, 100) / 100;
    var decay = num(el.decay, 100) / 100;
    var ease = global.MotionCurves.easing(shape, dir, strength, decay);
    var w = 100, h = 60, pad = 6, steps = 64, d = '';
    var lo = 0, hi = 1, i, v, pts = [];
    for (i = 0; i <= steps; i++) { v = ease(i / steps); pts.push(v); if (v < lo) lo = v; if (v > hi) hi = v; }
    var range = (hi - lo) || 1;
    for (i = 0; i <= steps; i++) {
      var x = pad + (w - pad * 2) * (i / steps);
      var y = (h - pad) - (h - pad * 2) * ((pts[i] - lo) / range);
      d += (i ? 'L' : 'M') + x.toFixed(2) + ' ' + y.toFixed(2);
    }
    el.curve.setAttribute('d', d);
    if (el.curveBase) {
      var y0 = (h - pad) - (h - pad * 2) * ((0 - lo) / range);
      var y1 = (h - pad) - (h - pad * 2) * ((1 - lo) / range);
      el.curveBase.setAttribute('d', 'M' + pad + ' ' + y0.toFixed(2) + 'L' + (w - pad) + ' ' + y1.toFixed(2));
    }
    if (el.decayRow) el.decayRow.style.display = shape === 'bounce' ? '' : 'none';
  }

  function syncLabels() {
    if (el.strengthVal) el.strengthVal.textContent = Math.round(num(el.strength, 100)) + '%';
    if (el.decayVal) el.decayVal.textContent = Math.round(num(el.decay, 100)) + '%';
    if (el.intervalVal) el.intervalVal.textContent = Math.round(num(el.interval, 1)) + 'f';
    if (el.intensityVal) el.intensityVal.textContent = Math.round(num(el.intensity, 100)) + '%';
    if (el.durationVal) el.durationVal.textContent = Math.round(num(el.duration, 12)) + 'f';
  }

  // ── Selection ───────────────────────────────────────────────────────────
  function refresh() {
    status('Reading selection…');
    return host('motionInspectKeyframes', [], 20000).then(function (res) {
      if (!res || res.error) throw new Error((res && res.error) || 'Could not read the selection.');
      state.fps = res.fps || 30;
      state.clips = res.clips || [];
      state.selectedProps = {};
      renderProps();
      var animated = 0, total = 0;
      for (var i = 0; i < state.clips.length; i++) {
        for (var p = 0; p < state.clips[i].properties.length; p++) {
          total++;
          if (state.clips[i].properties[p].animated) animated++;
        }
      }
      if (el.selection) {
        el.selection.textContent = state.clips.length
          ? state.clips.length + ' clip' + (state.clips.length === 1 ? '' : 's') + ' · ' + animated + ' animated propert' + (animated === 1 ? 'y' : 'ies') + ' · ' + state.fps + ' fps'
          : 'Select one or more timeline clips';
      }
      status(animated ? 'Ready.' : 'No keyframes found — use Presets to create some.', false, !!animated);
      return res;
    }).catch(function (err) {
      state.clips = [];
      renderProps();
      if (el.selection) el.selection.textContent = 'Host unavailable';
      status(err.message, true);
    });
  }

  function propKey(clipIndex, prop) { return clipIndex + ':' + prop.component + ':' + prop.property; }

  function renderProps() {
    if (!el.props) return;
    var rows = [], i, p;
    for (i = 0; i < state.clips.length; i++) {
      var clip = state.clips[i];
      for (p = 0; p < clip.properties.length; p++) {
        var prop = clip.properties[p];
        if (!prop.animated || !prop.keys.length) continue;
        rows.push({ clipIndex: i, clipName: clip.name, prop: prop });
      }
    }
    if (!rows.length) {
      el.props.innerHTML = '<div class="ml-empty">No animated properties on the selection. ' +
        'Add keyframes in Effect Controls, or apply a preset above.</div>';
      return;
    }
    el.props.innerHTML = '';
    rows.forEach(function (row) {
      var key = propKey(row.clipIndex, row.prop);
      state.selectedProps[key] = true;
      var line = document.createElement('label');
      line.className = 'ml-prop';
      var box = document.createElement('input');
      box.type = 'checkbox'; box.checked = true; box.setAttribute('data-ml-prop', key);
      var text = document.createElement('span');
      text.textContent = row.prop.name;
      var meta = document.createElement('em');
      meta.textContent = row.prop.effect + ' · ' + row.prop.keys.length + ' keys';
      line.appendChild(box); line.appendChild(text); line.appendChild(meta);
      el.props.appendChild(line);
    });
  }

  function chosenEntries() {
    var out = [], i, p;
    for (i = 0; i < state.clips.length; i++) {
      for (p = 0; p < state.clips[i].properties.length; p++) {
        var prop = state.clips[i].properties[p];
        if (!prop.animated || prop.keys.length < 2) continue;
        if (!state.selectedProps[propKey(i, prop)]) continue;
        out.push({ clipIndex: i, prop: prop });
      }
    }
    return out;
  }

  // ── Easing ──────────────────────────────────────────────────────────────
  function applyEase() {
    var chosen = chosenEntries();
    if (!chosen.length) { status('Tick at least one animated property with two or more keyframes.', true); return; }
    var opts = {
      shape: el.shape ? el.shape.value : 'cubic',
      dir: el.dir ? el.dir.value : 'out',
      strength: num(el.strength, 100) / 100,
      decay: num(el.decay, 100) / 100,
      fps: state.fps,
      intervalFrames: num(el.interval, 1)
    };
    busy(true); status('Reading key values…');
    // The host has to hand back the value at every key before anything can be
    // baked: Premiere gives no way to read a property's curve, only its values.
    var reads = chosen.map(function (item) {
      return host('motionReadKeyValues', [JSON.stringify({
        clipIndex: item.clipIndex, component: item.prop.component, property: item.prop.property
      })], 20000).then(function (res) {
        return (res && res.values) ? { item: item, values: res.values, times: res.times } : null;
      }).catch(function () { return null; });
    });
    Promise.all(reads).then(function (results) {
      var entries = [], capped = false, totalKeys = 0;
      results.forEach(function (r) {
        if (!r || !r.times || r.times.length < 2) return;
        var keys = global.MotionCurves.bakeSeries(r.times, r.values, opts);
        if (!keys.length) return;
        if (keys.length >= global.MotionCurves.MAX_KEYS) capped = true;
        totalKeys += keys.length;
        entries.push({
          clipIndex: r.item.clipIndex, component: r.item.prop.component, property: r.item.prop.property,
          replaceFrom: r.times[0], replaceTo: r.times[r.times.length - 1], keys: keys
        });
      });
      if (!entries.length) throw new Error('Nothing could be read from the selected properties.');
      status('Baking ' + totalKeys + ' keyframes…');
      return host('motionBakeKeys', [JSON.stringify({ entries: entries, undoLabel: 'Orbit - Ease Keyframes' })], 60000)
        .then(function (res) {
          if (!res || res.error) throw new Error((res && res.error) || 'Easing failed.');
          status('Eased ' + res.properties + ' propert' + (res.properties === 1 ? 'y' : 'ies') +
            ' · ' + res.keys + ' keyframes' + (capped ? ' (capped — raise the interval)' : '') + '.', false, true);
          return refresh();
        });
    }).catch(function (err) { status(err.message, true); })
      .then(function () { busy(false); });
  }

  // ── Presets ─────────────────────────────────────────────────────────────
  function renderPresets() {
    if (!el.presetGrid) return;
    el.presetGrid.innerHTML = '';
    state.presets.forEach(function (preset) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ml-preset';
      b.setAttribute('data-ml-preset', preset.id);
      b.title = preset.name + ' (' + preset.category + ')';
      b.innerHTML = '<strong></strong><span></span>';
      b.firstChild.textContent = preset.name;
      b.lastChild.textContent = preset.category;
      el.presetGrid.appendChild(b);
    });
  }

  // CEP serves the panel from file://, where fetch() is blocked. modules/
  // autoCaptions.js reads its templates through Node for the same reason, and
  // the old motion panel carried a note that CEP fetch is unreliable. So: Node
  // first, then fetch, then XHR.
  function readPresetsSync() {
    var req = global.require || (typeof require === 'function' ? require : null);
    if (!req) return null;
    try {
      var fs = req('fs'), path = req('path');
      var ext = '';
      try { ext = new CSInterface().getSystemPath(SystemPath.EXTENSION); } catch (_) {}
      if (!ext) return null;
      var candidates = [path.join(ext, 'motion-presets.json'), path.join(ext, 'client', 'motion-presets.json')];
      for (var i = 0; i < candidates.length; i++) {
        if (fs.existsSync(candidates[i])) return JSON.parse(fs.readFileSync(candidates[i], 'utf8'));
      }
    } catch (_) {}
    return null;
  }

  function usePresets(list) {
    state.presets = Object.prototype.toString.call(list) === '[object Array]' ? list : [];
    renderPresets();
    if (!state.presets.length && el.presetGrid) {
      el.presetGrid.innerHTML = '<div class="ml-empty">motion-presets.json could not be loaded.</div>';
    }
    return state.presets;
  }

  function loadPresets() {
    var local = readPresetsSync();
    if (local) return Promise.resolve(usePresets(local));
    return new Promise(function (resolve) {
      try {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', 'motion-presets.json', true);
        xhr.onload = function () {
          try { resolve(usePresets(JSON.parse(xhr.responseText))); } catch (_) { resolve(usePresets(null)); }
        };
        xhr.onerror = function () { resolve(usePresets(null)); };
        xhr.send();
      } catch (_) { resolve(usePresets(null)); }
    });
  }

  function applyPreset() {
    if (!state.preset) { status('Pick a preset first.', true); return; }
    if (!state.clips.length) { status('Select one or more timeline clips.', true); return; }
    var preset = null;
    for (var i = 0; i < state.presets.length; i++) if (state.presets[i].id === state.preset) preset = state.presets[i];
    if (!preset) { status('That preset is no longer available.', true); return; }
    var mode = el.mode && el.mode.value === 'out' ? 'out' : 'in';
    var opts = {
      duration: num(el.duration, preset.duration || 12),
      intensity: num(el.intensity, 100),
      direction: el.direction ? el.direction.value : 'none'
    };
    var resolved = global.MotionEngine.resolvePreset(preset, opts);
    var entries = [];
    state.clips.forEach(function (clip, clipIndex) {
      var durationFrames = Math.max(1, Math.round(clip.duration * state.fps));
      var base = global.MotionEngine.resolveBaseFrame(mode, durationFrames, opts.duration);
      for (var propName in resolved) {
        if (!resolved.hasOwnProperty(propName)) continue;
        var target = findProperty(clip, propName);
        if (!target) continue;
        var keys = resolved[propName].map(function (k) {
          return { t: (base + k.frame) / state.fps, v: toHostValue(propName, k.value) };
        });
        if (!keys.length) continue;
        entries.push({
          clipIndex: clipIndex, component: target.component, property: target.property,
          replaceFrom: keys[0].t, replaceTo: keys[keys.length - 1].t, keys: keys
        });
      }
    });
    if (!entries.length) { status('None of the selected clips expose the properties this preset needs.', true); return; }
    busy(true); status('Applying ' + preset.name + '…');
    host('motionBakeKeys', [JSON.stringify({ entries: entries, undoLabel: 'Orbit - ' + preset.name })], 60000)
      .then(function (res) {
        if (!res || res.error) throw new Error((res && res.error) || 'Preset failed.');
        status(preset.name + ' applied to ' + res.properties + ' propert' + (res.properties === 1 ? 'y' : 'ies') + '.', false, true);
        return refresh();
      })
      .catch(function (err) { status(err.message, true); })
      .then(function () { busy(false); });
  }

  // Preset property names are generic ("scale"); Premiere's are localised
  // display names. Match on the English name first, then a few known aliases.
  var ALIASES = {
    scale: ['scale', 'uniform scale'],
    position: ['position'],
    rotation: ['rotation'],
    opacity: ['opacity']
  };
  function findProperty(clip, propName) {
    var wanted = ALIASES[propName] || [propName];
    for (var i = 0; i < clip.properties.length; i++) {
      var name = String(clip.properties[i].name || '').toLowerCase();
      for (var w = 0; w < wanted.length; w++) if (name === wanted[w]) return clip.properties[i];
    }
    return null;
  }

  function toHostValue(propName, value) {
    if (propName === 'position' && value && typeof value === 'object') {
      return [Number(value.x) || 0, Number(value.y) || 0];
    }
    return value;
  }

  // ── Loop ────────────────────────────────────────────────────────────────
  // After Effects' loopOut() / loopIn() for a host with no expression engine.
  // "Keep easing" samples the property's drawn shape rather than copying key
  // values, because bezier handles cannot be read back from Premiere.
  function applyLoop() {
    var chosen = chosenEntries();
    if (!chosen.length) { status('Tick at least one animated property with two or more keyframes.', true); return; }
    var direction = el.loopDir ? el.loopDir.value : 'out';
    var type = el.loopType ? el.loopType.value : 'cycle';
    var unitCount = Number(el.loopKeys && el.loopKeys.value) || 0;
    var endMode = el.loopEnd ? el.loopEnd.value : 'clip';
    var smooth = !!(el.loopSmooth && el.loopSmooth.checked);
    var frame = 1 / (state.fps || 30);

    busy(true); status('Reading keyframes\u2026');
    var reads = chosen.map(function (item) {
      var payload = { clipIndex: item.clipIndex, component: item.prop.component, property: item.prop.property };
      return host('motionReadKeyValues', [JSON.stringify(payload)], 20000).then(function (res) {
        if (!res || !res.times || res.times.length < 2) return null;
        var unit = global.MotionLoop.selectUnit(res.times, res.values, unitCount, direction);
        if (!smooth) return { item: item, unit: unit, all: res };
        // Resample the unit so any easing between its keys survives the loop.
        var sample = {
          clipIndex: item.clipIndex, component: item.prop.component, property: item.prop.property,
          from: unit.times[0], to: unit.times[unit.times.length - 1], step: frame
        };
        return host('motionSampleValues', [JSON.stringify(sample)], 20000).then(function (s2) {
          if (!s2 || !s2.times || s2.times.length < 2) return { item: item, unit: unit, all: res };
          return { item: item, unit: { times: s2.times, values: s2.values }, all: res };
        }).catch(function () { return { item: item, unit: unit, all: res }; });
      }).catch(function () { return null; });
    });

    Promise.all(reads).then(function (results) {
      var entries = [], capped = false, totalKeys = 0, cycles = 0;
      results.forEach(function (r) {
        if (!r) return;
        var clip = state.clips[r.item.clipIndex];
        if (!clip) return;
        var until;
        if (endMode === 'playhead') {
          if (typeof clip.playhead !== 'number') return;
          until = clip.playhead;
        } else {
          until = direction === 'in' ? 0 : clip.duration;
        }
        var built = global.MotionLoop.buildLoop({
          times: r.unit.times, values: r.unit.values, type: type,
          direction: direction, until: until, epsilon: frame
        });
        if (!built.keys.length) return;
        if (built.capped) capped = true;
        totalKeys += built.keys.length;
        cycles = Math.max(cycles, built.cycles);
        // Only the looped span is replaced; the original keyframes stay put.
        var from = direction === 'in' ? built.keys[0].t : r.unit.times[r.unit.times.length - 1] + frame / 2;
        var to = direction === 'in' ? r.unit.times[0] - frame / 2 : built.keys[built.keys.length - 1].t;
        entries.push({
          clipIndex: r.item.clipIndex, component: r.item.prop.component, property: r.item.prop.property,
          replaceFrom: from, replaceTo: to, keys: built.keys
        });
      });
      if (!entries.length) {
        throw new Error(endMode === 'playhead'
          ? 'Move the playhead past the keyframes you want to loop.'
          : 'There is no room left on the clip to loop into.');
      }
      status('Writing ' + totalKeys + ' keyframes\u2026');
      return host('motionBakeKeys', [JSON.stringify({ entries: entries, undoLabel: 'Orbit - Loop Keyframes' })], 60000)
        .then(function (res) {
          if (!res || res.error) throw new Error((res && res.error) || 'Loop failed.');
          status('Looped ' + res.properties + ' propert' + (res.properties === 1 ? 'y' : 'ies') +
            ' \u00b7 ' + cycles + ' repeat' + (cycles === 1 ? '' : 's') + ' \u00b7 ' + res.keys + ' keyframes' +
            (capped ? ' (capped)' : '') + '.', false, true);
          return refresh();
        });
    }).catch(function (err) { status(err.message, true); })
      .then(function () { busy(false); });
  }

  // ── Keyframe utilities ──────────────────────────────────────────────────
  function editKeys(op, offsetFrames) {
    var chosen = chosenEntries();
    if (!chosen.length) { status('Tick at least one animated property.', true); return; }
    var payload = {
      op: op,
      offset: (Number(offsetFrames) || 0) / state.fps,
      entries: chosen.map(function (item) {
        return { clipIndex: item.clipIndex, component: item.prop.component, property: item.prop.property };
      })
    };
    busy(true);
    status(op === 'shift' ? 'Shifting keyframes…' : (op === 'swap' ? 'Swapping keyframes…' : 'Clearing keyframes…'));
    host('motionEditKeys', [JSON.stringify(payload)], 30000)
      .then(function (res) {
        if (!res || res.error) throw new Error((res && res.error) || 'Keyframe edit failed.');
        status(res.changed + ' propert' + (res.changed === 1 ? 'y' : 'ies') + ' updated.', false, true);
        return refresh();
      })
      .catch(function (err) { status(err.message, true); })
      .then(function () { busy(false); });
  }

  // ── Wiring ──────────────────────────────────────────────────────────────
  function wire() {
    el = {
      view: $('motionView'), refresh: $('mlRefresh'), selection: $('mlSelection'), status: $('mlStatus'),
      presetGrid: $('mlPresetGrid'), mode: $('mlMode'), direction: $('mlDirection'),
      intensity: $('mlIntensity'), intensityVal: $('mlIntensityValue'),
      duration: $('mlDuration'), durationVal: $('mlDurationValue'), applyPreset: $('mlApplyPreset'),
      props: $('mlProps'), shape: $('mlShape'), dir: $('mlDir'),
      strength: $('mlStrength'), strengthVal: $('mlStrengthValue'),
      decay: $('mlDecay'), decayVal: $('mlDecayValue'), decayRow: $('mlDecayRow'),
      interval: $('mlInterval'), intervalVal: $('mlIntervalValue'), applyEase: $('mlApplyEase'),
      loopDir: $('mlLoopDir'), loopType: $('mlLoopType'), loopKeys: $('mlLoopKeys'),
      loopEnd: $('mlLoopEnd'), loopSmooth: $('mlLoopSmooth'), applyLoop: $('mlApplyLoop'),
      curve: $('mlCurvePath'), curveBase: $('mlCurveBase'), keyOps: $('mlKeyOps')
    };
    if (!el.view) return;

    if (el.refresh) el.refresh.addEventListener('click', refresh);
    if (el.applyEase) el.applyEase.addEventListener('click', applyEase);
    if (el.applyPreset) el.applyPreset.addEventListener('click', applyPreset);
    if (el.applyLoop) el.applyLoop.addEventListener('click', applyLoop);

    ['shape', 'dir', 'strength', 'decay'].forEach(function (k) {
      if (el[k]) el[k].addEventListener('input', function () { syncLabels(); drawCurve(); });
      if (el[k]) el[k].addEventListener('change', function () { syncLabels(); drawCurve(); });
    });
    ['interval', 'intensity', 'duration'].forEach(function (k) {
      if (el[k]) el[k].addEventListener('input', syncLabels);
    });

    if (el.presetGrid) el.presetGrid.addEventListener('click', function (event) {
      var b = event.target && event.target.closest ? event.target.closest('[data-ml-preset]') : null;
      if (!b) return;
      state.preset = b.getAttribute('data-ml-preset');
      var all = el.presetGrid.querySelectorAll('[data-ml-preset]');
      for (var i = 0; i < all.length; i++) all[i].classList.toggle('active', all[i] === b);
    });

    if (el.props) el.props.addEventListener('change', function (event) {
      var box = event.target;
      if (!box || !box.getAttribute || !box.getAttribute('data-ml-prop')) return;
      state.selectedProps[box.getAttribute('data-ml-prop')] = !!box.checked;
    });

    if (el.keyOps) el.keyOps.addEventListener('click', function (event) {
      var b = event.target && event.target.closest ? event.target.closest('[data-ml-key]') : null;
      if (!b) return;
      var op = b.getAttribute('data-ml-key');
      if (op === 'shift-back') editKeys('shift', -num(el.interval, 1));
      else if (op === 'shift-fwd') editKeys('shift', num(el.interval, 1));
      else editKeys(op, 0);
    });

    syncLabels();
    drawCurve();
    loadPresets();

    // Refresh when the rail opens, not on a timer.
    global.addEventListener('compx:rail-route', function (event) {
      if (event && event.detail && event.detail.type === 'motion') refresh();
    });
    document.addEventListener('host-loader-ready', function () {
      if (el.view && el.view.classList.contains('orbit-route-active')) refresh();
    });
  }

  wire();
  global.MotionPanel = { refresh: refresh, applyEase: applyEase, applyPreset: applyPreset, applyLoop: applyLoop, editKeys: editKeys, _state: state };
}(window));
