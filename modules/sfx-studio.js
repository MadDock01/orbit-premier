/**
 * sfx-studio.js — the SFX view: browse a local sound library, shape a sound,
 * put it on the timeline.
 *
 * Replaces the old SFX half of the shared SFX/MOGRT library. The old one could
 * find a file and drop it at the playhead; everything between those two steps —
 * hearing it, trimming to the part you want, pitching it, reversing it — meant
 * leaving the panel. This does that part.
 *
 * Three collaborators, and the split matters:
 *   · SfxLibrary  — the index. No DOM, no Premiere.
 *   · SfxDsp      — the maths. No DOM, no Premiere, no Web Audio.
 *   · this file   — the DOM, Web Audio playback, and the host calls.
 *
 * The rule that keeps preview honest: previewing and inserting both call
 * render(), so what you hear is the file that gets written. Any effect that
 * only existed in the preview path would be a lie.
 */
(function (global) {
  'use strict';

  // Colour labels. The colours themselves live in css/sfx-studio.css, keyed
  // off data-label, so the palette is one place.
  var LABELS = ['', 'orange', 'yellow', 'green', 'purple'];

  var state = {
    lib: null, item: null, clip: null,
    selFrom: 0, selTo: 1,            // fraction of the clip
    viewFrom: 0, viewTo: 1,          // fraction shown by the waveform
    stereo: true, loop: false,
    ctx: null, source: null, playing: false,
    results: [], settings: { target: 'playhead', normalize: false },
    // '' means every indexed folder; otherwise the folder the sources column
    // has selected.
    root: '',
    media: null, busy: false,
    // Mono peak data per decoded sound, for the list's mini waveforms. Keyed
    // by path so it survives re-sorting and re-filtering the list.
    waves: {}
  };

  function $(id) { return document.getElementById(id); }
  function el(sel, root) { return (root || document).querySelector(sel); }

  function host(name, args, timeout) {
    if (global.OrbitCore && global.OrbitCore.host) return global.OrbitCore.host.call(name, args || [], { timeout: timeout || 20000 });
    if (!global.CEP || typeof global.CEP.evalScript !== 'function') return Promise.reject(new Error('CEP bridge unavailable'));
    return global.CEP.evalScript(name, args || [], timeout || 20000);
  }

  function nodeRequire() {
    var req = global.require || (typeof require === 'function' ? require : null);
    if (!req) throw new Error('Local file access is unavailable in this panel.');
    return req;
  }

  function status(message, error) {
    var line = $('sfxsStatus');
    if (!line) return;
    line.textContent = message || '';
    line.classList.toggle('error', !!error);
  }

  function busy(on) {
    state.busy = !!on;
    var view = $('sfxStudioView');
    if (view) view.classList.toggle('is-busy', !!on);
  }

  function seconds(value) {
    var v = Math.max(0, Number(value) || 0);
    return v >= 10 ? v.toFixed(1) + 's' : v.toFixed(2) + 's';
  }

  // m:ss.hh — a length you can compare at a glance down a column.
  function clock(value) {
    var v = Math.max(0, Number(value) || 0);
    var m = Math.floor(v / 60), rest = v - m * 60;
    return m + ':' + (rest < 10 ? '0' : '') + rest.toFixed(2);
  }

  /* ------------------------------------------------------------ browser -- */

  function readFilters() {
    var active = el('.sfxs-chip.active');
    return {
      search: ($('sfxsSearch') || {}).value || '',
      filter: active ? active.getAttribute('data-sfxs-filter') : 'all',
      sort: ($('sfxsSort') || {}).value || 'name',
      root: state.root || ''
    };
  }

  function fmtOf(name) {
    var dot = String(name).lastIndexOf('.');
    return dot < 0 ? '—' : String(name).slice(dot + 1).toUpperCase();
  }

  function sizeOf(bytes) {
    var n = Number(bytes) || 0;
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  // Four boxed cells cost 103px of a 676px panel to say four short things.
  // One line says the same in 13px, and the space goes to the results list.
  function setFacts(item, clip) {
    var line = $('sfxsFacts');
    if (!line) return;
    if (!item) { line.textContent = ''; return; }
    var parts = [fmtOf(item.name), sizeOf(item.size)];
    if (clip) {
      parts.push(clock(global.SfxDsp.lengthOf(clip) / clip.sampleRate));
      parts.push(Math.round(clip.sampleRate / 1000) + ' kHz');
      parts.push(clip.channels.length > 1 ? 'stereo' : 'mono');
    } else if (item.duration > 0) {
      parts.push(clock(item.duration));
    }
    line.textContent = parts.join(' · ');
  }

  function filterCounts() {
    if (!state.lib) return { all: 0, oneshot: 0, ambience: 0, favorites: 0 };
    var all = state.lib.all(), out = { all: all.length, oneshot: 0, ambience: 0, favorites: 0 };
    for (var i = 0; i < all.length; i++) {
      var k = state.lib.kind(all[i]);
      if (k === 'oneshot') out.oneshot++;
      else if (k === 'ambience') out.ambience++;
      if (all[i].favorite) out.favorites++;
    }
    return out;
  }

  function renderList() {
    var list = $('sfxsList');
    if (!list || !state.lib) return;
    state.results = state.lib.query(readFilters());

    var totals = filterCounts();
    var chips = { sfxsCountAll: totals.all, sfxsCountOneshot: totals.oneshot,
      sfxsCountAmbience: totals.ambience, sfxsCountFav: totals.favorites };
    Object.keys(chips).forEach(function (id) { var node = $(id); if (node) node.textContent = chips[id]; });
    var count = $('sfxsCount');
    if (count) count.textContent = state.results.length + (state.results.length === 1 ? ' result' : ' results');

    if (!state.results.length) {
      list.innerHTML = '<div class="sfxs-empty">' + (totals.all
        ? 'No sound matches this search.'
        : 'No sounds indexed yet. Add a folder with + to get started.') + '</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < state.results.length; i++) {
      var item = state.results[i];
      var selected = state.item && state.item.path === item.path;
      html += '<div class="sfxs-card' + (selected ? ' selected' : '') + (item.missing ? ' missing' : '') +
        '" data-sfxs-index="' + i + '" title="' + item.path.replace(/"/g, '&quot;') + '">' +
        '<button type="button" class="sfxs-cardplay" data-sfxs-row-play="' + i + '" aria-label="Preview">▶</button>' +
        '<div class="sfxs-cardmain">' +
          '<div class="sfxs-cardname">' +
            '<i class="sfxs-label"' + (item.label ? ' data-label="' + item.label + '"' : '') + '></i>' +
            '<span>' + item.name.replace(/</g, '&lt;') + '</span>' +
            // The length sits with the name rather than in the right-hand
            // column, because that column is the first thing to go on a
            // narrow panel and the length is the last thing you'd give up.
            '<b class="sfxs-carddur">' + (item.duration > 0 ? clock(item.duration) : '—:—') + '</b>' +
          '</div>' +
          '<canvas class="sfxs-cardwave" data-sfxs-wave="' + i + '" height="16"></canvas>' +
        '</div>' +
        '<div class="sfxs-cardside">' +
          '<span class="sfxs-cardfmt">' + fmtOf(item.name) + ' · ' + sizeOf(item.size) + '</span>' +
        '</div>' +
        '<button type="button" class="sfxs-heart' + (item.favorite ? ' on' : '') +
          '" data-sfxs-row-fav="' + i + '" aria-label="Favourite">' + (item.favorite ? '★' : '☆') + '</button>' +
        '</div>';
    }
    list.innerHTML = html;
    drawCardWaves();
  }

  /**
   * The per-row waveforms. Only sounds already decoded get one — decoding
   * every file in a folder of several hundred to paint a list would lock the
   * panel for minutes, so a row shows a flat line until it has been heard,
   * which is the same thing its "—:—" duration is saying.
   */
  function drawCardWaves() {
    var canvases = document.querySelectorAll('#sfxsList [data-sfxs-wave]');
    for (var i = 0; i < canvases.length; i++) {
      var canvas = canvases[i];
      var item = state.results[Number(canvas.getAttribute('data-sfxs-wave'))];
      var cached = item && state.waves[item.path];
      var ratio = global.devicePixelRatio || 1;
      var width = canvas.clientWidth || 120, height = canvas.clientHeight || 16;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      var ctx = canvas.getContext('2d');
      if (!ctx) continue;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      var mid = height / 2;
      if (!cached) {
        ctx.fillStyle = 'rgba(120,150,130,.22)';
        ctx.fillRect(0, mid - 0.5, width, 1);
        continue;
      }
      var peaks = global.SfxDsp.peaks(cached, Math.max(1, Math.round(width)));
      ctx.fillStyle = state.item && item.path === state.item.path ? '#5fd97f' : '#2f7a4a';
      for (var x = 0; x < width; x++) {
        var lo = peaks[x * 2], hi = peaks[x * 2 + 1];
        var top = mid - hi * (mid * 0.92), bottom = mid - lo * (mid * 0.92);
        ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
      }
    }
  }

  /* -------------------------------------------------------- decode/draw -- */

  function audioContext() {
    if (!state.ctx) {
      var Ctor = global.AudioContext || global.webkitAudioContext;
      if (!Ctor) throw new Error('This panel has no Web Audio support.');
      state.ctx = new Ctor();
    }
    return state.ctx;
  }

  function decode(filePath) {
    var fs = nodeRequire()('fs');
    return fs.promises.readFile(filePath).then(function (buffer) {
      var copy = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      return audioContext().decodeAudioData(copy);
    }).then(function (decoded) {
      var channels = [];
      for (var c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));
      return global.SfxDsp.clip(decoded.sampleRate, channels);
    });
  }

  function drawWave() {
    var canvas = $('sfxsWave');
    if (!canvas) return;
    var ratio = global.devicePixelRatio || 1;
    var width = canvas.clientWidth || 260, height = canvas.clientHeight || 92;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#09110c';
    ctx.fillRect(0, 0, width, height);
    if (!state.clip) return;

    var total = global.SfxDsp.lengthOf(state.clip);
    var from = Math.floor(state.viewFrom * total), to = Math.ceil(state.viewTo * total);
    var lanes = state.stereo && state.clip.channels.length > 1 ? 2 : 1;
    var laneH = height / lanes;

    for (var lane = 0; lane < lanes; lane++) {
      var channel = state.clip.channels[Math.min(lane, state.clip.channels.length - 1)];
      var slice = channel.subarray(from, to);
      var peaks = global.SfxDsp.peaks(slice, Math.max(1, Math.round(width)));
      var mid = laneH * lane + laneH / 2, scale = (laneH / 2) * 0.92;
      ctx.fillStyle = '#2f9e52';
      for (var x = 0; x < width; x++) {
        var lo = peaks[x * 2], hi = peaks[x * 2 + 1];
        var top = mid - hi * scale, bottom = mid - lo * scale;
        ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
      }
      if (lane) { ctx.strokeStyle = 'rgba(120,150,130,.25)'; ctx.beginPath(); ctx.moveTo(0, laneH); ctx.lineTo(width, laneH); ctx.stroke(); }
    }

    // Selection, drawn in view coordinates so it stays put while zooming.
    var span = state.viewTo - state.viewFrom;
    if (span > 0) {
      var sx = (state.selFrom - state.viewFrom) / span * width;
      var ex = (state.selTo - state.viewFrom) / span * width;
      ctx.fillStyle = 'rgba(0,0,0,.45)';
      if (sx > 0) ctx.fillRect(0, 0, Math.min(sx, width), height);
      if (ex < width) ctx.fillRect(Math.max(0, ex), 0, width - Math.max(0, ex), height);
      ctx.strokeStyle = '#45d66f';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, height); ctx.moveTo(ex, 0); ctx.lineTo(ex, height); ctx.stroke();
    }
  }

  function syncSegmentFields() {
    if (!state.clip) return;
    var duration = global.SfxDsp.lengthOf(state.clip) / state.clip.sampleRate;
    var from = $('sfxsIn'), to = $('sfxsOut');
    if (from) from.value = (state.selFrom * duration).toFixed(2);
    if (to) to.value = (state.selTo * duration).toFixed(2);
    var span = $('sfxsSpan');
    if (span) span.textContent = seconds((state.selTo - state.selFrom) * duration);
  }

  /* ------------------------------------------------------------ render -- */

  function rackOptions() {
    function num(id, fallback) { var node = $(id); return node ? Number(node.value) : fallback; }
    function on(id) { var node = $(id); return !!(node && node.checked); }
    return {
      gainDb: num('sfxsGain', 0),
      semitones: num('sfxsPitch', 0),
      speed: num('sfxsSpeed', 100) / 100,
      lockPitch: on('sfxsLock'),
      reverse: on('sfxsReverse'),
      fadeInMs: num('sfxsFadeIn', 0),
      fadeOutMs: num('sfxsFadeOut', 0),
      normalize: on('sfxsNormalize')
    };
  }

  /**
   * The processed clip. Preview and both Insert buttons go through here, so
   * there is exactly one definition of what the sound is.
   */
  function render(useSelection) {
    if (!state.clip) return null;
    var source = state.clip;
    if (useSelection) {
      var total = global.SfxDsp.lengthOf(state.clip);
      source = global.SfxDsp.slice(state.clip, state.selFrom * total, state.selTo * total);
    }
    return global.SfxDsp.process(source, rackOptions());
  }

  function stop() {
    if (state.source) { try { state.source.stop(); } catch (_) {} state.source = null; }
    state.playing = false;
    var play = $('sfxsPlay');
    if (play) { play.classList.remove('active'); play.textContent = '▶'; }
  }

  function play(useSelection) {
    if (!state.clip) return;
    stop();
    var rendered = render(useSelection);
    if (!rendered) return;
    var ctx = audioContext();
    var buffer = ctx.createBuffer(rendered.channels.length, global.SfxDsp.lengthOf(rendered), rendered.sampleRate);
    for (var c = 0; c < rendered.channels.length; c++) buffer.copyToChannel(rendered.channels[c], c);
    var node = ctx.createBufferSource();
    node.buffer = buffer;
    node.loop = !!state.loop;
    node.connect(ctx.destination);
    node.onended = function () { if (state.source === node) stop(); };
    node.start();
    state.source = node;
    state.playing = true;
    var button = $('sfxsPlay');
    if (button) { button.classList.add('active'); button.textContent = '❚❚'; }
    status('Playing — this is exactly what Insert will write.');
  }

  /* ------------------------------------------------------------ insert -- */

  function mediaFolder() {
    if (state.media) return Promise.resolve(state.media);
    return host('sfxMediaFolder', [], 15000).then(function (res) {
      if (!res || res.error) throw new Error((res && res.error) || 'Could not work out where to write the audio.');
      state.media = res;
      return res;
    });
  }

  function safeName(name) { return String(name).replace(/[\\\/:*?"<>|]+/g, '_').replace(/\.[^.]+$/, ''); }

  function insert(useSelection) {
    if (!state.clip || !state.item) { status('Select a sound first.', true); return Promise.resolve(); }
    busy(true);
    status('Preparing audio…');
    return mediaFolder().then(function (media) {
      var rendered = render(useSelection);
      var wav = global.SfxDsp.encodeWav(rendered);
      var req = nodeRequire(), fs = req('fs'), path = req('path'), BufferCtor = req('buffer').Buffer;
      var folder = useSelection ? media.segments : media.converted;
      if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
      var label = safeName(state.item.name) + (useSelection ? '-segment' : '-edit') + '-' + Date.now() + '.wav';
      var file = path.join(folder, label);
      fs.writeFileSync(file, BufferCtor.from(wav));
      status('Inserting…');
      return host('sfxInsertAudio', [file, JSON.stringify({
        target: state.settings.target, cue: 0,
        kind: useSelection ? 'segment' : 'full',
        label: safeName(state.item.name)
      })], 30000);
    }).then(function (res) {
      if (!res || res.error) throw new Error((res && res.error) || 'The audio could not be inserted.');
      var where = res.target === 'clip' ? 'at the selected clip' : 'at the playhead';
      status('Inserted on A' + ((res.track || 0) + 1) + ' ' + where +
        (state.media && state.media.scope === 'user' ? ' · saved to Documents (project not saved yet)' : ''));
    }).catch(function (err) {
      status(err.message, true);
    }).then(function () { busy(false); });
  }

  /* ------------------------------------------------------------ select -- */

  function select(item) {
    if (!item) return Promise.resolve();
    stop();
    state.item = item;
    state.selFrom = 0; state.selTo = 1;
    state.viewFrom = 0; state.viewTo = 1;
    var name = $('sfxsName');
    if (name) name.textContent = item.name;
    var now = $('sfxsNowName');
    if (now) now.textContent = item.name;
    var view = $('sfxStudioView');
    if (view) view.classList.add('has-sound');
    setFacts(item, null);
    renderList();
    status('Decoding…');
    return decode(item.path).then(function (clip) {
      state.clip = clip;
      var duration = global.SfxDsp.lengthOf(clip) / clip.sampleRate;
      // The index does not measure duration during a scan, so this is where
      // it learns — which is also what makes the one-shot/ambience filter
      // fill in as you listen rather than after a long blocking pass.
      if (state.lib) state.lib.note(item.path, { duration: duration, channels: clip.channels.length });
      // Cache a mono copy for the list's mini waveform, so the row fills in
      // the moment the sound has been heard once.
      state.waves[item.path] = clip.channels[0];
      setFacts(item, clip);
      var stereoBtn = el('[data-sfxs-action="stereo"]'), monoBtn = el('[data-sfxs-action="mono"]');
      if (clip.channels.length < 2) {
        state.stereo = false;
        if (stereoBtn) stereoBtn.disabled = true;
      } else if (stereoBtn) stereoBtn.disabled = false;
      if (stereoBtn) stereoBtn.classList.toggle('active', state.stereo);
      if (monoBtn) monoBtn.classList.toggle('active', !state.stereo);
      drawWave();
      syncSegmentFields();
      renderList();
      status('');
    }).catch(function (err) {
      state.clip = null;
      var hint = /\.aiff?$/i.test(item.name)
        ? 'This panel’s decoder does not read AIFF. Convert it to WAV to use it here.'
        : err.message;
      status(hint, true);
    });
  }

  function step(delta) {
    if (!state.results.length) return;
    var at = -1;
    for (var i = 0; i < state.results.length; i++) if (state.item && state.results[i].path === state.item.path) { at = i; break; }
    var next = at < 0 ? 0 : (at + delta + state.results.length) % state.results.length;
    select(state.results[next]);
  }

  /* -------------------------------------------------------------- wire -- */

  function pickFolder() {
    var input = $('sfxsFolderInput');
    if (input) input.click();
  }

  function addPickedFolder(files) {
    if (!files || !files.length || !state.lib) return;
    var req = nodeRequire(), path = req('path');
    var first = files[0];
    var full = first.path || '';
    if (!full) { status('This panel could not read the folder path.', true); return; }
    // A directory picker hands back the files inside it, so the folder is the
    // first file's parent minus the relative path it came with.
    var relative = String(first.webkitRelativePath || '');
    var depth = relative ? relative.split('/').length - 1 : 0;
    var folder = path.dirname(full);
    for (var i = 1; i < depth; i++) folder = path.dirname(folder);
    var result = state.lib.addFolder(folder);
    if (result.error) { status(result.error, true); return; }
    status('Indexed ' + result.added + ' sound' + (result.added === 1 ? '' : 's') + ' from ' + folder + '.');
    renderFolders();
    renderList();
  }

  /**
   * The sources column: every indexed folder with its own count, the way the
   * After Effects panel shows it. "All local sounds" is a real entry rather
   * than a cleared filter, because with one folder indexed the two look the
   * same and the user should still see what is there.
   */
  function renderFolders() {
    var box = $('sfxsFolders');
    if (!box || !state.lib) return;
    var folders = state.lib.folders();
    var perFolder = state.lib.folderCounts();
    var totals = state.lib.counts();
    var filter = (($('sfxsFolderFilter') || {}).value || '').toLowerCase();

    var head = $('sfxsSourceCount');
    if (head) head.textContent = folders.length
      ? folders.length + (folders.length === 1 ? ' source active' : ' sources active')
      : 'No source';
    var foot = $('sfxsIndexedCount');
    if (foot) foot.textContent = totals.total + ' indexed sound' + (totals.total === 1 ? '' : 's');

    var html = '<button type="button" class="sfxs-src' + (state.root ? '' : ' active') +
      '" data-sfxs-root=""><span class="sfxs-srcname">All local sounds</span>' +
      '<span class="sfxs-srcsub">Every indexed folder</span>' +
      '<i class="sfxs-srcn">' + totals.total + '</i></button>';

    var shown = 0;
    for (var i = 0; i < folders.length; i++) {
      var folder = folders[i];
      var leaf = folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder;
      if (filter && leaf.toLowerCase().indexOf(filter) < 0 && folder.toLowerCase().indexOf(filter) < 0) continue;
      shown++;
      html += '<button type="button" class="sfxs-src' + (state.root === folder ? ' active' : '') +
        '" data-sfxs-root="' + folder.replace(/"/g, '&quot;') + '" title="' + folder.replace(/"/g, '&quot;') + '">' +
        '<span class="sfxs-srcname">' + leaf.replace(/</g, '&lt;') + '</span>' +
        '<span class="sfxs-srcsub">' + folder.replace(/</g, '&lt;') + '</span>' +
        '<i class="sfxs-srcn">' + (perFolder[folder] || 0) + '</i>' +
        '<b class="sfxs-srcdrop" data-sfxs-drop="' + i + '" title="Remove from the index (the files are not touched)">\u00d7</b>' +
        '</button>';
    }
    if (!folders.length) html += '<div class="sfxs-empty">Add a folder to index your sounds.</div>';
    else if (!shown) html += '<div class="sfxs-empty">No folder matches that filter.</div>';
    box.innerHTML = html;
  }

  function canvasFraction(event) {
    var canvas = $('sfxsWave');
    var rect = canvas.getBoundingClientRect();
    var at = (event.clientX - rect.left) / Math.max(1, rect.width);
    at = Math.max(0, Math.min(1, at));
    return state.viewFrom + at * (state.viewTo - state.viewFrom);
  }

  function zoom(factor) {
    var centre = (state.selFrom + state.selTo) / 2;
    var span = Math.max(0.005, Math.min(1, (state.viewTo - state.viewFrom) * factor));
    var from = centre - span / 2, to = centre + span / 2;
    if (from < 0) { to -= from; from = 0; }
    if (to > 1) { from -= (to - 1); to = 1; }
    state.viewFrom = Math.max(0, from);
    state.viewTo = Math.min(1, to);
    var readout = $('sfxsZoom');
    if (readout) readout.textContent = (1 / Math.max(0.005, state.viewTo - state.viewFrom)).toFixed(1) + '×';
    drawWave();
  }

  function wire() {
    var view = $('sfxStudioView');
    if (!view || view.getAttribute('data-sfxs-wired') === '1') return;
    view.setAttribute('data-sfxs-wired', '1');

    state.lib = global.SfxLibrary ? global.SfxLibrary.create({}) : null;

    var search = $('sfxsSearch');
    if (search) search.addEventListener('input', renderList);
    var sort = $('sfxsSort');
    if (sort) sort.addEventListener('change', renderList);
    var folderFilter = $('sfxsFolderFilter');
    if (folderFilter) folderFilter.addEventListener('input', renderFolders);

    view.addEventListener('click', function (event) {
      var target = event.target;
      var chip = target.closest ? target.closest('[data-sfxs-filter]') : null;
      if (chip) {
        var chips = view.querySelectorAll('.sfxs-chip');
        for (var c = 0; c < chips.length; c++) chips[c].classList.toggle('active', chips[c] === chip);
        renderList();
        return;
      }
      // The heart and the round play button sit inside the card, so they are
      // checked before the card itself or every one of them would just select.
      var fav = target.closest ? target.closest('[data-sfxs-row-fav]') : null;
      if (fav && state.lib) {
        var favItem = state.results[Number(fav.getAttribute('data-sfxs-row-fav'))];
        if (favItem) { state.lib.mark(favItem.path, { favorite: !favItem.favorite }); renderList(); }
        return;
      }
      var rowPlay = target.closest ? target.closest('[data-sfxs-row-play]') : null;
      if (rowPlay) {
        var playItem = state.results[Number(rowPlay.getAttribute('data-sfxs-row-play'))];
        if (!playItem) return;
        if (state.item && state.item.path === playItem.path && state.playing) { stop(); return; }
        Promise.resolve(select(playItem)).then(function () { if (state.clip) play(false); });
        return;
      }
      var row = target.closest ? target.closest('[data-sfxs-index]') : null;
      if (row) { select(state.results[Number(row.getAttribute('data-sfxs-index'))]); return; }
      // The × sits inside the source button, so it is checked first or every
      // press of it would just select that folder.
      var drop = target.closest ? target.closest('[data-sfxs-drop]') : null;
      if (drop && state.lib) {
        var folders = state.lib.folders();
        var going = folders[Number(drop.getAttribute('data-sfxs-drop'))];
        state.lib.removeFolder(going);
        if (state.root === going) state.root = '';
        renderFolders(); renderList();
        return;
      }
      var src = target.closest ? target.closest('[data-sfxs-root]') : null;
      if (src) {
        state.root = src.getAttribute('data-sfxs-root') || '';
        renderFolders(); renderList();
        return;
      }
      var action = target.closest ? target.closest('[data-sfxs-action]') : null;
      if (!action) return;
      run(action.getAttribute('data-sfxs-action'));
    });

    var canvas = $('sfxsWave');
    if (canvas) {
      var dragging = false, anchor = 0;
      canvas.addEventListener('mousedown', function (event) {
        if (!state.clip) return;
        dragging = true; anchor = canvasFraction(event);
        state.selFrom = anchor; state.selTo = anchor;
        drawWave(); syncSegmentFields();
      });
      global.addEventListener('mousemove', function (event) {
        if (!dragging) return;
        var at = canvasFraction(event);
        state.selFrom = Math.min(anchor, at);
        state.selTo = Math.max(anchor, at);
        drawWave(); syncSegmentFields();
      });
      global.addEventListener('mouseup', function () {
        if (!dragging) return;
        dragging = false;
        // A click with no drag is "select nothing", which is never what
        // anyone meant; treat it as clearing back to the whole sound.
        if (state.selTo - state.selFrom < 0.002) { state.selFrom = 0; state.selTo = 1; }
        drawWave(); syncSegmentFields();
      });
      global.addEventListener('resize', function () { drawWave(); drawCardWaves(); });
    }

    ['sfxsIn', 'sfxsOut'].forEach(function (id) {
      var field = $(id);
      if (!field) return;
      field.addEventListener('change', function () {
        if (!state.clip) return;
        var duration = global.SfxDsp.lengthOf(state.clip) / state.clip.sampleRate;
        var from = Math.max(0, Math.min(duration, Number($('sfxsIn').value) || 0));
        var to = Math.max(0, Math.min(duration, Number($('sfxsOut').value) || duration));
        if (to <= from) to = Math.min(duration, from + 0.05);
        state.selFrom = from / duration; state.selTo = to / duration;
        drawWave(); syncSegmentFields();
      });
    });

    var rack = view.querySelectorAll('.sfxs-rack input, .sfxs-rack select');
    for (var r = 0; r < rack.length; r++) {
      rack[r].addEventListener('input', function (event) {
        var readout = event.target.parentNode.querySelector('.val');
        if (readout) readout.textContent = event.target.getAttribute('data-suffix')
          ? event.target.value + event.target.getAttribute('data-suffix') : event.target.value;
      });
    }

    var target = $('sfxsTarget');
    if (target) target.addEventListener('change', function () { state.settings.target = target.value; });

    var folderInput = $('sfxsFolderInput');
    if (folderInput) folderInput.addEventListener('change', function () { addPickedFolder(folderInput.files); folderInput.value = ''; });

    renderFolders();
    renderList();
  }

  function run(action) {
    if (action === 'play') { state.playing ? stop() : play(state.selFrom > 0 || state.selTo < 1); }
    else if (action === 'stop') stop();
    else if (action === 'loop') {
      state.loop = !state.loop;
      var button = el('[data-sfxs-action="loop"]');
      if (button) button.classList.toggle('active', state.loop);
      if (state.playing) play(state.selFrom > 0 || state.selTo < 1);
    }
    else if (action === 'prev') step(-1);
    else if (action === 'next') step(1);
    else if (action === 'zoom-in') zoom(0.5);
    else if (action === 'zoom-out') zoom(2);
    else if (action === 'stereo' || action === 'mono') {
      // Two buttons rather than one toggle, so the current mode is readable
      // without having to work out what the toggle would do next.
      state.stereo = action === 'stereo';
      var stereoBtn = el('[data-sfxs-action="stereo"]'), monoBtn = el('[data-sfxs-action="mono"]');
      if (stereoBtn) stereoBtn.classList.toggle('active', state.stereo);
      if (monoBtn) monoBtn.classList.toggle('active', !state.stereo);
      drawWave();
    }
    else if (action === 'reverse-toggle') {
      var reverse = $('sfxsReverse');
      if (reverse) {
        reverse.checked = !reverse.checked;
        var mirror = el('[data-sfxs-action="reverse-toggle"]');
        if (mirror) mirror.classList.toggle('active', reverse.checked);
        if (state.playing) play(state.selFrom > 0 || state.selTo < 1);
      }
    }
    else if (action === 'fx') {
      var rack = $('sfxsFx');
      if (rack) {
        rack.hidden = !rack.hidden;
        var fxBtn = $('sfxsFxBtn');
        if (fxBtn) fxBtn.classList.toggle('active', !rack.hidden);
      }
    }
    else if (action === 'full') { state.selFrom = 0; state.selTo = 1; drawWave(); syncSegmentFields(); }
    else if (action === 'favorite' && state.lib && state.item) {
      state.lib.mark(state.item.path, { favorite: !state.item.favorite });
      renderList();
    }
    else if (action === 'pin' && state.lib && state.item) {
      state.lib.mark(state.item.path, { pinned: !state.item.pinned });
      renderList();
    }
    else if (action === 'add-folder') pickFolder();
    else if (action === 'rescan' && state.lib) {
      var result = state.lib.rescan();
      status('Rescanned: ' + result.added + ' new, ' + result.removed + ' gone, ' + result.total + ' indexed.');
      renderList();
    }
    else if (action === 'sources') {
      var view = $('sfxStudioView');
      if (view) {
        view.classList.toggle('show-sources');
        var toggle = el('[data-sfxs-action="sources"]');
        if (toggle) toggle.classList.toggle('active', view.classList.contains('show-sources'));
      }
    }
    else if (action === 'settings') {
      var panel = $('sfxsSettings');
      if (panel) panel.hidden = !panel.hidden;
    }
    else if (action === 'insert') insert(false);
    else if (action === 'insert-segment') insert(true);
    else if (action === 'reset') {
      var inputs = { sfxsGain: 0, sfxsPitch: 0, sfxsSpeed: 100, sfxsFadeIn: 0, sfxsFadeOut: 0 };
      Object.keys(inputs).forEach(function (id) {
        var node = $(id);
        if (!node) return;
        node.value = inputs[id];
        var readout = node.parentNode.querySelector('.val');
        if (readout) readout.textContent = node.getAttribute('data-suffix') ? node.value + node.getAttribute('data-suffix') : node.value;
      });
      ['sfxsReverse', 'sfxsNormalize'].forEach(function (id) { var node = $(id); if (node) node.checked = false; });
      var mirrorReset = el('[data-sfxs-action="reverse-toggle"]');
      if (mirrorReset) mirrorReset.classList.remove('active');
      var lock = $('sfxsLock'); if (lock) lock.checked = true;
      status('Rack reset.');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  global.SfxStudio = {
    wire: wire, select: select, render: render, insert: insert, run: run,
    play: play, stop: stop, renderList: renderList, drawWave: drawWave,
    drawCardWaves: drawCardWaves, renderFolders: renderFolders,
    _state: state, LABELS: LABELS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.SfxStudio;
}(typeof window !== 'undefined' ? window : globalThis));
