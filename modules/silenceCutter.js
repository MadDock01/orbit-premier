/**
 * silenceCutter.js — Silence Cutter module
 * Waveform canvas UI: shows audio amplitude, silence regions in red,
 * draggable threshold line. Detect + Cut silences from the Premiere timeline.
 */

(function (global) {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  // Detection now runs against a concatenated WAV of every visible clip
  // on the chosen track (built via the same FFmpeg pipeline the Auto-
  // Captions feature uses) rather than against a single source file.
  // That kills the long-standing "second clip on a track is ignored"
  // bug — concat covers all clips, and the clipMap translates concat-
  // time silences back to timeline positions.
  var detectedSilences = [];
  var waveformPeaks    = [];   // normalized 0..1 array of the concat WAV
  var waveformDuration = 0;    // duration of the concat WAV, seconds
  var mediaPath        = '';   // path to the concat WAV (reused as the
                               // detect + waveform source)
  var clipMap          = null; // [{ concatStart, concatEnd, timelineStart }]
  var _cachedWfPath    = '';   // concat WAV path whose waveform is loaded

  // ── Concat ↔ timeline translation helpers ─────────────────────────────────
  // The clipMap is a list of segments [{ concatStart, concatEnd,
  // timelineStart }] describing where each piece of the concat WAV
  // sits on the sequence timeline. Two translators built around it:

  // concat-time → timeline-time.  Points inside a clip's range map
  // linearly; points outside any clip (shouldn't happen for silence
  // ranges, but defensive) snap to the nearest segment edge.
  function _concatToTimeline(t) {
    if (!clipMap || !clipMap.length) return t;
    for (var i = 0; i < clipMap.length; i++) {
      var cm = clipMap[i];
      if (t < cm.concatStart) return cm.timelineStart;
      if (t <= cm.concatEnd) {
        return cm.timelineStart + (t - cm.concatStart);
      }
    }
    var last = clipMap[clipMap.length - 1];
    return last.timelineStart + (last.concatEnd - last.concatStart);
  }

  // timeline-time → concat-time (inverse). Used by the waveform
  // drawer to find which peak index a timeline-positioned silence
  // lives at.
  function _timelineToConcat(t) {
    if (!clipMap || !clipMap.length) return t;
    for (var i = 0; i < clipMap.length; i++) {
      var cm = clipMap[i];
      var timelineEnd = cm.timelineStart + (cm.concatEnd - cm.concatStart);
      if (t < cm.timelineStart) return cm.concatStart;
      if (t <= timelineEnd) {
        return cm.concatStart + (t - cm.timelineStart);
      }
    }
    return clipMap[clipMap.length - 1].concatEnd;
  }

  // Split a concat-time silence into 1+ timeline-time ranges along
  // clipMap boundaries. A silence that straddles two clips on the
  // concat side becomes TWO separate cut ranges so neither one
  // crosses the timeline gap between the clips (where there's
  // nothing to cut). Each output range is { start, end } in
  // timeline-seconds.
  function _splitToTimelineRanges(concatStart, concatEnd) {
    if (concatEnd <= concatStart) return [];
    if (!clipMap || !clipMap.length) {
      return [{ start: concatStart, end: concatEnd }];
    }
    var out = [];
    for (var i = 0; i < clipMap.length; i++) {
      var cm = clipMap[i];
      var os = Math.max(concatStart, cm.concatStart);
      var oe = Math.min(concatEnd,   cm.concatEnd);
      if (oe > os) {
        out.push({
          start: cm.timelineStart + (os - cm.concatStart),
          end:   cm.timelineStart + (oe - cm.concatStart)
        });
      }
    }
    return out;
  }

  // ── DOM refs ───────────────────────────────────────────────────────────────
  var thresholdSlider = document.getElementById('sc-threshold');
  var thresholdVal    = document.getElementById('sc-threshold-val');
  var scopeSelect     = document.getElementById('sc-scope');
  var autoThresholdBtn= document.getElementById('sc-auto-threshold');
  var durationSlider  = document.getElementById('sc-duration');
  var durationVal     = document.getElementById('sc-duration-val');
  var prePaddingSlider = document.getElementById('sc-pre-padding');
  var prePaddingVal    = document.getElementById('sc-pre-padding-val');
  var postPaddingSlider= document.getElementById('sc-post-padding');
  var postPaddingVal   = document.getElementById('sc-post-padding-val');
  var applyModeSelect  = document.getElementById('sc-apply-mode');
  var safetyCopyToggle = document.getElementById('sc-safety-copy');
  var detectListEl    = document.getElementById('sc-detect-list');
  var trackListEl     = document.getElementById('sc-track-list');
  var refreshTracksBtn= document.getElementById('sc-refresh-tracks');
  var detectBtn       = document.getElementById('sc-detect-btn');
  var cutBtn          = document.getElementById('sc-cut-btn');
  var _detectBtnOrigHTML = null;
  var _cutBtnOrigHTML    = null;
  var canvas          = document.getElementById('sc-waveform');
  var waveformWrap    = document.getElementById('sc-waveform-wrap');
  var waveformHint    = document.getElementById('sc-waveform-hint');
  var cutListEl       = document.getElementById('sc-cut-list');
  var cutCountEl      = document.getElementById('sc-cut-count');
  var cutListWrapEl   = document.getElementById('sc-cut-list-wrap');

  // ── Canvas setup ───────────────────────────────────────────────────────────
  var ctx = canvas ? canvas.getContext('2d') : null;

  function resizeCanvas() {
    if (!canvas || !ctx) return;
    var rect = waveformWrap.getBoundingClientRect();
    canvas.width  = rect.width  || 280;
    canvas.height = 72;
    drawWaveform();
  }

  // ── Slider live labels ─────────────────────────────────────────────────────
  thresholdSlider.addEventListener('input', function () {
    thresholdVal.textContent = this.value + ' dB';
    drawWaveform(); // re-draw threshold line
  });
  durationSlider.addEventListener('input', function () {
    durationVal.textContent = parseFloat(this.value).toFixed(1) + ' s';
  });
  prePaddingSlider.addEventListener('input', function () {
    prePaddingVal.textContent = parseFloat(this.value).toFixed(2) + ' s';
  });
  postPaddingSlider.addEventListener('input', function () {
    postPaddingVal.textContent = parseFloat(this.value).toFixed(2) + ' s';
  });

  // ── Waveform drawing ───────────────────────────────────────────────────────
  var COLORS = {
    wave:      '#3a7fd5',
    waveSil:   'rgba(255,60,50,0.85)',
    waveOff:   'rgba(255,255,255,0.28)',
    silBg:     'rgba(255,40,30,0.18)',
    silOffBg:  'rgba(255,255,255,0.05)',
    threshold: '#ff9f0a',
    grid:      'rgba(255,255,255,0.04)',
    text:      'rgba(255,255,255,0.25)'
  };

  function drawWaveform() {
    if (!ctx || !canvas) return;
    var W = canvas.width;
    var H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = '#151518';
    ctx.fillRect(0, 0, W, H);

    // Grid lines
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    for (var g = 1; g < 4; g++) {
      var gy = Math.round(H * g / 4) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
    }

    if (waveformPeaks.length === 0) return;

    // Build silence lookup: for each peak index, is it silent?
    // Silences are stored in timeline-seconds; the waveform is of
    // the concat WAV. Translate via the clipMap before mapping to
    // peak indices.
    var silentPeaks   = new Uint8Array(waveformPeaks.length); // 1 = enabled cut (red)
    var disabledPeaks = new Uint8Array(waveformPeaks.length); // 1 = disabled cut (dimmed)
    if (detectedSilences.length > 0 && waveformDuration > 0) {
      for (var si = 0; si < detectedSilences.length; si++) {
        var s = detectedSilences[si];
        var cStart = Math.max(0,                _timelineToConcat(s.start));
        var cEnd   = Math.min(waveformDuration, _timelineToConcat(s.end));
        var iStart = Math.floor(cStart / waveformDuration * waveformPeaks.length);
        var iEnd   = Math.ceil(cEnd   / waveformDuration * waveformPeaks.length);
        for (var pi = iStart; pi < iEnd; pi++) {
          if (pi >= 0 && pi < silentPeaks.length) {
            if (s.enabled === false) disabledPeaks[pi] = 1;
            else silentPeaks[pi] = 1;
          }
        }
      }
    }

    var barW = W / waveformPeaks.length;
    var mid  = H / 2;

    // Cut-region background blocks (red = enabled cut, faint = disabled)
    for (var di = 0; di < detectedSilences.length; di++) {
      var dc  = detectedSilences[di];
      var dcs = Math.max(0,                _timelineToConcat(dc.start));
      var dce = Math.min(waveformDuration, _timelineToConcat(dc.end));
      var dxx = dcs / waveformDuration * W;
      var dww = Math.max(1, (dce - dcs) / waveformDuration * W);
      ctx.fillStyle = dc.enabled === false ? COLORS.silOffBg : COLORS.silBg;
      ctx.fillRect(dxx, 0, dww, H);
    }

    // Waveform bars
    for (var bi = 0; bi < waveformPeaks.length; bi++) {
      var peak = waveformPeaks[bi];
      var bh   = Math.max(1, peak * (H * 0.88));
      var bx   = bi * barW;
      ctx.fillStyle = silentPeaks[bi] ? COLORS.waveSil : (disabledPeaks[bi] ? COLORS.waveOff : COLORS.wave);
      ctx.fillRect(bx, mid - bh / 2, Math.max(1, barW - 0.5), bh);
    }

    // Threshold line
    var tdb    = parseFloat(thresholdSlider.value);   // e.g. -30
    // Map dB to amplitude: amplitude = 10^(dB/20). Normalize against 0 dB = 1.0
    var tAmp   = Math.pow(10, tdb / 20);
    // The waveform peaks are normalized 0..1. Threshold maps to same space
    // but we need to scale relative to what "0 dB" would look like.
    // Since peaks are normalized, show threshold as fraction of half-height:
    var tY     = mid - tAmp * (H * 0.88) / 2;
    tY = Math.max(4, Math.min(H - 4, tY));

    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = COLORS.threshold;
    ctx.lineWidth   = 1.5;
    ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.moveTo(0, tY); ctx.lineTo(W, tY); ctx.stroke();
    // Mirror below center
    var tYb = mid + (mid - tY);
    ctx.beginPath(); ctx.moveTo(0, tYb); ctx.lineTo(W, tYb); ctx.stroke();
    ctx.restore();

    // Threshold label
    ctx.fillStyle = COLORS.threshold;
    ctx.font      = '9px monospace';
    ctx.fillText(tdb + ' dB', 4, tY - 3);

    // Duration label (bottom right)
    if (waveformDuration > 0) {
      ctx.fillStyle = COLORS.text;
      ctx.font      = '9px monospace';
      var durLabel  = waveformDuration.toFixed(1) + 's';
      ctx.fillText(durLabel, W - ctx.measureText(durLabel).width - 4, H - 4);
    }
  }

  // ── Draggable threshold line ───────────────────────────────────────────────
  var dragging = false;

  canvas && canvas.addEventListener('mousedown', function (e) {
    var H = canvas.height;
    var mid = H / 2;
    var tdb = parseFloat(thresholdSlider.value);
    var tAmp = Math.pow(10, tdb / 20);
    var tY   = mid - tAmp * (H * 0.88) / 2;
    var rect = canvas.getBoundingClientRect();
    var mouseY = (e.clientY - rect.top) * (H / rect.height);
    if (Math.abs(mouseY - tY) < 12 || Math.abs(mouseY - (H - tY)) < 12) {
      dragging = true;
      e.preventDefault();
    }
  });

  document.addEventListener('mousemove', function (e) {
    if (!dragging || !canvas) return;
    var H    = canvas.height;
    var mid  = H / 2;
    var rect = canvas.getBoundingClientRect();
    var mouseY = (e.clientY - rect.top) * (H / rect.height);
    // Convert Y to amplitude, then to dB
    var amp = Math.max(0.0001, Math.min(1, (mid - mouseY) / (H * 0.44)));
    var db  = Math.round(20 * Math.log10(amp));
    db = Math.max(-60, Math.min(-10, db));
    thresholdSlider.value = db;
    thresholdVal.textContent = db + ' dB';
    drawWaveform();
  });

  document.addEventListener('mouseup', function () {
    if (dragging) {
      dragging = false;
      // Re-run detection with new threshold if we have media
      if (mediaPath) runDetectionInner();
    }
  });

  // Cursor hint on hover
  canvas && canvas.addEventListener('mousemove', function (e) {
    if (dragging) return;
    var H   = canvas.height;
    var mid = H / 2;
    var tdb = parseFloat(thresholdSlider.value);
    var tAmp = Math.pow(10, tdb / 20);
    var tY   = mid - tAmp * (H * 0.88) / 2;
    var rect = canvas.getBoundingClientRect();
    var mouseY = (e.clientY - rect.top) * (H / rect.height);
    canvas.style.cursor = (Math.abs(mouseY - tY) < 12 || Math.abs(mouseY - (H - tY)) < 12)
      ? 'ns-resize' : 'default';
  });

  // ── Track list ─────────────────────────────────────────────────────────────
  function getDetectValues() {
    var values = [];
    detectListEl.querySelectorAll('input[type="checkbox"]:checked').forEach(function (cb) { values.push(cb.value); });
    return values;
  }

  function getDetectValue() {
    var values = getDetectValues();
    return values.length ? values[0] : '';
  }

  function syncDetectPin() {
    var detectValues = getDetectValues();
    trackListEl.querySelectorAll('input[type="checkbox"]:not([value="all"])').forEach(function (cb) {
      var isPinned = detectValues.indexOf(cb.value) !== -1;
      cb.disabled = isPinned;
      if (isPinned) {
        cb.checked = true;
        cb.parentElement.classList.add('checked');
        cb.parentElement.classList.add('pinned');
      } else {
        cb.parentElement.classList.remove('pinned');
      }
    });
  }

  function loadTrackList() {
    setStatus('info', 'Reading tracks from Premiere…');
    return CEP.evalScript('orbitGetTrackList', [], 8000)
      .then(function (result) {
        if (result && result.error) throw new Error(result.error);
        var tracks = Array.isArray(result) ? result : (result && Array.isArray(result.tracks) ? result.tracks : []);
        var prevDetects = getDetectValues();
        var prevChecked = getCheckedTracks().map(function (t) { return t.type + ':' + t.index; });
        var prevAllSel  = prevChecked.length === 0;

        var audioTracks = tracks.filter(function (t) { return t.type === 'audio'; });
        detectListEl.innerHTML = '';
        if (!audioTracks.length) {
          setStatus('error', 'No audio clips found in the active sequence. Open the sequence and refresh tracks.');
        }
        audioTracks.forEach(function (t, idx) {
          var val = t.type + ':' + t.index;
          var isChecked = prevDetects.length ? prevDetects.indexOf(val) !== -1 : idx === 0;

          var label = document.createElement('label');
          label.className = 'track-chip' + (isChecked ? ' checked' : '');

          var rb = document.createElement('input');
          rb.type = 'checkbox';
          rb.name = 'sc-detect-guidance';
          rb.value = val;
          rb.checked = isChecked;
          rb.addEventListener('change', function () {
            if (!rb.checked && getDetectValues().length === 0) rb.checked = true;
            label.classList.toggle('checked', rb.checked);
            syncDetectPin();
            _cachedWfPath = '';
          });

          label.appendChild(rb);
          label.appendChild(document.createTextNode(t.name));
          detectListEl.appendChild(label);
        });

        // Cut tracks
        trackListEl.innerHTML = '';

        var allLabel = document.createElement('label');
        var allCb = document.createElement('input');
        allCb.type = 'checkbox';
        allCb.value = 'all';
        allCb.checked = prevAllSel;
        allLabel.className = 'track-chip' + (prevAllSel ? ' checked' : '');
        allCb.addEventListener('change', function () {
          allLabel.classList.toggle('checked', allCb.checked);
          trackListEl.querySelectorAll('input[type="checkbox"]:not([value="all"])').forEach(function (cb) {
            if (!cb.disabled) {
              cb.checked = allCb.checked;
              cb.parentElement.classList.toggle('checked', allCb.checked);
            }
          });
        });
        allLabel.appendChild(allCb);
        allLabel.appendChild(document.createTextNode('All'));
        trackListEl.appendChild(allLabel);

        var detectVals = getDetectValues();
        tracks.forEach(function (t) {
          var val      = t.type + ':' + t.index;
          var isPinned = detectVals.indexOf(val) !== -1;
          var wasChecked = prevAllSel || isPinned || prevChecked.indexOf(val) !== -1;

          var label = document.createElement('label');
          label.className = 'track-chip' + (wasChecked ? ' checked' : '') + (isPinned ? ' pinned' : '');

          var cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.value = val;
          cb.checked = wasChecked;
          cb.disabled = isPinned;
          cb.addEventListener('change', function () {
            label.classList.toggle('checked', cb.checked);
            if (!cb.checked) {
              allCb.checked = false;
              allLabel.classList.remove('checked');
            } else {
              var allChecked = true;
              trackListEl.querySelectorAll('input[type="checkbox"]:not([value="all"])').forEach(function (c) {
                if (!c.checked) allChecked = false;
              });
              allCb.checked = allChecked;
              allLabel.classList.toggle('checked', allChecked);
            }
          });

          label.appendChild(cb);
          label.appendChild(document.createTextNode(t.name));
          trackListEl.appendChild(label);
        });

        var allIndividualsChecked = true;
        trackListEl.querySelectorAll('input[type="checkbox"]:not([value="all"])').forEach(function (c) {
          if (!c.checked) allIndividualsChecked = false;
        });
        allCb.checked = allIndividualsChecked;
        allLabel.classList.toggle('checked', allIndividualsChecked);
        if (audioTracks.length) setStatus('success', 'Tracks ready: ' + audioTracks.map(function (t) { return t.name; }).join(', ') + '. Select guidance and click Analyze.');
      })
      .catch(function (err) {
        setStatus('error', (err && err.message) || 'Could not read tracks from Premiere.');
      });
  }

  function getCheckedTracks() {
    var allCb = trackListEl.querySelector('input[value="all"]');
    if (allCb && allCb.checked) return [];
    var result = [];
    trackListEl.querySelectorAll('input[type="checkbox"]:not([value="all"])').forEach(function (cb) {
      if (cb.checked) {
        var parts = cb.value.split(':');
        result.push({ type: parts[0], index: parseInt(parts[1], 10) });
      }
    });
    return result;
  }

  // ── Non-destructive cut list (Smart Jump Cut preview) ─────────────────────
  // Every detected silence becomes a row with its own enable/disable toggle.
  // Nothing is removed from the timeline until the user presses Apply Cuts.
  function syncApplyButton() {
    var enabledCount = 0;
    for (var ai = 0; ai < detectedSilences.length; ai++) {
      if (detectedSilences[ai].enabled) enabledCount++;
    }
    cutBtn.disabled = enabledCount === 0;
    if (cutCountEl) {
      cutCountEl.textContent = detectedSilences.length
        ? (enabledCount + ' / ' + detectedSilences.length)
        : '';
    }
  }

  function renderCutList() {
    if (!cutListEl) return;
    cutListEl.innerHTML = '';
    for (var ci = 0; ci < detectedSilences.length; ci++) {
      var r = detectedSilences[ci];
      var row = document.createElement('label');
      row.className = 'sc-cut-row' + (r.enabled ? ' enabled' : ' disabled');

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!r.enabled;
      cb.addEventListener('change', (function (range, labelEl, checkbox) {
        return function () {
          range.enabled = checkbox.checked;
          labelEl.classList.toggle('enabled', range.enabled);
          labelEl.classList.toggle('disabled', !range.enabled);
          syncApplyButton();
          drawWaveform();
        };
      })(r, row, cb));

      var timeEl = document.createElement('span');
      timeEl.className = 'sc-cut-time';
      timeEl.textContent = _fmtCutTime(r.start) + ' – ' + _fmtCutTime(r.end);

      var durEl = document.createElement('span');
      durEl.className = 'sc-cut-dur';
      durEl.textContent = r.duration.toFixed(2) + 's';

      row.appendChild(cb);
      row.appendChild(timeEl);
      row.appendChild(durEl);
      cutListEl.appendChild(row);
    }
    if (cutListWrapEl) cutListWrapEl.classList.toggle('hidden', detectedSilences.length === 0);
    syncApplyButton();
  }

  function _fmtCutTime(seconds) {
    var m = Math.floor(seconds / 60);
    var s = seconds - m * 60;
    var ss = s.toFixed(2);
    return String(m).padStart(2, '0') + ':' + (ss.length === 4 ? ss : '0' + ss);
  }

  refreshTracksBtn.addEventListener('click', loadTrackList);
  setStatus('info', 'Cut v3 — waiting for verified Premiere host startup…');
  document.addEventListener('host-loader-ready', loadTrackList);
  window.addEventListener('compx:rail-route', function (event) {
    if (event && event.detail && event.detail.type === 'silence') loadTrackList();
  });

  function _trimClipsToScope(clips, scope) {
    if (!scope || scope.end <= scope.start) return clips;
    var out = [];
    for (var i = 0; i < clips.length; i++) {
      var clip = clips[i];
      var clipDuration = clip.srcOut - clip.srcIn;
      var clipEnd = clip.timelineStart + clipDuration;
      var start = Math.max(clip.timelineStart, scope.start);
      var end = Math.min(clipEnd, scope.end);
      if (end <= start) continue;
      out.push({ sourceFile: clip.sourceFile, srcIn: clip.srcIn + (start - clip.timelineStart), srcOut: clip.srcIn + (end - clip.timelineStart), timelineStart: start });
    }
    return out;
  }

  function _getDetectionScope() {
    if (!scopeSelect || scopeSelect.value !== 'inout') return Promise.resolve(null);
    return CEP.evalScript('getSequenceInfo', [], 5000).then(function (info) {
      var start = Number(info && info.inPoint);
      var end = Number(info && info.outPoint);
      if (!isFinite(start) || !isFinite(end) || end <= start) throw new Error('Set valid In and Out points on the Premiere timeline first.');
      return { start: start, end: end };
    });
  }

  function _recommendThreshold() {
    if (!mediaPath) return Promise.reject(new Error('Analyze a track first, then use Auto.'));
    if (!FFmpegAPI.decodePcm) return Promise.reject(new Error('Audio analysis is unavailable.'));
    return FFmpegAPI.decodePcm(mediaPath, 4000).then(function (pcm) {
      var samples = pcm && pcm.samples;
      if (!samples || !samples.length) throw new Error('No audio samples found.');
      var windowSize = 400;
      var levels = [];
      for (var offset = 0; offset < samples.length; offset += windowSize) {
        var end = Math.min(offset + windowSize, samples.length);
        var sum = 0;
        for (var si = offset; si < end; si++) sum += samples[si] * samples[si];
        var rms = Math.sqrt(sum / Math.max(1, end - offset));
        levels.push(20 * Math.log(Math.max(rms, 0.000001)) / Math.LN10);
      }
      levels.sort(function (a, b) { return a - b; });
      var noiseFloor = levels[Math.min(levels.length - 1, Math.floor(levels.length * 0.2))];
      return Math.max(-55, Math.min(-18, Math.round(noiseFloor + 6)));
    });
  }

  if (autoThresholdBtn) autoThresholdBtn.addEventListener('click', function () {
    autoThresholdBtn.disabled = true;
    _recommendThreshold().then(function (db) {
      thresholdSlider.value = db;
      thresholdVal.textContent = db + ' dB';
      drawWaveform();
      setStatus('success', 'Auto threshold set to ' + db + ' dB.');
      return runDetectionInner();
    }).catch(function (err) {
      setStatus('error', err.message || 'Could not estimate threshold.');
    }).then(function () { autoThresholdBtn.disabled = false; }, function () { autoThresholdBtn.disabled = false; });
  });

  // ── Detect silences ────────────────────────────────────────────────────────
  var _autoCutAfterDetect = false;
  detectBtn.addEventListener('click', function () { runDetection(); });

  // Public: detect, then auto-trigger cut once silences are found
  global._scQuickCut = function () {
    _autoCutAfterDetect = true;
    runDetection();
  };

  function waitForServer(attempts) {
    attempts = attempts || 0;
    if (attempts > 15) return Promise.reject(new Error('Server did not start. Try reloading the panel.'));
    return FFmpegAPI.ping()
      .catch(function () {
        return new Promise(function (res) { setTimeout(res, 800); })
          .then(function () { return waitForServer(attempts + 1); });
      });
  }

  function runDetection() {
    setWorking(true, 'Starting server…');
    detectedSilences = [];
    cutBtn.disabled  = true;

    var detectValues = getDetectValues();
    if (!detectValues.length) {
      setWorking(false);
      setStatus('error', 'Select at least one guidance audio track.');
      return;
    }
    var detectTracks = detectValues.map(function (value) {
      var parts = value.split(':');
      return { type: parts[0] || 'audio', index: parseInt(parts[1], 10) || 0 };
    });

    waitForServer()
      .then(function () {
        // `ping()` is intentionally cheap and does not spawn FFmpeg. Validate
        // the binary before asking Premiere for clips so macOS packaging/PATH
        // failures are reported as FFmpeg failures, not as a misleading
        // "audio track not found" message.
        if (!FFmpegAPI.checkFFmpeg) throw new Error('Audio analysis is unavailable.');
        return FFmpegAPI.checkFFmpeg();
      })
      .then(function () {
        setStatus('working', 'Loading track…');
        _setBtnLoad(detectBtn, true, 'Loading track…');
        // Gather EVERY clip on the chosen track (the host helper
        // accepts both 'audio' and 'video' types). Then ask the
        // Node server to extract + concatenate them into a single
        // WAV. Returns a clipMap describing the concat-time ↔
        // timeline-time mapping per segment.
        var requests = detectTracks.map(function (track) {
          return CEP.evalScript('getAudioTrackClips', [track.type, track.index], 15000);
        });
        requests.push(_getDetectionScope());
        return Promise.all(requests);
      })
      .then(function (loaded) {
        var scope = loaded[loaded.length - 1];
        var groups = loaded.slice(0, -1).map(function (clips) { return _trimClipsToScope(clips || [], scope); });
        var clips = [];
        for (var gi = 0; gi < groups.length; gi++) clips = clips.concat(groups[gi]);
        if (!clips.length) throw new Error(scope ? 'No clips overlap the selected In / Out range.' : 'No clips found on the selected guidance tracks.');
        return CEP.evalScript('getTempDir', [], 10000)
          .then(function (tmpDir) {
            var outPath = (tmpDir + '/orbit_silence_guidance.wav').replace(/\\/g, '/');
            if (detectTracks.length === 1) return FFmpegAPI.extractSegments(clips, outPath);
            return FFmpegAPI.mixTimelineClips(clips, outPath, scope);
          });
      })
      .then(function (result) {
        mediaPath = result.outputPath;
        clipMap   = result.clipMap || null;

        setStatus('working', 'Detecting silences…');
        _setBtnLoad(detectBtn, true, 'Detecting…');

        return FFmpegAPI.detectSilence(
          mediaPath,
          parseFloat(thresholdSlider.value),
          parseFloat(durationSlider.value)
        );
      })
      .then(function (silences) {
        var prePadding = parseFloat(prePaddingSlider.value);
        var postPadding = parseFloat(postPaddingSlider.value);
        // For each silence: shrink by padding (in concat-time),
        // then split-translate to 1+ timeline-time cut ranges so a
        // silence that straddles two clips doesn't produce a single
        // range crossing the inter-clip gap.
        var ranges = [];
        for (var i = 0; i < silences.length; i++) {
          var s  = silences[i];
          var cs = s.start + postPadding;
          var ce = s.end   - prePadding;
          if (ce <= cs) continue;
          var parts = _splitToTimelineRanges(cs, ce);
          for (var j = 0; j < parts.length; j++) {
            ranges.push({
              start:    parts[j].start,
              end:      parts[j].end,
              duration: parts[j].end - parts[j].start,
              enabled:  true
            });
          }
        }
        detectedSilences = ranges;
        cutBtn.disabled = ranges.length === 0;
        renderCutList();

        // Detection done — unblock the user immediately
        setWorking(false);
        setStatus('success', 'Found ' + ranges.length + ' silent section(s).');

        // Quick Cut: chain straight into cut once silences are detected
        if (_autoCutAfterDetect) {
          _autoCutAfterDetect = false;
          if (ranges.length > 0) cutBtn.click();
        }

        // Load waveform in the background if not cached
        if (mediaPath !== _cachedWfPath) {
          var _wfPath = mediaPath;
          FFmpegAPI.waveform(_wfPath)
            .then(function (wfData) {
              if (mediaPath !== _wfPath) return; // track changed while loading — discard
              waveformPeaks    = wfData.peaks    || [];
              waveformDuration = wfData.duration || 0;
              _cachedWfPath    = _wfPath;
              if (waveformHint) waveformHint.classList.add('hidden');
              resizeCanvas();
            })
            .catch(function () {}); // waveform is optional — silent fail
        } else {
          if (waveformHint) waveformHint.classList.add('hidden');
          resizeCanvas();
        }
      })
      .catch(function (err) {
        _autoCutAfterDetect = false;
        setWorking(false);
        setStatus('error', err.message || 'Detection failed. Try again.');
      });
  }

  // Inner re-detection (after threshold drag — waveform already loaded)
  function runDetectionInner() {
    if (!mediaPath) return;
    var threshold = parseFloat(thresholdSlider.value);
    var duration  = parseFloat(durationSlider.value);
    var prePadding  = parseFloat(prePaddingSlider.value);
    var postPadding = parseFloat(postPaddingSlider.value);

    FFmpegAPI.detectSilence(mediaPath, threshold, duration)
      .then(function (silences) {
        // Same pad-then-split-translate pipeline as the full
        // detection path. Re-runs on the same cached concat WAV +
        // clipMap so the threshold slider stays cheap (no re-concat).
        var ranges = [];
        for (var i = 0; i < silences.length; i++) {
          var s  = silences[i];
          var cs = s.start + postPadding;
          var ce = s.end   - prePadding;
          if (ce <= cs) continue;
          var parts = _splitToTimelineRanges(cs, ce);
          for (var j = 0; j < parts.length; j++) {
            ranges.push({
              start:    parts[j].start,
              end:      parts[j].end,
              duration: parts[j].end - parts[j].start,
              enabled:  true
            });
          }
        }
        detectedSilences = ranges;
        cutBtn.disabled = ranges.length === 0;
        renderCutList();
        drawWaveform();
        setStatus('success', 'Found ' + ranges.length + ' silent section(s).');
      })
      .catch(function () {});
  }

  // ── Cut silences ───────────────────────────────────────────────────────────
  cutBtn.addEventListener('click', function () {
    if (detectedSilences.length === 0) return;

    // Non-destructive: only the cuts the user left enabled are applied.
    var enabledRanges = [];
    for (var ri = 0; ri < detectedSilences.length; ri++) {
      if (detectedSilences[ri].enabled) {
        enabledRanges.push({ start: detectedSilences[ri].start, end: detectedSilences[ri].end });
      }
    }
    if (enabledRanges.length === 0) return;

    var cutTracks = getCheckedTracks();
    var applyMode = applyModeSelect ? applyModeSelect.value : 'ripple';
    var totalDuration = enabledRanges.reduce(function (sum, range) {
      return sum + Math.max(0, Number(range.end) - Number(range.start));
    }, 0);
    var core = window.OrbitCore;
    var operation = core ? core.run({
      id: 'silence-cut-apply', title: 'Apply Smart Jump Cut', button: cutBtn,
      busyLabel: 'Removing…', startMessage: 'Preparing ' + enabledRanges.length + ' cut(s)…',
      confirm: true, danger: applyMode === 'ripple',
      safetyCopy: function () { return !!(safetyCopyToggle && safetyCopyToggle.checked); },
      preview: function () { return 'Remove ' + enabledRanges.length + ' detected silent section(s) (' + totalDuration.toFixed(2) + ' seconds) using ' + applyMode + ' mode.'; },
      execute: function (context) {
        context.status('Applying timeline cuts…');
        return context.host('removeSilenceRanges', [JSON.stringify(enabledRanges), JSON.stringify(cutTracks), applyMode], { timeout: 60000 });
      },
      successMessage: function (result) { return 'Removed ' + ((result && result.removed) || 0) + ' of ' + ((result && result.total) || enabledRanges.length) + ' silent sections.'; },
      toast: false,
      onStatus: function (phase, value, isError) { setStatus(isError ? 'error' : (phase === 'success' ? 'success' : 'working'), value); }
    }) : CEP.evalScript('removeSilenceRanges', [JSON.stringify(enabledRanges), JSON.stringify(cutTracks), applyMode], 60000);

    operation
      .then(function (result) {
        if (result && result.cancelled) return;
        if (result.errors && result.errors.length > 0) {
          setStatus('error', 'Some clips couldn\'t be removed.');
        } else {
          setStatus('success', 'Done! Removed ' + (result.removed || 0) + ' of ' + (result.total || 0) + ' silent sections.');
          detectedSilences = [];
          renderCutList();
          drawWaveform();
        }
      })
      .catch(function (err) {
        setStatus('error', (err && err.message) || 'Something went wrong. Try again.');
      });
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  function setStatus(type, msg) {
    var statusEl = document.getElementById('sc-connection-status');
    if (!statusEl) {
      statusEl = document.createElement('div');
      statusEl.id = 'sc-connection-status';
      statusEl.setAttribute('role', 'status');
      statusEl.setAttribute('aria-live', 'polite');
      statusEl.style.cssText = 'padding:8px 12px;margin:0 0 10px;font-size:12px;line-height:1.5;white-space:normal;overflow-wrap:anywhere;';
      var panel = document.getElementById('panel-silence-cutter');
      if (panel) panel.insertBefore(statusEl, panel.firstChild);
    }
    statusEl.textContent = msg;
    statusEl.style.color = type === 'error' ? '#ff8f9a' : '#b8d6c3';
    if (typeof window.setStatus === 'function') {
      try { window.setStatus(type, msg); } catch (_) {}
    }
    if (type === 'error' && typeof window.showToast === 'function') {
      try { window.showToast(msg, true); } catch (_) {}
    } else if (type === 'success' && typeof window.showToast === 'function') {
      try { window.showToast(msg); } catch (_) {}
    }
    console.log('[SilenceCutter] ' + type + ': ' + msg);
  }

  function _setBtnLoad(btn, isLoading, text, origRef) {
    if (!btn) return;
    if (isLoading) {
      if (!btn._origHTML) btn._origHTML = btn.innerHTML;
      btn.innerHTML = '<span class="btn-spinner"></span>' + (text || 'Working…');
    } else if (btn._origHTML) {
      btn.innerHTML = btn._origHTML;
    }
  }

  function setWorking(isWorking, label) {
    detectBtn.disabled = isWorking;
    _setBtnLoad(detectBtn, isWorking, label || 'Working…');
    if (isWorking) {
      if (typeof window.showBusy === 'function') window.showBusy(label || 'Working…');
    } else {
      if (typeof window.hideBusy === 'function') window.hideBusy();
    }
  }

  // ── Init canvas size ───────────────────────────────────────────────────────
  setTimeout(resizeCanvas, 50);
  window.addEventListener('resize', resizeCanvas);

  // ── Public API ─────────────────────────────────────────────────────────────
  global.SilenceCutter = { init: function () {} };

}(window));
