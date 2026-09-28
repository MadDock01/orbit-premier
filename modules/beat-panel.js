/**
 * beat-panel.js - Beat Lab controller.
 * Dual beat/onset detection, corrected beat grid, deterministic selection,
 * cached analysis, in-panel audio/tick preview, marker tools and Beat Motion.
 */
(function (global) {
  'use strict';

  var CACHE_KEY = 'compx_orbit_beat_cache_v2';
  var CACHE_VERSION = 3;
  var state = {
    trackVal: '',
    analysis: null,
    events: [],
    selected: [],
    manual: {},
    region: null,
    peaks: [],
    wavPath: '',
    busy: false,
    action: 'markers',
    audio: null,
    preview: null,
    previewStartedAt: 0,
    playhead: -1
  };

  function byId(id) { return document.getElementById(id); }
  var el = {
    tracks: byId('beatTrackList'), refresh: byId('beatRefresh'),
    canvas: byId('beatWaveform'), wrap: byId('beatWaveWrap'), hint: byId('beatWaveHint'),
    bpm: byId('beatBpm'), count: byId('beatBeatCount'), onsets: byId('beatOnsetCount'), dur: byId('beatDur'),
    manualBpm: byId('beatManualBpm'), half: byId('beatBpmHalf'), double: byId('beatBpmDouble'),
    offset: byId('beatOffset'), offsetValue: byId('beatOffsetValue'),
    includeOnsets: byId('beatIncludeOnsets'), subdivision: byId('beatSubdivision'), everyNth: byId('beatEveryNth'),
    strength: byId('beatStrength'), strengthValue: byId('beatStrengthValue'),
    amount: byId('beatAmount'), amountValue: byId('beatAmountValue'),
    chaos: byId('beatChaos'), chaosValue: byId('beatChaosValue'),
    minDistance: byId('beatMinDistance'), minDistanceValue: byId('beatMinDistanceValue'),
    seed: byId('beatSeed'), randomizeSeed: byId('beatRandomizeSeed'),
    previewPlay: byId('beatPreviewPlay'), audioVolume: byId('beatAudioVolume'), tickVolume: byId('beatTickVolume'),
    markerType: byId('beatMarkerType'), scope: byId('beatScope'), markerOptions: byId('beatMarkerOptions'),
    motionOptions: byId('beatMotionOptions'), motionProperty: byId('beatMotionProperty'),
    motionCurve: byId('beatMotionCurve'), motionAmount: byId('beatMotionAmount'),
    motionDuration: byId('beatMotionDuration'), motionRepeat: byId('beatMotionRepeat'),
    motionStagger: byId('beatMotionStagger'), ripple: byId('beatRipple'),
    montageOptions: byId('beatMontageOptions'), montageMode: byId('beatMontageMode'),
    montageTrack: byId('beatMontageTrack'), montageConstant: byId('beatMontageConstant'),
    montageConstantRow: byId('beatMontageConstantRow'), montageDuration: byId('beatMontageDuration'),
    montageOrder: byId('beatMontageOrder'), montageSourceStart: byId('beatMontageSourceStart'),
    montageMinShot: byId('beatMontageMinShot'), montageMaxShot: byId('beatMontageMaxShot'),
    montageTransition: byId('beatMontageTransition'), montageTransitionFrames: byId('beatMontageTransitionFrames'),
    montageRepeat: byId('beatMontageRepeat'), montagePlayhead: byId('beatMontagePlayhead'),
    montageSafety: byId('beatMontageSafety'), montageSourceAudio: byId('beatMontageSourceAudio'),
    montageOverwrite: byId('beatMontageOverwrite'), montageRefreshSources: byId('beatMontageRefreshSources'),
    montageSourceCount: byId('beatMontageSourceCount'), montagePreview: byId('beatMontagePreview'),
    montagePlan: byId('beatMontagePlan'),
    analyze: byId('beatAnalyze'), sync: byId('beatSync'), status: byId('beatStatus'),
    actions: Array.prototype.slice.call(document.querySelectorAll('input[name="beatAction"]')),
    markerCommands: Array.prototype.slice.call(document.querySelectorAll('.beat-marker-command'))
  };

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

  function setStatus(text, isError, busy) {
    if (!el.status) return;
    el.status.textContent = text || '';
    el.status.className = 'beat-status' + (isError ? ' error' : '') + (busy ? ' busy' : '');
  }

  function fmtDur(sec) {
    if (!isFinite(sec) || sec < 0) return '-';
    var m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function numberValue(node, fallback) {
    var n = node ? Number(node.value) : NaN;
    return isFinite(n) ? n : fallback;
  }

  function simpleHash(value) {
    var text = String(value || ''), hash = 2166136261;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(36);
  }

  function clipSignature(clips) {
    return simpleHash(JSON.stringify((clips || []).map(function (clip) {
      return [clip.sourceFile, clip.srcIn, clip.srcOut, clip.timelineStart];
    })));
  }

  function readCache() {
    try {
      var data = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
      return data.version === CACHE_VERSION && data.entries ? data : { version: CACHE_VERSION, entries: {} };
    } catch (_) { return { version: CACHE_VERSION, entries: {} }; }
  }

  function cacheGet(key) {
    var cache = readCache(), row = cache.entries[key];
    if (!row) return null;
    row.lastUsed = Date.now();
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (_) {}
    return row;
  }

  function cachePut(key, row) {
    var cache = readCache();
    row.lastUsed = Date.now();
    cache.entries[key] = row;
    var keys = Object.keys(cache.entries).sort(function (a, b) {
      return cache.entries[b].lastUsed - cache.entries[a].lastUsed;
    });
    for (var i = 8; i < keys.length; i++) delete cache.entries[keys[i]];
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (_) {}
  }

  function loadTracks() {
    hostCall('orbitGetTrackList', [], 8000).then(function (result) {
      if (result && result.error) throw new Error(result.error);
      var tracks = Array.isArray(result) ? result : (result && Array.isArray(result.tracks) ? result.tracks : []);
      if (!tracks || !el.tracks) return;
      var audio = tracks.filter(function (track) { return track.type === 'audio'; });
      el.tracks.innerHTML = '';
      if (!audio.length) {
        el.tracks.innerHTML = '<span class="track-list-hint">no audio tracks</span>';
        return;
      }
      audio.forEach(function (track, index) {
        var value = track.type + ':' + track.index;
        var label = document.createElement('label');
        label.className = 'track-chip' + ((state.trackVal ? value === state.trackVal : index === 0) ? ' checked' : '');
        var radio = document.createElement('input');
        radio.type = 'radio'; radio.name = 'beat-track'; radio.value = value;
        radio.checked = state.trackVal ? value === state.trackVal : index === 0;
        radio.addEventListener('change', function () {
          stopPreview();
          state.trackVal = value;
          Array.prototype.forEach.call(el.tracks.querySelectorAll('label'), function (node) {
            node.classList.remove('checked');
          });
          label.classList.add('checked');
        });
        label.appendChild(radio);
        label.appendChild(document.createTextNode(track.name));
        el.tracks.appendChild(label);
        if (radio.checked) state.trackVal = value;
      });
    }).catch(function (error) {
      if (el.tracks) el.tracks.textContent = (error && error.message) || 'host unavailable';
    });
  }

  var ctx = el.canvas ? el.canvas.getContext('2d') : null;
  function resizeCanvas() {
    if (!el.canvas || !ctx) return;
    var rect = el.wrap ? el.wrap.getBoundingClientRect() : null;
    el.canvas.width = Math.max(280, Math.round((rect && rect.width) || 280));
    el.canvas.height = 82;
    draw();
  }

  function draw() {
    if (!ctx || !el.canvas) return;
    var W = el.canvas.width, H = el.canvas.height, duration = state.analysis ? state.analysis.duration : 0;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#050806'; ctx.fillRect(0, 0, W, H);
    var mid = H / 2;
    if (state.peaks.length) {
      var barW = W / state.peaks.length;
      for (var i = 0; i < state.peaks.length; i++) {
        var height = Math.max(1, state.peaks[i] * H * 0.76);
        ctx.fillStyle = 'rgba(58,127,213,.78)';
        ctx.fillRect(i * barW, mid - height / 2, Math.max(1, barW - .5), height);
      }
    }
    if (duration > 0) {
      if (state.region) {
        ctx.fillStyle = 'rgba(67,237,126,.16)';
        ctx.fillRect(state.region[0] / duration * W, 0, (state.region[1] - state.region[0]) / duration * W, H);
      }
      for (var j = 0; j < state.events.length; j++) {
        var event = state.events[j];
        var x = event.t / duration * W;
        if (event.selected) ctx.fillStyle = event.type === 'onset' ? '#ffad42' : '#43ed7e';
        else ctx.fillStyle = event.type === 'onset' ? 'rgba(255,173,66,.28)' : 'rgba(83,105,91,.34)';
        ctx.fillRect(Math.round(x), event.selected ? 0 : 12, event.selected ? 2 : 1, event.selected ? H : H - 24);
      }
      if (state.playhead >= 0) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(state.playhead / duration * W, 0, 1, H);
      }
      ctx.fillStyle = 'rgba(255,255,255,.35)';
      ctx.font = '9px monospace';
      var label = fmtDur(duration);
      ctx.fillText(label, W - ctx.measureText(label).width - 4, H - 4);
    }
  }

  function selectionOptions() {
    return {
      bpm: numberValue(el.manualBpm, state.analysis ? state.analysis.bpm : 0),
      offset: (state.analysis ? state.analysis.offset : 0) + numberValue(el.offset, 0) / 1000,
      includeOnsets: !!(el.includeOnsets && el.includeOnsets.checked),
      subdivisions: numberValue(el.subdivision, 1),
      everyNth: numberValue(el.everyNth, 1),
      strength: numberValue(el.strength, 70),
      amount: numberValue(el.amount, 100),
      chaos: numberValue(el.chaos, 0),
      minDistance: numberValue(el.minDistance, 0) / 1000,
      seed: numberValue(el.seed, 1337)
    };
  }

  function updateSelection() {
    if (!state.analysis) { state.events = []; state.selected = []; draw(); return; }
    var result = global.BeatEngine.selectEvents(state.analysis, selectionOptions());
    for (var i = 0; i < result.all.length; i++) {
      var key = Math.round(result.all[i].t * 1000);
      if (state.manual.hasOwnProperty(key)) result.all[i].selected = state.manual[key];
    }
    state.events = result.all;
    state.selected = state.events.filter(function (event) { return event.selected; });
    if (el.count) el.count.textContent = String(state.selected.length);
    if (el.bpm) el.bpm.textContent = result.bpm ? String(Math.round(result.bpm * 10) / 10) : '-';
    updateApplyState();
    draw();
  }

  function montageDuration() {
    var manual = numberValue(el.montageDuration, 0);
    return manual > 0 ? manual : (state.analysis ? Number(state.analysis.duration) || 0 : 0);
  }

  function montageSettings() {
    return {
      mode: el.montageMode ? el.montageMode.value : 'beat',
      targetTrack: Math.max(1, Math.round(numberValue(el.montageTrack, 2))),
      constantDuration: Math.max(.1, numberValue(el.montageConstant, 2.5)),
      durationSec: montageDuration(),
      order: el.montageOrder ? el.montageOrder.value : 'sequential',
      sourceStart: el.montageSourceStart ? el.montageSourceStart.value : 'random',
      minShot: Math.max(.1, numberValue(el.montageMinShot, .5)),
      maxShot: Math.max(.1, numberValue(el.montageMaxShot, 4)),
      transition: el.montageTransition ? el.montageTransition.value : '',
      transitionFrames: Math.max(1, Math.round(numberValue(el.montageTransitionFrames, 6))),
      repeat: !!(el.montageRepeat && el.montageRepeat.checked),
      startAtPlayhead: !!(el.montagePlayhead && el.montagePlayhead.checked),
      safetyCopy: !!(el.montageSafety && el.montageSafety.checked),
      keepSourceAudio: !!(el.montageSourceAudio && el.montageSourceAudio.checked),
      allowOverwrite: !!(el.montageOverwrite && el.montageOverwrite.checked),
      seed: numberValue(el.seed, 1337)
    };
  }

  function montageCanApply() {
    if (state.action !== 'montage') return !!state.selected.length;
    var settings = montageSettings();
    if (settings.mode === 'beat') return !!state.selected.length && settings.durationSec > 0;
    if (settings.mode === 'constant') return settings.durationSec > 0;
    return true;
  }

  function updateApplyState() {
    if (el.sync) el.sync.disabled = state.busy || !montageCanApply();
  }

  function updateMontageMode() {
    var mode = el.montageMode ? el.montageMode.value : 'beat';
    if (el.montageConstantRow) el.montageConstantRow.style.display = mode === 'constant' ? 'grid' : 'none';
    if (el.montagePlan) {
      if (mode === 'beat') el.montagePlan.textContent = 'Uses the green beat/onset lines selected above.';
      else if (mode === 'constant') el.montagePlan.textContent = 'Creates equal-duration cuts for the full edit duration.';
      else el.montagePlan.textContent = 'Uses sequence markers as edit points.';
    }
    updateApplyState();
  }

  function refreshMontageSources(showPlan) {
    var settings = montageSettings();
    if (el.montageRefreshSources) el.montageRefreshSources.disabled = true;
    return hostCall('beatMontageInspectSources', [JSON.stringify(settings)], 15000).then(function (result) {
      if (!result || result.error) throw new Error((result && result.error) || 'Could not inspect Project sources.');
      var names = result.names || [];
      if (el.montageSourceCount) {
        el.montageSourceCount.textContent = result.sourceCount ?
          result.sourceCount + ' source' + (result.sourceCount === 1 ? '' : 's') + (names.length ? ' - ' + names.slice(0, 3).join(', ') : '') :
          'No supported Project clips selected';
      }
      if (showPlan && el.montagePlan) {
        var mode = settings.mode === 'beat' ? state.selected.length + ' selected beat point(s)' :
          (settings.mode === 'constant' ? settings.constantDuration + 's constant cuts' : result.markerCount + ' sequence marker(s)');
        var duration = settings.durationSec > 0 ? Math.round(settings.durationSec * 10) / 10 + 's' : 'marker-defined duration';
        el.montagePlan.textContent = result.sourceCount + ' source(s) - ' + mode + ' - ' + duration + ' - V' + settings.targetTrack + '. Nothing changed yet.';
      }
      return result;
    }).catch(function (error) {
      if (el.montageSourceCount) el.montageSourceCount.textContent = 'No supported Project clips selected';
      if (showPlan && el.montagePlan) el.montagePlan.textContent = error.message;
      throw error;
    }).then(function (result) {
      if (el.montageRefreshSources) el.montageRefreshSources.disabled = false;
      return result;
    }, function (error) {
      if (el.montageRefreshSources) el.montageRefreshSources.disabled = false;
      throw error;
    });
  }

  function previewMontage() {
    setStatus('Reading selected Project sources...', false, true);
    refreshMontageSources(true).then(function (result) {
      if (!result.sourceCount) setStatus('Select video/image clips or a bin in the Project panel.', true);
      else setStatus('Montage plan ready. Review it, then Apply Selected.', false);
    }).catch(function (error) { setStatus(error.message || 'Preview failed.', true); });
  }

  function applyAnalysis(analysis, peaks, wavPath, fromCache) {
    stopPreview();
    state.analysis = analysis;
    state.peaks = peaks || [];
    state.wavPath = wavPath || '';
    state.audio = null;
    state.manual = {};
    state.region = null;
    if (el.manualBpm) el.manualBpm.value = analysis.bpm ? String(analysis.bpm) : '';
    if (el.offset) el.offset.value = '0';
    if (el.offsetValue) el.offsetValue.textContent = '0 ms';
    if (el.onsets) el.onsets.textContent = String((analysis.onsets || []).length);
    if (el.dur) el.dur.textContent = fmtDur(analysis.duration);
    if (el.hint) el.hint.classList.add('hidden');
    if (el.previewPlay) el.previewPlay.disabled = !state.wavPath;
    updateSelection();
    setStatus((fromCache ? 'Cached result - ' : '') + 'Found ' + analysis.bpm + ' BPM, ' +
      (analysis.onsets || []).length + ' onsets.', false);
  }

  function analyze() {
    if (state.busy) return;
    if (!state.trackVal) { setStatus('Pick a music track first.', true); return; }
    stopPreview();
    state.busy = true;
    if (el.analyze) el.analyze.disabled = true;
    if (el.sync) el.sync.disabled = true;
    setStatus('Loading track...', false, true);
    var parts = state.trackVal.split(':'), clips, signature;

    hostCall('getAudioTrackClips', [parts[0], parseInt(parts[1], 10)], 15000)
      .then(function (rows) {
        clips = rows;
        if (!clips || !clips.length) throw new Error('No clips on this track.');
        signature = state.trackVal + ':' + clipSignature(clips);
        var cached = cacheGet(signature);
        function extractWav() {
          return hostCall('getTempDir', [], 10000).then(function (tmpDir) {
            var outPath = (tmpDir + '/compx_orbit_beat_' + simpleHash(signature) + '.wav').replace(/\\/g, '/');
            return global.FFmpegAPI.extractSegments(clips, outPath);
          });
        }
        if (cached && cached.analysis) {
          var validate = cached.wavPath && global.FFmpegAPI.readWavBuffer ?
            global.FFmpegAPI.readWavBuffer(cached.wavPath) : Promise.reject(new Error('Cached preview missing'));
          return validate.then(function () {
            applyAnalysis(cached.analysis, cached.peaks, cached.wavPath, true);
            return null;
          }).catch(function () {
            setStatus('Restoring cached preview audio...', false, true);
            return extractWav().then(function (audioResult) {
              cached.wavPath = audioResult.outputPath;
              cachePut(signature, cached);
              applyAnalysis(cached.analysis, cached.peaks, cached.wavPath, true);
              return null;
            });
          });
        }
        return extractWav();
      })
      .then(function (result) {
        if (!result) return null;
        state.wavPath = result.outputPath;
        setStatus('Detecting beats and onsets...', false, true);
        return global.FFmpegAPI.decodePcm(state.wavPath, 8000);
      })
      .then(function (pcm) {
        if (!pcm) return null;
        var analysis = global.BeatEngine.analyzeBeats(pcm.samples, pcm.sampleRate);
        if (!analysis.bpm && !(analysis.onsets || []).length) throw new Error('No beat or transient activity found.');
        return global.FFmpegAPI.waveform(state.wavPath, 600)
          .then(function (waveform) { return { analysis: analysis, peaks: waveform.peaks || [] }; })
          .catch(function () { return { analysis: analysis, peaks: [] }; });
      })
      .then(function (result) {
        if (!result) return;
        cachePut(signature, { analysis: result.analysis, peaks: result.peaks, wavPath: state.wavPath });
        applyAnalysis(result.analysis, result.peaks, state.wavPath, false);
      })
      .catch(function (error) {
        setStatus(error && error.message ? error.message : 'Analysis failed.', true);
      })
      .then(function () {
        state.busy = false;
        if (el.analyze) el.analyze.disabled = false;
        if (el.sync) el.sync.disabled = !state.selected.length;
      });
  }

  function ensureAudio() {
    if (state.audio) return Promise.resolve(state.audio);
    if (!state.wavPath) return Promise.reject(new Error('Analyze audio before preview.'));
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return Promise.reject(new Error('Web Audio preview is unavailable.'));
    var context = state.preview && state.preview.context ? state.preview.context : new AC();
    return global.FFmpegAPI.readWavBuffer(state.wavPath).then(function (buffer) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        function ok(decoded) {
          if (settled) return; settled = true;
          state.audio = { context: context, buffer: decoded };
          resolve(state.audio);
        }
        function fail(error) {
          if (settled) return; settled = true;
          reject(error || new Error('Cannot decode preview audio.'));
        }
        try {
          var promise = context.decodeAudioData(buffer, ok, fail);
          if (promise && promise.then) promise.then(ok).catch(fail);
        } catch (error) { fail(error); }
      });
    });
  }

  function createClick(context) {
    var length = Math.max(1, Math.round(context.sampleRate * .025));
    var buffer = context.createBuffer(1, length, context.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < length; i++) data[i] = Math.sin(2 * Math.PI * 1350 * i / context.sampleRate) * Math.exp(-i / (context.sampleRate * .006));
    return buffer;
  }

  function stopPreview() {
    if (state.preview) {
      try { state.preview.source.stop(); } catch (_) {}
      for (var i = 0; i < state.preview.clicks.length; i++) {
        try { state.preview.clicks[i].stop(); } catch (_) {}
      }
      if (state.preview.raf) cancelAnimationFrame(state.preview.raf);
    }
    state.preview = null;
    state.playhead = -1;
    if (el.previewPlay) el.previewPlay.innerHTML = '&#9654; Preview';
    if (el.wrap) el.wrap.classList.remove('playing');
    draw();
  }

  function animatePreview() {
    if (!state.preview || !state.analysis) return;
    state.playhead = state.preview.context.currentTime - state.previewStartedAt;
    if (state.playhead >= state.analysis.duration) { stopPreview(); return; }
    draw();
    state.preview.raf = requestAnimationFrame(animatePreview);
  }

  function togglePreview() {
    if (state.preview) { stopPreview(); return; }
    setStatus('Loading preview...', false, true);
    ensureAudio().then(function (audio) {
      if (audio.context.state === 'suspended') audio.context.resume();
      var source = audio.context.createBufferSource();
      var audioGain = audio.context.createGain(), tickGain = audio.context.createGain();
      audioGain.gain.value = numberValue(el.audioVolume, 80) / 100;
      tickGain.gain.value = numberValue(el.tickVolume, 45) / 100;
      source.buffer = audio.buffer;
      source.connect(audioGain); audioGain.connect(audio.context.destination);
      tickGain.connect(audio.context.destination);
      var startAt = audio.context.currentTime + .04;
      var clicks = [], clickBuffer = createClick(audio.context);
      for (var i = 0; i < state.selected.length; i++) {
        var click = audio.context.createBufferSource();
        click.buffer = clickBuffer; click.connect(tickGain);
        click.start(startAt + state.selected[i].t);
        clicks.push(click);
      }
      source.start(startAt);
      state.previewStartedAt = startAt;
      state.preview = { context: audio.context, source: source, audioGain: audioGain, tickGain: tickGain, clicks: clicks, raf: 0 };
      source.onended = function () { if (state.preview && state.preview.source === source) stopPreview(); };
      if (el.previewPlay) el.previewPlay.innerHTML = '&#9632; Stop';
      if (el.wrap) el.wrap.classList.add('playing');
      setStatus('Previewing selected beats and onsets.', false);
      animatePreview();
    }).catch(function (error) {
      setStatus(error && error.message ? error.message : 'Preview failed.', true);
    });
  }

  function selectedTimes() {
    return state.selected.map(function (event) { return Math.round(event.t * 1000) / 1000; });
  }

  function rippleRanges(times, selection) {
    var items = (selection && selection.items) || [], ranges = [];
    for (var i = 0; i + 1 < times.length; i += 2) {
      for (var c = 0; c < items.length; c++) {
        var start = Math.max(times[i], items[c].start), end = Math.min(times[i + 1], items[c].end);
        if (end - start > .05) ranges.push({ start: start, end: end, duration: end - start });
      }
    }
    return ranges;
  }

  function actionResultCount(result) {
    if (!result) return 0;
    var names = ['created', 'added', 'clips', 'moved', 'markers', 'keys', 'deleted', 'copied', 'pasted'];
    for (var i = 0; i < names.length; i++) if (result[names[i]] != null) return result[names[i]];
    return 0;
  }

  function syncToBeat() {
    if (state.busy || !montageCanApply()) return;
    stopPreview();
    var times = selectedTimes(), promise;
    state.busy = true;
    if (el.sync) el.sync.disabled = true;
    setStatus(state.action === 'montage' ? 'Building montage...' : 'Applying...', false, true);

    if (state.action === 'markers') {
      promise = hostCall('beatCreateMarkers', [
        JSON.stringify(times), el.markerType.value, el.scope.value, 'Beat'
      ], 45000);
    } else if (state.action === 'cut') {
      if (el.ripple && el.ripple.checked) {
        promise = hostCall('motionGetSelection', [], 8000).then(function (selection) {
          var ranges = rippleRanges(times, selection);
          if (!ranges.length) throw new Error('No beat intervals inside selected clips.');
          return hostCall('removeSilenceRanges', [JSON.stringify(ranges), '[]'], 60000);
        });
      } else promise = hostCall('beatCutClips', [JSON.stringify(times)], 60000);
    } else if (state.action === 'arrange') {
      promise = hostCall('beatArrangeClips', [JSON.stringify(times)], 45000);
    } else if (state.action === 'motion') {
      promise = hostCall('beatApplyMotion', [JSON.stringify(times), JSON.stringify({
        property: el.motionProperty.value,
        curve: el.motionCurve.value,
        amount: numberValue(el.motionAmount, 12),
        durationFrames: numberValue(el.motionDuration, 8),
        repeatEvery: numberValue(el.motionRepeat, 1),
        staggerFrames: numberValue(el.motionStagger, 0)
      })], 90000);
    } else {
      promise = hostCall('beatBuildMontage', [
        JSON.stringify((el.montageMode && el.montageMode.value === 'beat') ? times : []),
        JSON.stringify(montageSettings())
      ], 180000);
    }

    promise.then(function (result) {
      if (result && result.error) setStatus(result.error, true);
      else if (!(Number(actionResultCount(result)) > 0)) {
        setStatus('No changes were confirmed by Premiere. Check the selected clips, target track and beat range.', true);
      } else if (state.action === 'montage') {
        setStatus('Montage ready - ' + actionResultCount(result) + ' clip(s) on V' + (result.targetTrack || montageSettings().targetTrack) +
          (result.backupCreated ? ' - sequence backup created.' : '.'), false);
        if (el.montagePlan) el.montagePlan.textContent = (result.created || 0) + ' clips created, ' + (result.skipped || 0) + ' skipped' +
          (result.transitions ? ', ' + result.transitions + ' transition edge(s).' : '.');
      } else setStatus('Done - ' + actionResultCount(result) + ' item(s) changed.', false);
    }).catch(function (error) {
      setStatus(error && error.message ? error.message : 'Apply failed.', true);
    }).then(function () {
      state.busy = false;
      updateApplyState();
    });
  }

  function markerCommand(command) {
    setStatus(command.charAt(0).toUpperCase() + command.slice(1) + ' markers...', false, true);
    hostCall('beatManageMarkers', [command, el.markerType.value, el.scope.value], 45000)
      .then(function (result) {
        if (result && result.error) setStatus(result.error, true);
        else setStatus('Marker ' + command + ': ' + actionResultCount(result) + '.', false);
      })
      .catch(function (error) { setStatus(error && error.message ? error.message : 'Marker command failed.', true); });
  }

  function updateActionPanels() {
    if (el.markerOptions) el.markerOptions.style.display = state.action === 'markers' ? 'block' : 'none';
    if (el.motionOptions) el.motionOptions.style.display = state.action === 'motion' ? 'block' : 'none';
    if (el.montageOptions) el.montageOptions.style.display = state.action === 'montage' ? 'block' : 'none';
    if (el.ripple) el.ripple.style.display = state.action === 'cut' ? 'flex' : 'none';
    if (el.sync) el.sync.textContent = state.action === 'montage' ? 'Build Montage' : 'Apply Selected';
    updateApplyState();
  }

  function bindRange(node, output, suffix, callback) {
    if (!node) return;
    node.addEventListener('input', function () {
      if (output) output.textContent = node.value + suffix;
      if (callback) callback();
    });
  }

  function init() {
    if (!el.canvas || !global.BeatEngine) return;
    if (el.refresh) el.refresh.addEventListener('click', loadTracks);
    if (el.analyze) el.analyze.addEventListener('click', analyze);
    if (el.sync) el.sync.addEventListener('click', syncToBeat);
    if (el.previewPlay) el.previewPlay.addEventListener('click', togglePreview);
    if (el.montageRefreshSources) el.montageRefreshSources.addEventListener('click', function () {
      refreshMontageSources(false).then(function (result) {
        setStatus(result.sourceCount ? result.sourceCount + ' montage source(s) ready.' : 'Select clips or a bin in the Project panel.', !result.sourceCount);
      }).catch(function (error) { setStatus(error.message || 'Source refresh failed.', true); });
    });
    if (el.montagePreview) el.montagePreview.addEventListener('click', previewMontage);
    if (el.montageMode) el.montageMode.addEventListener('change', updateMontageMode);
    [el.montageDuration, el.montageConstant, el.montageMinShot, el.montageMaxShot].forEach(function (node) {
      if (node) node.addEventListener('input', updateApplyState);
    });

    bindRange(el.offset, el.offsetValue, ' ms', updateSelection);
    bindRange(el.strength, el.strengthValue, '%', updateSelection);
    bindRange(el.amount, el.amountValue, '%', updateSelection);
    bindRange(el.chaos, el.chaosValue, '%', updateSelection);
    bindRange(el.minDistance, el.minDistanceValue, ' ms', updateSelection);

    [el.manualBpm, el.includeOnsets, el.subdivision, el.everyNth, el.seed].forEach(function (node) {
      if (node) node.addEventListener('change', updateSelection);
    });
    if (el.half) el.half.addEventListener('click', function () {
      var bpm = numberValue(el.manualBpm, state.analysis ? state.analysis.bpm : 0);
      if (bpm) { el.manualBpm.value = String(Math.round(bpm * 5) / 10); updateSelection(); }
    });
    if (el.double) el.double.addEventListener('click', function () {
      var bpm = numberValue(el.manualBpm, state.analysis ? state.analysis.bpm : 0);
      if (bpm) { el.manualBpm.value = String(Math.round(bpm * 20) / 10); updateSelection(); }
    });
    if (el.randomizeSeed) el.randomizeSeed.addEventListener('click', function () {
      el.seed.value = String(Math.floor(Math.random() * 2147483646) + 1);
      updateSelection();
    });
    if (el.audioVolume) el.audioVolume.addEventListener('input', function () {
      if (state.preview) state.preview.audioGain.gain.value = numberValue(el.audioVolume, 80) / 100;
    });
    if (el.tickVolume) el.tickVolume.addEventListener('input', function () {
      if (state.preview) state.preview.tickGain.gain.value = numberValue(el.tickVolume, 45) / 100;
    });

    // CEP's Chromium has no :has(), so mark the chosen option's label here.
    function syncActionLabels() {
      el.actions.forEach(function (other) {
        if (other.parentNode && other.parentNode.classList) other.parentNode.classList.toggle('is-checked', other.checked);
      });
    }
    syncActionLabels();
    el.actions.forEach(function (input) {
      input.addEventListener('change', function () {
        syncActionLabels();
        if (input.checked) {
          state.action = input.value; updateActionPanels();
          if (state.action === 'montage') refreshMontageSources(false).catch(function () {});
        }
      });
    });
    el.markerCommands.forEach(function (button) {
      button.addEventListener('click', function () { markerCommand(button.getAttribute('data-command')); });
    });

    var regionStart = null, suppressBeatClick = false;
    function canvasTime(event) {
      var box = el.canvas.getBoundingClientRect();
      return Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * state.analysis.duration;
    }
    el.canvas.addEventListener('mousedown', function (event) {
      if (!event.shiftKey || !state.analysis) return;
      regionStart = canvasTime(event);
      event.preventDefault();
    });
    global.addEventListener('mouseup', function (event) {
      if (regionStart === null || !state.analysis) return;
      var end = canvasTime(event);
      state.region = [Math.min(regionStart, end), Math.max(regionStart, end)];
      regionStart = null; suppressBeatClick = true; draw();
      global.setTimeout(function () { suppressBeatClick = false; }, 0);
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-beat-region]'), function (button) {
      button.addEventListener('click', function () {
        if (!state.analysis) return;
        var mode = button.getAttribute('data-beat-region');
        if (mode === 'clear') { state.region = null; draw(); return; }
        if (!state.region) { setStatus('Shift-drag on the waveform to highlight a region first.', true); return; }
        state.events.forEach(function (event) {
          var inside = event.t >= state.region[0] && event.t <= state.region[1];
          if (inside || mode === 'replace') state.manual[Math.round(event.t * 1000)] = inside && mode !== 'remove';
        });
        updateSelection();
      });
    });
    el.canvas.addEventListener('click', function (event) {
      if (suppressBeatClick || event.shiftKey) return;
      if (!state.analysis || !state.events.length) return;
      var rect = el.canvas.getBoundingClientRect();
      var time = (event.clientX - rect.left) / rect.width * state.analysis.duration;
      var nearest = null, distance = Infinity;
      for (var i = 0; i < state.events.length; i++) {
        var d = Math.abs(state.events[i].t - time);
        if (d < distance) { distance = d; nearest = state.events[i]; }
      }
      if (nearest && distance <= state.analysis.duration * 9 / el.canvas.width) {
        var key = Math.round(nearest.t * 1000);
        state.manual[key] = !nearest.selected;
        updateSelection();
      }
    });

    loadTracks();
    global.addEventListener('compx:rail-route', function (event) {
      if (event && event.detail && event.detail.type === 'beat') loadTracks();
    });
    updateMontageMode();
    updateActionPanels();
    setTimeout(resizeCanvas, 50);
    global.addEventListener('resize', resizeCanvas);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  global.BeatPanel = { init: init, refresh: loadTracks, stopPreview: stopPreview };
})(window);
