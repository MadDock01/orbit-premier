/**
 * audio-panel.js - AI Voice Cleaner panel controller.
 *
 * UI -> controller -> engine -> Premiere adapter, same family architecture as
 * the Motion / Beat / Punch / B-Roll panels.
 *
 * Flow:
 *   select clip -> FFmpegAPI.extractClipWav (48 kHz WAV)
 *              -> denoise (native RNNoise addon if compiled, else the
 *                pure-JS spectral gate in audio-engine.js)
 *              -> audioImportAndInsert (same timeline position, new track;
 *                optionally mute the original - non-destructive)
 *
 * Preview plays a 5 s window around the playhead through the browser
 * AudioContext (BEFORE/AFTER toggle).
 */
(function (global) {
  'use strict';

  // ── Presets (spec Step 23) ───────────────────────────────────────────────
  var PRESETS = {
    subtle: { label: 'Subtle', strength: 0.40, normalize: true },
    voice:  { label: 'Voice',  strength: 0.70, normalize: true },
    strong: { label: 'Strong', strength: 0.90, normalize: true }
  };

  // ── State ────────────────────────────────────────────────────────────────
  var state = {
    clips: [],            // [{ sourceFile, srcIn, srcOut, timelineStart, name, duration, enabled }]
    preset: 'voice',
    noiseAmount: 80,      // 0..100
    mix: 100,             // 0..100
    normalize: true,
    outputMode: 'new',    // 'new' | 'replace' | 'file'
    working: false
  };

  // ── DOM refs ─────────────────────────────────────────────────────────────
  var el = {};
  function cacheEls() {
    el.selection = document.getElementById('audioSelection');
    el.refresh = document.getElementById('audioRefresh');
    el.noise = document.getElementById('audioNoiseAmount');
    el.noiseVal = document.getElementById('audioNoiseValue');
    el.mix = document.getElementById('audioMix');
    el.mixVal = document.getElementById('audioMixValue');
    el.normalize = document.getElementById('audioNormalize');
    el.presetBtns = Array.prototype.slice.call(document.querySelectorAll('.audio-preset-btn'));
    el.modeRadios = Array.prototype.slice.call(document.querySelectorAll('input[name="audioOutputMode"]'));
    el.preview = document.getElementById('audioPreview');
    el.clean = document.getElementById('audioClean');
    el.autoMix = document.getElementById('audioAutoMix');
    el.mixRole = document.getElementById('audioMixRole');
    el.ab = document.getElementById('audioBeforeAfter');
    el.progressWrap = document.getElementById('audioProgressWrap');
    el.progressBar = document.getElementById('audioProgressBar');
    el.progressText = document.getElementById('audioProgressText');
    el.status = document.getElementById('audioStatus');
    el.fileOnly = document.getElementById('audioModeFile');
    el.clipListWrap = document.getElementById('audioClipListWrap');
    el.clipList = document.getElementById('audioClipList');
    el.clipCount = document.getElementById('audioClipCount');
  }

  function primaryClip() { return state.clips && state.clips.length ? state.clips[0] : null; }

  // ── Host bridge ──────────────────────────────────────────────────────────
  function hostCall(name, args, timeout) {
    return new Promise(function (resolve, reject) {
      if (!global.CEP || typeof global.CEP.evalScript !== 'function') {
        reject(new Error('CEP bridge unavailable'));
        return;
      }
      try {
        global.CEP.evalScript(name, args || [], timeout || 10000).then(resolve).catch(reject);
      } catch (e) { reject(e); }
    });
  }

  function ffmpeg() {
    return global.FFmpegAPI || null;
  }

  function setStatus(text, isError, busy) {
    if (!el.status) return;
    el.status.textContent = text || '';
    el.status.className = 'audio-status' + (isError ? ' error' : '') + (busy ? ' busy' : '');
  }

  function setSelection(text) {
    if (el.selection) el.selection.textContent = text || 'Select an audio clip';
  }

  function setProgress(p, label) {
    if (!el.progressWrap) return;
    if (typeof p === 'number') {
      el.progressWrap.style.display = '';
      if (el.progressBar) el.progressBar.style.width = Math.round(p * 100) + '%';
      if (el.progressText) el.progressText.textContent = label || (Math.round(p * 100) + '%');
    } else {
      el.progressWrap.style.display = 'none';
    }
  }

  function applyAutoMix() {
    var role = el.mixRole ? el.mixRole.value : 'voice';
    if (el.autoMix) el.autoMix.disabled = true;
    setStatus('Applying ' + role + ' mix...', false, true);
    hostCall('audioApplyAutoMix', [role], 20000).then(function (res) {
      if (res && res.error) throw new Error(res.error);
      setStatus('Mixed ' + ((res && res.applied) || 0) + ' selected audio clip(s) to ' + ((res && res.db) || 0) + ' dB.');
    }).catch(function (err) { setStatus((err && err.message) || 'Auto mix failed.', true); })
      .then(function () { if (el.autoMix) el.autoMix.disabled = false; });
  }

  // ── Selection (multi-clip) ──────────────────────────────────────────────
  function refreshSelection(silent) {
    return hostCall('audioGetSelectedClips', [], 8000)
      .then(function (res) {
        var clips = (res && res.clips) || [];
        state.clips = clips.map(function (c, i) { return Object.assign({}, c, { enabled: true, key: i }); });
        renderClipList();
        updateSelectionLabel();
        return state.clips;
      })
      .catch(function (err) {
        state.clips = [];
        renderClipList();
        updateSelectionLabel();
        if (!silent) setSelection('Host unavailable');
        return [];
      });
  }

  function updateSelectionLabel() {
    var n = state.clips.length;
    var on = state.clips.filter(function (c) { return c.enabled; }).length;
    if (!n) { setSelection('Select an audio clip'); if (el.clipCount) el.clipCount.textContent = '0'; return; }
    var text = n + ' clip' + (n === 1 ? '' : 's') + ' selected';
    if (on !== n) text += '  -  ' + on + ' enabled';
    setSelection(text);
    if (el.clipCount) el.clipCount.textContent = String(n);
  }

  // One row per selected clip: checkbox + name + duration. Unchecking a clip
  // excludes it from the batch (non-destructive, like the punch list).
  function renderClipList() {
    if (!el.clipList) return;
    el.clipList.innerHTML = '';
    if (!state.clips.length) {
      if (el.clipListWrap) { el.clipListWrap.classList.add('hidden'); el.clipListWrap.style.display = 'none'; }
      return;
    }
    if (el.clipListWrap) { el.clipListWrap.classList.remove('hidden'); el.clipListWrap.style.display = ''; }
    state.clips.forEach(function (clip) {
      var row = document.createElement('label');
      row.className = 'audio-clip-row';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = clip.enabled;
      cb.className = 'audio-clip-check';
      cb.addEventListener('change', function () {
        clip.enabled = cb.checked;
        row.classList.toggle('off', !cb.checked);
        updateSelectionLabel();
        syncApplyButton();
      });
      var name = document.createElement('span');
      name.className = 'audio-clip-name';
      name.textContent = clip.name || 'clip ' + (clip.key + 1);
      name.title = clip.sourceFile || '';
      var dur = document.createElement('span');
      dur.className = 'audio-clip-dur';
      dur.textContent = (clip.duration || 0).toFixed(1) + 's';
      row.appendChild(cb);
      row.appendChild(name);
      row.appendChild(dur);
      el.clipList.appendChild(row);
    });
    syncApplyButton();
  }

  function enabledClips() { return state.clips.filter(function (c) { return c.enabled; }); }

  function syncApplyButton() {
    if (!el.clean) return;
    el.clean.disabled = state.working || enabledClips().length === 0;
  }

  // ── Processing pipeline ──────────────────────────────────────────────────
  // Extract the clip's source range to a 48 kHz WAV in the temp dir.
  function exportWav(clip, tag) {
    var api = ffmpeg();
    if (!api || !api.extractClipWav) return Promise.reject(new Error('FFmpeg unavailable.'));
    return hostCall('getTempDir', [], 10000).then(function (tmpDir) {
      var outPath = (tmpDir + '/orbit_audio_' + (tag || 'input') + '.wav').replace(/\\/g, '/');
      return api.extractClipWav(clip, outPath, 48000).then(function (r) { return r.outputPath; });
    });
  }

  // Denoise a WAV on disk. Uses the native RNNoise addon when present,
  // otherwise the JS spectral gate.
  function denoiseFile(inputPath, opts) {
    var api = ffmpeg();
    if (!api) return Promise.reject(new Error('FFmpeg unavailable.'));
    if (api.denoiseWav) {
      return api.denoiseWav(inputPath, opts);
    }
    // Fallback: JS engine directly (browser test / no addon compiled).
    if (global.AudioEngine && global.AudioEngine.processFile) {
      var outPath = inputPath.replace(/\.wav$/i, '_clean.wav');
      return global.AudioEngine.processFile(inputPath, outPath, opts, function (p) {
        setProgress(p, 'Denoising... ' + Math.round(p * 100) + '%');
      }).then(function () { return outPath; });
    }
    return Promise.reject(new Error('No denoiser available (CEP host offline).'));
  }

  function currentOptions() {
    return {
      strength: state.noiseAmount / 100,
      mix: state.mix / 100,
      normalize: state.normalize,
      preset: state.preset
    };
  }

  // Full batch pipeline: for each enabled clip -> export -> denoise, then ONE
  // host call inserts every clean file on its own audio track (one undo group).
  function enhanceClip() {
    if (state.working) return;
    var clips = enabledClips();
    if (!clips.length) {
      setStatus('Select an audio clip first.', true);
      return;
    }
    state.working = true;
    setWorking(true);
    setProgress(null);
    setStatus('Preparing ' + clips.length + ' clip' + (clips.length === 1 ? '' : 's') + '...', false, true);
    var opts = currentOptions();

    var results = [];
    var chain = Promise.resolve();
    clips.forEach(function (clip, idx) {
      chain = chain.then(function () {
        setProgress(idx / clips.length, 'Clip ' + (idx + 1) + ' / ' + clips.length + '...');
        setStatus('Clip ' + (idx + 1) + ' / ' + clips.length + ': removing noise...', false, true);
        return exportWav(clip, 'input_' + idx)
          .then(function (inPath) { return denoiseFile(inPath, opts); })
          .then(function (cleanRes) {
            var cleanPath = (cleanRes && typeof cleanRes === 'object' && cleanRes.outputPath) ? cleanRes.outputPath : cleanRes;
            results.push({
              cleanPath: cleanPath,
              timelineStart: clip.timelineStart || 0,
              sourceFile: clip.sourceFile || ''
            });
          });
      });
    });

    chain
      .then(function () {
        setProgress(1, 'Importing ' + results.length + ' clean track' + (results.length === 1 ? '' : 's') + '...');
        setStatus('Importing clean audio...', false, true);
        return hostCall('audioImportAndInsertBatch', [JSON.stringify({
          items: results,
          mode: state.outputMode,
          muteOriginal: state.outputMode === 'replace'
        })], 60000);
      })
      .then(function (res) {
        if (res && res.error) {
          setStatus(res.error, true);
          return;
        }
        var parts = [];
        if (res && res.imported !== undefined) parts.push(res.imported + ' imported');
        if (state.outputMode !== 'file' && res && res.inserted !== undefined) parts.push(res.inserted + ' inserted');
        if (state.outputMode === 'replace') parts.push('originals muted');
        if (res && res.errors && res.errors.length) parts.push(res.errors.length + ' skipped');
        var summary = state.outputMode === 'file' ? 'Imported to project bin' : 'Voice enhanced';
        setStatus(summary + ' - ' + parts.join(', ') + '.');
      })
      .catch(function (err) {
        setStatus(err && err.message ? err.message : 'Enhance failed.', true);
      })
      .finally(function () {
        state.working = false;
        setWorking(false);
        setProgress(null);
      });
  }

  // ── Preview (5 s around the playhead) ────────────────────────────────────
  var _previewCtx = null;
  var _previewSrc = null;
  var _previewClean = null; // AudioBuffer

  function previewPlayheadClip() {
    if (state.working) return;
    var clip = primaryClip();
    if (!clip) {
      setStatus('Select an audio clip first.', true);
      return;
    }
    state.working = true;
    setWorking(true);
    setProgress(null);
    setStatus('Rendering preview...', false, true);
    var playhead = 0;
    var dur = clip.duration || 0;
    hostCall('getPlayheadTime', [], 5000)
      .then(function (ph) {
        playhead = (ph && typeof ph.time === 'number') ? ph.time : 0;
        // Window: playhead - 2 s ... +3 s, clamped to the clip.
        var winStart = Math.max(clip.timelineStart || 0, playhead - 2);
        var winEnd = Math.min((clip.timelineStart || 0) + dur, playhead + 3);
        if (winEnd <= winStart) { winStart = clip.timelineStart || 0; winEnd = Math.min((clip.timelineStart || 0) + dur, winStart + 5); }
        var previewClip = {
          sourceFile: clip.sourceFile,
          srcIn: clip.srcIn + Math.max(0, winStart - (clip.timelineStart || 0)),
          srcOut: clip.srcIn + Math.max(0, winEnd - (clip.timelineStart || 0)),
          timelineStart: 0
        };
        return exportWav(previewClip, 'preview');
      })
      .then(function (inPath) {
        return denoiseFile(inPath, currentOptions());
      })
      .then(function (cleanRes) {
        var cleanPath = (cleanRes && typeof cleanRes === 'object' && cleanRes.outputPath) ? cleanRes.outputPath : cleanRes;
        return loadWavBuffer(cleanPath);
      })
      .then(function (buf) {
        _previewClean = buf;
        setStatus('Preview ready - listen below.', false, true);
        setWorking(false);
        state.working = false;
        playBuffer(buf);
      })
      .catch(function (err) {
        setStatus(err && err.message ? 'Preview failed: ' + err.message : 'Preview failed.', true);
        setWorking(false);
        state.working = false;
      });
  }

  function loadWavBuffer(path) {
    var api = ffmpeg();
    if (api && api.readWavBuffer) return api.readWavBuffer(path);
    return Promise.reject(new Error('Cannot load preview audio.'));
  }

  function playBuffer(buf) {
    try {
      if (!_previewCtx) {
        var AC = global.AudioContext || global.webkitAudioContext;
        if (!AC) return;
        _previewCtx = new AC();
      }
      if (_previewSrc) { try { _previewSrc.stop(); } catch (_) {} }
      _previewCtx.decodeAudioData(buf.slice(0)).then(function (audioBuf) {
        _previewSrc = _previewCtx.createBufferSource();
        _previewSrc.buffer = audioBuf;
        _previewSrc.connect(_previewCtx.destination);
        _previewSrc.start();
        setStatus('Preview playing - cleaned audio.');
      }).catch(function () {
        setStatus('Preview decoded but could not play.', true);
      });
    } catch (e) {
      setStatus('Preview playback unavailable.', true);
    }
  }

  function stopPreview() {
    if (_previewSrc) { try { _previewSrc.stop(); } catch (_) {} _previewSrc = null; }
  }

  // ── Controls ─────────────────────────────────────────────────────────────
  function bindControls() {
    if (!el.noise) return;
    el.noise.addEventListener('input', function () {
      state.noiseAmount = Number(el.noise.value);
      el.noiseVal.textContent = state.noiseAmount + '%';
      // Reflect preset state visually once the user touches the slider.
      el.presetBtns.forEach(function (b) { b.classList.remove('active'); });
    });
    el.mix.addEventListener('input', function () {
      state.mix = Number(el.mix.value);
      el.mixVal.textContent = state.mix + '%';
    });
    el.normalize.addEventListener('change', function () { state.normalize = el.normalize.checked; });

    el.presetBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-preset');
        if (!PRESETS[id]) return;
        state.preset = id;
        el.presetBtns.forEach(function (b) { b.classList.toggle('active', b === btn); });
        var p = PRESETS[id];
        state.noiseAmount = Math.round(p.strength * 100);
        el.noise.value = state.noiseAmount;
        el.noiseVal.textContent = state.noiseAmount + '%';
        state.normalize = !!p.normalize;
        el.normalize.checked = state.normalize;
      });
    });

    el.modeRadios.forEach(function (r) {
      r.addEventListener('change', function () {
        if (r.checked) state.outputMode = r.value;
        if (el.fileOnly) el.fileOnly.checked = state.outputMode === 'file';
      });
    });

    el.refresh.addEventListener('click', function () {
      setStatus('Refreshing selection...', false, true);
      refreshSelection().then(function () { setStatus(''); });
    });
    el.preview.addEventListener('click', previewPlayheadClip);
    el.clean.addEventListener('click', enhanceClip);
    if (el.autoMix) el.autoMix.addEventListener('click', applyAutoMix);
    if (el.ab) el.ab.addEventListener('click', function () {
      if (_previewClean) playBuffer(_previewClean); else setStatus('Run Preview first.', true);
    });
  }

  function setWorking(on) {
    if (!el.clean) return;
    el.clean.disabled = on || enabledClips().length === 0;
    if (el.preview) el.preview.disabled = on;
    el.clean.textContent = on ? 'Processing...' : 'Enhance Voice';
  }

  // ── Init ─────────────────────────────────────────────────────────────────
  function init() {
    cacheEls();
    bindControls();
    setWorking(false);
    // Load defaults from state.
    var p = PRESETS[state.preset];
    if (el.noise) { el.noise.value = state.noiseAmount; }
    if (el.noiseVal) el.noiseVal.textContent = state.noiseAmount + '%';
    if (el.mix) el.mix.value = state.mix;
    if (el.mixVal) el.mixVal.textContent = state.mix + '%';
    if (el.normalize) el.normalize.checked = state.normalize;
    if (el.presetBtns.length) {
      el.presetBtns.forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-preset') === state.preset); });
    }
    el.modeRadios.forEach(function (r) { r.checked = r.value === state.outputMode; });
    if (el.fileOnly) el.fileOnly.checked = state.outputMode === 'file';
    refreshSelection(true);
    global.addEventListener('compx:rail-route', function (event) {
      if (event && event.detail && event.detail.type === 'audio') refreshSelection(true);
    });
  }

  if (typeof document !== 'undefined' && document.readyState !== 'loading') {
    init();
  } else if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', init);
  }

  // Public surface for tests / other panels.
  global.AudioPanel = {
    refreshSelection: refreshSelection,
    enhanceClip: enhanceClip,
    preview: previewPlayheadClip,
    stopPreview: stopPreview,
    getState: function () { return state; },
    init: init
  };

})(typeof window !== 'undefined' ? window : this);
