/**
 * motion-panel.js — Motion Engine panel controller (UI → controller → engine → adapter).
 *
 * Loads motion-presets.json (with an inline fallback so the panel always
 * renders), renders the IN / OUT / COMBO preset grid + controls, and applies
 * the selected motion to every selected timeline clip in ONE host call (one
 * undo group in Premiere).
 */
(function (global) {
  'use strict';

  // ── Fallback presets ───────────────────────────────────────────────────────
  // Used only when motion-presets.json cannot be fetched (CEP fetch can be
  // flaky on file:// panels). Mirrors the shipped file's core set.
  var FALLBACK_PRESETS = [
    { id: 'pop-in', name: 'Pop', category: 'in', duration: 12, properties: { scale: [{ frame: 0, value: 70 }, { frame: 7, value: 108 }, { frame: 12, value: 100 }], opacity: [{ frame: 0, value: 0 }, { frame: 4, value: 100 }] } },
    { id: 'zoom-in', name: 'Zoom', category: 'in', duration: 12, properties: { scale: [{ frame: 0, value: 85 }, { frame: 12, value: 100 }], opacity: [{ frame: 0, value: 0 }, { frame: 12, value: 100 }] } },
    { id: 'slide-in', name: 'Slide', category: 'in', duration: 12, properties: { position: [{ frame: 0, value: { x: 0, y: 150, relative: true } }, { frame: 12, value: { x: 0, y: 0, relative: true } }], opacity: [{ frame: 0, value: 0 }, { frame: 7, value: 100 }] } },
    { id: 'bounce-in', name: 'Bounce', category: 'in', duration: 16, properties: { scale: [{ frame: 0, value: 50 }, { frame: 8, value: 115 }, { frame: 11, value: 94 }, { frame: 14, value: 104 }, { frame: 16, value: 100 }] } },
    { id: 'rotate-in', name: 'Rotate', category: 'in', duration: 14, properties: { scale: [{ frame: 0, value: 75 }, { frame: 14, value: 100 }], rotation: [{ frame: 0, value: -8 }, { frame: 14, value: 0 }], opacity: [{ frame: 0, value: 0 }, { frame: 6, value: 100 }] } },
    { id: 'fade-in', name: 'Fade', category: 'in', duration: 12, properties: { opacity: [{ frame: 0, value: 0 }, { frame: 12, value: 100 }] } },
    { id: 'fade-out', name: 'Fade', category: 'out', duration: 12, properties: { opacity: [{ frame: 0, value: 100 }, { frame: 12, value: 0 }] } },
    { id: 'zoom-out', name: 'Zoom Out', category: 'out', duration: 12, properties: { scale: [{ frame: 0, value: 100 }, { frame: 12, value: 120 }], opacity: [{ frame: 0, value: 100 }, { frame: 12, value: 0 }] } },
    { id: 'slide-out', name: 'Slide', category: 'out', duration: 12, properties: { position: [{ frame: 0, value: { x: 0, y: 0, relative: true } }, { frame: 12, value: { x: 0, y: 150, relative: true } }], opacity: [{ frame: 0, value: 100 }, { frame: 12, value: 0 }] } },
    { id: 'drop-out', name: 'Drop', category: 'out', duration: 14, properties: { position: [{ frame: 0, value: { x: 0, y: 0, relative: true } }, { frame: 14, value: { x: 0, y: 180, relative: true } }], opacity: [{ frame: 0, value: 100 }, { frame: 12, value: 0 }] } },
    { id: 'shrink-out', name: 'Shrink', category: 'out', duration: 12, properties: { scale: [{ frame: 0, value: 100 }, { frame: 12, value: 60 }], opacity: [{ frame: 0, value: 100 }, { frame: 12, value: 0 }] } },
    { id: 'rotate-out', name: 'Rotate', category: 'out', duration: 14, properties: { rotation: [{ frame: 0, value: 0 }, { frame: 14, value: 12 }], scale: [{ frame: 0, value: 100 }, { frame: 14, value: 110 }], opacity: [{ frame: 0, value: 100 }, { frame: 14, value: 0 }] } },
    { id: 'pop-fade', name: 'Pop/Fade', category: 'combo', in: { duration: 12, properties: { scale: [{ frame: 0, value: 70 }, { frame: 7, value: 108 }, { frame: 12, value: 100 }], opacity: [{ frame: 0, value: 0 }, { frame: 4, value: 100 }] } }, out: { duration: 10, properties: { opacity: [{ frame: 0, value: 100 }, { frame: 10, value: 0 }] } } },
    { id: 'slide-fade', name: 'Slide/Fade', category: 'combo', in: { duration: 12, properties: { position: [{ frame: 0, value: { x: 0, y: 150, relative: true } }, { frame: 12, value: { x: 0, y: 0, relative: true } }], opacity: [{ frame: 0, value: 0 }, { frame: 7, value: 100 }] } }, out: { duration: 10, properties: { opacity: [{ frame: 0, value: 100 }, { frame: 10, value: 0 }] } } },
    { id: 'bounce-fade', name: 'Bounce/Fade', category: 'combo', in: { duration: 16, properties: { scale: [{ frame: 0, value: 50 }, { frame: 8, value: 115 }, { frame: 11, value: 94 }, { frame: 14, value: 104 }, { frame: 16, value: 100 }] } }, out: { duration: 10, properties: { opacity: [{ frame: 0, value: 100 }, { frame: 10, value: 0 }] } } }
  ];

  // ── State ──────────────────────────────────────────────────────────────────
  var state = {
    mode: 'in',            // 'in' | 'out' | 'combo'
    presetId: null,        // id of the selected preset in the current tab
    duration: 12,          // frames
    intensity: 100,        // percent
    direction: 'up',       // left | up | down | right | none
    ease: 'ease',          // linear | ease | ease-out | overshoot
    stagger: 0             // frames between clips
  };

  var presets = [];
  var clips = [];          // last selection from the host
  var fps = 30;
  var working = false;

  // ── DOM refs ───────────────────────────────────────────────────────────────
  var el = {
    count: document.getElementById('motionSelectionCount'),
    refresh: document.getElementById('motionRefresh'),
    tabs: Array.prototype.slice.call(document.querySelectorAll('.motion-tab')),
    grid: document.getElementById('motionPresetGrid'),
    duration: document.getElementById('motionDuration'),
    durationVal: document.getElementById('motionDurationValue'),
    intensity: document.getElementById('motionIntensity'),
    intensityVal: document.getElementById('motionIntensityValue'),
    directionBtns: Array.prototype.slice.call(document.querySelectorAll('.motion-direction button')),
    ease: document.getElementById('motionEase'),
    stagger: document.getElementById('motionStagger'),
    staggerVal: document.getElementById('motionStaggerValue'),
    apply: document.getElementById('motionApply'),
    reframeRatio: document.getElementById('reframeRatio'),
    reframeFocus: document.getElementById('reframeFocus'),
    reframeApply: document.getElementById('reframeApply'),
    status: document.getElementById('motionStatus')
  };

  // ── Preset loading ─────────────────────────────────────────────────────────
  function loadPresets() {
    fetch('motion-presets.json')
      .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error('HTTP ' + res.status)); })
      .then(function (arr) {
        if (!Array.isArray(arr) || !arr.length) throw new Error('Empty preset list');
        presets = arr;
        renderAll();
      })
      .catch(function () {
        presets = FALLBACK_PRESETS;
        renderAll();
      });
  }

  function getPreset(id) {
    for (var i = 0; i < presets.length; i++) {
      if (presets[i].id === id) return presets[i];
    }
    return null;
  }

  function presetsForMode() {
    return presets.filter(function (p) { return p.category === state.mode; });
  }

  // ── Rendering ──────────────────────────────────────────────────────────────
  function renderAll() {
    renderTabs();
    renderGrid();
    renderControls();
  }

  function renderTabs() {
    el.tabs.forEach(function (tab) {
      tab.classList.toggle('active', tab.dataset.mode === state.mode);
    });
  }

  function renderGrid() {
    if (!el.grid) return;
    el.grid.innerHTML = '';
    var list = presetsForMode();
    // Keep the previous selection if it's visible in this tab, else pick the first.
    if (!getPreset(state.presetId) || getPreset(state.presetId).category !== state.mode) {
      state.presetId = list.length ? list[0].id : null;
    }
    list.forEach(function (preset) {
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'motion-preset' + (preset.id === state.presetId ? ' selected' : '');
      card.textContent = preset.name;
      card.title = preset.id;
      card.addEventListener('click', function () {
        state.presetId = preset.id;
        el.grid.querySelectorAll('.motion-preset').forEach(function (b) { b.classList.remove('selected'); });
        card.classList.add('selected');
      });
      el.grid.appendChild(card);
    });
  }

  function renderControls() {
    if (el.duration) el.duration.value = state.duration;
    if (el.durationVal) el.durationVal.textContent = state.duration + 'f';
    if (el.intensity) el.intensity.value = state.intensity;
    if (el.intensityVal) el.intensityVal.textContent = state.intensity + '%';
    if (el.ease) el.ease.value = state.ease;
    if (el.stagger) el.stagger.value = state.stagger;
    if (el.staggerVal) el.staggerVal.textContent = state.stagger + 'f';
    el.directionBtns.forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.direction === state.direction);
    });
  }

  // ── Selection ──────────────────────────────────────────────────────────────
  function hostCall(name, args, timeout) {
    if (global.OrbitCore && global.OrbitCore.host) return global.OrbitCore.host.call(name, args || [], { timeout: timeout || 10000 });
    return new Promise(function (resolve, reject) {
      if (!global.CEP || typeof global.CEP.evalScript !== 'function') {
        reject(new Error('CEP bridge unavailable'));
        return;
      }
      try {
        global.CEP.evalScript(name, args || [], timeout || 10000)
          .then(function (res) { resolve(res); })
          .catch(reject);
      } catch (e) {
        reject(e);
      }
    });
  }

  function setCount(text) {
    if (el.count) el.count.textContent = text || 'No selection';
  }

  function refreshSelection(silent) {
    return hostCall('motionGetSelection', [], 8000)
      .then(function (res) {
        if (res && res.items) {
          clips = res.items;
          fps = res.fps && res.fps > 0 ? res.fps : 30;
          setCount(clips.length ? clips.length + (clips.length === 1 ? ' clip' : ' clips') : 'No selection');
        } else {
          clips = [];
          setCount('No selection');
        }
        return clips;
      })
      .catch(function () {
        if (!silent) setCount('Host unavailable');
        clips = [];
        return [];
      });
  }

  function setStatus(text, isError, busy) {
    if (!el.status) return;
    el.status.textContent = text || '';
    el.status.className = 'motion-status' + (isError ? ' error' : '') + (busy ? ' busy' : '');
  }

  // ── Keyframe building (pure engine → absolute times) ──────────────────────
  function mergeProps(a, b) {
    var out = {};
    for (var k in a) { if (a.hasOwnProperty(k)) out[k] = a[k]; }
    for (var k2 in b) { if (b.hasOwnProperty(k2)) out[k2] = (out[k2] || []).concat(b[k2]); }
    return out;
  }

  // One phase (IN or OUT): resolved preset → absolute seconds keyframes.
  function phaseToAbsolute(presetBody, clip, mode, fps, baseFrameOverride) {
    var resolved = global.MotionEngine.resolvePreset(presetBody, {
      duration: state.duration,
      intensity: state.intensity,
      direction: state.direction
    });
    var presetDuration = presetBody.duration || state.duration;
    var clipDurationFrames = Math.max(1, Math.round(clip.duration * fps));
    var baseFrame = baseFrameOverride != null
      ? baseFrameOverride
      : global.MotionEngine.resolveBaseFrame(mode, clipDurationFrames, presetDuration);
    var props = {};
    for (var prop in resolved) {
      if (!resolved.hasOwnProperty(prop)) continue;
      props[prop] = resolved[prop].map(function (k) {
        return {
          t: +(clip.start + (baseFrame + k.frame) / fps).toFixed(4),
          v: k.value
        };
      });
    }
    return props;
  }

  function buildComboProps(preset, clip, fps) {
    var inProps = preset.in ? phaseToAbsolute(preset.in, clip, 'in', fps, 0) : {};
    var clipDurationFrames = Math.max(1, Math.round(clip.duration * fps));
    var outDuration = (preset.out && preset.out.duration) || state.duration;
    var outBase = global.MotionEngine.resolveBaseFrame('out', clipDurationFrames, outDuration);
    var outProps = preset.out ? phaseToAbsolute(preset.out, clip, 'out', fps, outBase) : {};
    return mergeProps(inProps, outProps);
  }

  // ── Apply ──────────────────────────────────────────────────────────────────
  function applyMotion() {
    if (working) return;
    var preset = getPreset(state.presetId);
    if (!preset) { setStatus('Pick a preset first.', true); return; }

    working = true;
    setStatus('Reading selection…', false, true);

    function executeMotion(context) {
      return refreshSelection(true).then(function (items) {
        if (!items.length) throw new Error('Select at least one clip.');
        if (context && context.status) context.status('Building keyframes…');
        else setStatus('Building keyframes…', false, true);
        var payload = [];
        var staggerFrames = (state.mode === 'out') ? 0 : state.stagger;
        for (var i = 0; i < items.length; i++) {
          var clip = items[i];
          var props = (state.mode === 'combo')
            ? buildComboProps(preset, clip, fps)
            : phaseToAbsolute(preset, clip, state.mode, fps, state.mode === 'in' ? (i * staggerFrames) : null);
          payload.push({ clipIndex: i, properties: props, ease: state.ease });
        }
        return context && context.host
          ? context.host('motionApplyClipKeyframes', [JSON.stringify(payload)], { timeout: 45000 })
          : hostCall('motionApplyClipKeyframes', [JSON.stringify(payload)], 45000);
      });
    }
    var operation = global.OrbitCore ? global.OrbitCore.run({
      id: 'motion-apply-preset', title: 'Apply Motion Preset', button: el.apply,
      busyLabel: 'Applying…', startMessage: 'Reading selected clips…', confirm: false, safetyCopy: false,
      execute: executeMotion,
      successMessage: function (res) { return 'Applied ' + preset.name + ' motion to ' + ((res && res.clips) || 0) + ' clip(s).'; },
      toast: false, onStatus: function (phase, value, isError) { setStatus(value, isError, phase === 'working'); }
    }) : executeMotion(null);

    operation
      .then(function (res) {
        if (res && res.cancelled) return;
        if (res && res.error) {
          setStatus(res.error, true);
        } else {
          setStatus('Applied motion to ' + (res && res.clips != null ? res.clips : 0) + ' clip(s).');
        }
      })
      .catch(function (err) {
        setStatus(err && err.message ? err.message : 'Could not apply motion.', true);
      })
      .then(function () { working = false; });
  }

  function applyReframe() {
    if (working) return;
    working = true;
    var ratio = el.reframeRatio ? el.reframeRatio.value : '9:16';
    var focus = el.reframeFocus ? el.reframeFocus.value : 'center';
    var operation = global.OrbitCore ? global.OrbitCore.run({
      id: 'motion-smart-reframe', title: 'Smart Auto Reframe', button: el.reframeApply,
      busyLabel: 'Reframing…', startMessage: 'Preparing Smart Reframe…', confirm: true, safetyCopy: true,
      preview: function () { return 'Reframe the selected clips for ' + ratio + ' using ' + focus + ' focus. Motion Position and Scale may be changed.'; },
      execute: function (context) { return context.host('smartAutoReframe', [ratio, focus], { timeout: 30000 }); },
      successMessage: function (res) { return 'Reframed ' + ((res && res.applied) || 0) + ' selected clip(s) to ' + ((res && res.ratio) || ratio) + '.'; },
      toast: false,
      onStatus: function (phase, value, isError) { setStatus(value, isError, phase === 'working'); }
    }) : hostCall('ppro_duplicateActiveSequence', [], 15000).then(function (copy) {
      if (!copy || copy.success === false) throw new Error((copy && copy.message) || 'Could not create safety copy.');
      return hostCall('smartAutoReframe', [ratio, focus], 30000);
    });

    operation
      .then(function (res) {
        if (res && res.cancelled) return;
        if (res && res.error) throw new Error(res.error);
        setStatus('Reframed ' + ((res && res.applied) || 0) + ' selected clip(s) to ' + ((res && res.ratio) || ratio) + '. Safety copy created.');
      })
      .catch(function (err) { setStatus((err && err.message) || 'Auto reframe failed.', true); })
      .then(function () { working = false; });
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────
  function init() {
    if (el.refresh) el.refresh.addEventListener('click', function () { refreshSelection(false); });
    el.tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        state.mode = tab.dataset.mode;
        renderTabs();
        renderGrid();
      });
    });
    if (el.duration) el.duration.addEventListener('input', function () {
      state.duration = parseInt(this.value, 10);
      if (el.durationVal) el.durationVal.textContent = state.duration + 'f';
    });
    if (el.intensity) el.intensity.addEventListener('input', function () {
      state.intensity = parseInt(this.value, 10);
      if (el.intensityVal) el.intensityVal.textContent = state.intensity + '%';
    });
    if (el.ease) el.ease.addEventListener('change', function () { state.ease = this.value; });
    if (el.stagger) el.stagger.addEventListener('input', function () {
      state.stagger = parseInt(this.value, 10);
      if (el.staggerVal) el.staggerVal.textContent = state.stagger + 'f';
    });
    el.directionBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.direction = btn.dataset.direction;
        el.directionBtns.forEach(function (b) { b.classList.toggle('active', b === btn); });
      });
    });
    if (el.apply) el.apply.addEventListener('click', applyMotion);
    if (el.reframeApply) el.reframeApply.addEventListener('click', applyReframe);

    loadPresets();
    refreshSelection(true);
    global.addEventListener('compx:rail-route', function (event) {
      if (event && event.detail && event.detail.type === 'motion') refreshSelection(true);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.MotionPanel = { init: init, refresh: refreshSelection };
})(window);
