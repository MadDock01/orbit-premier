(function (global) {
  'use strict';
  function byId(id) { return document.getElementById(id); }
  var el = {
    refresh: byId('multicamRefresh'), analyze: byId('multicamAnalyze'), preview: byId('multicamPreview'),
    apply: byId('multicamApply'), markers: byId('multicamMarkers'), sequence: byId('multicamSequence'),
    plan: byId('multicamPlan'), list: byId('multicamPreviewList'), cameraA: byId('multicamCameraA'),
    cameraB: byId('multicamCameraB'), wide: byId('multicamWideCamera'), micA: byId('multicamMicA'),
    micB: byId('multicamMicB'), minShot: byId('multicamMinShot'), silence: byId('multicamSilence'),
    overlap: byId('multicamOverlapWide'), safety: byId('multicamSafetyCopy')
  };
  var lastSuggestions = [];

  function call(name, args, timeout) {
    return new Promise(function (resolve, reject) {
      if (!global.CEP || !global.CEP.evalScript) return reject(new Error('CEP bridge unavailable'));
      global.CEP.evalScript(name, args || [], timeout || 20000).then(resolve).catch(reject);
    });
  }
  function parse(v) {
    if (typeof v === 'string') {
      try { return JSON.parse(v); } catch (_) { return { error: v }; }
    }
    return v || {};
  }
  function setSelect(select, tracks, prefix) {
    if (!select) return;
    var old = select.value;
    select.innerHTML = '';
    (tracks || []).forEach(function (t) {
      var o = document.createElement('option');
      o.value = String(t.index + 1);
      o.textContent = prefix + (t.index + 1) + ' · ' + t.clips + ' clips';
      select.appendChild(o);
    });
    if (old && select.querySelector('option[value="' + old + '"]')) select.value = old;
  }
  function autoMap(r) {
    var audio = (r.audioTracks || []).filter(function (t) { return t.clips > 0; });
    var video = (r.videoTracks || []).filter(function (t) { return t.clips > 0; });
    if (audio.length && el.micA) el.micA.value = String(audio[0].index + 1);
    if (audio.length > 1 && el.micB) el.micB.value = String(audio[1].index + 1);
    else if (audio.length === 1 && el.micB && r.audioTracks.length > 1) el.micB.value = String(Math.min(r.audioTracks.length, audio[0].index + 2));
    if (video.length && el.cameraA) el.cameraA.value = String(video[0].index + 1);
    if (video.length > 1 && el.cameraB) el.cameraB.value = String(video[1].index + 1);
    if (video.length > 2 && el.wide) el.wide.value = String(video[2].index + 1);
    else if (video.length && el.wide) el.wide.value = String(video[0].index + 1);
  }
  function settings() {
    return {
      speakerATrack: Number(el.micA && el.micA.value || 1),
      speakerBTrack: Number(el.micB && el.micB.value || 2),
      cameraA: Number(el.cameraA && el.cameraA.value || 1),
      cameraB: Number(el.cameraB && el.cameraB.value || 2),
      wideCamera: Number(el.wide && el.wide.value || 1),
      minShot: Number(el.minShot && el.minShot.value || 2),
      silenceToWide: Number(el.silence && el.silence.value || 1),
      overlapToWide: !!(el.overlap && el.overlap.checked),
      safetyCopy: !!(el.safety && el.safety.checked)
    };
  }
  function time(sec) {
    sec = Math.max(0, Number(sec) || 0);
    var m = Math.floor(sec / 60), s = (sec - m * 60).toFixed(1);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function showPlan(r) {
    var s = r.suggestions || [];
    lastSuggestions = s;
    if (el.markers) el.markers.disabled = !s.length;
    if (el.apply) el.apply.disabled = !s.length;
    if (el.plan) el.plan.textContent = r.summary || (s.length + ' suggested camera changes.');
    if (el.list) {
      el.list.innerHTML = s.slice(0, 80).map(function (x) {
        return '<div class="mc-preview-row"><span class="mc-time">' + time(x.time) +
          '</span><b class="mc-label">' + x.label + '</b><span class="mc-reason">' + x.reason + '</span></div>';
      }).join('') || '<div class="mc-preview-row">No speaker boundaries were found.</div>';
    }
  }
  function inspect() {
    if (el.sequence) el.sequence.textContent = 'Reading active sequence…';
    return call('multicamInspect', []).then(parse).then(function (r) {
      if (r.error) throw new Error(r.error);
      setSelect(el.cameraA, r.videoTracks, 'V');
      setSelect(el.cameraB, r.videoTracks, 'V');
      setSelect(el.wide, r.videoTracks, 'V');
      setSelect(el.micA, r.audioTracks, 'A');
      setSelect(el.micB, r.audioTracks, 'A');
      autoMap(r);
      if (el.sequence) {
        el.sequence.textContent = r.sequenceName + ' · ' + r.videoTracks.length +
          ' video / ' + r.audioTracks.length + ' audio tracks · ' + time(r.duration);
      }
      if (el.preview) el.preview.disabled = false;
      if (el.plan) el.plan.textContent = 'Tracks mapped from clip activity. Preview plans switches; Apply keeps the active camera.';
    }).catch(function (e) {
      if (el.sequence) el.sequence.textContent = 'Could not read sequence: ' + e.message;
    });
  }
  function preview() {
    if (el.plan) el.plan.textContent = 'Building speaker-switch preview…';
    return call('multicamPreviewSwitches', [JSON.stringify(settings())]).then(parse).then(function (r) {
      if (r.error) throw new Error(r.error);
      showPlan(r);
    }).catch(function (e) {
      if (el.plan) el.plan.textContent = 'Preview failed: ' + e.message;
    });
  }
  function markers() {
    if (el.markers) el.markers.disabled = true;
    if (el.plan) el.plan.textContent = 'Creating review markers…';
    call('multicamCreateReviewMarkers', [JSON.stringify(settings())]).then(parse).then(function (r) {
      if (r.error) throw new Error(r.error);
      if (el.plan) el.plan.textContent = 'Created ' + r.created + ' review markers in "' + r.sequenceName + '".';
      if (el.markers) el.markers.disabled = false;
    }).catch(function (e) {
      if (el.plan) el.plan.textContent = 'Marker creation failed: ' + e.message;
      if (el.markers) el.markers.disabled = false;
    });
  }
  function applySwitches() {
    if (!lastSuggestions.length) {
      if (el.plan) el.plan.textContent = 'Preview switches first so the plan is ready.';
      return;
    }
    if (el.apply) el.apply.disabled = true;
    if (el.plan) el.plan.textContent = 'Applying camera switches…';
    call('multicamApplySwitches', [JSON.stringify(settings())], 180000).then(parse).then(function (r) {
      if (r.error) throw new Error(r.error);
      if (el.plan) {
        el.plan.textContent = 'Applied ' + (r.segments || 0) + ' segment(s) · removed ' +
          (r.removed || 0) + ' off-camera piece(s)' +
          (r.backupName ? ' · safety copy: ' + r.backupName : '') + '.';
      }
      if (typeof global.showToast === 'function') {
        try { global.showToast(el.plan.textContent, false); } catch (_) {}
      }
      if (el.apply) el.apply.disabled = !lastSuggestions.length;
    }).catch(function (e) {
      if (el.plan) el.plan.textContent = 'Apply failed: ' + e.message;
      if (el.apply) el.apply.disabled = !lastSuggestions.length;
    });
  }

  if (el.refresh) {
    el.refresh.addEventListener('click', inspect);
    if (el.analyze) el.analyze.addEventListener('click', inspect);
    if (el.preview) el.preview.addEventListener('click', preview);
    if (el.markers) el.markers.addEventListener('click', markers);
    if (el.apply) el.apply.addEventListener('click', applySwitches);
  }
  global.addEventListener('compx:rail-route', function (event) {
    if (event && event.detail && event.detail.type === 'multicam') inspect();
  });
  global.MulticamPanel = { inspect: inspect, preview: preview, markers: markers, apply: applySwitches };
}(window));
