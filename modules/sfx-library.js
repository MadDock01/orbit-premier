/**
 * sfx-library.js — the local sound index behind the SFX Studio.
 *
 * Scans folders the user adds, keeps a record per file, and answers queries
 * (search / filter / sort). Deliberately free of DOM and of Premiere: the
 * whole thing runs against an injected `fs`, which is what lets
 * tests/sfx-regression.cjs exercise the scanner and the query engine on a
 * fake tree rather than on someone's disk.
 *
 * Durations are NOT read during a scan. Decoding every file to index a folder
 * of a few thousand sounds would lock the panel for minutes; the studio fills
 * a duration in when a sound is first previewed, and `note()` writes it back.
 */
(function (global) {
  'use strict';

  var AUDIO_EXT = /\.(wav|mp3|m4a|aac|ogg|oga|flac|aif|aiff)$/i;
  // AIFF is listed because the index can hold it and the file manager can show
  // it; Chromium's decoder refuses most AIFFs, so the studio reports that when
  // a preview fails rather than the index pretending the file is unusable.
  var STORAGE_KEY = 'compXSfxIndex.v1';
  var MAX_DEPTH = 8;

  // "One shot" or "ambience" is a duration split in every sound library that
  // bothers to make one, because it is the question you actually ask: do I
  // need a hit, or a bed? Two seconds is where the two stop overlapping.
  var ONE_SHOT_MAX_SECONDS = 2;

  function nodeRequire() {
    var req = global.require || (typeof require === 'function' ? require : null);
    if (!req) throw new Error('Local file access is unavailable in this panel.');
    return req;
  }

  // Reading window.localStorage THROWS on an opaque origin, which is what a
  // page loaded from file:// is — and a CEP panel is loaded from file://.
  // Touching the property unguarded took the whole view down before it drew
  // anything. An index that cannot persist is still a usable index.
  function safeStorage() {
    try {
      var store = global.localStorage;
      if (!store) return null;
      store.getItem('compXSfxProbe');
      return store;
    } catch (_) { return null; }
  }

  function create(options) {
    options = options || {};
    var fs = options.fs || null;
    var path = options.path || null;
    var store = options.storage !== undefined ? options.storage : safeStorage();

    function io() {
      if (!fs) { var req = nodeRequire(); fs = req('fs'); path = path || req('path'); }
      if (!path) path = nodeRequire()('path');
      return { fs: fs, path: path };
    }

    var state = { folders: [], items: {}, order: [] };

    /* ------------------------------------------------------- persistence -- */

    function load() {
      if (!store) return state;
      var raw = null;
      try { raw = store.getItem(STORAGE_KEY); } catch (_) { return state; }
      if (!raw) return state;
      try {
        var parsed = JSON.parse(raw);
        state.folders = Array.isArray(parsed.folders) ? parsed.folders : [];
        state.items = parsed.items && typeof parsed.items === 'object' ? parsed.items : {};
        state.order = Array.isArray(parsed.order) ? parsed.order : Object.keys(state.items);
      } catch (_) {
        // A corrupt index is not worth a crash: start clean and let a rescan
        // rebuild it. The folder list is the only thing genuinely lost.
        state = { folders: [], items: {}, order: [] };
      }
      return state;
    }

    function save() {
      if (!store) return false;
      try { store.setItem(STORAGE_KEY, JSON.stringify(state)); return true; }
      catch (_) { return false; }
    }

    /* ------------------------------------------------------------- scan -- */

    function key(filePath) { return String(filePath).replace(/\\/g, '/').toLowerCase(); }

    function baseName(filePath) {
      var clean = String(filePath).replace(/\\/g, '/');
      var cut = clean.lastIndexOf('/');
      return cut < 0 ? clean : clean.slice(cut + 1);
    }

    function walk(root, out, depth) {
      var api = io();
      var entries;
      try { entries = api.fs.readdirSync(root); } catch (_) { return out; }
      for (var i = 0; i < entries.length; i++) {
        var name = entries[i];
        if (name.charAt(0) === '.') continue;            // .DS_Store and friends
        var full = api.path.join(root, name);
        var stat = null;
        try { stat = api.fs.statSync(full); } catch (_) { continue; }
        if (stat.isDirectory()) {
          // A symlinked folder can point back up its own tree; the depth cap
          // is what stops that becoming an infinite walk.
          if (depth < MAX_DEPTH) walk(full, out, depth + 1);
          continue;
        }
        if (!AUDIO_EXT.test(name)) continue;
        out.push({ path: full, name: name, size: Number(stat.size) || 0, mtime: Number(stat.mtimeMs) || 0 });
      }
      return out;
    }

    /**
     * Rescans every registered folder and reconciles the index with what is
     * on disk. Records for files that have gone are dropped, but their user
     * data — favourite, label, pin — is kept by path, so a drive that was
     * offline during one scan does not cost the user their markings.
     */
    function rescan(only) {
      var roots = only ? [only] : state.folders.slice();
      var seen = {}, added = 0, removed = 0;
      for (var r = 0; r < roots.length; r++) {
        var found = walk(roots[r], [], 0);
        for (var i = 0; i < found.length; i++) {
          var k = key(found[i].path);
          seen[k] = true;
          var existing = state.items[k];
          if (existing) {
            existing.size = found[i].size;
            // A changed file invalidates what we measured from its audio.
            if (existing.mtime !== found[i].mtime) { existing.mtime = found[i].mtime; existing.duration = null; existing.channels = null; }
            existing.missing = false;
            continue;
          }
          state.items[k] = {
            path: found[i].path, name: found[i].name, root: roots[r],
            size: found[i].size, mtime: found[i].mtime,
            duration: null, channels: null,
            favorite: false, label: '', pinned: false, missing: false
          };
          state.order.push(k);
          added++;
        }
      }
      // Only prune the roots this pass actually visited.
      for (var j = state.order.length - 1; j >= 0; j--) {
        var id = state.order[j], item = state.items[id];
        if (!item) { state.order.splice(j, 1); continue; }
        var inScope = false;
        for (var z = 0; z < roots.length; z++) if (item.root === roots[z]) { inScope = true; break; }
        if (!inScope || seen[id]) continue;
        if (item.favorite || item.label || item.pinned) { item.missing = true; continue; }
        delete state.items[id];
        state.order.splice(j, 1);
        removed++;
      }
      save();
      return { added: added, removed: removed, total: state.order.length };
    }

    function addFolder(folder) {
      var clean = String(folder || '').replace(/[\\\/]+$/, '');
      if (!clean) return { error: 'No folder given.' };
      for (var i = 0; i < state.folders.length; i++) {
        if (key(state.folders[i]) === key(clean)) return { error: 'That folder is already in the library.' };
        // Re-indexing a subfolder of something already indexed would list
        // every sound in it twice, under two roots.
        if (key(clean).indexOf(key(state.folders[i]) + '/') === 0) {
          return { error: 'That folder is already covered by ' + state.folders[i] + '.' };
        }
      }
      state.folders.push(clean);
      var result = rescan(clean);
      return { ok: true, folder: clean, added: result.added, total: result.total };
    }

    function removeFolder(folder) {
      var k = key(folder), kept = [];
      for (var i = 0; i < state.folders.length; i++) if (key(state.folders[i]) !== k) kept.push(state.folders[i]);
      if (kept.length === state.folders.length) return { error: 'That folder is not in the library.' };
      state.folders = kept;
      for (var j = state.order.length - 1; j >= 0; j--) {
        var item = state.items[state.order[j]];
        if (item && key(item.root) === k) { delete state.items[state.order[j]]; state.order.splice(j, 1); }
      }
      save();
      return { ok: true, total: state.order.length };
    }

    /* ------------------------------------------------------------ query -- */

    function kind(item) {
      if (!(item.duration > 0)) return 'unknown';
      return item.duration <= ONE_SHOT_MAX_SECONDS ? 'oneshot' : 'ambience';
    }

    // Every space-separated word has to appear somewhere in the name or the
    // folder path. "door wood" then finds wooden-door-slam.wav without the
    // user having to remember which order the file put them in.
    function matches(item, terms) {
      if (!terms.length) return true;
      var hay = (item.name + ' ' + item.path).toLowerCase();
      for (var i = 0; i < terms.length; i++) if (hay.indexOf(terms[i]) < 0) return false;
      return true;
    }

    function query(options) {
      options = options || {};
      var terms = String(options.search || '').toLowerCase().split(/\s+/).filter(Boolean);
      var filter = String(options.filter || 'all');
      var sort = String(options.sort || 'name');
      var root = options.root ? key(options.root) : '';
      var out = [];

      for (var i = 0; i < state.order.length; i++) {
        var item = state.items[state.order[i]];
        if (!item) continue;
        if (root && key(item.path).indexOf(root + '/') !== 0 && key(item.root) !== root) continue;
        if (filter === 'favorites' && !item.favorite) continue;
        if (filter === 'oneshot' && kind(item) !== 'oneshot') continue;
        if (filter === 'ambience' && kind(item) !== 'ambience') continue;
        if (!matches(item, terms)) continue;
        out.push(item);
      }

      var by = {
        name: function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : (a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0); },
        // Unmeasured durations sort last rather than as zero, so a folder
        // that has not been previewed yet does not pretend to be all hits.
        duration: function (a, b) {
          var x = a.duration > 0 ? a.duration : Infinity, y = b.duration > 0 ? b.duration : Infinity;
          return x - y;
        },
        label: function (a, b) {
          var x = a.label || '￿', y = b.label || '￿';
          return x < y ? -1 : (x > y ? 1 : 0);
        }
      };
      out.sort(by[sort] || by.name);
      // Pinned sounds float to the top of whatever the sort produced, which is
      // the point of pinning: it survives changing the sort.
      out.sort(function (a, b) { return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0); });
      return out;
    }

    /* ------------------------------------------------------- user marks -- */

    function get(filePath) { return state.items[key(filePath)] || null; }

    function mark(filePath, changes) {
      var item = get(filePath);
      if (!item) return null;
      if (changes.favorite !== undefined) item.favorite = !!changes.favorite;
      if (changes.pinned !== undefined) item.pinned = !!changes.pinned;
      if (changes.label !== undefined) item.label = String(changes.label || '');
      save();
      return item;
    }

    /** Records what decoding a file revealed, so the next scan need not. */
    function note(filePath, facts) {
      var item = get(filePath);
      if (!item) return null;
      if (facts.duration > 0) item.duration = Number(facts.duration);
      if (facts.channels > 0) item.channels = Number(facts.channels);
      save();
      return item;
    }

    function folders() { return state.folders.slice(); }
    function all() { return state.order.map(function (k) { return state.items[k]; }).filter(Boolean); }
    /**
     * Per-folder totals for the sources column. Counted from the index rather
     * than the disk, so it matches exactly what a query on that folder will
     * return — a figure read off the filesystem would disagree the moment a
     * file went missing.
     */
    function folderCounts() {
      var out = {}, i;
      for (i = 0; i < state.folders.length; i++) out[state.folders[i]] = 0;
      for (i = 0; i < state.order.length; i++) {
        var item = state.items[state.order[i]];
        if (!item) continue;
        if (out[item.root] === undefined) out[item.root] = 0;
        out[item.root]++;
      }
      return out;
    }

    function counts() {
      var total = 0, favorites = 0, missing = 0;
      for (var i = 0; i < state.order.length; i++) {
        var item = state.items[state.order[i]];
        if (!item) continue;
        total++;
        if (item.favorite) favorites++;
        if (item.missing) missing++;
      }
      return { total: total, favorites: favorites, missing: missing, folders: state.folders.length };
    }

    load();
    return {
      load: load, save: save, rescan: rescan,
      addFolder: addFolder, removeFolder: removeFolder, folders: folders,
      query: query, get: get, mark: mark, note: note, all: all, counts: counts,
      folderCounts: folderCounts,
      kind: kind, baseName: baseName, _state: state,
      AUDIO_EXT: AUDIO_EXT, ONE_SHOT_MAX_SECONDS: ONE_SHOT_MAX_SECONDS
    };
  }

  global.SfxLibrary = { create: create, AUDIO_EXT: AUDIO_EXT, STORAGE_KEY: STORAGE_KEY };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.SfxLibrary;
}(typeof window !== 'undefined' ? window : globalThis));
