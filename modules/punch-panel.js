/**
 * punch-panel.js — Auto Punch / Smart Zoom panel controller.
 *
 * Flow: pick a style + tune sliders → ANALYZE (transcript words from Auto
 * Captions + optional volume peaks) → preview the punch list → APPLY sends
 * Motion-Scale keyframes through the existing Motion Engine adapter
 * (motionApplyClipKeyframes) so every punch lands in one undo group.
 */
(function (global) {
  'use strict';

  var state = {
    style: 'youtube',
    frequency: 60,          // 0..100 → low / medium / high
    zoomAmount: 108,
    duration: 0,            // 0 = use preset duration
    avoidConsecutive: true,
    respectPauses: true,
    alternateZoom: true,
    useAudioPeaks: true,
    panPx: 18,
    smoothEase: true,
    clips: [],
    fps: 30,
    punches: [],            // [{ t, zoom, score, reason }] — last analysis
    busy: false
  };

  function freqLabel(v) {
    if (v < 45) return 'Low';
    if (v > 75) return 'High';
    return 'Medium';
  }

  // ── DOM refs ───────────────────────────────────────────────────────────────
  var el = {
    count: document.getElementById('punchSelectionCount'),
    refresh: document.getElementById('punchRefresh'),
    styleBtns: Array.prototype.slice.call(document.querySelectorAll('.punch-style-btn')),
    frequency: document.getElementById('punchFrequency'),
    frequencyVal: document.getElementById('punchFrequencyValue'),
    zoom: document.getElementById('punchZoom'),
    zoomVal: document.getElementById('punchZoomValue'),
    duration: document.getElementById('punchDuration'),
    durationVal: document.getElementById('punchDurationValue'),
    avoid: document.getElementById('punchAvoidConsec'),
    pauses: document.getElementById('punchRespectPauses'),
    alternate: document.getElementById('punchAlternate'),
    audio: document.getElementById('punchUseAudio'),
    pan: document.getElementById('punchPan'),
    panVal: document.getElementById('punchPanValue'),
    ease: document.getElementById('punchEase'),
    analyze: document.getElementById('punchAnalyze'),
    apply: document.getElementById('punchApply'),
    listWrap: document.getElementById('punchListWrap'),
    list: document.getElementById('punchList'),
    countVal: document.getElementById('punchCount'),
    addManual: document.getElementById('punchAddManual'),
    status: document.getElementById('punchStatus')
  };

  // ── Host bridge ────────────────────────────────────────────────────────────
  function hostCall(name, args, timeout) {
    if (global.OrbitCore && global.OrbitCore.host) return global.OrbitCore.host.call(name, args || [], { timeout: timeout || 10000 });
    return new Promise(function (resolve, reject) {
      if (!global.CEP || typeof global.CEP.evalScript !== 'function') {
        reject(new Error('CEP bridge unavailable'));
        return;
      }
      try {
        global.CEP.evalScript(name, args || [], timeout || 10000)
          .then(resolve)
          .catch(reject);
      } catch (e) {
        reject(e);
      }
    });
  }

  function setStatus(text, isError, busy) {
    if (!el.status) return;
    el.status.textContent = text || '';
    el.status.className = 'punch-status' + (isError ? ' error' : '') + (busy ? ' busy' : '');
  }

  function setCount(text) {
    if (el.count) el.count.textContent = text || 'No selection';
  }

  // Large keyframe lists exceed CEP's evalScript argument limit and arrive
  // truncated in ExtendScript. Write them to the OS temp directory instead;
  // only the short file path crosses the bridge.
  function writeMotionPayload(payload) {
    var req = global.require || (typeof require === 'function' ? require : null);
    if (!req) return null;
    var fs = req('fs');
    var path = req('path');
    var os = req('os');
    var folder = path.join(os.tmpdir(), 'CompX-Orbit-Premiere', 'motion-payloads');
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
    var filePath = path.join(folder, 'punch-' + Date.now() + '-' + Math.round(Math.random() * 1000000) + '.json');
    fs.writeFileSync(filePath, JSON.stringify(payload), 'utf8');
    return { path: filePath, fs: fs };
  }

  function refreshSelection(silent) {
    return hostCall('motionGetSelection', [], 8000)
      .then(function (res) {
        if (res && res.items && res.items.length) {
          state.clips = res.items;
          state.fps = res.fps && res.fps > 0 ? res.fps : 30;
          var label = res.items.length + (res.items.length === 1 ? ' clip' : ' clips');
          if (res.source === 'playhead') label += ' · at playhead';
          setCount(label);
          if (!silent && res.source === 'playhead') {
            setStatus('Using clip under playhead. Click Analyze, or select a clip first.', false);
          }
        } else {
          state.clips = [];
          setCount('No selection');
          if (!silent) setStatus('Select a timeline clip (or park the playhead on one), then Analyze.', true);
        }
        return state.clips;
      })
      .catch(function () {
        if (!silent) setCount('Host unavailable');
        state.clips = [];
        return [];
      });
  }

  // ── Sources ────────────────────────────────────────────────────────────────
  // Transcript words written by Auto Captions (persistCaptions) — timeline
  // seconds, same sequence assumption as the captioner.
  function readTranscriptWords() {
    try {
      var raw = global.localStorage.getItem('machicut_captions');
      if (!raw) return [];
      var data = JSON.parse(raw);
      var words = (data && data.words) || [];
      return words.map(function (w) { return { word: w.word || w.text || '', start: Number(w.start), end: Number(w.end) }; })
                  .filter(function (w) { return isFinite(w.start); });
    } catch (e) {
      return [];
    }
  }

  function inClipRange(clips) {
    var ranges = [];
    for (var i = 0; i < clips.length; i++) {
      ranges.push({ start: clips[i].start, end: clips[i].end });
    }
    return function (t) {
      for (var r = 0; r < ranges.length; r++) {
        if (t >= ranges[r].start - 0.05 && t <= ranges[r].end + 0.05) return true;
      }
      return false;
    };
  }

  // Volume peaks from the first audio track that has clips (concat timeline
  // maps 1:1 onto the sequence, so peak times are timeline times already).
  function fetchAudioPeaks() {
    return hostCall('orbitGetTrackList', [], 8000)
      .then(function (result) {
        if (result && result.error) throw new Error(result.error);
        var tracks = Array.isArray(result) ? result : (result && Array.isArray(result.tracks) ? result.tracks : []);
        var audio = (tracks || []).filter(function (t) { return t.type === 'audio'; });
        if (!audio.length) return [];
        return hostCall('getAudioTrackClips', ['audio', audio[0].index], 15000);
      })
      .then(function (clips) {
        if (!clips || !clips.length) return [];
        return hostCall('getTempDir', [], 10000).then(function (tmpDir) {
          var outPath = (tmpDir + '/machicut_punch_audio.wav').replace(/\\/g, '/');
          return global.FFmpegAPI.extractSegments(clips, outPath);
        });
      })
      .then(function (result) {
        return global.FFmpegAPI.decodePcm(result.outputPath, 8000);
      })
      .then(function (pcm) {
        return global.PunchEngine.detectVolumePoints(pcm.samples, pcm.sampleRate);
      })
      .catch(function () {
        return [];          // audio access is optional — transcript alone works
      });
  }

  // ── Analyze ────────────────────────────────────────────────────────────────
  function analyze() {
    if (state.busy) return;
    state.busy = true;
    el.analyze.disabled = true;
    el.apply.disabled = true;
    setStatus('Reading selection…', false, true);

    refreshSelection(true)
      .then(function (clips) {
        if (!clips.length) throw new Error('Select a timeline clip first (or put the playhead on Export.mp4 / your clip), then Analyze.');
        setStatus('Detecting emphasis…', false, true);
        var words = readTranscriptWords();
        var wordPoints = words.length ? global.PunchEngine.detectWordPoints(words) : [];
        var audioPromise = (state.useAudioPeaks && global.FFmpegAPI && typeof global.FFmpegAPI.decodePcm === 'function')
          ? fetchAudioPeaks()
          : Promise.resolve([]);
        return audioPromise.then(function (audioPoints) {
          return { words: words, wordPoints: wordPoints, audioPoints: audioPoints };
        });
      })
      .then(function (src) {
        var inRange = inClipRange(state.clips);
        var combined = src.wordPoints.concat(src.audioPoints)
          .filter(function (p) { return inRange(p.time); });
        var result = global.PunchEngine.buildPunches(combined, {
          style: state.style,
          frequency: freqLabel(state.frequency).toLowerCase(),
          zoomAmount: state.zoomAmount,
          durationFrames: state.duration,
          fps: state.fps,
          avoidConsecutive: state.avoidConsecutive,
          respectPauses: state.respectPauses,
          alternateZoom: state.alternateZoom,
          pan: state.panPx,
          words: src.words
        });
        state.punches = result.punches;
        renderPunchList();
        var srcNote = (src.wordPoints.length ? 'transcript' : '') +
                      (src.wordPoints.length && src.audioPoints.length ? ' + ' : '') +
                      (src.audioPoints.length ? 'audio' : '');
        if (!state.punches.length) {
          var hint = !src.wordPoints.length && !src.audioPoints.length
            ? ' Run Captions first (for speech punches) or keep Audio peaks on.'
            : ' Lower Frequency or try Dyn style.';
          setStatus('No punches found' + (srcNote ? ' (' + srcNote + ')' : '') + '.' + hint, true);
        } else {
          setStatus('Found ' + state.punches.length + ' punch' + (state.punches.length === 1 ? '' : 'es') +
                    ' from ' + (srcNote || 'points') + '. Click Apply Punches.', false);
        }
      })
      .catch(function (err) {
        setStatus(err && err.message ? err.message : 'Analysis failed.', true);
      })
      .then(function () {
        state.busy = false;
        el.analyze.disabled = false;
        if (el.apply) el.apply.disabled = !state.punches.length;
      });
  }

  // ── Apply ──────────────────────────────────────────────────────────────────
  function applyPunches() {
    if (state.busy) return;
    if (!state.punches.length) { setStatus('Analyze first — no punches to apply.', true); return; }
    state.busy = true;
    setStatus('Building keyframes…', false, true);

    function executePunches(context) {
      return refreshSelection(true).then(function (clips) {
        if (!clips.length) throw new Error('Select at least one clip on the timeline.');
        if (context && context.status) context.status('Building punch keyframes…');
        var durFrames = state.duration || global.PunchEngine.presets[state.style].durationFrames;
        var payload = [];
        for (var i = 0; i < clips.length; i++) {
          var clip = clips[i];
          // PunchEngine expects clip-relative seconds. Analysis points are
          // sequence-relative, so keep only points inside this clip and remap.
          var clipPunches = state.punches.filter(function (p) {
            return p.t >= clip.start - 0.001 && p.t <= clip.end + 0.001;
          }).map(function (p) {
            return { t: Math.max(0, p.t - clip.start), zoom: p.zoom, dir: p.dir, score: p.score, reason: p.reason };
          });
          if (!clipPunches.length) continue;
          var kf = global.PunchEngine.buildPunchKeyframes(clipPunches, state.fps, durFrames, Math.max(0, clip.duration), { ease: state.smoothEase });
          var properties = {};
          properties.scale = kf.scale.map(function (k) {
            return { t: +(clip.start + k.t).toFixed(4), v: k.v };
          });
          if (kf.position.length) {
            properties.position = kf.position.map(function (k) {
              return { t: +(clip.start + k.t).toFixed(4), v: { x: k.v.x, y: k.v.y } };
            });
          }
          payload.push({
            clipIndex: i,
            start: clip.start,
            end: clip.end,
            properties: properties,
            ease: state.smoothEase ? 'ease' : 'linear'
          });
        }
        if (!payload.length) throw new Error('No analyzed punches fall inside the selected clips. Analyze again.');
        // Prefer the inline payload host call. A file-bridge helper was never
        // shipped, and calling the missing *File variant aborted Apply.
        var call = context && context.host
          ? function (name, args) { return context.host(name, args, { timeout: 45000 }); }
          : function (name, args) { return hostCall(name, args, 45000); };
        return call('motionApplyClipKeyframes', [JSON.stringify(payload)]);
      });
    }
    var operation = global.OrbitCore ? global.OrbitCore.run({
      id: 'punch-apply', title: 'Apply Smart Punches', button: el.apply,
      busyLabel: 'Applying…', startMessage: 'Preparing ' + state.punches.length + ' punch zoom(s)…',
      confirm: true, safetyCopy: false,
      preview: function () { return 'Apply ' + state.punches.length + ' reviewed punch zoom(s) to the selected clips. All keyframes are added in one Premiere undo step.'; },
      execute: executePunches,
      successMessage: function (res) { return 'Applied ' + state.punches.length + ' punch zoom(s) to ' + ((res && res.clips) || 0) + ' clip(s).'; },
      toast: false, onStatus: function (phase, value, isError) { setStatus(value, isError, phase === 'working'); }
    }) : executePunches(null);

    operation
      .then(function (res) {
        if (res && res.cancelled) return;
        if (res && res.error) {
          setStatus(res.error, true);
        } else {
          var n = res && res.clips != null ? res.clips : 0;
          setStatus('Punched ' + n + ' clip' + (n === 1 ? '' : 's') + ' · ' + state.punches.length + ' zoom' + (state.punches.length === 1 ? '' : 's') + '.');
        }
      })
      .catch(function (err) {
        setStatus(err && err.message ? err.message : 'Could not apply punches.', true);
      })
      .then(function () {
        state.busy = false;
        if (el.apply) el.apply.disabled = !state.punches.length;
      });
  }

  // ── Punch list ─────────────────────────────────────────────────────────────
  function fmt(t) {
    var m = Math.floor(t / 60);
    var s = Math.floor(t % 60);
    var ms = Math.floor((t - Math.floor(t)) * 10);
    return m + ':' + String(s).padStart(2, '0') + '.' + ms;
  }

  var REASON_LABEL = {
    sentence_start: 'sentence',
    keyword: 'keyword',
    pause_resume: 'pause',
    long_sentence: 'long run',
    volume: 'volume',
    manual: 'manual'
  };

  // Click a row's zoom value → inline number editor; Enter/blur commits.
  function editZoom(idx, zoomEl) {
    if (!state.punches[idx]) return;
    var input = document.createElement('input');
    input.type = 'number';
    input.className = 'punch-zoom-input';
    input.min = 100;
    input.max = 200;
    input.step = 1;
    input.value = state.punches[idx].zoom;
    zoomEl.replaceWith(input);
    input.focus();
    input.select();
    var commit = function () {
      var v = parseInt(input.value, 10);
      if (isFinite(v) && v >= 100 && v <= 200) {
        state.punches[idx].zoom = v;
        setStatus('Punch zoom set to ' + v + '%.', false);
      }
      renderPunchList();
    };
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { renderPunchList(); }
    });
    input.addEventListener('blur', commit);
  }

  function renderPunchList() {
    if (!el.list) return;
    el.list.innerHTML = '';
    var punches = state.punches;
    if (el.countVal) el.countVal.textContent = String(punches.length);
    if (el.listWrap) el.listWrap.classList.toggle('hidden', !punches.length);
    if (el.apply) el.apply.disabled = !punches.length;
    if (!punches.length) return;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < punches.length; i++) {
      (function (idx) {
        var p = punches[idx];
        var row = document.createElement('div');
        row.className = 'punch-row';
        var time = document.createElement('span');
        time.className = 'punch-time';
        time.textContent = fmt(p.t);
        var bar = document.createElement('span');
        bar.className = 'punch-bar';
        bar.style.width = Math.round(p.score * 100) + '%';
        var zoom = document.createElement('span');
        zoom.className = 'punch-zoom';
        zoom.textContent = p.zoom + '%';
        zoom.title = 'Click to edit zoom';
        zoom.addEventListener('click', function () { editZoom(idx, zoom); });
        var reason = document.createElement('span');
        reason.className = 'punch-reason';
        reason.textContent = REASON_LABEL[p.reason] || p.reason;
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'punch-del';
        del.title = 'Remove punch';
        del.setAttribute('aria-label', 'Remove punch');
        del.textContent = '×';
        del.addEventListener('click', function () {
          punches.splice(idx, 1);
          renderPunchList();
          setStatus('Punch removed.', false);
        });
        row.appendChild(time);
        row.appendChild(bar);
        row.appendChild(zoom);
        row.appendChild(reason);
        row.appendChild(del);
        frag.appendChild(row);
      })(i);
    }
    el.list.appendChild(frag);
  }

  // Manual marker: punch at the current playhead, clamped into the selection.
  function addManualPunch() {
    if (state.busy) return;
    if (!state.clips.length) { setStatus('Select a clip on the timeline first.', true); return; }
    setStatus('Reading playhead…', false, true);
    hostCall('getPlayheadTime', [], 8000)
      .then(function (res) {
        if (!res || res.error || !isFinite(res.time)) {
          throw new Error(res && res.error ? res.error : 'No playhead time.');
        }
        var t = Number(res.time);
        var clip = null;
        for (var i = 0; i < state.clips.length; i++) {
          if (t >= state.clips[i].start && t <= state.clips[i].end) { clip = state.clips[i]; break; }
        }
        if (!clip) {
          // Clamp to the nearest clip edge.
          var bestDist = Infinity;
          for (var j = 0; j < state.clips.length; j++) {
            var s = state.clips[j].start, e = state.clips[j].end;
            var d = t < s ? (s - t) : (t - e);
            if (d < bestDist) { bestDist = d; clip = state.clips[j]; }
          }
          t = t < clip.start ? clip.start : clip.end;
        }
        var preset = global.PunchEngine.presets[state.style];
        var levels = preset.zoomLevels.map(function (l) { return Math.round(100 + (l - 100) * state.zoomAmount / 100); });
        var pan = Number(state.panPx) || 0;
        state.punches.push({
          t: Math.round(t * 1000) / 1000,
          zoom: levels[0],
          dir: pan > 0 ? { x: pan, y: 0 } : null,
          score: 1,
          reason: 'manual'
        });
        state.punches.sort(function (a, b) { return a.t - b.t; });
        renderPunchList();
        setStatus('Added manual punch at ' + fmt(t) + ' (' + levels[0] + '%).', false);
      })
      .catch(function (err) {
        setStatus(err && err.message ? err.message : 'Could not read the playhead.', true);
      });
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────
  function syncStyleBtns() {
    el.styleBtns.forEach(function (b) { b.classList.toggle('active', b.dataset.style === state.style); });
  }

  function init() {
    if (el.refresh) el.refresh.addEventListener('click', function () { refreshSelection(false); });
    el.styleBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.style = btn.dataset.style;
        syncStyleBtns();
        if (el.duration && state.duration === 0) {
          el.duration.value = global.PunchEngine.presets[state.style].durationFrames;
          if (el.durationVal) el.durationVal.textContent = global.PunchEngine.presets[state.style].durationFrames + 'f';
        }
      });
    });
    if (el.frequency) el.frequency.addEventListener('input', function () {
      state.frequency = parseInt(this.value, 10);
      if (el.frequencyVal) el.frequencyVal.textContent = freqLabel(state.frequency);
    });
    if (el.zoom) el.zoom.addEventListener('input', function () {
      state.zoomAmount = parseInt(this.value, 10);
      if (el.zoomVal) el.zoomVal.textContent = state.zoomAmount + '%';
    });
    if (el.duration) el.duration.addEventListener('input', function () {
      state.duration = parseInt(this.value, 10);
      if (el.durationVal) el.durationVal.textContent = state.duration + 'f';
    });
    if (el.avoid) el.avoid.addEventListener('change', function () { state.avoidConsecutive = el.avoid.checked; });
    if (el.pauses) el.pauses.addEventListener('change', function () { state.respectPauses = el.pauses.checked; });
    if (el.alternate) el.alternate.addEventListener('change', function () { state.alternateZoom = el.alternate.checked; });
    if (el.audio) el.audio.addEventListener('change', function () { state.useAudioPeaks = el.audio.checked; });
    if (el.pan) el.pan.addEventListener('input', function () {
      state.panPx = parseInt(this.value, 10);
      if (el.panVal) el.panVal.textContent = state.panPx + 'px';
    });
    if (el.ease) el.ease.addEventListener('change', function () { state.smoothEase = el.ease.checked; });
    if (el.analyze) el.analyze.addEventListener('click', analyze);
    if (el.apply) el.apply.addEventListener('click', applyPunches);
    if (el.addManual) el.addManual.addEventListener('click', addManualPunch);

    // Sync controls with state (duration shows the preset value for the style).
    syncStyleBtns();
    if (el.duration) el.duration.value = global.PunchEngine.presets[state.style].durationFrames;
    if (el.durationVal) el.durationVal.textContent = global.PunchEngine.presets[state.style].durationFrames + 'f';
    if (el.frequencyVal) el.frequencyVal.textContent = freqLabel(state.frequency);
    if (el.zoomVal) el.zoomVal.textContent = state.zoomAmount + '%';
    if (el.panVal) el.panVal.textContent = state.panPx + 'px';

    refreshSelection(true);
    global.addEventListener('compx:rail-route', function (event) {
      if (event && event.detail && event.detail.type === 'punch') refreshSelection(true);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.PunchPanel = { init: init, refresh: refreshSelection };
})(window);
