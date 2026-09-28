/**
 * library.js — Content Library ("Arsenal") module
 *
 * Two-pane media browser inspired by Mister Horse's Animation Composer "User
 * Library": a FOLDER TREE on the left, a PREVIEW GRID on the right. Editors
 * REGISTER folders on disk (reference-in-place); items apply by drag-to-timeline
 * (CEP native file-drop) or double-click (import + insert at the playhead).
 *
 * Built to stay smooth at 1000+ assets:
 *   • Async, chunked, cancellable folder scan — never blocks the UI thread.
 *   • Disk index cache (stale-while-revalidate) — reopening is instant; a
 *     background rescan refreshes silently.
 *   • Lazy thumbnails via IntersectionObserver — only near-viewport media loads,
 *     and heavy <video> memory is released when scrolled far away.
 *   • content-visibility on cards (CSS) — offscreen items skip layout/paint.
 *   • Debounced search; incremental add; in-memory remove.
 *
 * Persistence: %USER_DATA%/MachiCut/library.json        { folders:[], favorites:[] }
 *              %USER_DATA%/MachiCut/library-index.json   scan cache
 * (USER_DATA = %APPDATA% on Windows, ~/Library/Application Support on macOS.)
 */
(function (global) {
  'use strict';

  // ── Media type map ─────────────────────────────────────────────────────────
  var VIDEO_EXT = { mp4:1, mov:1, m4v:1, webm:1, avi:1, mkv:1 };
  var AUDIO_EXT = { wav:1, mp3:1, aac:1, m4a:1, aif:1, aiff:1, ogg:1, flac:1 };
  var IMAGE_EXT = { png:1, jpg:1, jpeg:1, gif:1, webp:1, tif:1, tiff:1, bmp:1 };
  var MOGRT_EXT = { mogrt:1 };

  function kindOf(ext) {
    ext = (ext || '').toLowerCase();
    if (VIDEO_EXT[ext]) return 'video';
    if (AUDIO_EXT[ext]) return 'audio';
    if (IMAGE_EXT[ext]) return 'image';
    if (MOGRT_EXT[ext]) return 'mogrt';
    return null;
  }

  var CHUNK = 240;          // stat() calls per scan tick (keeps UI responsive)
  var IO_MARGIN = '400px';  // preload media within this distance of the viewport

  // ── State ──────────────────────────────────────────────────────────────────
  var folders   = [];       // registered folder roots (normalized, '/')
  var favorites = {};       // { normalizedLowerPath: true }
  var items     = [];       // [{ path, url, name, ext, kind, folder }]
  var missing   = {};       // { rootPath: true } — registered folders not found
  var tree      = { roots: [], _all: {} };
  var filter    = { kind: 'all', ar: 'all', query: '' };
  var selected  = 'all';    // 'all' | 'fav' | a folder path
  var expanded  = {};       // { folderPath: true }
  var durations = {};       // { idOf(path): seconds } — from thumbnail probe
  var aspects   = {};       // { idOf(path): 'landscape'|'portrait'|'square' }
  var cues      = {};       // { idOf(path): seconds } — audio "hit" offset
  var recents   = [];       // idOf(path)[], most-recent first (max 50)
  var RECENT_MAX = 50;
  var cueSnap   = true;     // snap an audio hit to the playhead on insert
  var CUE_VER   = 2;        // bump to invalidate cues cached by an older algorithm
  var _loaded   = false;
  var _scanned  = false;
  var _scanTok  = 0;        // bumped on every scan → cancels in-flight scans
  var _scanning = false;
  var _searchTimer = null;
  var _idxSaveTimer = null;
  var _isWin    = navigator.platform.toLowerCase().indexOf('win') === 0;

  // Node modules (available inside CEP) for the on-disk thumbnail cache.
  var _nreq = (typeof require !== 'undefined') ? require : (global.require || null);
  var _nfs   = null, _npath = null, _ncrypto = null, _ncp = null;
  if (_nreq) { try { _nfs = _nreq('fs'); _npath = _nreq('path'); _ncrypto = _nreq('crypto'); _ncp = _nreq('child_process'); } catch (_) {} }
  var THUMB_W = 320;        // cached thumbnail width (covers small retina cards)
  var MAX_GEN = 3;          // concurrent ffmpeg thumbnail jobs

  // ── DOM refs ───────────────────────────────────────────────────────────────
  var elTree, elGrid, elBody, elEmpty, elSearch, elChips, elCount, _io;

  // ── Path helpers ───────────────────────────────────────────────────────────
  function norm(p) { return (p || '').replace(/\\/g, '/'); }
  function idOf(p) { var n = norm(p); return _isWin ? n.toLowerCase() : n; }
  function baseName(p) { var n = norm(p); return n.slice(n.lastIndexOf('/') + 1); }
  function dirName(p) { var n = norm(p); return n.slice(0, n.lastIndexOf('/')); }
  function extOf(name) { var d = name.lastIndexOf('.'); return d < 0 ? '' : name.slice(d + 1); }
  function stripExt(name) { var d = name.lastIndexOf('.'); return d < 0 ? name : name.slice(0, d); }
  function byName(a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; }

  function fileURL(p) {
    var np = norm(p);
    if (np.charAt(0) !== '/') np = '/' + np; // windows: /C:/...
    var parts = np.split('/').map(function (seg) { return encodeURIComponent(seg); });
    return 'file://' + parts.join('/').replace(/^(\/[A-Za-z])%3A/, '$1:');
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ── CEP filesystem ─────────────────────────────────────────────────────────
  function fs() { return (global.cep && global.cep.fs) ? global.cep.fs : null; }
  function userDataDir() {
    try {
      var cs = new CSInterface();
      return norm(cs.getSystemPath(SystemPath.USER_DATA)) + '/MachiCut';
    } catch (_) { return ''; }
  }
  function configPath() { return userDataDir() + '/library.json'; }
  function indexPath() { return userDataDir() + '/library-index.json'; }
  function ensureDir(dir) { var f = fs(); if (f) { try { f.makedir(dir); } catch (_) {} } }

  // ── Persistence: config (folders + favorites) ───────────────────────────────
  function loadConfig() {
    if (_loaded) return;
    _loaded = true;
    var f = fs(); if (!f) return;
    try {
      var res = f.readFile(configPath());
      if (res && res.err === 0 && res.data) {
        var cfg = JSON.parse(res.data);
        folders = (cfg.folders || []).map(norm);
        favorites = {};
        (cfg.favorites || []).forEach(function (p) { favorites[idOf(p)] = true; });
        recents = (cfg.recents || []).map(idOf);
        cueSnap = cfg.cueSnap !== false; // default on
      }
    } catch (_) {}
  }
  function saveConfig() {
    var f = fs(); if (!f) return;
    ensureDir(userDataDir());
    var favArr = Object.keys(favorites).filter(function (k) { return favorites[k]; });
    try { f.writeFile(configPath(), JSON.stringify({ folders: folders, favorites: favArr, recents: recents, cueSnap: cueSnap }, null, 2)); }
    catch (e) { console.log('[Library] config save failed', e); }
  }

  // ── Persistence: scan index cache (stale-while-revalidate) ──────────────────
  function saveIndex() {
    var f = fs(); if (!f) return;
    ensureDir(userDataDir());
    var payload = {
      folders: folders.slice(), cueVer: CUE_VER,
      items: items.map(function (it) { return { p: it.path, n: it.name, e: it.ext, k: it.kind, f: it.folder, d: it.dur || 0, c: it.cue || 0, a: it.ar || '' }; })
    };
    try { f.writeFile(indexPath(), JSON.stringify(payload)); }
    catch (e) { console.log('[Library] index save failed', e); }
  }
  function loadIndex() {
    var f = fs(); if (!f) return false;
    try {
      var res = f.readFile(indexPath());
      if (!res || res.err !== 0 || !res.data) return false;
      var c = JSON.parse(res.data);
      // Only trust the cache if it was built for exactly today's folder set.
      if (!sameSet(c.folders || [], folders)) return false;
      var keepCues = (c.cueVer === CUE_VER); // else recompute with the new algorithm
      items = (c.items || []).map(function (x) {
        if (x.d) durations[idOf(x.p)] = x.d;
        if (x.c && keepCues) cues[idOf(x.p)] = x.c;
        if (x.a) aspects[idOf(x.p)] = x.a;
        return { path: x.p, url: fileURL(x.p), name: x.n, ext: x.e, kind: x.k, folder: x.f, dur: x.d || 0, cue: (keepCues ? (x.c || 0) : 0), ar: x.a || '' };
      });
      buildTree();
      _scanned = true;
      return true;
    } catch (_) { return false; }
  }
  function sameSet(a, b) {
    if (a.length !== b.length) return false;
    var s = {}; a.forEach(function (x) { s[x] = 1; });
    return b.every(function (x) { return s[x]; });
  }

  // ── Thumbnail cache (FFmpeg-generated, lazy, concurrency-limited) ───────────
  // Every card shows a small cached image: video → poster frame, image →
  // downscaled copy, audio → waveform picture. Generated on demand as cards
  // approach the viewport, capped at MAX_GEN concurrent ffmpeg jobs, cached to
  // disk keyed by a hash of the source path and invalidated by mtime.
  var _cacheDir = '';
  function cacheDir() { if (!_cacheDir) { _cacheDir = userDataDir() + '/library-cache'; ensureDir(_cacheDir); } return _cacheDir; }
  function sha1(s) {
    if (_ncrypto) { try { return _ncrypto.createHash('sha1').update(s).digest('hex'); } catch (_) {} }
    var h = 0; for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return 'x' + (h >>> 0).toString(16);
  }
  function thumbFile(it) { return cacheDir() + '/' + sha1(idOf(it.path)) + ((it.kind === 'audio' || it.kind === 'mogrt') ? '.png' : '.jpg'); }
  function thumbFresh(src, thumb) {
    if (!_nfs) return false;
    try { return _nfs.statSync(thumb).mtimeMs >= _nfs.statSync(src).mtimeMs; } catch (_) { return false; }
  }

  var _genQueue = [], _genActive = 0, _genInflight = {}, _noThumb = {};
  function pumpGen() {
    while (_genActive < MAX_GEN && _genQueue.length) {
      var job = _genQueue.shift();
      _genActive++;
      job();
    }
  }
  // Resolves to a file:// URL for the item's cached thumbnail, generating it
  // (once) if needed. Resolves null if none is possible (→ generic card).
  function getThumb(it) {
    var tf = thumbFile(it);
    if (thumbFresh(it.path, tf)) return Promise.resolve(fileURL(tf));
    if (_noThumb[tf]) return Promise.resolve(null);        // known-no-preview
    if (_genInflight[tf]) return _genInflight[tf];
    var canFF = !!(global.FFmpegAPI && global.FFmpegAPI.makeThumb);
    if (it.kind !== 'mogrt' && !canFF) return Promise.resolve(null);

    var p = new Promise(function (resolve) {
      _genQueue.push(function () {
        var job = (it.kind === 'mogrt')
          ? extractMogrtPreview(it.path, tf) // resolves fileURL or null
          : global.FFmpegAPI.makeThumb(it.path, tf, it.kind, { width: THUMB_W, color: accentHex() })
              .then(function (r) {
                if (r && r.duration) setDuration(it, r.duration);
                if (r && r.width && (it.kind === 'video' || it.kind === 'image')) setAspect(it, r.width, r.height);
                return fileURL(tf);
              });
        job.then(function (url) { if (!url) _noThumb[tf] = true; resolve(url || null); })
           .catch(function () { _noThumb[tf] = true; resolve(null); })
           .then(function () { delete _genInflight[tf]; _genActive--; pumpGen(); });
      });
    });
    _genInflight[tf] = p;
    pumpGen();
    return p;
  }

  // MOGRTs are zip archives; modern bsdtar (Windows 10+/macOS `tar`) reads zip.
  // Pull out an embedded preview image if the template ships one → its file
  // URL, else null (the card falls back to a generic MOGRT tile).
  function tarBin() {
    if (_isWin) {
      try {
        var root = (global.process && global.process.env && global.process.env.SystemRoot) || 'C:\\Windows';
        return root + '\\System32\\tar.exe';
      } catch (_) { return 'tar'; }
    }
    return 'tar';
  }
  function extractMogrtPreview(mogrtPath, outFile) {
    return new Promise(function (resolve) {
      if (!_ncp || !_nfs || !_npath) { resolve(null); return; }
      var bin = tarBin();
      _ncp.execFile(bin, ['-tf', mogrtPath], { timeout: 8000, windowsHide: true, maxBuffer: 4 << 20 }, function (err, stdout) {
        if (err || !stdout) { resolve(null); return; }
        var imgs = String(stdout).split(/\r?\n/).filter(function (e) { return /\.(png|jpe?g)$/i.test(e); });
        if (!imgs.length) { resolve(null); return; }
        imgs.sort(function (a, b) { return (/(preview|thumb)/i.test(a) ? 0 : 1) - (/(preview|thumb)/i.test(b) ? 0 : 1); });
        var member = imgs[0];
        var tmp = _npath.join(cacheDir(), '_x_' + sha1(mogrtPath).slice(0, 12));
        try { _nfs.mkdirSync(tmp, { recursive: true }); } catch (_) {}
        function cleanup() { try { _nfs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }
        _ncp.execFile(bin, ['-xf', mogrtPath, '-C', tmp, member], { timeout: 8000, windowsHide: true }, function (err2) {
          if (err2) { cleanup(); resolve(null); return; }
          try {
            var extracted = _npath.join(tmp, member);
            if (_nfs.existsSync(extracted)) { _nfs.copyFileSync(extracted, outFile); cleanup(); resolve(fileURL(outFile)); return; }
          } catch (_) {}
          cleanup(); resolve(null);
        });
      });
    });
  }

  function accentHex() {
    try {
      var c = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      var m = c.match(/^#?([0-9a-f]{6})$/i);
      if (m) return m[1];
    } catch (_) {}
    return '638fff';
  }

  function setDuration(it, sec) {
    it.dur = sec; durations[idOf(it.path)] = sec;
    clearTimeout(_idxSaveTimer);
    _idxSaveTimer = setTimeout(saveIndex, 1500); // debounce — many probes at once
  }
  function fmtDur(sec) {
    sec = Math.round(sec || 0);
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ── Aspect ratio (video/image) ──────────────────────────────────────────────
  function arBucket(w, h) {
    if (!w || !h) return '';
    var r = w / h;
    if (r > 1.15) return 'landscape';
    if (r < 0.87) return 'portrait';
    return 'square';
  }
  var _arRenderTimer = null;
  function setAspect(it, w, h) {
    var b = arBucket(w, h);
    if (!b) return;
    it.ar = b; aspects[idOf(it.path)] = b;
    clearTimeout(_idxSaveTimer); _idxSaveTimer = setTimeout(saveIndex, 1500);
    // If an AR filter is active, newly-probed items may now match/mismatch —
    // settle the grid with one debounced re-render rather than per-item churn.
    if (filter.ar !== 'all') { clearTimeout(_arRenderTimer); _arRenderTimer = setTimeout(render, 400); }
  }

  // ── Cue point (audio "hit" offset) ──────────────────────────────────────────
  // Finds the moment of a one-shot sound's audible impact so double-click insert
  // can land it on the playhead instead of the file's silent lead-in.
  // Heuristic: smooth the peaks (kill single-sample clicks), then take the FIRST
  // moment the sound reaches near its loudest — that's the primary transient,
  // and using "first near-max" ignores a marginally louder reverb tail. A small
  // pre-roll keeps the attack from being clipped.
  function onsetFromPeaks(peaks, dur) {
    var n = peaks && peaks.length;
    if (!n || !dur) return 0;
    var s = new Array(n), i;
    for (i = 0; i < n; i++) {
      var a = i > 0 ? peaks[i - 1] : peaks[i];
      var c = i < n - 1 ? peaks[i + 1] : peaks[i];
      s[i] = (a + peaks[i] + c) / 3;
    }
    var max = 0;
    for (i = 0; i < n; i++) if (s[i] > max) max = s[i];
    if (max <= 0) return 0;
    var thr = max * 0.85, hit = 0;
    for (i = 0; i < n; i++) { if (s[i] >= thr) { hit = i; break; } }
    var sec = (hit / n) * dur;
    return Math.max(0, sec - 0.012);
  }
  function getCue(it) {
    if (it.kind !== 'audio') return Promise.resolve(0);
    var id = idOf(it.path);
    if (typeof cues[id] === 'number') return Promise.resolve(cues[id]);
    if (!global.FFmpegAPI || !global.FFmpegAPI.waveform) return Promise.resolve(0);
    return global.FFmpegAPI.waveform(it.path, 1000).then(function (r) {
      var sec = onsetFromPeaks(r.peaks, r.duration);
      cues[id] = sec; it.cue = sec;
      if (r.duration && !it.dur) setDuration(it, r.duration); // free duration too
      clearTimeout(_idxSaveTimer); _idxSaveTimer = setTimeout(saveIndex, 1500);
      return sec;
    }).catch(function () { return 0; });
  }

  // ── Recently used ────────────────────────────────────────────────────────────
  function pushRecent(it, refresh) {
    var id = idOf(it.path);
    recents = recents.filter(function (r) { return r !== id; });
    recents.unshift(id);
    if (recents.length > RECENT_MAX) recents = recents.slice(0, RECENT_MAX);
    saveConfig();
    if (refresh) { if (selected === 'recent') render(); else renderTree(); }
  }

  // ── Async chunked scan ──────────────────────────────────────────────────────
  // Walks `roots` breadth-first in CHUNK-sized bursts, yielding to the event
  // loop between bursts so the panel never freezes. Cancellable via _scanTok.
  function scanRoots(roots) {
    var f = fs();
    var token = ++_scanTok;
    var work = roots.map(function (r) { return { dir: r, root: r, top: true }; });
    var out = [];
    var miss = {};
    _scanning = true;

    return new Promise(function (resolve) {
      function step() {
        if (token !== _scanTok) { resolve(null); return; } // cancelled
        var budget = CHUNK;
        while (work.length && budget-- > 0) {
          var w = work.pop();
          var ls = f.readdir(w.dir);
          if (!ls || ls.err !== 0 || !ls.data) { if (w.top) miss[w.root] = true; continue; }
          for (var i = 0; i < ls.data.length; i++) {
            var name = ls.data[i];
            if (name.charAt(0) === '.') continue;
            var full = w.dir + '/' + name;
            var st = f.stat(full);
            if (!st || st.err !== 0 || !st.data) continue;
            if (st.data.isDirectory()) { work.push({ dir: full, root: w.root, top: false }); continue; }
            var ext = extOf(name), kind = kindOf(ext);
            if (!kind) continue;
            out.push({ path: full, url: fileURL(full), name: stripExt(name),
                       ext: ext.toLowerCase(), kind: kind, folder: w.root,
                       dur: durations[idOf(full)] || 0, cue: cues[idOf(full)] || 0,
                       ar: aspects[idOf(full)] || '' });
          }
        }
        if (token === _scanTok) showScanning(out.length);
        if (work.length) { setTimeout(step, 0); }
        else { resolve({ items: out, missing: miss, token: token }); }
      }
      step();
    });
  }

  function finishScan() {
    _scanning = false;
    items.sort(byName);
    buildTree();
    if (selected !== 'all' && selected !== 'fav' && !tree._all[selected]) selected = 'all';
    _scanned = true;
    saveIndex();
    render();
  }

  // Full (re)scan of every registered folder — replaces the item list.
  function fullRescan() {
    if (!folders.length) { items = []; missing = {}; buildTree(); _scanned = true; render(); return; }
    scanRoots(folders).then(function (r) {
      if (!r || r.token !== _scanTok) return; // superseded
      items = r.items; missing = r.missing;
      finishScan();
    });
  }

  // Scan only the newly added roots and append (used by "Add folder").
  function addRoots(roots) {
    scanRoots(roots).then(function (r) {
      if (!r || r.token !== _scanTok) return;
      items = items.concat(r.items);
      Object.keys(r.missing).forEach(function (k) { missing[k] = true; });
      finishScan();
    });
  }

  // ── Folder tree ────────────────────────────────────────────────────────────
  function buildTree() {
    tree = { roots: [], _all: {} };
    var rootNodes = {};
    folders.forEach(function (r) {
      var n = { name: baseName(r) || r, path: r, isRoot: true, missing: !!missing[r], children: {}, count: 0 };
      rootNodes[r] = n; tree._all[r] = n; tree.roots.push(n);
    });
    items.forEach(function (it) {
      var rootNode = rootNodes[it.folder];
      if (!rootNode) return;
      rootNode.count++;
      var rel = dirName(it.path).slice(it.folder.length).replace(/^\//, '');
      if (!rel) return;
      var parts = rel.split('/'), cur = it.folder, node = rootNode;
      for (var i = 0; i < parts.length; i++) {
        cur = cur + '/' + parts[i];
        if (!node.children[cur]) {
          node.children[cur] = { name: parts[i], path: cur, isRoot: false, children: {}, count: 0 };
          tree._all[cur] = node.children[cur];
        }
        node = node.children[cur];
        node.count++;
      }
    });
  }
  function childArray(node) {
    return Object.keys(node.children).map(function (k) { return node.children[k]; }).sort(byName);
  }

  // ── Filtering (right pane) ─────────────────────────────────────────────────
  function inSelected(it) {
    if (selected === 'all') return true;
    if (selected === 'fav') return !!favorites[idOf(it.path)];
    return it.folder === selected || it.path.indexOf(selected + '/') === 0;
  }
  function visibleItems() {
    var q = filter.query.trim().toLowerCase();
    var base = items, isRecent = (selected === 'recent');
    if (isRecent) {
      var byId = {}; items.forEach(function (it) { byId[idOf(it.path)] = it; });
      base = recents.map(function (id) { return byId[id]; }).filter(Boolean); // recents order preserved
    }
    return base.filter(function (it) {
      if (!isRecent && !inSelected(it)) return false;
      if (filter.kind !== 'all' && it.kind !== filter.kind) return false;
      if (filter.ar !== 'all') {
        if (it.kind !== 'video' && it.kind !== 'image') return false; // audio/mogrt have no AR
        if (it.ar && it.ar !== filter.ar) return false;               // unknown passes until probed
      }
      if (q && it.name.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }

  // ── Tree rendering ─────────────────────────────────────────────────────────
  var CARET = '<svg class="lib-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
  var ICO_FOLDER = '<svg class="lib-tico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7l2-3h5l2 3h7a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7z"/></svg>';
  var ICO_ALL = '<svg class="lib-tico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
  var ICO_STAR = '<svg class="lib-tico" viewBox="0 0 24 24"><path d="M12 17.3l-6.16 3.7 1.64-7.03L2 9.24l7.19-.61L12 2l2.81 6.63 7.19.61-5.48 4.73 1.64 7.03z"/></svg>';
  var ICO_CLOCK = '<svg class="lib-tico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

  function specialRow(key, label, count, icon) {
    var sel = selected === key ? ' is-sel' : '';
    return '<div class="lib-trow lib-trow-special' + sel + '" data-sel="' + key + '" style="padding-left:8px">' +
      '<span class="lib-caret-slot"></span>' + icon +
      '<span class="lib-tname">' + esc(label) + '</span>' +
      (count ? '<span class="lib-tcount">' + count + '</span>' : '') + '</div>';
  }
  function treeNodeHTML(node, depth) {
    var kids = childArray(node), hasKids = kids.length > 0, isExp = !!expanded[node.path];
    var sel = selected === node.path ? ' is-sel' : '', pad = depth * 12 + 8;
    var html = '<div class="lib-trow' + sel + (node.missing ? ' is-missing' : '') +
      '" data-sel="' + esc(node.path) + '" style="padding-left:' + pad + 'px" title="' + esc(node.path) + '">';
    html += hasKids
      ? '<span class="lib-caret-slot lib-caret-btn' + (isExp ? ' is-open' : '') + '" data-toggle="' + esc(node.path) + '">' + CARET + '</span>'
      : '<span class="lib-caret-slot"></span>';
    html += ICO_FOLDER + '<span class="lib-tname">' + esc(node.name) + '</span>' +
      (node.missing ? '<span class="lib-tmiss" title="Folder not found — was it moved?">!</span>'
                    : (node.count ? '<span class="lib-tcount">' + node.count + '</span>' : ''));
    if (node.isRoot) html += '<button class="lib-troot-x" data-remove="' + esc(node.path) + '" title="Remove folder" aria-label="Remove folder">&times;</button>';
    html += '</div>';
    if (hasKids && isExp) for (var i = 0; i < kids.length; i++) html += treeNodeHTML(kids[i], depth + 1);
    return html;
  }
  function renderTree() {
    if (!elTree) return;
    var idset = {}, favCount = 0;
    items.forEach(function (it) { var id = idOf(it.path); idset[id] = 1; if (favorites[id]) favCount++; });
    var recCount = recents.reduce(function (n, id) { return n + (idset[id] ? 1 : 0); }, 0);
    var html = specialRow('all', 'All items', items.length, ICO_ALL) +
               specialRow('recent', 'Recently used', recCount, ICO_CLOCK) +
               specialRow('fav', 'Favorites', favCount, ICO_STAR);
    if (folders.length) {
      html += '<div class="lib-tsep"></div>';
      tree.roots.forEach(function (n) { html += treeNodeHTML(n, 0); });
    }
    html += '<button class="lib-tadd" id="lib-tree-add" title="Click to browse, or drag folders onto the panel">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>' +
      '<span>Add folder</span></button>';
    elTree.innerHTML = html;
  }

  // ── Grid rendering (lazy thumbnails) ────────────────────────────────────────
  function render() {
    renderTree();
    if (!elGrid) return;
    var list = visibleItems();
    if (elCount) elCount.textContent = _scanning ? ('Scanning… ' + items.length)
      : (list.length ? (list.length + (list.length === 1 ? ' item' : ' items')) : '');

    if (!folders.length) {
      elGrid.innerHTML = ''; teardownIO();
      showEmpty('Build your arsenal',
        'Drag folders of sound effects, overlays, or images anywhere here — or click Add a folder. They show up ready to drop onto your timeline.', true);
      return;
    }
    if (!list.length) {
      elGrid.innerHTML = ''; teardownIO();
      if (selected === 'recent' && !_scanning && !filter.query) {
        showEmpty('Nothing yet', 'Items you insert or drag to the timeline show up here for quick reuse.', false);
      } else {
        showEmpty(_scanning ? 'Scanning your folders…' : 'No results',
          _scanning ? ('Found ' + items.length + ' items so far.')
                    : (items.length ? 'Nothing here matches your search or filter.' : 'These folders have no supported media yet.'),
          false);
      }
      return;
    }
    hideEmpty();

    var html = '';
    for (var i = 0; i < list.length; i++) {
      var it = list[i], fav = !!favorites[idOf(it.path)];
      var durHtml = (it.kind === 'audio' || it.kind === 'video')
        ? '<span class="lib-dur">' + (it.dur ? fmtDur(it.dur) : '') + '</span>' : '';
      // MOGRTs can't be file-dropped (they need importMGT) → double-click only.
      var drag = (it.kind === 'mogrt') ? 'false' : 'true';
      html += '<div class="lib-item" draggable="' + drag + '" data-idx="' + i + '" data-kind="' + it.kind + '" title="' + esc(it.name) + '">' +
        '<div class="lib-thumb lib-thumb-' + it.kind + '">' + thumbInner(it) +
          '<button class="lib-fav' + (fav ? ' is-on' : '') + '" data-idx="' + i + '" title="Favorite" aria-label="Favorite">' +
            '<svg viewBox="0 0 24 24"><path d="M12 17.3l-6.16 3.7 1.64-7.03L2 9.24l7.19-.61L12 2l2.81 6.63 7.19.61-5.48 4.73 1.64 7.03z"/></svg>' +
          '</button><span class="lib-badge">' + it.ext.toUpperCase() + '</span>' + durHtml + '</div>' +
        '<div class="lib-name">' + esc(it.name) + '</div></div>';
    }
    elGrid.innerHTML = html;
    elGrid._list = list;
    observeMedia(); // generate/attach cached thumbnails as cards approach the viewport
  }

  // Each card renders a fallback glyph + an empty <img class="lib-poster">.
  // loadCard() fills the poster from the FFmpeg thumbnail cache once the card
  // nears the viewport; video scrub-preview mounts a <video> only on hover.
  function thumbInner(it) {
    var poster = '<img class="lib-poster" alt=""/>';
    if (it.kind === 'image') return poster;
    if (it.kind === 'mogrt') {
      return '<span class="lib-mogrt-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 9l4 3-4 3z"/><path d="M14 15h3"/></svg></span>' + poster;
    }
    if (it.kind === 'video') {
      return '<span class="lib-vid-fallback"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M17 9h4M3 15h4M17 15h4"/></svg></span>' +
             poster + '<span class="lib-play"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></span>';
    }
    return '<span class="lib-audio-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10v4M6 6v12M10 3v18M14 7v10M18 5v14M22 10v4"/></svg></span>' +
           poster + '<span class="lib-cue-mark" title="Hit point — snaps to the playhead"></span>' +
           '<span class="lib-audio-line"></span>' +
           '<span class="lib-play"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></span>';
  }

  function showScanning(n) { if (elCount) elCount.textContent = 'Scanning… ' + n; }

  function showEmpty(title, body, withBtn) {
    if (!elEmpty) return;
    elEmpty.classList.toggle('is-dropzone', !!withBtn);
    var ico = withBtn ? '<svg class="lib-empty-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7l2-3h5l2 3h7a1 1 0 0 1 1 1v6"/><path d="M3 7h18v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7z"/><path d="M12 11v6"/><path d="M9 14l3 3 3-3"/></svg>' : '';
    elEmpty.innerHTML = ico +
      '<div class="lib-empty-title">' + esc(title) + '</div>' +
      '<div class="lib-empty-body">' + esc(body) + '</div>' +
      (withBtn ? '<button class="btn btn-secondary" id="lib-empty-add">Add a folder</button>' : '');
    elEmpty.style.display = '';
    var b = document.getElementById('lib-empty-add');
    if (b) b.addEventListener('click', addFolder);
  }
  function hideEmpty() { if (elEmpty) elEmpty.style.display = 'none'; }

  // ── Lazy media via IntersectionObserver ─────────────────────────────────────
  // We observe the CARD (.lib-item), not the <img>/<video>. With
  // content-visibility:auto the media inside an offscreen card is size-contained
  // and would never report intersection; the card's own box always carries the
  // reserved intrinsic size, so it fires reliably. On approach we promote the
  // media's data-src → src; on far-exit we release the <video> to free memory.
  function cardItem(card) {
    if (!elGrid._list) return null;
    return elGrid._list[parseInt(card.getAttribute('data-idx'), 10)] || null;
  }
  function loadCard(card) {
    var img = card.querySelector('img.lib-poster');
    if (!img || img.getAttribute('src') || img._req) return;
    var it = cardItem(card);
    if (!it) return;
    img._req = true; // guard against duplicate requests while generating
    getThumb(it).then(function (url) {
      if (!url) { img._req = false; return; }
      img.onload = function () {
        img.classList.add('is-ready');
        if (img.parentNode) img.parentNode.classList.add('has-poster');
      };
      img.src = url;
      var d = card.querySelector('.lib-dur');
      if (d && it.dur && !d.textContent) d.textContent = fmtDur(it.dur);
    });
  }
  function unloadCard() { /* posters are tiny JPG/PNG — keep them cached in DOM */ }
  function ensureIO() {
    if (_io || typeof IntersectionObserver === 'undefined') return;
    _io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) loadCard(entries[i].target);
        else unloadCard(entries[i].target);
      }
    }, { root: elBody, rootMargin: IO_MARGIN + ' 0px' });
  }
  function observeMedia() {
    ensureIO();
    var cards = elGrid.querySelectorAll('.lib-item');
    if (!_io) { for (var j = 0; j < cards.length; j++) loadCard(cards[j]); return; } // no IO → eager
    _io.disconnect();
    for (var i = 0; i < cards.length; i++) _io.observe(cards[i]);
  }
  function teardownIO() { if (_io) _io.disconnect(); }

  // ── Actions ────────────────────────────────────────────────────────────────
  // Register one or more folder paths (from the picker OR a drag-drop).
  function registerFolders(paths) {
    var newRoots = [], last = '';
    (paths || []).forEach(function (p) {
      var np = norm(p);
      if (np && folders.indexOf(np) < 0) { folders.push(np); newRoots.push(np); last = np; }
    });
    if (!newRoots.length) return 0;
    saveConfig();
    if (last) { expanded[last] = true; selected = last; }
    render();            // paints "Scanning…" immediately
    addRoots(newRoots);  // scans only the new folders, then re-renders
    return newRoots.length;
  }
  function addFolder() {
    var f = fs();
    if (!f || !f.showOpenDialogEx) { console.log('[Library] showOpenDialogEx unavailable'); return; }
    var res = f.showOpenDialogEx(true, true, 'Add folders to your library', '');
    if (!res || res.err !== 0 || !res.data || !res.data.length) return;
    registerFolders(res.data);
  }

  function removeFolder(path) {
    var i = folders.indexOf(path);
    if (i < 0) return;
    folders.splice(i, 1);
    delete expanded[path]; delete missing[path];
    if (selected === path || (typeof selected === 'string' && selected.indexOf(path + '/') === 0)) selected = 'all';
    // In-memory prune — no disk rescan needed for a removal.
    items = items.filter(function (it) { return it.folder !== path; });
    buildTree();
    saveConfig(); saveIndex();
    render();
  }

  function toggleFav(it) {
    var id = idOf(it.path);
    if (favorites[id]) delete favorites[id]; else favorites[id] = true;
    saveConfig();
  }

  function insertItem(it, cardEl) {
    if (cardEl) cardEl.classList.add('is-busy');
    // Audio double-click snaps the sound's hit onto the playhead (when Snap-hit
    // is on); video/image just land at the playhead. First insert of a sound
    // probes its cue (cached thereafter).
    var wantCue = (it.kind === 'audio' && cueSnap);
    (wantCue ? getCue(it) : Promise.resolve(0)).then(function (cue) {
      return global.CEP.evalScript('libraryInsertItem', [it.path, it.kind, '', cue || 0], 20000);
    }).then(function (r) {
      if (r && r.error) notify(r.error, true);
      else { notify('Added “' + it.name + '” at the playhead'); pushRecent(it, true); }
    })
      .catch(function (e) { notify(e.message || 'Insert failed', true); })
      .then(function () { if (cardEl) cardEl.classList.remove('is-busy'); });
  }
  function notify(msg, isErr) {
    try { if (global.setStatus) { global.setStatus(isErr ? 'error' : 'success', msg); return; } } catch (_) {}
    console.log('[Library] ' + msg);
  }

  // ── Tree events ────────────────────────────────────────────────────────────
  function bindTree() {
    elTree.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('#lib-tree-add')) { addFolder(); return; }
      var rm = e.target.closest ? e.target.closest('.lib-troot-x') : null;
      if (rm) { e.stopPropagation(); removeFolder(rm.getAttribute('data-remove')); return; }
      var caret = e.target.closest ? e.target.closest('.lib-caret-btn') : null;
      if (caret) {
        e.stopPropagation();
        var p = caret.getAttribute('data-toggle');
        if (expanded[p]) delete expanded[p]; else expanded[p] = true;
        renderTree();
        return;
      }
      var row = e.target.closest ? e.target.closest('.lib-trow') : null;
      if (row) { selected = row.getAttribute('data-sel'); render(); }
    });
  }

  // ── Grid events (delegated) ────────────────────────────────────────────────
  function itemFromEvent(e) {
    var card = e.target.closest ? e.target.closest('.lib-item') : null;
    if (!card || !elGrid._list) return null;
    return { it: elGrid._list[parseInt(card.getAttribute('data-idx'), 10)], card: card };
  }
  function bindGrid() {
    elGrid.addEventListener('click', function (e) {
      var favBtn = e.target.closest ? e.target.closest('.lib-fav') : null;
      if (favBtn) {
        e.stopPropagation();
        var it = elGrid._list && elGrid._list[parseInt(favBtn.getAttribute('data-idx'), 10)];
        if (it) { toggleFav(it); favBtn.classList.toggle('is-on'); if (selected === 'fav') render(); else renderTree(); }
        return;
      }
      var aCard = e.target.closest ? e.target.closest('.lib-item[data-kind="audio"]') : null;
      if (aCard) {
        var it2 = elGrid._list && elGrid._list[parseInt(aCard.getAttribute('data-idx'), 10)];
        if (it2) toggleAudio(it2, aCard);
      }
    });
    elGrid.addEventListener('dblclick', function (e) {
      var hit = itemFromEvent(e);
      if (hit && hit.it) insertItem(hit.it, hit.card);
    });
    elGrid.addEventListener('dragstart', function (e) {
      var hit = itemFromEvent(e);
      if (!hit || !hit.it) return;
      try {
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('com.adobe.cep.dnd.file.0', hit.it.path);
        e.dataTransfer.setData('text/uri-list', hit.it.url);
        pushRecent(hit.it, false); // record intent; UI refreshes on next render
      } catch (_) {}
    });
    // Media 'error' doesn't bubble → capture phase. Hide a failed scrub video
    // (the cached poster stays visible behind it).
    elGrid.addEventListener('error', function (e) {
      if (e.target && e.target.tagName === 'VIDEO') e.target.classList.add('lib-hidden');
    }, true);

    // Hover-scrub: a live <video> is mounted only over the hovered video card
    // (one at a time), so memory stays bounded no matter how big the library.
    elGrid.addEventListener('mousemove', function (e) {
      var card = e.target.closest ? e.target.closest('.lib-item[data-kind="video"]') : null;
      if (!card) { if (_scrubCard) teardownScrub(); return; }
      if (card !== _scrubCard) { var it = cardItem(card); if (it) mountScrub(card, it); }
      if (!_scrubVideo || !_scrubVideo.duration || isNaN(_scrubVideo.duration)) return;
      var r = card.getBoundingClientRect();
      var frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      try { _scrubVideo.currentTime = frac * _scrubVideo.duration; } catch (_) {}
    });
    elGrid.addEventListener('mouseleave', teardownScrub);
  }

  var _scrubCard = null, _scrubVideo = null;
  function teardownScrub() {
    if (_scrubVideo) {
      try { _scrubVideo.pause(); _scrubVideo.removeAttribute('src'); _scrubVideo.load(); } catch (_) {}
      if (_scrubVideo.parentNode) _scrubVideo.parentNode.removeChild(_scrubVideo);
    }
    _scrubVideo = null; _scrubCard = null;
  }
  function mountScrub(card, it) {
    teardownScrub();
    var thumb = card.querySelector('.lib-thumb');
    if (!thumb) return;
    var v = document.createElement('video');
    v.className = 'lib-scrub'; v.muted = true; v.playsInline = true; v.preload = 'metadata';
    v.src = it.url;
    try { v.load(); } catch (_) {}
    thumb.appendChild(v);
    _scrubCard = card; _scrubVideo = v;
  }

  // ── Audio preview (single shared element) ───────────────────────────────────
  var _audio = null, _audioCard = null;
  function _setLine(card, frac) {
    if (!card) return;
    var line = card.querySelector('.lib-audio-line');
    if (line) line.style.left = (Math.max(0, Math.min(1, frac)) * 100) + '%';
  }
  function toggleAudio(it, card) {
    if (!_audio) {
      _audio = new Audio();
      _audio.addEventListener('ended', stopAudio);
      // Drive the playhead line across the preview from playback progress.
      _audio.addEventListener('timeupdate', function () {
        if (_audioCard && _audio.duration) _setLine(_audioCard, _audio.currentTime / _audio.duration);
      });
    }
    if (_audioCard === card && !_audio.paused) { stopAudio(); return; }
    stopAudio();
    _audio.src = it.url; _audioCard = card;
    _setLine(card, 0);
    card.classList.add('is-playing');
    // Reveal the cue marker (where the hit will snap to the playhead) — only
    // when Snap-hit is enabled.
    if (cueSnap) getCue(it).then(function (cue) {
      if (_audioCard !== card || !(cue > 0) || !it.dur) return;
      var mark = card.querySelector('.lib-cue-mark');
      if (mark) { mark.style.left = (cue / it.dur * 100) + '%'; mark.classList.add('is-set'); }
    });
    _audio.play().catch(function () { stopAudio(); });
  }
  function stopAudio() {
    if (_audio) { try { _audio.pause(); } catch (_) {} }
    if (_audioCard) {
      _audioCard.classList.remove('is-playing'); _setLine(_audioCard, 0);
      var mark = _audioCard.querySelector('.lib-cue-mark');
      if (mark) mark.classList.remove('is-set');
    }
    _audioCard = null;
  }

  // ── Controls ────────────────────────────────────────────────────────────────
  function bindControls() {
    var clearBtn = document.getElementById('lib-search-clear');
    function syncClear() { if (clearBtn) clearBtn.classList.toggle('is-visible', !!(elSearch && elSearch.value)); }
    if (elSearch) elSearch.addEventListener('input', function () {
      filter.query = elSearch.value || '';
      syncClear();
      clearTimeout(_searchTimer);
      _searchTimer = setTimeout(render, 130); // debounce keystrokes
    });
    if (clearBtn) clearBtn.addEventListener('click', function () {
      if (!elSearch) return;
      elSearch.value = ''; filter.query = '';
      syncClear(); elSearch.focus(); render();
    });
    var addBtn = document.getElementById('lib-add-folder');
    if (addBtn) addBtn.addEventListener('click', addFolder);
    if (elChips) {
      elChips.addEventListener('click', function (e) {
        // Toggle a dropdown open/closed.
        var btn = e.target.closest ? e.target.closest('.lib-dd-btn') : null;
        if (btn) {
          var menu = btn.parentNode.querySelector('.lib-dd-menu');
          var wasHidden = menu.classList.contains('hidden');
          closeAllDD();
          if (wasHidden) menu.classList.remove('hidden');
          return;
        }
        // Pick an option.
        var item = e.target.closest ? e.target.closest('.lib-dd-item') : null;
        if (item) {
          var dd = item.closest('.lib-dd');
          Array.prototype.forEach.call(dd.querySelectorAll('.lib-dd-item'), function (i) { i.classList.toggle('is-on', i === item); });
          var lbl = dd.querySelector('.lib-dd-label');
          if (lbl) lbl.textContent = item.textContent;
          if (item.hasAttribute('data-kind')) filter.kind = item.getAttribute('data-kind');
          else if (item.hasAttribute('data-ar')) filter.ar = item.getAttribute('data-ar');
          closeAllDD();
          render();
        }
      });
      // Close menus on any outside click.
      document.addEventListener('click', function (e) {
        if (!elChips.contains(e.target)) closeAllDD();
      });
    }
    var cueBtn = document.getElementById('lib-cue-toggle');
    if (cueBtn) cueBtn.addEventListener('click', function () {
      cueSnap = !cueSnap;
      cueBtn.classList.toggle('is-on', cueSnap);
      saveConfig();
    });
  }
  function syncCueToggle() {
    var cueBtn = document.getElementById('lib-cue-toggle');
    if (cueBtn) cueBtn.classList.toggle('is-on', cueSnap);
  }
  function closeAllDD() {
    if (!elChips) return;
    Array.prototype.forEach.call(elChips.querySelectorAll('.lib-dd-menu'), function (m) { m.classList.add('hidden'); });
  }

  // ── Drag folders onto the panel to register them ────────────────────────────
  // OS file/folder drops expose 'Files' in dataTransfer.types — that's how we
  // tell them apart from our own item drags (which set com.adobe.cep.dnd.*).
  function bindDrop() {
    var panel = document.getElementById('panel-library');
    if (!panel) return;
    var depth = 0; // dragenter/leave can fire on children — count to avoid flicker
    function isFileDrag(e) {
      var t = e.dataTransfer && e.dataTransfer.types;
      return !!t && Array.prototype.indexOf.call(t, 'Files') !== -1;
    }
    panel.addEventListener('dragenter', function (e) {
      if (!isFileDrag(e)) return;
      e.preventDefault(); depth++; panel.classList.add('lib-dropping');
    });
    panel.addEventListener('dragover', function (e) {
      if (!isFileDrag(e)) return;
      e.preventDefault(); try { e.dataTransfer.dropEffect = 'copy'; } catch (_) {}
    });
    panel.addEventListener('dragleave', function (e) {
      if (!isFileDrag(e)) return;
      depth--; if (depth <= 0) { depth = 0; panel.classList.remove('lib-dropping'); }
    });
    panel.addEventListener('drop', function (e) {
      if (!isFileDrag(e)) return;
      e.preventDefault(); depth = 0; panel.classList.remove('lib-dropping');
      var files = (e.dataTransfer && e.dataTransfer.files) || [];
      var dirs = [], sawFile = false;
      for (var i = 0; i < files.length; i++) {
        var p = files[i].path; if (!p) continue;
        try { if (_nfs && _nfs.statSync(p).isDirectory()) dirs.push(p); else sawFile = true; }
        catch (_) {}
      }
      if (dirs.length) {
        var n = registerFolders(dirs);
        if (n) notify('Added ' + n + (n === 1 ? ' folder' : ' folders') + ' to your library');
      } else if (sawFile) {
        notify('Drop a folder (not individual files) to add it to your library', true);
      }
    });
  }

  // ── Public ──────────────────────────────────────────────────────────────────
  function onShow() {
    loadConfig();
    syncCueToggle();
    if (!_scanned) {
      if (loadIndex()) {   // instant paint from cache…
        render();
        fullRescan();      // …then refresh silently in the background
      } else {
        render();          // shows Scanning… / empty
        fullRescan();
      }
    } else {
      render();
    }
  }

  function init() {
    elTree   = document.getElementById('lib-tree');
    elGrid   = document.getElementById('lib-grid');
    elEmpty  = document.getElementById('lib-empty');
    elSearch = document.getElementById('lib-search');
    elChips  = document.getElementById('lib-chips');
    elCount  = document.getElementById('lib-count');
    if (!elGrid || !elTree) return;
    elBody = elGrid.parentNode; // .lib-body — the scroll container / IO root
    bindControls();
    bindTree();
    bindGrid();
    bindDrop();
  }

  init();
  global.Library = { init: init, onShow: onShow };

}(window));
