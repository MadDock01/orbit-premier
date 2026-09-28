/**
 * sfx-design.js — the sound-design drawer under the SFX library.
 *
 * Select a sound, see its waveform, drag a selection, shape it with the rack,
 * and insert the processed result at the playhead. What you hear is exactly
 * what gets inserted: preview and insert both run the same SfxDsp.process over
 * the same selection, so there is no "sounded different in the panel" gap.
 *
 * The rendered audio is written to Documents, not the OS temp directory —
 * Premiere keeps referencing the file after import, and temp cleanup would turn
 * every inserted SFX into offline media.
 */
(function (global) {
  'use strict';

  var el = {};
  var state = {
    item: null,        // { id, name, path, type }
    clip: null,        // decoded SfxDsp clip
    selFrom: 0,        // selection, 0..1 of the whole file
    selTo: 1,
    source: null,      // live preview node
    looping: false,
    drag: null
  };

  function $(id) { return document.getElementById(id); }
  function dsp() { return global.SfxDsp; }

  function req() {
    return global.require || (typeof require === 'function' ? require : null);
  }

  function status(message, error, ok) {
    if (!el.status) return;
    el.status.textContent = message || '';
    el.status.className = 'sfxd-status' + (error ? ' error' : (ok ? ' success' : ''));
  }

  function busy(on) {
    var nodes = document.querySelectorAll('#sfxDesign button, #sfxDesign input');
    for (var i = 0; i < nodes.length; i++) nodes[i].disabled = !!on;
  }

  function audioCtx() {
    if (!state.ctx) state.ctx = new (global.AudioContext || global.webkitAudioContext)();
    return state.ctx;
  }

  // ── Rack ────────────────────────────────────────────────────────────────
  function rack() {
    return {
      gainDb: Number(el.gain && el.gain.value) || 0,
      semitones: Number(el.pitch && el.pitch.value) || 0,
      speed: (Number(el.speed && el.speed.value) || 100) / 100,
      lockPitch: !!(el.lock && el.lock.checked),
      reverse: !!(el.reverse && el.reverse.checked),
      normalize: !!(el.normalize && el.normalize.checked),
      normalizeDb: -1,
      fadeInMs: Number(el.fadeIn && el.fadeIn.value) || 0,
      fadeOutMs: Number(el.fadeOut && el.fadeOut.value) || 0
    };
  }

  function syncLabels() {
    var r = rack();
    if (el.gainVal) el.gainVal.textContent = (r.gainDb > 0 ? '+' : '') + r.gainDb.toFixed(1) + ' dB';
    if (el.pitchVal) el.pitchVal.textContent = (r.semitones > 0 ? '+' : '') + r.semitones + ' st';
    if (el.speedVal) el.speedVal.textContent = Math.round(r.speed * 100) + '%';
    if (el.fadeInVal) el.fadeInVal.textContent = r.fadeInMs + ' ms';
    if (el.fadeOutVal) el.fadeOutVal.textContent = r.fadeOutMs + ' ms';
    updateMeta();
  }

  function selectionSamples() {
    if (!state.clip) return { from: 0, to: 0 };
    var n = dsp().lengthOf(state.clip);
    var a = Math.round(Math.min(state.selFrom, state.selTo) * n);
    var b = Math.round(Math.max(state.selFrom, state.selTo) * n);
    if (b - a < 16) { a = 0; b = n; }
    return { from: a, to: b };
  }

  function render() {
    if (!state.clip) return null;
    var s = selectionSamples();
    return dsp().process(dsp().slice(state.clip, s.from, s.to), rack());
  }

  function updateMeta() {
    if (!el.meta || !state.clip) return;
    var s = selectionSamples(), sr = state.clip.sampleRate;
    var srcSec = (s.to - s.from) / sr;
    var r = rack();
    var outSec = r.lockPitch ? srcSec / (r.speed || 1)
      : srcSec / ((Math.pow(2, r.semitones / 12)) * (r.speed || 1));
    var whole = s.to - s.from >= dsp().lengthOf(state.clip) - 1;
    el.meta.textContent = (whole ? 'full clip' : 'selection') + ' · ' +
      srcSec.toFixed(2) + 's → ' + outSec.toFixed(2) + 's · ' +
      state.clip.channels.length + 'ch · ' + Math.round(sr / 1000) + 'kHz';
  }

  // ── Waveform ────────────────────────────────────────────────────────────
  function drawWave() {
    var canvas = el.wave;
    if (!canvas) return;
    var ratio = global.devicePixelRatio || 1;
    var w = canvas.clientWidth || 260, h = canvas.clientHeight || 72;
    if (canvas.width !== Math.round(w * ratio)) { canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio); }
    var g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#09110c';
    g.fillRect(0, 0, w, h);
    if (!state.clip) return;

    var mid = h / 2, buckets = Math.max(40, Math.floor(w));
    var peaks = dsp().peaks(state.clip.channels[0], buckets);

    // selection band first, so the waveform sits on top of it
    var a = Math.min(state.selFrom, state.selTo) * w, b = Math.max(state.selFrom, state.selTo) * w;
    if (b - a > 1) {
      g.fillStyle = 'rgba(50, 211, 106, .13)';
      g.fillRect(a, 0, b - a, h);
      g.strokeStyle = '#32d36a'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(a + .5, 0); g.lineTo(a + .5, h);
      g.moveTo(b - .5, 0); g.lineTo(b - .5, h); g.stroke();
    }
    g.strokeStyle = '#2a3a31'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, mid + .5); g.lineTo(w, mid + .5); g.stroke();

    g.strokeStyle = '#45d36f'; g.lineWidth = 1;
    g.beginPath();
    for (var i = 0; i < buckets; i++) {
      var x = (i / buckets) * w + .5;
      g.moveTo(x, mid - peaks[i * 2 + 1] * (mid - 2));
      g.lineTo(x, mid - peaks[i * 2] * (mid - 2));
    }
    g.stroke();
  }

  function pointerFraction(event) {
    var rect = el.wave.getBoundingClientRect();
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  }

  function wireCanvas() {
    if (!el.wave) return;
    el.wave.addEventListener('mousedown', function (event) {
      if (!state.clip) return;
      state.drag = pointerFraction(event);
      state.selFrom = state.drag; state.selTo = state.drag;
      drawWave();
      event.preventDefault();
    });
    document.addEventListener('mousemove', function (event) {
      if (state.drag === null || state.drag === undefined) return;
      state.selTo = pointerFraction(event);
      drawWave(); updateMeta();
    });
    document.addEventListener('mouseup', function () {
      if (state.drag === null || state.drag === undefined) return;
      state.drag = null;
      // A click with no drag means "the whole file", not an empty selection.
      if (Math.abs(state.selTo - state.selFrom) < 0.005) { state.selFrom = 0; state.selTo = 1; }
      drawWave(); updateMeta();
    });
    global.addEventListener('resize', drawWave);
  }

  // ── Load ────────────────────────────────────────────────────────────────
  function isAudio(item) {
    if (!item || !item.path) return false;
    return /\.(mp3|wav|aiff|aif|m4a|ogg)$/i.test(item.path);
  }

  function open(item) {
    state.item = item;
    state.clip = null;
    state.selFrom = 0; state.selTo = 1;
    stop();
    if (el.panel) el.panel.hidden = false;
    if (el.name) el.name.textContent = item.name || '';
    status('Decoding…');
    drawWave();

    var nodeReq = req();
    if (!nodeReq) { status('Node access unavailable — cannot read the file.', true); return; }
    var fs = nodeReq('fs');

    fs.promises.readFile(item.path).then(function (data) {
      var ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      return new Promise(function (resolve, reject) {
        audioCtx().decodeAudioData(ab, resolve, function () {
          reject(new Error(/\.aiff?$/i.test(item.path)
            ? 'This build of Premiere cannot decode AIFF for preview. Convert it to WAV first.'
            : 'Could not decode this audio.'));
        });
      });
    }).then(function (buffer) {
      if (state.item !== item) return;         // selection moved on while decoding
      var channels = [];
      for (var c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice());
      state.clip = dsp().clip(buffer.sampleRate, channels);
      drawWave(); updateMeta();
      status('Drag across the waveform to pick a range.', false, true);
    }).catch(function (err) {
      if (state.item !== item) return;
      status(err.message, true);
    });
  }

  function close() {
    stop();
    state.item = null; state.clip = null;
    if (el.panel) el.panel.hidden = true;
  }

  // ── Preview ─────────────────────────────────────────────────────────────
  function stop() {
    state.looping = false;
    if (state.source) {
      try { state.source.onended = null; state.source.stop(); } catch (_) {}
      state.source = null;
    }
    if (el.play) el.play.classList.remove('active');
    if (el.loop) el.loop.classList.remove('active');
  }

  function play(loop) {
    if (!state.clip) { status('Nothing loaded.', true); return; }
    stop();
    var processed;
    try { processed = render(); } catch (err) { status('Render failed: ' + err.message, true); return; }
    if (!processed || !dsp().lengthOf(processed)) { status('The selection is empty.', true); return; }

    var ctx = audioCtx();
    var buffer = ctx.createBuffer(processed.channels.length, dsp().lengthOf(processed), processed.sampleRate);
    for (var c = 0; c < processed.channels.length; c++) buffer.copyToChannel(processed.channels[c], c);
    var src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = !!loop;
    src.connect(ctx.destination);
    src.onended = function () { if (!state.looping) stop(); };
    src.start();
    state.source = src;
    state.looping = !!loop;
    if (loop && el.loop) el.loop.classList.add('active');
    if (!loop && el.play) el.play.classList.add('active');
    status('Playing — this is exactly what Insert will write.');
  }

  // ── Insert ──────────────────────────────────────────────────────────────
  function host(name, args, timeout) {
    if (global.OrbitCore && global.OrbitCore.host) return global.OrbitCore.host.call(name, args || [], { timeout: timeout || 30000 });
    if (!global.CEP || typeof global.CEP.evalScript !== 'function') return Promise.reject(new Error('CEP bridge unavailable'));
    return global.CEP.evalScript(name, args || [], timeout || 30000);
  }

  function outputPath(nodeReq) {
    var fs = nodeReq('fs'), path = nodeReq('path'), os = nodeReq('os');
    // Documents, not os.tmpdir(): Premiere keeps referencing the file after
    // import, and temp cleanup would make every inserted SFX go offline.
    var dir = path.join(os.homedir(), 'Documents', 'CompX-Orbit-Premiere', 'Generated Media', 'sfx');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    var base = String((state.item && state.item.name) || 'sfx').replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '').trim() || 'sfx';
    return path.join(dir, base.slice(0, 40) + '-' + Date.now() + '.wav');
  }

  function insert() {
    if (!state.clip) { status('Select a sound first.', true); return; }
    var nodeReq = req();
    if (!nodeReq) { status('Node access unavailable — cannot write the file.', true); return; }

    busy(true); status('Rendering…');
    Promise.resolve().then(function () {
      var processed = render();
      if (!processed || !dsp().lengthOf(processed)) throw new Error('The selection is empty.');
      var fs = nodeReq('fs');
      var file = outputPath(nodeReq);
      fs.writeFileSync(file, Buffer.from(dsp().encodeWav(processed)));
      status('Inserting…');
      return host('libraryInsertItem', [file, 'audio', '', 0], 40000).then(function (res) {
        if (!res || res.error) throw new Error((res && res.error) || 'Premiere refused the insert.');
        var seconds = dsp().lengthOf(processed) / processed.sampleRate;
        status('Inserted ' + seconds.toFixed(2) + 's at the playhead.', false, true);
      });
    }).catch(function (err) { status(err.message, true); })
      .then(function () { busy(false); });
  }

  function reset() {
    if (el.gain) el.gain.value = 0;
    if (el.pitch) el.pitch.value = 0;
    if (el.speed) el.speed.value = 100;
    if (el.fadeIn) el.fadeIn.value = 0;
    if (el.fadeOut) el.fadeOut.value = 0;
    if (el.lock) el.lock.checked = true;
    if (el.reverse) el.reverse.checked = false;
    if (el.normalize) el.normalize.checked = false;
    state.selFrom = 0; state.selTo = 1;
    syncLabels(); drawWave();
    status('Rack reset.');
  }

  function wire() {
    el = {
      panel: $('sfxDesign'), name: $('sfxdName'), meta: $('sfxdMeta'), close: $('sfxdClose'),
      wave: $('sfxdWave'), status: $('sfxdStatus'),
      play: $('sfxdPlay'), loop: $('sfxdLoop'), stop: $('sfxdStop'), all: $('sfxdAll'),
      gain: $('sfxdGain'), gainVal: $('sfxdGainValue'),
      pitch: $('sfxdPitch'), pitchVal: $('sfxdPitchValue'),
      speed: $('sfxdSpeed'), speedVal: $('sfxdSpeedValue'),
      fadeIn: $('sfxdFadeIn'), fadeInVal: $('sfxdFadeInValue'),
      fadeOut: $('sfxdFadeOut'), fadeOutVal: $('sfxdFadeOutValue'),
      lock: $('sfxdLock'), reverse: $('sfxdReverse'), normalize: $('sfxdNormalize'),
      reset: $('sfxdReset'), insert: $('sfxdInsert')
    };
    if (!el.panel) return;

    ['gain', 'pitch', 'speed', 'fadeIn', 'fadeOut'].forEach(function (k) {
      if (el[k]) el[k].addEventListener('input', syncLabels);
    });
    ['lock', 'reverse', 'normalize'].forEach(function (k) {
      if (el[k]) el[k].addEventListener('change', syncLabels);
    });
    if (el.play) el.play.addEventListener('click', function () { play(false); });
    if (el.loop) el.loop.addEventListener('click', function () { play(true); });
    if (el.stop) el.stop.addEventListener('click', stop);
    if (el.all) el.all.addEventListener('click', function () {
      state.selFrom = 0; state.selTo = 1; drawWave(); updateMeta();
    });
    if (el.reset) el.reset.addEventListener('click', reset);
    if (el.insert) el.insert.addEventListener('click', insert);
    if (el.close) el.close.addEventListener('click', close);
    wireCanvas();

    document.addEventListener('compx:sfx-selected', function (event) {
      var item = event && event.detail;
      if (!item) { close(); return; }
      if (!isAudio(item)) { close(); return; }   // MOGRT and presets have nothing to design
      open(item);
    });

    syncLabels();
  }

  wire();
  global.SfxDesign = {
    open: open, close: close, play: play, stop: stop, insert: insert, reset: reset,
    render: render, rack: rack, _state: state
  };
}(window));
