/* CompX Asset Library — panel logic
 *
 * Runs inside the CEP (Chromium) panel. Node integration is enabled in the
 * manifest (--enable-nodejs / --mixed-context) so we can use fs/path directly
 * to read audio files from disk and scan folders — no upload/copy step,
 * matching the "reference the file path, don't duplicate storage" goal.
 */

(function () {
  "use strict";

  // CEP Node integration is optional in some Adobe installs. Never let a
  // missing `require` stop the entire panel (including tab switching).
  const nodeRequire = typeof require === "function" ? require : (typeof window.require === "function" ? window.require : null);
  const fs = nodeRequire ? nodeRequire("fs") : null;
  const path = nodeRequire ? nodeRequire("path") : null;
  const zlib = nodeRequire ? nodeRequire("zlib") : null;
  const os = nodeRequire ? nodeRequire("os") : null;
  const cp = nodeRequire ? nodeRequire("child_process") : null;
  const crypto = nodeRequire ? nodeRequire("crypto") : null;
  const nodeAvailable = !!(fs && path && zlib && os && cp && crypto);
  if (!nodeAvailable) {
    try { console.warn("CompX: CEP Node is unavailable; file-based Library features are disabled, but panel tabs remain usable."); } catch (e) { auditFallback("MAIN_GLOBAL_001", e); }
  }

  const csInterface = new CSInterface();
  const AUDIO_EXT = [".mp3", ".wav", ".aiff", ".aif", ".m4a", ".ogg"];
  const MOGRT_EXT = [".mogrt"];
  const PRFPSET_EXT = [".prfpset"];
  const EXT_BY_TYPE = { sfx: AUDIO_EXT, mogrt: MOGRT_EXT, prfpset: PRFPSET_EXT };
  const COLORS = ["#e0654f", "#f0a63c", "#e8d05a", "#5fd68c", "#5aa7e8", "#b587e8"];
  const RECENT_LIMIT = 20;
  const IMAGE_EXT_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif" };
  const VIDEO_EXT_MIME = { ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime" };
  const PRFPSET_DEFAULTS_FLAG = "orbit.prfpset.defaults.v5";
  const PRFPSET_LIBRARY_EXCLUDE = /deep\s*glow|drop\s*shadow\s*text\s*glow/i;

  // The "Graphic" shelf (mogrt) shares preview/import/insert behavior —
  // only SFX plays back as audio through the Web Audio engine.
  function isGraphicType(t) {
    return t === "mogrt";
  }
  function isPresetType(t) {
    return t === "prfpset";
  }

  function assetNoun(type) {
    if (type === "mogrt") return "template";
    if (type === "prfpset") return "preset";
    return "sound";
  }

  // ---------------- State ----------------

  const STORAGE_KEY = "sfxCommandCenter.library.v1";
  const STORAGE_RECOVERY_KEY = "sfxCommandCenter.library.recovery";
  let indexedDbReady = false;
  let indexedDbInitStarted = false;
  let pendingStorageSave = false;
  let storageWriteChain = Promise.resolve();

  /** @type {{id:string,type:"sfx"|"mogrt"|"prfpset",name:string,path:string,category:string,tags:string[],favorite:boolean,duration:number|null,thumbnail:string|null,thumbnailChecked:boolean,color:string|null,collections:string[],lastPlayedAt:number|null,relativePath:string,folderPath:string,filterCount?:number}[]} */
  let library = loadLibrary();
  let assetType = "sfx"; // "sfx" | "mogrt" | "prfpset"
  let filterText = "";
  let selectedId = null;
  let audioCtx = null;
  let currentSource = null;
  let currentBuffer = null;
  let currentGain = null;
  let previewVolume = 1.0;
  let isPlaying = false;
  let playStartedAt = 0;

  let currentView = "all"; // all | recent | favorites | collections
  let activeCollection = null;
  let batchMode = false;
  let batchSelected = new Set();

  let selectedFolder = ""; // active folder path in the sidebar tree
  let viewMode = "grid"; // "grid" | "list"
  let sortBy = "name"; // "name" | "recent" | "duration" | "favorite"
  let sidebarCollapsed = false;
  try {
    var savedFolders = localStorage.getItem("compXLibraryFolders");
    if (savedFolders === "off") sidebarCollapsed = true;
    else if (savedFolders === "on") sidebarCollapsed = false;
  } catch (e) {}
  const ASSET_PAGE_SIZE = 120;
  let assetRenderLimit = ASSET_PAGE_SIZE;
  let lastAssetQueryKey = "";
  const missingAssetIds = new Set();
  const activeMogrtCacheDirs = new Set();
  const mogrtImportInProgress = new Set();

  // ---------------- DOM refs ----------------

  const el = {
    library: document.getElementById("library"),
    search: document.getElementById("search"),
    btnAddFiles: document.getElementById("btnAddFiles"),
    btnAddFolder: document.getElementById("btnAddFolder"),
    btnReset: document.getElementById("btnReset"),
    btnRemoveSelected: document.getElementById("btnRemoveSelected"),
    btnFolderView: document.getElementById("btnFolderView"),
    btnBackupLibrary: document.getElementById("btnBackupLibrary"),
    btnRestoreLibrary: document.getElementById("btnRestoreLibrary"),
    btnCheckMissing: document.getElementById("btnCheckMissing"),
    btnRelinkLibrary: document.getElementById("btnRelinkLibrary"),
    btnClearMogrtCache: document.getElementById("btnClearMogrtCache"),
    btnCopyDiagnostics: document.getElementById("btnCopyDiagnostics"),
    mogrtCacheInfo: document.getElementById("mogrtCacheInfo"),
    diagnosticSummary: document.getElementById("diagnosticSummary"),
    fileInputFiles: document.getElementById("fileInputFiles"),
    fileInputFolder: document.getElementById("fileInputFolder"),
    fileInputLibraryBackup: document.getElementById("fileInputLibraryBackup"),
    fileInputRelinkFolder: document.getElementById("fileInputRelinkFolder"),
    nowPlaying: document.getElementById("nowPlaying"),
    pitch: document.getElementById("pitch"),
    pitchVal: document.getElementById("pitchVal"),
    volume: document.getElementById("volume"),
    volumeVal: document.getElementById("volumeVal"),
    btnFavorite: document.getElementById("btnFavorite"),
    btnInsert: document.getElementById("btnInsert"),
    hostHint: document.getElementById("hostHint"),
    toast: document.getElementById("toast"),
    waveformWrap: null, // removed from UI
    waveform: null,     // removed from UI
    assetTypeRow: document.getElementById("assetTypeRow"),
    tabsRow: document.getElementById("tabsRow"),
    collectionsRow: document.getElementById("collectionsRow"),
    pitchBlock: document.getElementById("pitchBlock"),
    playHint: document.getElementById("playHint"),
    btnBatchMode: document.getElementById("btnBatchMode"),
    batchBar: document.getElementById("batchBar"),
    batchCount: document.getElementById("batchCount"),
    batchColor: document.getElementById("batchColor"),
    batchCollection: document.getElementById("batchCollection"),
    batchDelete: document.getElementById("batchDelete"),
    tagEditorRow: document.getElementById("tagEditorRow"),
    tagEditor: document.getElementById("tagEditor"),
    mainLayout: document.getElementById("mainLayout"),
    sidebar: document.getElementById("sidebar"),
    btnCollapse: document.getElementById("btnCollapse"),
    folderTree: document.getElementById("folderTree"),
    breadcrumb: document.getElementById("breadcrumb"),
    sortBy: document.getElementById("sortBy"),
    btnGridView: document.getElementById("btnGridView"),
    btnListView: document.getElementById("btnListView"),
    customModal: document.getElementById("customModal"),
    modalBox: document.getElementById("modalBox"),
    modalTitle: document.getElementById("modalTitle"),
    modalMessage: document.getElementById("modalMessage"),
    modalInput: document.getElementById("modalInput"),
    modalBtnOk: document.getElementById("modalBtnOk"),
    modalBtnCancel: document.getElementById("modalBtnCancel"),
  };

  // ---------------- Persistence ----------------

  function loadLibrary() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
      const items = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(items)) throw new Error("Stored library is not an array");
      return normalizeLibraryItems(items);
    } catch (e) {
      // Preserve malformed data before a future save can replace it. This is
      // intentionally silent in the UI because loadLibrary runs before the
      // panel DOM references are initialized.
      if (raw) {
        try {
          localStorage.setItem(STORAGE_RECOVERY_KEY, JSON.stringify({
            savedAt: new Date().toISOString(),
            error: String(e && e.message ? e.message : e),
            raw: raw
          }));
        } catch (recoveryError) { auditFallback("MAIN_LOADLIBRARY_001", recoveryError); }
      }
      try { console.error("CompX: stored library could not be read; recovery copy preserved.", e); } catch (consoleError) { auditFallback("MAIN_LOADLIBRARY_002", consoleError); }
      return [];
    }
  }

  function normalizeLibraryItems(input) {
      const items = Array.isArray(input) ? input : [];
      // Pre-MOGRT libraries have no `type` field — everything saved before
      // this version was a sound effect.
      items.forEach((it) => {
        if (!it.type) it.type = "sfx";
        // The separate "Text Preset" shelf was removed — fold any previously
        // saved text-preset items into the MOGRT shelf (same file format).
        if (it.type === "text") it.type = "mogrt";
        if (it.thumbnail === undefined) it.thumbnail = null;
        if (it.thumbnailChecked === undefined) it.thumbnailChecked = false;
        if (!it.relativePath) {
          it.relativePath = it.name + (it.type === "mogrt" ? ".mogrt" : ".wav");
        }
        if (it.folderPath === undefined) {
          it.folderPath = "";
        }
      });
      return items;
  }

  function prepareLibraryForPersistence(items) {
      return items.map((item) => {
        const copy = Object.assign({}, item);
        if (typeof copy.thumbnail === "string" && copy.thumbnail.indexOf("data:") === 0) {
          copy.thumbnail = null;
          copy.thumbnailChecked = false;
        }
        return copy;
      });
  }

  function saveLibrary() {
    const persisted = prepareLibraryForPersistence(library);
    if (indexedDbReady && window.CompXStorage) {
      const snapshot = persisted;
      storageWriteChain = storageWriteChain
        .then(() => window.CompXStorage.replaceAllAssets(snapshot))
        .catch((e) => {
          try { console.error("CompX IndexedDB save failed:", e); } catch (consoleError) { auditFallback("MAIN_SAVELIBRARY_001", consoleError); }
          try { localStorage.setItem(STORAGE_RECOVERY_KEY, JSON.stringify(snapshot)); } catch (recoveryError) { auditFallback("MAIN_SAVELIBRARY_002", recoveryError); }
          showToast("Could not save library database", true);
        });
      return;
    }
    pendingStorageSave = true;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
    } catch (e) {
      showToast("Could not save temporary library: " + e.message, true);
    }
  }

  async function initializeIndexedDbLibrary() {
    if (indexedDbInitStarted || !window.CompXStorage) return;
    indexedDbInitStarted = true;
    try {
      const result = await window.CompXStorage.migrateFromLocalStorage(STORAGE_KEY);
      if (pendingStorageSave) {
        await window.CompXStorage.replaceAllAssets(prepareLibraryForPersistence(library));
      } else {
        library = normalizeLibraryItems(result.assets || []);
      }
      indexedDbReady = true;
      pendingStorageSave = false;
      const removed = purgeAllLibraryPrfpsets();
      if (removed > 0) {
        try { console.log("[Orbit] removed " + removed + " library effect presets (PRESET shelf retired)"); } catch (e) {}
      }
      if (assetType === "prfpset") assetType = "sfx";
      render();
      if (result.migrated) showToast("Library upgraded to IndexedDB (" + result.count + " items)");
    } catch (e) {
      indexedDbReady = false;
      try { console.error("CompX IndexedDB initialization failed:", e); } catch (consoleError) { auditFallback("MAIN_INITIALIZEINDEXEDDBLIBRARY_001", consoleError); }
      showToast("IndexedDB unavailable — using local recovery storage", true);
      purgeAllLibraryPrfpsets();
      if (assetType === "prfpset") assetType = "sfx";
      render();
    }
  }

  function buildLibraryBackup() {
    return {
      format: "compx-library-backup",
      version: 1,
      extensionVersion: "2.3.1",
      exportedAt: new Date().toISOString(),
      assetCount: library.length,
      library: prepareLibraryForPersistence(library).map((item) => {
        const copy = Object.assign({}, item);
        delete copy.pathType;
        return copy;
      }),
    };
  }

  async function exportLibraryBackup() {
    if (!nodeAvailable || !fs.promises) return showToast("File access is unavailable", true);
    try {
      const backupDir = path.join(os.homedir(), "Documents", "CompX", "Backups");
      await fs.promises.mkdir(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const fileName = "CompX-Library-" + stamp + ".json";
      const backupPath = path.join(backupDir, fileName);
      await fs.promises.writeFile(backupPath, JSON.stringify(buildLibraryBackup(), null, 2), "utf8");
      showToast("Backup exported: " + fileName);
    } catch (e) {
      showToast("Backup failed: " + (e.message || e), true);
    }
  }

  function parseLibraryBackup(raw) {
    if (typeof raw !== "string" || raw.length > 25 * 1024 * 1024) throw new Error("Backup is too large");
    const data = JSON.parse(raw);
    if (!data || data.format !== "compx-library-backup" || data.version !== 1 || !Array.isArray(data.library)) {
      throw new Error("Not a supported CompX library backup");
    }
    if (data.library.length > 100000) throw new Error("Backup contains too many items");
    const seen = new Set();
    const items = [];
    data.library.forEach((item) => {
      if (!item || typeof item.id !== "string" || typeof item.path !== "string" || !item.path) return;
      const type = item.type === "mogrt" ? "mogrt" : "sfx";
      const key = type + "|" + item.path;
      if (seen.has(key)) return;
      seen.add(key);
      items.push(Object.assign({}, item, { type: type, thumbnail: null, thumbnailChecked: false }));
    });
    return normalizeLibraryItems(items);
  }

  async function restoreLibraryBackup(filePath) {
    if (!nodeAvailable || !fs.promises || !filePath) return showToast("Backup file is unavailable", true);
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile() || stat.size > 25 * 1024 * 1024) throw new Error("Backup is too large or invalid");
      const restored = parseLibraryBackup(await fs.promises.readFile(filePath, "utf8"));
      const ok = await showModal({
        title: "Restore Library Backup?",
        message: "Replace the current " + library.length + " items with " + restored.length + " backup items? Your backup file will not be changed.",
        okText: "Replace Library",
        cancelText: "Cancel",
        danger: true,
      });
      if (!ok) return;
      if (currentSource) stopPlayback();
      library = restored;
      missingAssetIds.clear();
      selectedId = null;
      saveLibrary();
      render();
      const missing = await detectMissingFiles(false);
      showToast("Restored " + restored.length + " items" + (missing.length ? " · " + missing.length + " missing" : ""), !!missing.length);
    } catch (e) {
      showToast("Restore failed: " + (e.message || e), true);
    }
  }

  async function detectMissingFiles(showResult) {
    if (!nodeAvailable || !fs.promises) {
      if (showResult !== false) showToast("File access is unavailable", true);
      return [];
    }
    missingAssetIds.clear();
    const missing = [];
    const batchSize = 100;
    for (let start = 0; start < library.length; start += batchSize) {
      const batch = library.slice(start, start + batchSize);
      const results = await Promise.all(batch.map(async (item) => {
        try { await fs.promises.access(item.path, fs.constants.F_OK); return null; }
        catch (e) { return item; }
      }));
      results.forEach((item) => {
        if (!item) return;
        missing.push(item);
        missingAssetIds.add(item.id);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    render();
    if (showResult !== false) {
      showToast(missing.length ? missing.length + " missing file(s) found" : "All " + library.length + " files are available", !!missing.length);
    }
    return missing;
  }

  async function relinkLibraryFromFiles(files) {
    const candidates = Array.from(files || []).filter((file) => file && file.path);
    if (!candidates.length) return showToast("No files selected for relinking", true);
    const byName = new Map();
    candidates.forEach((file) => {
      const key = path.basename(file.path).toLowerCase();
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(file);
    });
    const missing = await detectMissingFiles(false);
    let relinked = 0;
    missing.forEach((item) => {
      const matches = byName.get(path.basename(item.path).toLowerCase()) || [];
      let match = null;
      if (matches.length === 1) {
        match = matches[0];
      } else if (matches.length > 1 && item.relativePath) {
        const wanted = item.relativePath.replace(/\\/g, "/").toLowerCase();
        const exact = matches.filter((file) => String(file.webkitRelativePath || file.path).replace(/\\/g, "/").toLowerCase().endsWith(wanted));
        if (exact.length === 1) match = exact[0];
      }
      if (!match) return;
      item.path = match.path;
      if (match.webkitRelativePath) {
        item.relativePath = match.webkitRelativePath.replace(/\\/g, "/");
        const relDir = path.posix.dirname(item.relativePath);
        item.folderPath = relDir === "." ? "" : relDir;
      }
      missingAssetIds.delete(item.id);
      relinked++;
    });
    if (relinked) saveLibrary();
    render();
    showToast(relinked + " file(s) relinked" + (missing.length - relinked ? " · " + (missing.length - relinked) + " unresolved" : ""), relinked === 0);
  }

  // ---------------- Helpers ----------------

  function uid() {
    return "sfx_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }

  function guessCategory(name) {
    const n = name.toLowerCase();
    if (/(boom|impact|hit|slam|thud|punch)/.test(n)) return "Impacts";
    if (/(whoosh|swoosh|swish|transition)/.test(n)) return "Whoosh";
    if (/(horror|scary|tense|drone|dark)/.test(n)) return "Horror";
    if (/(explo|blast)/.test(n)) return "Explosions";
    if (/(ui|click|button|beep|notif)/.test(n)) return "UI";
    if (/(ambience|ambient|room|wind|rain)/.test(n)) return "Ambience";
    return "Uncategorized";
  }

  function guessTags(name) {
    const n = name.toLowerCase();
    const tags = [];
    ["boom", "whoosh", "horror", "cinematic", "transition", "hit", "explosion", "impact", "riser", "drone"].forEach(
      (t) => {
        if (n.indexOf(t) !== -1) tags.push(t);
      }
    );
    return tags;
  }

  function guessMogrtCategory(name) {
    const n = name.toLowerCase();
    if (/(lower.?third|lt[_-])/.test(n)) return "Lower Thirds";
    if (/(title|headline|opener)/.test(n)) return "Titles";
    if (/(intro|outro)/.test(n)) return "Intros/Outros";
    if (/(subscribe|social|instagram|youtube|tiktok|handle)/.test(n)) return "Social";
    if (/(transition|wipe|swipe)/.test(n)) return "Transitions";
    if (/(callout|badge|label|tag)/.test(n)) return "Callouts";
    return "Uncategorized";
  }

  function guessMogrtTags(name) {
    const n = name.toLowerCase();
    const tags = [];
    [
      "title", "lower third", "subscribe", "social", "youtube", "instagram", "tiktok",
      "transition", "intro", "outro", "callout", "badge", "logo",
    ].forEach((t) => {
      if (n.indexOf(t.replace(" ", "")) !== -1 || n.indexOf(t) !== -1) tags.push(t);
    });
    return tags;
  }

  function fmtTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return "--:--";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m + ":" + String(s).padStart(2, "0");
  }

  function seedFromName(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = ((hash << 5) - hash) + name.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  function generatePseudoWaveform(name) {
    let seed = seedFromName(name);
    const rand = () => {
      const x = Math.sin(seed++) * 10000;
      return x - Math.floor(x);
    };
    const pointsCount = 36;
    let svg = '<svg viewBox="0 0 160 60" preserveAspectRatio="none" style="width:100%; height:100%;">';
    svg += '<path d="M 0 30 ';
    for (let i = 0; i <= pointsCount; i++) {
      const x = (i / pointsCount) * 160;
      const progress = i / pointsCount;
      const weight = Math.sin(progress * Math.PI);
      const h = rand() * 24 * weight;
      svg += 'L ' + x + ' ' + (30 - h) + ' ';
    }
    for (let i = pointsCount; i >= 0; i--) {
      const x = (i / pointsCount) * 160;
      const progress = i / pointsCount;
      const weight = Math.sin(progress * Math.PI);
      const h = rand() * 24 * weight;
      svg += 'L ' + x + ' ' + (30 + h) + ' ';
    }
    svg += 'Z" fill="#e9e7e2" opacity="0.45"/>';
    svg += '</svg>';
    return svg;
  }

  function showToast(msg, isError) {
    el.toast.textContent = msg;
    el.toast.className = "toast show" + (isError ? " error" : "");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      el.toast.className = "toast";
    }, 2600);
  }

  function recordDiagnostic(level, code, message, detail, outcome) {
    if (window.CompXDiagnostics) {
      window.CompXDiagnostics.record(level, code, message, detail, outcome);
      renderDiagnosticSummary();
    }
  }

  function renderDiagnosticSummary() {
    if (!el.diagnosticSummary || !window.CompXDiagnostics) return;
    const s = window.CompXDiagnostics.getSummary();
    el.diagnosticSummary.textContent = "A " + s.applied + " · S " + s.skipped + " · F " + s.failed + " · O " + s.optionalFallbacks;
  }

  function auditFallback(code, error) {
    if (window.CompXDiagnostics) {
      window.CompXDiagnostics.fallback(code, error);
      if (!auditFallback._summaryTimer) {
        auditFallback._summaryTimer = setTimeout(() => {
          auditFallback._summaryTimer = null;
          renderDiagnosticSummary();
        }, 100);
      }
    }
  }

  function reportError(code, error, userMessage) {
    const detail = String(error && error.stack ? error.stack : (error && error.message ? error.message : error));
    recordDiagnostic("error", code, userMessage, detail, "failed");
    showToast(userMessage, true);
  }

  async function runSystemCheck() {
    const checks = [];
    const add = (name, status, detail) => checks.push({ name, status, detail: detail || "" });

    try {
      const host = csInterface.getHostEnvironment();
      const appName = host && host.appName ? String(host.appName) : "Unknown Adobe host";
      add("Premiere connection", /PPRO|Premiere/i.test(appName) ? "pass" : "warn", appName);
    } catch (e) {
      add("Premiere connection", "fail", e.message || "Host environment unavailable");
    }

    add("CEP Node runtime", nodeAvailable ? "pass" : "fail", nodeAvailable ? "File and media tools available" : "Node integration unavailable");

    try {
      const extensionPath = csInterface.getSystemPath(SystemPath.EXTENSION);
      const manifestPath = path && extensionPath ? path.join(extensionPath, "CSXS", "manifest.xml") : "";
      add("Extension files", fs && manifestPath && fs.existsSync(manifestPath) ? "pass" : "fail", extensionPath || "Extension path unavailable");
    } catch (e) {
      add("Extension files", "fail", e.message || "Could not resolve extension path");
    }

    try {
      if (!window.FFmpegAPI || typeof window.FFmpegAPI.checkFFmpeg !== "function") throw new Error("FFmpeg API unavailable");
      const ffmpeg = await window.FFmpegAPI.checkFFmpeg();
      add("FFmpeg", ffmpeg && ffmpeg.ok ? "pass" : "fail", ffmpeg && ffmpeg.version ? ffmpeg.version : "No version returned");
    } catch (e) {
      add("FFmpeg", "fail", e.message || "Bundled FFmpeg could not run");
    }

    const hostAudit = await new Promise((resolve) => {
      callHost("compx_getHostDiagnostics()", (parsed) => resolve(parsed.success ? parsed.data : null), 15000);
    });
    add("Host script bridge", hostAudit ? "pass" : "fail", hostAudit ? "ExtendScript responding" : "No valid host response");
    if (hostAudit) window.CompXDiagnostics.setHostAudit(hostAudit);

    window.CompXDiagnostics.setHealthChecks(checks);
    const failed = checks.filter((check) => check.status === "fail").length;
    const warned = checks.filter((check) => check.status === "warn").length;
    return { checks, failed, warned };
  }
  async function copyDiagnosticReport() {
    if (!window.CompXDiagnostics) return showToast("Diagnostics are unavailable", true);
    try {
      const health = await runSystemCheck();
      let copied = await window.CompXDiagnostics.copyReport();
      if (!copied) {
        const area = document.createElement("textarea");
        area.value = window.CompXDiagnostics.reportText();
        area.style.position = "fixed";
        area.style.left = "-9999px";
        document.body.appendChild(area);
        area.select();
        copied = document.execCommand("copy");
        document.body.removeChild(area);
      }
      if (!copied) throw new Error("Clipboard API rejected the report");
      showToast(health.failed ? ("System check found " + health.failed + " problem(s) — report copied") : (health.warned ? "System check passed with warnings — report copied" : "System check passed — diagnostic report copied"), !!health.failed);
    } catch (e) {
      reportError("DIAGNOSTIC_COPY", e, "Could not copy diagnostic report");
    }
  }

  // ---------------- Custom modal (replaces native confirm()/prompt()) ----------------
  //
  // showModal({ title, message, input, placeholder, defaultValue, okText,
  //             cancelText, danger })
  //   -> Promise that resolves to:
  //        - the typed string (or "" ) when input:true and OK was pressed
  //        - null                    when input:true and cancelled
  //        - true                    when input:false and OK was pressed
  //        - false                   when input:false and cancelled
  function showModal(opts) {
    const o = Object.assign(
      { title: "", message: "", input: false, placeholder: "", defaultValue: "", okText: "OK", cancelText: "Cancel", danger: false },
      opts || {}
    );

    return new Promise((resolve) => {
      el.modalTitle.textContent = o.title;
      if (o.message) {
        el.modalMessage.textContent = o.message;
        el.modalMessage.style.display = "block";
      } else {
        el.modalMessage.style.display = "none";
      }
      el.modalInput.style.display = o.input ? "block" : "none";
      el.modalInput.value = o.defaultValue;
      el.modalInput.placeholder = o.placeholder;
      el.modalBtnOk.textContent = o.okText;
      el.modalBtnCancel.textContent = o.cancelText;
      el.modalBox.classList.toggle("danger", !!o.danger);
      el.modalBtnOk.classList.toggle("danger", !!o.danger);
      el.modalBtnOk.classList.toggle("primary", !o.danger);

      function cleanup() {
        el.customModal.style.display = "none";
        el.modalBtnOk.removeEventListener("click", onOk);
        el.modalBtnCancel.removeEventListener("click", onCancel);
        el.modalInput.removeEventListener("keydown", onKeydown);
        el.customModal.removeEventListener("mousedown", onBackdrop);
      }
      function onOk() {
        const val = o.input ? el.modalInput.value : true;
        cleanup();
        resolve(val);
      }
      function onCancel() {
        cleanup();
        resolve(o.input ? null : false);
      }
      function onKeydown(ev) {
        if (ev.key === "Enter") onOk();
        else if (ev.key === "Escape") onCancel();
      }
      function onBackdrop(ev) {
        if (ev.target === el.customModal) onCancel();
      }

      el.modalBtnOk.addEventListener("click", onOk);
      el.modalBtnCancel.addEventListener("click", onCancel);
      el.modalInput.addEventListener("keydown", onKeydown);
      el.customModal.addEventListener("mousedown", onBackdrop);

      el.customModal.style.display = "flex";
      if (o.input) {
        el.modalInput.focus();
        el.modalInput.select();
      } else {
        el.modalBtnOk.focus();
      }
    });
  }

  // Feature modules are loaded before this licensed entry point, but invoke
  // dialogs later from click handlers. Expose the same shared modal API as the
  // Studio build and keep a callback adapter for the older feature modules.
  window.showModal = showModal;
  window.showToast = showToast;
  window.showConfirm = function (message, onConfirm, onCancel) {
    return showModal({
      title: "Confirm",
      message: String(message || ""),
      okText: "Continue",
      cancelText: "Cancel"
    }).then(function (confirmed) {
      if (confirmed) {
        if (typeof onConfirm === "function") onConfirm();
      } else if (typeof onCancel === "function") {
        onCancel();
      }
      return confirmed;
    });
  };
  window.showAlert = function (message, title) {
    return showModal({
      title: title || "CompX Orbit",
      message: String(message || ""),
      okText: "OK",
      cancelText: "Close"
    });
  };

  // ---------------- MOGRT thumbnail extraction ----------------
  //
  // A .mogrt is a plain zip archive. There's no documented, guaranteed
  // "official" preview asset inside every .mogrt, so this is a best-effort
  // reader: it lists the zip's central directory itself (no npm dependency —
  // CEP panels can't easily vendor native/npm zip libs), looks for the most
  // plausible preview-ish image inside, and inflates it with Node's built-in
  // zlib if needed. If nothing image-like is found, callers fall back to a
  // generic placeholder — this mirrors the "best-effort, not guaranteed"
  // honesty already used for the timeline-drag and auto-add-track features.

  const MAX_ZIP_ENTRIES = 20000;
  const MAX_MOGRT_PREVIEW_ARCHIVE_BYTES = 512 * 1024 * 1024;
  const MAX_MOGRT_IMPORT_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
  const MAX_PREVIEW_IMAGE_BYTES = 16 * 1024 * 1024;
  const MOGRT_CACHE_ROOT = nodeAvailable ? path.join(os.tmpdir(), "CompX", "mogrt-cache") : "";

  function formatBytes(bytes) {
    if (!bytes) return "0 MB";
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + " KB";
    return (bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1) + " MB";
  }

  async function mogrtCacheInfoFor(filePath) {
    const stat = await fs.promises.stat(filePath);
    const identity = filePath + "|" + stat.size + "|" + Math.floor(stat.mtimeMs || stat.mtime.getTime());
    const key = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24);
    return { key: key, dir: path.join(MOGRT_CACHE_ROOT, key), stat: stat };
  }

  async function directorySize(dir) {
    let total = 0;
    let entries = [];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return 0; }
    for (let i = 0; i < entries.length; i++) {
      const full = path.join(dir, entries[i].name);
      if (entries[i].isDirectory()) total += await directorySize(full);
      else {
        try { total += (await fs.promises.stat(full)).size; } catch (e) { auditFallback("MAIN_DIRECTORYSIZE_001", e); }
      }
      if (i % 25 === 24) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return total;
  }

  async function refreshMogrtCacheInfo() {
    if (!el.mogrtCacheInfo || !nodeAvailable) return;
    const bytes = await directorySize(MOGRT_CACHE_ROOT);
    el.mogrtCacheInfo.textContent = "Cache: " + formatBytes(bytes);
    el.mogrtCacheInfo.title = MOGRT_CACHE_ROOT;
  }

  function removeDirectoryAsync(dir) {
    return new Promise((resolve, reject) => {
      const done = (error) => error ? reject(error) : resolve();
      if (fs.rm) fs.rm(dir, { recursive: true, force: true }, done);
      else fs.rmdir(dir, { recursive: true }, done);
    });
  }

  function cacheDirFromReferencedPath(filePath) {
    const normalizedRoot = path.resolve(MOGRT_CACHE_ROOT);
    const normalized = path.resolve(filePath);
    if (normalized.indexOf(normalizedRoot + path.sep) !== 0) return null;
    const relative = path.relative(normalizedRoot, normalized);
    const first = relative.split(path.sep)[0];
    return first ? path.join(normalizedRoot, first) : null;
  }

  async function getHostProtectedCacheDirs() {
    const protectedDirs = new Set(activeMogrtCacheDirs);
    if (currentHostAppId() !== "AEFT") return protectedDirs;
    const parsed = await new Promise((resolve) => {
      callHost("aeft_getReferencedCompXCachePaths(" + hostArg(MOGRT_CACHE_ROOT) + ")", resolve, 30000);
    });
    if (parsed.success && parsed.data && Array.isArray(parsed.data.paths)) {
      parsed.data.paths.forEach((filePath) => {
        const dir = cacheDirFromReferencedPath(filePath);
        if (dir) protectedDirs.add(dir);
      });
    } else if (!parsed.success) {
      recordDiagnostic("warn", "CACHE_REFERENCE_SCAN", "Could not query active AE cache references", parsed.message, "skipped");
    }
    return protectedDirs;
  }

  async function clearUnusedMogrtCache() {
    if (!nodeAvailable) return showToast("Cache access is unavailable", true);
    const ok = await showModal({
      title: "Clear Unused MOGRT Cache?",
      message: "CompX will keep files used by the active After Effects project and this panel session. Only unreferenced cache folders will be removed.",
      okText: "Clear Unused",
      cancelText: "Cancel",
      danger: true,
    });
    if (!ok) return;
    try {
      const protectedDirs = await getHostProtectedCacheDirs();
      let entries = [];
      try { entries = await fs.promises.readdir(MOGRT_CACHE_ROOT, { withFileTypes: true }); } catch (e) { auditFallback("MAIN_CLEARUNUSEDMOGRTCACHE_001", e); }
      let removed = 0;
      let removedBytes = 0;
      for (let i = 0; i < entries.length; i++) {
        if (!entries[i].isDirectory()) continue;
        const dir = path.join(MOGRT_CACHE_ROOT, entries[i].name);
        if (protectedDirs.has(dir)) continue;
        removedBytes += await directorySize(dir);
        await removeDirectoryAsync(dir);
        removed++;
      }
      await refreshMogrtCacheInfo();
      recordDiagnostic("info", "CACHE_CLEAR", "Unused MOGRT cache cleared", removed + " folders, " + formatBytes(removedBytes), "applied");
      showToast("Cleared " + removed + " unused cache folder(s) · " + formatBytes(removedBytes));
    } catch (e) {
      reportError("CACHE_CLEAR_FAILED", e, "Could not clear unused MOGRT cache");
    }
  }

  async function readMogrtBufferAsync(filePath, maxBytes) {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return null;
    return fs.promises.readFile(filePath);
  }

  function findEOCD(buf) {
    const minLen = 22;
    const maxCommentLen = 65535;
    const start = Math.max(0, buf.length - minLen - maxCommentLen);
    for (let i = buf.length - minLen; i >= start; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) return i;
    }
    return -1;
  }

  function listZipEntries(buf) {
    const eocdOffset = findEOCD(buf);
    if (eocdOffset === -1) return [];
    const cdSize = buf.readUInt32LE(eocdOffset + 12);
    const cdOffset = buf.readUInt32LE(eocdOffset + 16);
    const totalEntries = buf.readUInt16LE(eocdOffset + 10);
    if (totalEntries > MAX_ZIP_ENTRIES) return [];
    if (cdOffset > eocdOffset || cdSize > eocdOffset - cdOffset) return [];
    const entries = [];
    let offset = cdOffset;
    for (let i = 0; i < totalEntries; i++) {
      if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) break;
      const compression = buf.readUInt16LE(offset + 10);
      const compSize = buf.readUInt32LE(offset + 20);
      const uncompSize = buf.readUInt32LE(offset + 24);
      const nameLen = buf.readUInt16LE(offset + 28);
      const extraLen = buf.readUInt16LE(offset + 30);
      const commentLen = buf.readUInt16LE(offset + 32);
      const localHeaderOffset = buf.readUInt32LE(offset + 42);
      const nextOffset = offset + 46 + nameLen + extraLen + commentLen;
      if (nextOffset > buf.length) break;
      const name = buf.toString("utf8", offset + 46, offset + 46 + nameLen);
      entries.push({ name, compression, compSize, uncompSize, localHeaderOffset });
      offset = nextOffset;
    }
    return entries;
  }

  function readZipEntryData(buf, entry) {
    // MOGRTs are untrusted zip archives. Reject obviously dangerous entries
    // before handing them to zlib so a corrupt/hostile template cannot make
    // the CEP process allocate an unbounded buffer.
    const MAX_ZIP_ENTRY_BYTES = 512 * 1024 * 1024;
    const MAX_ZIP_RATIO = 500;
    if (!entry || entry.compSize < 0 || entry.uncompSize < 0) return null;
    if (entry.uncompSize > MAX_ZIP_ENTRY_BYTES) return null;
    if (entry.compSize === 0 && entry.uncompSize > 0) return null;
    if (entry.compSize > 0 && entry.uncompSize / entry.compSize > MAX_ZIP_RATIO) return null;
    const lho = entry.localHeaderOffset;
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) return null;
    const nameLen = buf.readUInt16LE(lho + 26);
    const extraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + nameLen + extraLen;
    if (dataStart < 0 || dataStart > buf.length || entry.compSize > buf.length - dataStart) return null;
    const raw = buf.slice(dataStart, dataStart + entry.compSize);
    if (entry.compression === 0) {
      if (entry.uncompSize && raw.length !== entry.uncompSize) return null;
      return raw;
    }
    if (entry.compression === 8) {
      try {
        const inflated = zlib.inflateRawSync(raw);
        if (inflated.length > MAX_ZIP_ENTRY_BYTES) return null;
        if (entry.uncompSize && inflated.length !== entry.uncompSize) return null;
        return inflated;
      } catch (e) {
        return null;
      }
    }
    return null; // unsupported compression method — extremely rare in .mogrt
  }

  function scoreImageEntry(entry) {
    const n = entry.name.toLowerCase();
    if (n.indexOf("poster") !== -1) return 3;
    if (n.indexOf("thumb") !== -1) return 3;
    if (n.indexOf("preview") !== -1) return 2;
    return 1;
  }

  async function extractMogrtThumbnail(filePath) {
    try {
      const buf = await readMogrtBufferAsync(filePath, MAX_MOGRT_PREVIEW_ARCHIVE_BYTES);
      if (!buf) return null;
      const entries = listZipEntries(buf);
      const images = entries.filter((e) => {
        const ext = path.extname(e.name).toLowerCase();
        return IMAGE_EXT_MIME.hasOwnProperty(ext) && e.uncompSize > 0 && e.uncompSize <= MAX_PREVIEW_IMAGE_BYTES;
      });
      if (images.length === 0) return null;
      images.sort((a, b) => scoreImageEntry(b) - scoreImageEntry(a));
      const best = images[0];
      const data = readZipEntryData(buf, best);
      if (!data) return null;
      const mime = IMAGE_EXT_MIME[path.extname(best.name).toLowerCase()];
      return "data:" + mime + ";base64," + data.toString("base64");
    } catch (e) {
      return null;
    }
  }

  const THUMBNAIL_QUEUE_DELAY_MS = 24;
  const thumbnailQueue = [];
  const queuedThumbnailIds = new Set();
  let thumbnailQueueActive = false;

  function updateRenderedThumbnail(item) {
    if (!item.thumbnail) return;
    const cards = document.querySelectorAll("#library .sfx-card");
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      if (card.dataset.id !== item.id) continue;
      const current = card.querySelector(".card-media-img");
      if (!current) continue;
      if (current.tagName && current.tagName.toLowerCase() === "img") {
        current.src = item.thumbnail;
      } else {
        const image = document.createElement("img");
        image.className = "card-media-img";
        image.src = item.thumbnail;
        image.style.width = "100%";
        image.style.height = "100%";
        image.style.objectFit = "cover";
        current.parentNode.replaceChild(image, current);
      }
    }
  }

  function scheduleThumbnailQueue() {
    if (thumbnailQueueActive || thumbnailQueue.length === 0) return;
    thumbnailQueueActive = true;
    setTimeout(async () => {
      const item = thumbnailQueue.shift();
      if (item) queuedThumbnailIds.delete(item.id);
      // A queued item may have been deleted or reset before its turn.
      if (item && !item.thumbnailChecked && library.some((entry) => entry.id === item.id)) {
        item.thumbnail = await extractMogrtThumbnail(item.path);
        item.thumbnailChecked = true;
        updateRenderedThumbnail(item);
      }
      thumbnailQueueActive = false;
      scheduleThumbnailQueue();
    }, THUMBNAIL_QUEUE_DELAY_MS);
  }

  function ensureThumbnail(item) {
    if (!isGraphicType(item.type) || item.thumbnailChecked || queuedThumbnailIds.has(item.id)) return;
    queuedThumbnailIds.add(item.id);
    thumbnailQueue.push(item);
    scheduleThumbnailQueue();
  }

  // ---------------- MOGRT → AE project extraction ----------------
  //
  // A .mogrt authored in After Effects is a zip that bundles the *source* AE
  // project plus its assets/fonts and a definition.json manifest. AE cannot
  // consume a .mogrt directly (that's Premiere-only), so to use the SAME
  // .mogrt file in AE we unpack it, drop the internal AE project (+ assets)
  // into a fresh temp folder, and hand the .aep to ExtendScript to import.
  // Premiere keeps using the .mogrt natively — one file, both hosts.
  //
  // Returns { aepPath, compName } or null when there's no AE project inside
  // (e.g. a Premiere-authored template, which AE genuinely cannot use).

  const AE_PROJECT_EXT = [".aep", ".aepx", ".aegraphic", ".aegp"];
  const REAL_AE_EXT = [".aep", ".aepx"]; // what importFile() actually accepts

  // A buffer is a local zip entry if it starts with the PK\x03\x04 signature.
  function isZipBuffer(b) {
    return b && b.length > 4 && b.readUInt32LE(0) === 0x04034b50;
  }

  // Pick the best AE-project-ish entry from a parsed zip buffer, preferring
  // real .aep/.aepx over the mogrt-internal .aegraphic/.aegp wrappers.
  function pickAeEntry(zipBuf, exts) {
    const entries = listZipEntries(zipBuf);
    let best = null, rank = 99;
    for (const e of entries) {
      const ext = path.extname(e.name).toLowerCase();
      const r = exts.indexOf(ext);
      if (r !== -1 && e.uncompSize > 0 && r < rank) { best = e; rank = r; }
    }
    return best;
  }

  // Write every file entry of a zip buffer to destDir, preserving relative
  // paths so an AE project's linked footage/fonts resolve correctly.
  function safeZipDestination(rootDir, entryName) {
    if (!entryName || entryName.indexOf("\0") !== -1 || path.isAbsolute(entryName) || /^[A-Za-z]:[\\/]/.test(entryName)) return null;
    const root = path.resolve(rootDir);
    const dest = path.resolve(root, entryName);
    return (dest === root || dest.indexOf(root + path.sep) === 0) ? dest : null;
  }

  async function spillZip(zipBuf, destDir) {
    const entries = listZipEntries(zipBuf);
    const MAX_TOTAL_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;
    let totalExtracted = 0;
    for (const e of entries) {
      if (/\/$/.test(e.name)) continue; // skip directory entries
      // Reject absolute paths, Windows drive paths, null bytes, and traversal.
      const dest = safeZipDestination(destDir, e.name);
      if (!dest) continue;
      if (e.uncompSize > MAX_TOTAL_EXTRACTED_BYTES - totalExtracted) continue;
      const data = readZipEntryData(zipBuf, e);
      if (!data) continue;
      if (data.length > MAX_TOTAL_EXTRACTED_BYTES - totalExtracted) continue;
      totalExtracted += data.length;
      try {
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        await fs.promises.writeFile(dest, data);
      } catch (writeError) {
        recordDiagnostic("warn", "MOGRT_CACHE_WRITE", "Skipped one extracted MOGRT entry", writeError.message || writeError, "skipped");
      }
      if (totalExtracted % (32 * 1024 * 1024) < data.length) await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  async function fileExists(filePath) {
    try { await fs.promises.access(filePath, fs.constants.F_OK); return true; }
    catch (e) { return false; }
  }

  async function extractMogrtAeProject(filePath) {
    const cache = await mogrtCacheInfoFor(filePath);
    const metadataPath = path.join(cache.dir, "compx-cache.json");
    try {
      const metadata = JSON.parse(await fs.promises.readFile(metadataPath, "utf8"));
      if (metadata && metadata.aepPath && await fileExists(metadata.aepPath)) {
        activeMogrtCacheDirs.add(cache.dir);
        recordDiagnostic("info", "MOGRT_CACHE_HIT", "Reused cached MOGRT extraction", cache.key, "applied");
        return { aepPath: metadata.aepPath, compName: metadata.compName || "", cacheDir: cache.dir, cached: true };
      }
    } catch (cacheReadError) { auditFallback("MAIN_EXTRACTMOGRTAEPROJECT_001", cacheReadError); }

    const buf = await readMogrtBufferAsync(filePath, MAX_MOGRT_IMPORT_ARCHIVE_BYTES);
    if (!buf) return null;
    const entries = listZipEntries(buf);
    if (!entries.length) return null;

    // Unpack into a deterministic source/size/mtime cache directory. Updating
    // the source MOGRT generates a new key and cannot reuse stale contents.
    try { await removeDirectoryAsync(cache.dir); } catch (e) { auditFallback("MAIN_EXTRACTMOGRTAEPROJECT_002", e); }
    await fs.promises.mkdir(cache.dir, { recursive: true });
    activeMogrtCacheDirs.add(cache.dir);
    const outDir = cache.dir;
    await spillZip(buf, outDir);

    const projEntry = pickAeEntry(buf, AE_PROJECT_EXT);
    if (!projEntry) {
      activeMogrtCacheDirs.delete(cache.dir);
      try { await removeDirectoryAsync(cache.dir); } catch (e) { auditFallback("MAIN_EXTRACTMOGRTAEPROJECT_003", e); }
      return null;
    } // no AE project inside → not AE-usable

    let projData = readZipEntryData(buf, projEntry);
    if (!projData) return null;

    // On-disk path of the project as first spilled (e.g. project.aegraphic).
    let aepPath = safeZipDestination(outDir, projEntry.name);
    if (!aepPath) return null;

    // CRUCIAL: AE-authored mogrts don't store a bare .aep — they wrap the real
    // RIFX .aep INSIDE project.aegraphic, which is ITSELF a zip. (A .aegraphic
    // handed straight to importFile fails with "bad format or not readable".)
    // So keep unwrapping nested zips until we reach the actual project bytes.
    let level = 0;
    while (isZipBuffer(projData) && level < 4) {
      const innerDir = path.join(outDir, "_nested" + level);
      await spillZip(projData, innerDir);
      const inner = pickAeEntry(projData, REAL_AE_EXT) ||
                    pickAeEntry(projData, AE_PROJECT_EXT);
      if (!inner) break;
      aepPath = safeZipDestination(innerDir, inner.name);
      if (!aepPath) return null;
      projData = readZipEntryData(projData, inner);
      level++;
      if (!projData) break;
    }

    if (!await fileExists(aepPath)) return null;

    // importFile() only accepts .aep/.aepx — copy if the extension differs.
    const curExt = path.extname(aepPath).toLowerCase();
    if (curExt !== ".aep" && curExt !== ".aepx") {
      const renamed = aepPath.replace(/\.[^.]+$/, "") + ".aep";
      try { await fs.promises.copyFile(aepPath, renamed); aepPath = renamed; } catch (cErr) { auditFallback("MAIN_EXTRACTMOGRTAEPROJECT_004", cErr); }
    }
    if (!await fileExists(aepPath)) return null;

    // Best-effort: read definition.json to learn the template/comp name.
    let compName = "";
    try {
      const defEntry = entries.find((e) => /(^|\/)definition\.json$/i.test(e.name));
      if (defEntry) {
        const defData = readZipEntryData(buf, defEntry);
        if (defData) {
          const def = JSON.parse(defData.toString("utf8"));
          compName = def.name || def.templateName ||
                     (def.template && def.template.name) ||
                     def.capsuleName || def.capsuleNameLocalized || "";
        }
      }
    } catch (defErr) {
      recordDiagnostic("warn", "MOGRT_DEFINITION", "Could not read MOGRT definition metadata", defErr.message || defErr, "skipped");
    }

    await fs.promises.writeFile(metadataPath, JSON.stringify({
      version: 1,
      sourceSize: cache.stat.size,
      sourceMtime: cache.stat.mtimeMs || cache.stat.mtime.getTime(),
      aepPath: aepPath,
      compName: compName,
      createdAt: new Date().toISOString(),
    }, null, 2), "utf8");
    activeMogrtCacheDirs.add(cache.dir);
    refreshMogrtCacheInfo();
    recordDiagnostic("info", "MOGRT_CACHE_CREATE", "Created reusable MOGRT cache", cache.key, "applied");
    return { aepPath, compName, cacheDir: cache.dir, cached: false };
  }

  async function safeExtractMogrtAeProject(filePath) {
    try { return await extractMogrtAeProject(filePath); }
    catch (e) {
      recordDiagnostic("error", "MOGRT_EXTRACT", "MOGRT extraction failed", e.stack || e.message || e, "failed");
      return null;
    }
  }

  // ---------------- Animated hover preview (MOGRT) ----------------
  //
  // Same "best-effort, not guaranteed" spirit as the thumbnail extraction
  // above: a .mogrt is just a zip, and there's no guaranteed animated asset
  // inside it. This looks for, in order of preference:
  //   1) a small embedded preview video (preview.mp4 / .webm / .mov)
  //   2) a numbered sequence of preview frames (preview_001.png, _002, ...)
  //   3) the single best static image (same one used for the thumbnail)
  // and plays whichever is found while the card is hovered. If a template
  // only has a single static image, hovering just leaves the thumbnail as-is
  // — there's nothing to animate, and we don't fake it.

  const previewAssetCache = new Map(); // bounded LRU: item.id -> preview asset
  const MAX_PREVIEW_CACHE_ITEMS = 8;
  const HOVER_PREVIEW_DELAY_MS = 120;

  function scoreMediaEntry(entry) {
    const n = entry.name.toLowerCase();
    if (n.indexOf("preview") !== -1) return 3;
    if (n.indexOf("thumb") !== -1) return 2;
    if (n.indexOf("poster") !== -1) return 2;
    return 1;
  }

  // "preview_0007.png" -> "preview_" (used to group a numbered frame sequence)
  function frameSequenceKey(fileName) {
    const base = fileName.replace(/\.[^.]+$/, "");
    const m = base.match(/^(.*?)(\d+)$/);
    return m ? m[1] : null;
  }

  async function extractPreviewAsset(filePath) {
    try {
      const buf = await readMogrtBufferAsync(filePath, MAX_MOGRT_PREVIEW_ARCHIVE_BYTES);
      if (!buf) return { type: "none" };
      const entries = listZipEntries(buf);

      // 1) Embedded preview video — capped so we never inline something huge.
      const MAX_VIDEO_BYTES = 12 * 1024 * 1024;
      const videos = entries.filter((e) => {
        const ext = path.extname(e.name).toLowerCase();
        return VIDEO_EXT_MIME.hasOwnProperty(ext) && e.uncompSize > 0 && e.uncompSize < MAX_VIDEO_BYTES;
      });
      if (videos.length) {
        videos.sort((a, b) => scoreMediaEntry(b) - scoreMediaEntry(a));
        const data = readZipEntryData(buf, videos[0]);
        if (data) {
          const mime = VIDEO_EXT_MIME[path.extname(videos[0].name).toLowerCase()];
          return { type: "video", url: "data:" + mime + ";base64," + data.toString("base64") };
        }
      }

      // 2) Numbered frame sequence — flipbook it like Premiere's own library scrub preview.
      const images = entries.filter((e) => {
        const ext = path.extname(e.name).toLowerCase();
        return IMAGE_EXT_MIME.hasOwnProperty(ext) && e.uncompSize > 0 && e.uncompSize <= MAX_PREVIEW_IMAGE_BYTES;
      });
      const groups = {};
      images.forEach((e) => {
        const key = frameSequenceKey(path.basename(e.name));
        if (key) {
          groups[key] = groups[key] || [];
          groups[key].push(e);
        }
      });
      const groupKeys = Object.keys(groups).filter((k) => groups[k].length >= 3);
      if (groupKeys.length) {
        groupKeys.sort((a, b) => groups[b].length - groups[a].length);
        const frameEntries = groups[groupKeys[0]]
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
          .slice(0, 30);
        const MAX_TOTAL_BYTES = 6 * 1024 * 1024;
        let total = 0;
        const frames = [];
        for (let i = 0; i < frameEntries.length; i++) {
          const e = frameEntries[i];
          if (total + e.uncompSize > MAX_TOTAL_BYTES) break;
          const data = readZipEntryData(buf, e);
          if (!data) continue;
          total += e.uncompSize;
          const mime = IMAGE_EXT_MIME[path.extname(e.name).toLowerCase()];
          frames.push("data:" + mime + ";base64," + data.toString("base64"));
        }
        if (frames.length >= 3) return { type: "frames", frames: frames };
      }

      // 3) Fallback: the same single best static image used for the thumbnail.
      if (images.length) {
        images.sort((a, b) => scoreImageEntry(b) - scoreImageEntry(a));
        const data = readZipEntryData(buf, images[0]);
        if (data) {
          const mime = IMAGE_EXT_MIME[path.extname(images[0].name).toLowerCase()];
          return { type: "image", url: "data:" + mime + ";base64," + data.toString("base64") };
        }
      }
    } catch (e) { auditFallback("MAIN_EXTRACTPREVIEWASSET_001", e); }
    return { type: "none" };
  }

  async function getPreviewAssetCached(item) {
    if (previewAssetCache.has(item.id)) {
      const cached = previewAssetCache.get(item.id);
      // Refresh insertion order so Map behaves as a small LRU cache.
      previewAssetCache.delete(item.id);
      previewAssetCache.set(item.id, cached);
      return cached;
    }
    const asset = await extractPreviewAsset(item.path);
    previewAssetCache.set(item.id, asset);
    while (previewAssetCache.size > MAX_PREVIEW_CACHE_ITEMS) {
      const oldestId = previewAssetCache.keys().next().value;
      previewAssetCache.delete(oldestId);
    }
    return asset;
  }

  async function applyCardHoverPreview(card, item) {
    const asset = await getPreviewAssetCached(item);
    if (!card._previewHovering || !document.documentElement.contains(card)) return;
    const img = card.querySelector(".card-media-img");
    const video = card.querySelector(".card-media-video");

    if (asset.type === "video" && video) {
      if (img) img.style.display = "none";
      video.src = asset.url;
      video.style.display = "block";
      try {
        video.currentTime = 0;
        video.play().catch(() => {});
      } catch (e) { auditFallback("MAIN_APPLYCARDHOVERPREVIEW_001", e); }
    } else if (asset.type === "frames" && img && asset.frames.length) {
      clearInterval(card._frameTimer);
      let idx = 0;
      img.src = asset.frames[0];
      card._frameTimer = setInterval(() => {
        idx = (idx + 1) % asset.frames.length;
        img.src = asset.frames[idx];
      }, 90);
    }
    // type "image" or "none" — nothing to animate, static thumbnail stays put.
  }

  function startCardHoverPreview(card, item) {
    card._previewHovering = true;
    clearTimeout(card._previewLoadTimer);
    // Avoid reading and inflating a MOGRT when the pointer merely passes over
    // a card. Intentional hovers still start quickly after this short delay.
    card._previewLoadTimer = setTimeout(async () => {
      if (!card._previewHovering || !document.documentElement.contains(card)) return;
      await applyCardHoverPreview(card, item);
    }, HOVER_PREVIEW_DELAY_MS);
  }

  function stopCardHoverPreview(card, item) {
    card._previewHovering = false;
    clearTimeout(card._previewLoadTimer);
    card._previewLoadTimer = null;
    clearInterval(card._frameTimer);
    card._frameTimer = null;
    const img = card.querySelector(".card-media-img");
    const video = card.querySelector(".card-media-video");
    if (video) {
      try { video.pause(); } catch (e) { auditFallback("MAIN_STOPCARDHOVERPREVIEW_001", e); }
      video.style.display = "none";
    }
    if (img) {
      img.style.display = "block";
      if (item.thumbnail) img.src = item.thumbnail;
    }
  }

  // ---------------- Library building ----------------

  function pushPrfpsetEntries(entries, rootDir) {
    let added = 0;
    entries.forEach(function (entry) {
      const keyName = entry.name;
      const keyPath = entry.path;
      if (library.some(function (s) { return s.type === "prfpset" && s.path === keyPath && s.name === keyName; })) return;
      const rel = rootDir ? path.relative(rootDir, keyPath).replace(/\\/g, "/") : ((entry.pack || "Presets") + "/" + path.basename(keyPath));
      const folderPath = entry.folderPath || entry.pack || path.dirname(rel).replace(/\\/g, "/");
      library.push({
        id: uid(),
        type: "prfpset",
        name: keyName,
        path: keyPath,
        relativePath: rel + "#" + keyName,
        folderPath: folderPath === "." ? (entry.pack || "") : folderPath,
        category: "Effect Preset",
        tags: ["prfpset", entry.pack || "preset"],
        favorite: false,
        duration: null,
        thumbnail: null,
        thumbnailChecked: true,
        color: null,
        collections: [],
        lastPlayedAt: null,
        filterCount: entry.filterCount || (entry.filters ? entry.filters.length : 0),
        preview: entry.preview || null
      });
      added++;
    });
    return added;
  }

  function isExcludedLibraryPrfpset(entry) {
    const pack = String((entry && (entry.pack || entry.folderPath || entry.path)) || "");
    const name = String((entry && entry.name) || "");
    return PRFPSET_LIBRARY_EXCLUDE.test(pack) || PRFPSET_LIBRARY_EXCLUDE.test(name);
  }

  function purgeExcludedLibraryPrfpsets() {
    const before = library.length;
    library = library.filter(function (item) {
      if (!item || item.type !== "prfpset") return true;
      return !isExcludedLibraryPrfpset(item);
    });
    const removed = before - library.length;
    if (removed > 0) saveLibrary();
    return removed;
  }

  function ensureDefaultPrfpsets() {
    // Library PRESET shelf was removed — never seed .prfpset cards into Library.
    return purgeAllLibraryPrfpsets();
  }

  function purgeAllLibraryPrfpsets() {
    const before = library.length;
    library = library.filter(function (item) {
      return !(item && item.type === "prfpset");
    });
    const removed = before - library.length;
    if (removed > 0) saveLibrary();
    return removed;
  }

  function addFilePaths(filePaths, type) {
    type = type || assetType;
    const extList = EXT_BY_TYPE[type];
    let added = 0;

    // Filter paths to only supported extension types
    const validPaths = filePaths.filter((p) => {
      const ext = path.extname(p).toLowerCase();
      return extList.indexOf(ext) !== -1;
    });

    if (validPaths.length === 0) {
      showToast("No supported files found", true);
      return;
    }

    if (type === "prfpset") {
      showToast("Effect presets are not in Library", true);
      return;
    }

    // Determine common root to build relative paths and folder paths
    let commonDir = path.dirname(validPaths[0]);
    validPaths.forEach((p) => {
      const dir = path.dirname(p);
      if (dir.length < commonDir.length && commonDir.startsWith(dir)) {
        commonDir = dir;
      }
    });
    // Use the parent of the common directory so the top-level folder itself is part of the tree
    const rootDir = path.dirname(commonDir);

    validPaths.forEach((p) => {
      if (library.some((s) => s.path === p && s.type === type)) return; // no dup by path/reference
      const ext = path.extname(p).toLowerCase();
      const name = path.basename(p, ext);
      
      // Compute relativePath and folderPath relative to the rootDir
      const rel = path.relative(rootDir, p).replace(/\\/g, "/");
      const relDir = path.dirname(rel).replace(/\\/g, "/");
      const folderPath = relDir === "." ? "" : relDir;

      library.push({
        id: uid(),
        type: type,
        name: name,
        path: p,
        relativePath: rel,
        folderPath: folderPath,
        category: isGraphicType(type) ? guessMogrtCategory(name) : guessCategory(name),
        tags: isGraphicType(type) ? guessMogrtTags(name) : guessTags(name),
        favorite: false,
        duration: null, // populated lazily on first decode (SFX only)
        thumbnail: null, // populated lazily on first view (MOGRT only)
        thumbnailChecked: false,
        color: null,
        collections: [],
        lastPlayedAt: null,
      });
      added++;
    });

    const noun = assetNoun(type);
    if (added > 0) {
      saveLibrary();
      render();
      showToast(added + " " + noun + (added > 1 ? "s" : "") + " added");
    } else {
      showToast("No new supported " + (isGraphicType(type) ? ".mogrt" : "audio") + " files found", true);
    }
  }

  // ---------------- Rendering ----------------

  function getFiltered() {
    let items = library.filter((s) => s.type === assetType);
    if (assetType === "prfpset") {
      items = items.filter(function (s) { return !isExcludedLibraryPrfpset(s); });
    }

    if (currentView === "favorites") {
      items = items.filter((s) => s.favorite);
    } else if (currentView === "recent") {
      items = items.filter((s) => s.lastPlayedAt != null);
    } else if (currentView === "collections" && activeCollection) {
      items = items.filter((s) => s.collections.includes(activeCollection));
    }

    // Selected folder filter (handles subfolders as well)
    if (selectedFolder) {
      items = items.filter((s) => {
        const folder = s.folderPath || "";
        return folder === selectedFolder || folder.indexOf(selectedFolder + "/") === 0;
      });
    }

    const q = filterText.trim().toLowerCase();
    if (q) {
      items = items.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.tags.some((t) => t.includes(q)) ||
          s.category.toLowerCase().includes(q) ||
          s.collections.some((c) => c.toLowerCase().includes(q))
      );
    }

    // Sort items
    if (sortBy === "name") {
      items.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortBy === "recent") {
      items.sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0));
    } else if (sortBy === "duration") {
      items.sort((a, b) => (b.duration || 0) - (a.duration || 0));
    } else if (sortBy === "favorite") {
      items.sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0));
    }

    return items;
  }

  function getAllCollections() {
    const set = new Set();
    library.filter((s) => s.type === assetType).forEach((s) => s.collections.forEach((c) => set.add(c)));
    return Array.from(set).sort();
  }

  function groupByCategory(items) {
    const groups = {};
    items.forEach((s) => {
      groups[s.category] = groups[s.category] || [];
      groups[s.category].push(s);
    });
    return groups;
  }

  function buildFolderTree(items) {
    const root = { name: "Root", children: {}, path: "", isRoot: true };
    items.forEach((item) => {
      if (!item.folderPath) return;
      const parts = item.folderPath.split("/");
      let current = root;
      let currentPath = "";
      parts.forEach((part) => {
        currentPath = currentPath ? currentPath + "/" + part : part;
        if (!current.children[part]) {
          current.children[part] = { name: part, children: {}, path: currentPath };
        }
        current = current.children[part];
      });
    });
    return root;
  }

  const collapsedFolders = new Set();

  function renderFolderTree() {
    const items = library.filter((s) => s.type === assetType);
    const treeData = buildFolderTree(items);
    el.folderTree.innerHTML = "";

    const ul = document.createElement("ul");
    
    const allLi = document.createElement("li");
    allLi.className = "folder-node";
    allLi.innerHTML = `
      <div class="folder-row ${currentView !== "favorites" && selectedFolder === "" ? "active" : ""}" data-folder="">
        <span class="folder-caret"></span>
        <span class="folder-icon"></span>
        <span class="folder-name">All Files</span>
        <span class="folder-count">${items.length}</span>
      </div>
    `;
    ul.appendChild(allLi);

    const favCount = items.filter((it) => !!it.favorite).length;
    const favLi = document.createElement("li");
    favLi.className = "folder-node";
    favLi.innerHTML = `
      <div class="folder-row ${currentView === "favorites" ? "active" : ""}" data-folder="__favorites__">
        <span class="folder-caret"></span>
        <span class="folder-icon"></span>
        <span class="folder-name">Favorites</span>
        <span class="folder-count">${favCount}</span>
      </div>
    `;
    ul.appendChild(favLi);

    function buildHtml(node, parentEl) {
      Object.keys(node.children).sort().forEach((key) => {
        const child = node.children[key];
        const li = document.createElement("li");
        li.className = "folder-node";
        const hasChildren = Object.keys(child.children).length > 0;
        const isCollapsed = collapsedFolders.has(child.path);
        if (isCollapsed) {
          li.classList.add("collapsed");
        }

        li.innerHTML = `
          <div class="folder-row ${currentView !== "favorites" && selectedFolder === child.path ? "active" : ""}" data-folder="${escapeHtml(child.path)}">
            <span class="folder-caret">${hasChildren ? (isCollapsed ? ">" : "v") : ""}</span>
            <span class="folder-icon"></span>
            <span class="folder-name">${escapeHtml(child.name)}</span>
            <span class="folder-count">${items.filter((it) => it.folderPath === child.path || (it.folderPath && it.folderPath.indexOf(child.path + "/") === 0)).length}</span>
          </div>
        `;

        if (hasChildren) {
          const subUl = document.createElement("ul");
          subUl.className = "folder-tree-sub";
          buildHtml(child, subUl);
          li.appendChild(subUl);
        }
        parentEl.appendChild(li);
      });
    }

    buildHtml(treeData, ul);
    el.folderTree.appendChild(ul);

    var countEl = document.getElementById("libItemCount");
    if (countEl) countEl.textContent = items.length + " items";
    var footer = document.getElementById("libSidebarFooter");
    if (footer) footer.textContent = items.length + " items";
  }

  function render() {
    const isGraphic = isGraphicType(assetType);
    const noun = assetNoun(assetType);
    const shelfCount = library.filter((s) => s.type === assetType).length;
    const filtered = getFiltered();
    const queryKey = [assetType, currentView, activeCollection || "", selectedFolder, filterText.trim().toLowerCase(), sortBy, viewMode].join("|");
    if (queryKey !== lastAssetQueryKey) {
      lastAssetQueryKey = queryKey;
      assetRenderLimit = ASSET_PAGE_SIZE;
    }
    el.library.innerHTML = "";
    
    // Update view mode classes on library container
    el.library.className = "library " + (viewMode === "grid" ? "grid" : "list");
    const sfxRoot = document.getElementById("sfxMogrtView");
    if (sfxRoot) sfxRoot.setAttribute("data-view-mode", viewMode);
    applyCardSize(document.getElementById("cardSizeSlider") && document.getElementById("cardSizeSlider").value, el.library);

    renderAssetTypeRow();
    renderTabsAndCollections();
    renderBatchBar();
    renderTransportForType();
    renderFolderTree();

    if (shelfCount === 0) {
      if (assetType === "mogrt") {
        el.library.innerHTML = '<div class="empty-state"><span class="big">🎨</span>Your MOGRT shelf is empty.<br/>Add .mogrt templates or import a folder to get started.</div>';
      } else if (assetType === "prfpset") {
        el.library.innerHTML = '<div class="empty-state"><span class="big">FX</span>Your Preset shelf is empty.<br/>Default packs load automatically — or add .prfpset files.</div>';
      } else {
        el.library.innerHTML = '<div class="empty-state"><span class="big">♪</span>Your library is empty.<br/>Add sounds or import a folder to get started.</div>';
      }
      return;
    }
    if (filtered.length === 0) {
      const msg =
        currentView === "recent"
          ? "Nothing " + (isGraphic ? "used" : "played") + " yet — " + (isGraphic ? "insert a " + noun : "play a sound") + " and it'll show up here."
          : currentView === "favorites"
          ? "No favorites yet — click the star on a " + noun + "."
          : currentView === "collections" && activeCollection
          ? "This collection is empty."
          : "No " + noun + "s match your search in this folder.";
      el.library.innerHTML = '<div class="empty-state">' + msg + "</div>";
      return;
    }

    // Render incrementally so very large libraries do not create thousands of
    // DOM nodes or extract every MOGRT thumbnail in one blocking pass.
    const visibleItems = filtered.slice(0, assetRenderLimit);
    visibleItems.forEach((item) => {
      el.library.appendChild(renderCard(item));
    });

    if (visibleItems.length < filtered.length) {
      const remaining = filtered.length - visibleItems.length;
      const batch = Math.min(ASSET_PAGE_SIZE, remaining);
      const more = document.createElement("div");
      more.className = "library-load-more";
      more.innerHTML = '<div class="library-load-progress">Showing ' + visibleItems.length + ' of ' + filtered.length + '</div>' +
        '<button type="button">Load ' + batch + ' more</button>';
      more.querySelector("button").addEventListener("click", () => {
        const previousScroll = el.library.scrollTop;
        assetRenderLimit += ASSET_PAGE_SIZE;
        render();
        requestAnimationFrame(() => { el.library.scrollTop = previousScroll; });
      });
      el.library.appendChild(more);
    }

  }

  function renderAssetTypeRow() {
    el.assetTypeRow.querySelectorAll(".shelf").forEach((b) => b.classList.toggle("active", b.dataset.type === "library" ? (assetType === "sfx" || assetType === "mogrt" || assetType === "prfpset") : b.dataset.type === assetType));
    document.querySelectorAll("#libraryTypeTabs [data-library-type]").forEach((b) => b.classList.toggle("active", b.dataset.libraryType === assetType));
  }

  function renderTransportForType() {
    const isGraphic = isGraphicType(assetType);
    const isPreset = isPresetType(assetType);
    var deckMixer = document.getElementById("libraryDeckMixer");
    if (deckMixer) deckMixer.style.display = "none";
    el.playHint.textContent = isPreset
      ? "Select a clip on the timeline · click Apply to put the preset on it"
      : isGraphic
      ? "Hover a " + assetNoun(assetType) + " to preview · click to insert at the playhead"
      : "Click a sound to play · click again to stop";
    if (el.btnAddFiles) {
      el.btnAddFiles.dataset.libTip = assetType === "mogrt" ? "Add MOGRT files" : (assetType === "prfpset" ? "Add preset packs" : "Add sound files");
    }
    if (el.btnAddFolder) {
      el.btnAddFolder.dataset.libTip = assetType === "mogrt" ? "Import MOGRT folder" : "Import sound folder";
    }
    el.fileInputFiles.setAttribute("accept", isGraphic ? ".mogrt" : (isPreset ? ".prfpset" : ".mp3,.wav,.aiff,.aif,.m4a,.ogg"));
  }

  function renderTabsAndCollections() {
    el.tabsRow.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === currentView));
    if (currentView !== "collections") {
      el.collectionsRow.style.display = "none";
      return;
    }
    el.collectionsRow.style.display = "flex";
    const cols = getAllCollections();
    if (cols.length === 0) {
      el.collectionsRow.innerHTML =
        '<span class="hint" style="margin:0;">No collections yet — use the 🗂 button on a sound to create one.</span>';
      return;
    }
    el.collectionsRow.innerHTML = cols
      .map(
        (c) =>
          '<button class="chip' + (c === activeCollection ? " active" : "") + '" data-collection="' + escapeHtml(c) + '">' +
          escapeHtml(c) +
          "</button>"
      )
      .join("");
  }

  function syncFolderToggle() {
    if (el.sidebar) el.sidebar.classList.toggle("collapsed", sidebarCollapsed);
    var open = !sidebarCollapsed;
    if (el.btnCollapse) {
      el.btnCollapse.textContent = open ? "<" : ">";
      el.btnCollapse.classList.toggle("open", open);
      el.btnCollapse.setAttribute("aria-pressed", open ? "true" : "false");
      el.btnCollapse.title = open ? "Hide folders" : "Show folders";
    }
  }

  function setFolderSidebar(hidden) {
    sidebarCollapsed = !!hidden;
    try { localStorage.setItem("compXLibraryFolders", sidebarCollapsed ? "off" : "on"); } catch (e) {}
    syncFolderToggle();
  }

  function renderBatchBar() {
    const count = batchSelected.size;
    if (el.batchBar) el.batchBar.style.display = count > 0 ? "flex" : "none";
    if (el.batchCount) el.batchCount.textContent = count + " selected";
    if (el.btnRemoveSelected) el.btnRemoveSelected.disabled = count === 0;
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = String(s == null ? "" : s);
    // textContent protects element text, while explicit quote encoding also
    // makes the result safe when reused inside generated HTML attributes.
    return d.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function renderCard(item) {
    const isGraphic = isGraphicType(item.type);
    const isPreset = isPresetType(item.type);
    if (isGraphic) ensureThumbnail(item);

    const card = document.createElement("div");
    card.className = "sfx-card fxlib-card" + (isPreset ? " prfpset-card" : "");
    if (missingAssetIds.has(item.id)) card.classList.add("missing-file");
    if (item.id === selectedId || batchSelected.has(item.id)) card.classList.add("selected");
    if (!isGraphic && !isPreset && isPlaying && item.id === selectedId) card.classList.add("playing");
    card.dataset.id = item.id;
    card.draggable = !isPreset;

    const colorStrip = item.color
      ? '<div class="color-strip" style="background:' + item.color + '"></div>'
      : "";

    let mediaArea = "";
    if (isPreset) {
      const preview = item.preview || (window.PrfpsetCatalog && window.PrfpsetCatalog.describePreview
        ? window.PrfpsetCatalog.describePreview(item.name, [])
        : { motion: "pop", label: "FX", glow: false, blur: 0 });
      mediaArea = '<div class="waveform-area fxlib-thumb prfpset-thumb" data-motion="' + escapeHtml(preview.motion || "pop") + '"' +
        (preview.blur ? ' style="--prfpset-blur:' + Number(preview.blur) + 'px"' : "") + '>' +
        '<div class="prfpset-stage">' +
        '<span class="prfpset-glow"></span>' +
        '<span class="prfpset-sample">Aa</span>' +
        '</div>' +
        '<span class="prfpset-badge">' + escapeHtml(preview.label || "FX") + '</span>' +
        '<strong class="prfpset-pack">' + escapeHtml(item.folderPath || "Preset") + '</strong>' +
        '<button class="card-favorite ' + (item.favorite ? "on" : "") + '" data-action="favorite" title="Favorite">★</button>' +
        '</div>';
    } else if (isGraphic) {
      mediaArea = '<div class="waveform-area fxlib-thumb">' +
        (item.thumbnail
          ? '<img class="card-media-img" src="' + item.thumbnail + '" style="width:100%;height:100%;object-fit:cover;" />'
          : '<span class="card-media-img thumb-fallback">🎨</span>') +
        '<video class="card-media-video" muted loop playsinline style="display:none;position:absolute;inset:0;width:100%;height:100%;object-fit:cover;"></video>' +
        '<button class="card-favorite ' + (item.favorite ? "on" : "") + '" data-action="favorite" title="Favorite">★</button>' +
        '</div>';
    } else {
      mediaArea = '<div class="waveform-area fxlib-thumb">' +
        generatePseudoWaveform(item.name) +
        '<button class="card-favorite ' + (item.favorite ? "on" : "") + '" data-action="favorite" title="Favorite">★</button>' +
        '<div class="hover-overlay">' +
        '<div class="play-circle">' + (isPlaying && item.id === selectedId ? "❚❚" : "▶") + '</div>' +
        '<span>' + (isPlaying && item.id === selectedId ? "Stop" : "Preview") + '</span>' +
        '</div>' +
        '</div>';
    }

    const durationText = item.duration != null ? fmtTime(item.duration) : "—";
    const subText = missingAssetIds.has(item.id)
      ? "Missing file"
      : (isPreset
        ? ((item.filterCount || 1) + " effect" + ((item.filterCount || 1) === 1 ? "" : "s"))
        : (item.type === "mogrt" ? "MOGRT Template" : "WAV · " + durationText));

    card.innerHTML = colorStrip + mediaArea +
      '<div class="meta-area fxlib-cardmeta">' +
      '<strong class="meta-title" title="' + escapeHtml(item.name) + '">' + escapeHtml(item.name) + '</strong>' +
      '<span class="meta-sub">' + subText + '</span>' +
      '</div>' +
      '<button class="fxlib-apply" data-action="insert" title="' + (isPreset ? "Apply preset to selected clips" : "Apply — insert at the playhead") + '">Apply</button>';

    // Click events inside cards
    card.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button");
      const action = btn ? btn.dataset.action : null;

      if (action === "favorite") {
        ev.stopPropagation();
        item.favorite = !item.favorite;
        saveLibrary();
        render();
        return;
      }

      if (ev.ctrlKey || ev.metaKey) {
        ev.preventDefault();
        ev.stopPropagation();
        toggleBatchSelect(item.id);
        return;
      }

      if (action === "collection") {
        ev.stopPropagation();
        promptAddToCollection([item]);
        return;
      }

      if (action === "insert") {
        ev.stopPropagation();
        selectItem(item.id);
        insertToTimeline();
        return;
      }

      if (ev.target.closest(".play-circle") || ev.target.closest(".hover-overlay")) {
        ev.stopPropagation();
        playOrStop(item.id);
        return;
      }

      if (isGraphic || isPreset) {
        selectItem(item.id);
        insertToTimeline();
      } else {
        playOrStop(item.id);
      }
    });

    if (isGraphic) {
      card.addEventListener("mouseenter", () => startCardHoverPreview(card, item));
      card.addEventListener("mouseleave", () => stopCardHoverPreview(card, item));
    }

    if (!isPreset) {
      card.addEventListener("dragstart", (ev) => {
        card.classList.add("dragging");
        const fileUrlRaw = libraryFileUrl(item.path, false);
        const fileUrlEncoded = libraryFileUrl(item.path, true);
        const mime = isGraphic ? "application/octet-stream" : "audio/" + path.extname(item.path).slice(1);
        ev.dataTransfer.setData("com.adobe.cep.dnd.file.0", item.path);
        ev.dataTransfer.setData("DownloadURL", mime + ":" + path.basename(item.path) + ":" + fileUrlEncoded);
        ev.dataTransfer.setData("text/uri-list", fileUrlRaw);
        ev.dataTransfer.setData("text/plain", item.path);
        ev.dataTransfer.effectAllowed = "copy";
      });
      card.addEventListener("dragend", () => card.classList.remove("dragging"));
    }

    return card;
  }

  function toggleBatchSelect(id) {
    if (batchSelected.has(id)) batchSelected.delete(id);
    else batchSelected.add(id);
    render();
  }

  function cycleColor(sfx) {
    const idx = sfx.color ? COLORS.indexOf(sfx.color) : -1;
    sfx.color = idx >= COLORS.length - 1 ? null : COLORS[idx + 1];
    saveLibrary();
    render();
  }

  async function promptAddToCollection(sfxList) {
    const existing = getAllCollections();
    const hint = existing.length ? "Existing: " + existing.join(", ") : "";
    const input = await showModal({
      title: "Add to Collection",
      message: "Comma-separated — new collections are created automatically." + (hint ? "\n" + hint : ""),
      input: true,
      placeholder: "e.g. Whoosh, Impacts",
      okText: "Add",
    });
    if (!input) return;
    const names = input
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (names.length === 0) return;
    sfxList.forEach((sfx) => {
      names.forEach((n) => {
        if (!sfx.collections.includes(n)) sfx.collections.push(n);
      });
    });
    saveLibrary();
    render();
    showToast("Added " + sfxList.length + " sound" + (sfxList.length > 1 ? "s" : "") + " to " + names.join(", "));
  }

  function updateAnimatedMeters() {
    if (!isPlaying) return;
    document.querySelectorAll(".sfx-row.playing .meter i").forEach((bar) => {
      bar.style.height = 20 + Math.random() * 80 + "%";
    });
  }
  setInterval(updateAnimatedMeters, 110);

  // ---------------- Selection & audio engine ----------------

  function getAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  function selectItem(id) {
    if (currentSource && selectedId !== id) stopPlayback();
    selectedId = id;
    const item = library.find((s) => s.id === id);
    // modules/sfx-design.js opens the sound-design drawer off this.
    try {
      document.dispatchEvent(new CustomEvent("compx:sfx-selected", {
        detail: item ? { id: item.id, name: item.name, path: item.path, type: item.type, duration: item.duration } : null
      }));
    } catch (_) {}
    el.nowPlaying.innerHTML = '<span class="label">Selected:</span> ' + escapeHtml(item ? item.name : "—");
    if (el.btnFavorite) el.btnFavorite.textContent = item && item.favorite ? "★ Favorited" : "☆ Favorite";
    if (item) {
      el.tagEditorRow.style.display = "flex";
      el.tagEditor.value = item.tags.join(", ");
    } else {
      el.tagEditorRow.style.display = "none";
    }

    // Card thumbnails/hover-previews load lazily via ensureThumbnail() in
    // renderCard() — no separate big preview panel needed anymore.
    if (!item || !isGraphicType(item.type)) {
      // Waveform removed from UI — just decode to get duration if unknown
      if (item) loadWaveform(item);
    }

    render();
  }

  async function loadWaveform(sfx) {
    // Waveform canvas removed from UI. Only decode to capture duration.
    if (sfx.duration != null) return; // already known — skip decode
    try {
      const data = await fs.promises.readFile(sfx.path);
      const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      getAudioCtx().decodeAudioData(
        arrayBuffer,
        (buffer) => {
          if (sfx.duration == null) {
            sfx.duration = buffer.duration;
            saveLibrary();
            render();
          }
        },
        () => recordDiagnostic("warn", "AUDIO_DURATION_DECODE", "Could not decode audio duration", sfx.name, "skipped")
      );
    } catch (e) {
      recordDiagnostic("warn", "AUDIO_DURATION_READ", "Could not read audio for duration", e.message || e, "skipped");
    }
  }

  // drawWaveform is a no-op — canvas element removed from the panel UI.
  function drawWaveform(buffer) {}

  async function playSelected() {
    const sfx = library.find((s) => s.id === selectedId);
    if (!sfx) {
      showToast("Select a sound first", true);
      return;
    }
    if (isGraphicType(sfx.type)) {
      showToast("Hover the card to preview — drag onto the timeline to insert it", true);
      return;
    }
    try {
      const requestedId = sfx.id;
      const data = await fs.promises.readFile(sfx.path);
      if (selectedId !== requestedId) return;
      const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      const ctx = getAudioCtx();
      ctx.decodeAudioData(
        arrayBuffer,
        (buffer) => {
          stopPlayback();
          currentBuffer = buffer;
          if (sfx.duration == null) {
            sfx.duration = buffer.duration;
            saveLibrary();
          }
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          applyPitch(source);
          const gain = ctx.createGain();
          gain.gain.value = previewVolume;
          source.connect(gain).connect(ctx.destination);
          source.onended = () => {
            if (currentSource === source) {
              isPlaying = false;
              currentSource = null;
              render();
            }
          };
          source.start(0);
          currentSource = source;
          currentGain = gain;
          isPlaying = true;
          playStartedAt = ctx.currentTime;
          sfx.lastPlayedAt = Date.now();
          saveLibrary();
          // drawWaveform removed — canvas no longer in DOM
          render();
        },
        () => reportError("AUDIO_DECODE", "decodeAudioData failed", "Could not decode " + sfx.name)
      );
    } catch (e) {
      reportError("AUDIO_READ", e, "Could not read file: " + sfx.name);
    }
  }

  function applyPitch(source) {
    // Pitch-only control via detune (no speed control per the current design —
    // click-to-play always plays back at natural speed, pitch-shifted).
    const pitchSemis = parseFloat(el.pitch.value);
    source.detune.value = pitchSemis * 100;
  }

  function parseYesNo(input, defaultYes) {
    const raw = String(input == null ? "" : input).trim().toLowerCase();
    if (!raw) return !!defaultYes;
    return raw === "y" || raw === "yes" || raw === "1" || raw === "true";
  }

  function stopPlayback() {
    if (currentSource) {
      try {
        currentSource.onended = null;
        currentSource.stop();
      } catch (e) { auditFallback("MAIN_STOPPLAYBACK_001", e); }
      currentSource = null;
    }
    isPlaying = false;
    render();
  }

  function togglePlay() {
    if (isPlaying) {
      stopPlayback();
    } else {
      playSelected();
    }
  }

  function playOrStop(id) {
    // Click-to-play: clicking the currently-playing row stops it; clicking any
    // other row selects it and starts playback immediately.
    if (isPlaying && selectedId === id) {
      stopPlayback();
      return;
    }
    selectItem(id);
    playSelected();
  }

  function stepSelection(delta) {
    const filtered = getFiltered();
    if (filtered.length === 0) return;
    const idx = filtered.findIndex((s) => s.id === selectedId);
    let next;
    if (idx === -1) next = delta > 0 ? 0 : filtered.length - 1;
    else next = (idx + delta + filtered.length) % filtered.length;
    selectItem(filtered[next].id);
  }

  // ---------------- Timeline insert (Premiere / AE) ----------------

  function applyPrfpsetPayload(payload, itemName) {
    const finish = (parsed) => {
      if (parsed && parsed.success) {
        showToast(parsed.message || ("Applied “" + itemName + "”"));
        recordDiagnostic("info", "PRFPSET_APPLY", "Effect preset applied", itemName, "applied");
      } else {
        showToast((parsed && (parsed.error || parsed.message)) || "Preset apply failed", true);
        recordDiagnostic("error", "PRFPSET_APPLY_FAILED", "Effect preset apply failed", (parsed && (parsed.error || parsed.message)) || itemName, "failed");
      }
    };
    // Prefer a temp file so large Finzar/RR packs are not truncated by evalScript.
    if (nodeAvailable && fs && os) {
      try {
        const tmp = path.join(os.tmpdir(), "compx-orbit-prfpset-apply.json");
        fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
        callHost("pproApplyPrfpsetFromFile(" + hostArg(tmp) + ")", finish, 60000);
        return;
      } catch (e) {
        auditFallback("MAIN_APPLYPRFPSET_FILE_001", e);
      }
    }
    callHost("pproApplyPrfpset(" + hostArg(JSON.stringify(payload)) + ")", finish, 60000);
  }

  async function insertToTimeline() {
    const item = library.find((s) => s.id === selectedId);
    if (!item) {
      showToast("Select a " + assetNoun(assetType) + " first", true);
      return;
    }

    if (isPresetType(item.type)) {
      if (!window.PrfpsetCatalog || typeof window.PrfpsetCatalog.getApplyPayload !== "function") {
        showToast("Preset catalog unavailable", true);
        return;
      }
      const payload = window.PrfpsetCatalog.getApplyPayload(item.path, item.name);
      if (!payload) {
        showToast("Could not read that preset from disk", true);
        return;
      }
      item.lastPlayedAt = Date.now();
      saveLibrary();
      showToast("Applying “" + item.name + "”…");
      applyPrfpsetPayload(payload, item.name);
      return;
    }

    const safePath = hostArg(item.path);
    const pitchSemis = parseFloat(el.pitch.value) || 0;
    const volumePercent = Math.max(0, Math.min(200, parseInt((el.volume && el.volume.value) || "100", 10) || 100));
    let script;
    let trackedMogrtImport = false;
    if (isGraphicType(item.type) && currentHostAppId() === "AEFT") {
      if (mogrtImportInProgress.has(item.id)) {
        showToast("This MOGRT is already being prepared", true);
        recordDiagnostic("warn", "MOGRT_DUPLICATE_IMPORT", "Duplicate MOGRT import request skipped", item.name, "skipped");
        return;
      }
      mogrtImportInProgress.add(item.id);
      trackedMogrtImport = true;
      showToast("Preparing MOGRT cache…");
      const ex = await safeExtractMogrtAeProject(item.path);
      if (ex && ex.aepPath) {
        script = "aeft_importMogrtProject(" + hostArg(ex.aepPath) + ", " + hostArg(ex.compName || "") + ", true)";
      } else {
        script = "aeft_revealMogrt(" + safePath + ")";
      }
    } else {
      const fn = isGraphicType(item.type) ? "importMogrt" : "importSfx";
      script = isGraphicType(item.type)
        ? fn + "(" + safePath + ", true)"
        : fn + "(" + safePath + ", true, " + pitchSemis + ", " + volumePercent + ")";
    }
    callHost(script, (parsed) => {
      if (trackedMogrtImport) mogrtImportInProgress.delete(item.id);
      if (parsed.success && parsed.inserted) {
        var adjustments = [];
        if (pitchSemis !== 0) adjustments.push("pitch: " + (pitchSemis > 0 ? "+" : "") + pitchSemis + " st");
        if (!isGraphicType(item.type) && volumePercent !== 100) adjustments.push("volume: " + volumePercent + "%");
        var suffix = adjustments.length ? " (" + adjustments.join(" · ") + ")" : "";
        showToast(parsed.warning || ("Inserted “" + item.name + "” on the timeline" + suffix), !!parsed.warning);
        recordDiagnostic("info", "TIMELINE_INSERT", "Asset inserted on timeline", item.name, "applied");
      } else if (parsed.success && !parsed.inserted) {
        showToast(parsed.warning || "Imported to project (no active sequence to insert into)", true);
        recordDiagnostic("warn", "PROJECT_IMPORT_ONLY", "Asset imported without timeline insertion", parsed.warning || item.name, "skipped");
      } else {
        showToast(parsed.error || parsed.message || "Insert failed", true);
        recordDiagnostic("error", "TIMELINE_INSERT_FAILED", "Timeline insertion failed", parsed.error || parsed.message, "failed");
      }
    });
  }

  function detectHost() {
    try {
      const info = csInterface.getHostEnvironment();
      el.hostHint.textContent = "Connected to " + (info && info.appName ? info.appName : "host");
    } catch (e) {
      el.hostHint.textContent = "Standalone preview (no Premiere/AE detected)";
    }
  }

  // ---------------- Wiring ----------------

  el.assetTypeRow.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".shelf");
    if (!btn) return;
    // Premiere's rail router already selected the view in capture phase.
    // Do not let this legacy asset handler turn Doctor into a library type.
    if (window.OrbitRailRouter) {
      if (btn.dataset.type === "library") renderAssetTypeRow();
      return;
    }

    el.assetTypeRow.querySelectorAll(".shelf").forEach((b) => b.classList.toggle("active", b === btn));
    try { localStorage.setItem("compXLibraryShelf", btn.dataset.type || "sfx"); } catch (e) { auditFallback("MAIN_DETECTHOST_001", e); }

    const sfxMogrtView = document.getElementById("sfxMogrtView");
    const ffxView = document.getElementById("ffxPresetView");
    const tanimView = document.getElementById("textAnimView");
    const shakeView = document.getElementById("shakeView");
    const expressionView = document.getElementById("expressionView");
    const scView = document.getElementById("silenceCutterView");
    const acView = document.getElementById("autoCaptionsView");
    const m3dView = document.getElementById("motion3dView");
    const motionView = document.getElementById("motionView");
    const beatView = document.getElementById("beatView");
    const audioView = document.getElementById("audioView");
    const composerView = document.getElementById("composerToolsView");
    [sfxMogrtView, ffxView, tanimView, shakeView, expressionView, scView, acView, m3dView, motionView, beatView, audioView, composerView].forEach((v) => { if (v) v.style.display = "none"; });
    if (btn.dataset.type === "silence") { if (scView) scView.style.display = "block"; return; }
    if (btn.dataset.type === "captions") { if (acView) acView.style.display = "block"; return; }
    if (btn.dataset.type === "motion3d") { if (m3dView) m3dView.style.display = "block"; return; }
    if (btn.dataset.type === "motion") { if (motionView) motionView.style.display = "block"; return; }
    if (btn.dataset.type === "beat") { if (beatView) beatView.style.display = "block"; return; }
    if (btn.dataset.type === "audio") { if (audioView) audioView.style.display = "block"; return; }
    if (btn.dataset.type === "composer") {
      if (sfxMogrtView) sfxMogrtView.style.display = "";
      renderAssetTypeRow();
      try { localStorage.setItem("compXLibraryShelf", "library"); } catch (e) {}
      return;
    }
    if (btn.dataset.type === "library") {
      if (sfxMogrtView) sfxMogrtView.style.display = "";
      renderAssetTypeRow();
      try { localStorage.setItem("compXLibraryShelf", "library"); } catch (e) {}
      return;
    }
    if (btn.dataset.type === "ffx") { if (ffxView) ffxView.style.display = "block"; return; }
    if (btn.dataset.type === "textanim") { if (tanimView) tanimView.style.display = "block"; return; }
    if (btn.dataset.type === "shake") { if (shakeView) shakeView.style.display = "block"; return; }
    if (btn.dataset.type === "expressions") { if (expressionView) expressionView.style.display = "block"; return; }
    if (sfxMogrtView) sfxMogrtView.style.display = "";
    if (btn.dataset.type === assetType) return; // already on this shelf

    if (currentSource) stopPlayback();
    assetType = btn.dataset.type;
    selectedId = null;
    filterText = "";
    selectedFolder = "";
    el.breadcrumb.textContent = "All";
    el.search.value = "";
    currentView = "all";
    activeCollection = null;
    batchMode = false;
    batchSelected.clear();
    el.tagEditorRow.style.display = "none";
    el.nowPlaying.innerHTML = '<span class="label">Selected:</span> —';
    render();
  });

  var libraryTypeTabs = document.getElementById("libraryTypeTabs");
  if (libraryTypeTabs) libraryTypeTabs.addEventListener("click", (ev) => {
    const button = ev.target.closest("[data-library-type]");
    if (!button) return;
    const nextType = button.dataset.libraryType;
    if (nextType !== "sfx" && nextType !== "mogrt") return;
    if (currentSource) stopPlayback();
    assetType = nextType;
    selectedId = null; filterText = ""; selectedFolder = ""; currentView = "all";
    activeCollection = null; batchMode = false; batchSelected.clear();
    el.breadcrumb.textContent = "All"; el.search.value = "";
    render();
    try { localStorage.setItem("compXLibraryShelf", "library"); } catch (e) {}
    try { localStorage.setItem("compXLibraryType", nextType); } catch (e) {}
  });

  document.addEventListener("compx:library-type-request", (ev) => {
    try {
      let nextType = ev && ev.detail && ev.detail.type;
      if (nextType === "prfpset") nextType = "sfx";
      if (nextType === "sfx" || nextType === "mogrt") {
        assetType = nextType;
        render();
      }
    } catch (e) { auditFallback("MAIN_LIBRARY_TYPE_REQUEST_001", e); }
  });

  el.search.addEventListener("input", () => {
    filterText = el.search.value;
    render();
  });

  el.btnAddFiles.addEventListener("click", () => el.fileInputFiles.click());

  function applyCardSize(px, grid) {
    const libraryGrid = grid || document.getElementById("library");
    if (!libraryGrid) return;
    const size = Math.max(90, Math.min(220, Number(px) || 130));
    libraryGrid.style.setProperty("--card-min-w", size + "px");
    const val = document.getElementById("cardSizeVal");
    if (val) val.textContent = String(size);
    const slider = document.getElementById("cardSizeSlider");
    if (slider && slider.value !== String(size)) slider.value = String(size);
  }

  (function wireLibToolbarTips() {
    const root = document.getElementById("sfxMogrtView");
    const tipEl = document.getElementById("libTooltip");
    if (!root || !tipEl) return;
    let hideTimer = null;
    function hideTip() {
      tipEl.hidden = true;
      tipEl.textContent = "";
    }
    function placeTip(target) {
      const text = target.getAttribute("data-lib-tip");
      if (!text) return hideTip();
      tipEl.textContent = text;
      tipEl.hidden = false;
      const rect = target.getBoundingClientRect();
      const tipRect = tipEl.getBoundingClientRect();
      let left = rect.left + rect.width / 2 - tipRect.width / 2;
      let top = rect.top - tipRect.height - 8;
      left = Math.max(6, Math.min(left, window.innerWidth - tipRect.width - 6));
      if (top < 4) top = rect.bottom + 8;
      tipEl.style.left = left + "px";
      tipEl.style.top = top + "px";
    }
    root.querySelectorAll(".lib-toolbar [data-lib-tip]").forEach((el) => {
      el.removeAttribute("title");
      el.addEventListener("mouseenter", () => {
        clearTimeout(hideTimer);
        placeTip(el);
      });
      el.addEventListener("mouseleave", () => {
        hideTimer = setTimeout(hideTip, 40);
      });
      el.addEventListener("focus", () => placeTip(el));
      el.addEventListener("blur", hideTip);
    });
  })();

  (function wireCardSizeSlider() {
    const slider = document.getElementById("cardSizeSlider");
    const libraryGrid = document.getElementById("library");
    if (!slider || !libraryGrid) return;
    const saved = parseInt(localStorage.getItem("ccCardSize") || "130", 10);
    const initial = isNaN(saved) ? 130 : Math.max(90, Math.min(220, saved));
    applyCardSize(initial, libraryGrid);
    let rafPending = false;
    slider.addEventListener("input", () => {
      if (rafPending) return;
      rafPending = true;
      libraryGrid.classList.add("resizing");
      requestAnimationFrame(() => {
        applyCardSize(slider.value, libraryGrid);
        rafPending = false;
      });
    });
    slider.addEventListener("change", () => {
      applyCardSize(slider.value, libraryGrid);
      libraryGrid.classList.remove("resizing");
      try { localStorage.setItem("ccCardSize", slider.value); } catch (e) { auditFallback("MAIN_WIRECARDSIZESLIDER_001", e); }
    });
  })();
  el.fileInputFolder.setAttribute("webkitdirectory", "");

  el.btnAddFolder.addEventListener("click", () => el.fileInputFolder.click());
  if (el.btnBackupLibrary) el.btnBackupLibrary.addEventListener("click", exportLibraryBackup);
  if (el.btnRestoreLibrary) el.btnRestoreLibrary.addEventListener("click", () => el.fileInputLibraryBackup.click());
  if (el.btnCheckMissing) el.btnCheckMissing.addEventListener("click", () => detectMissingFiles(true));
  if (el.btnRelinkLibrary) el.btnRelinkLibrary.addEventListener("click", () => el.fileInputRelinkFolder.click());
  if (el.btnClearMogrtCache) el.btnClearMogrtCache.addEventListener("click", clearUnusedMogrtCache);
  if (el.btnCopyDiagnostics) el.btnCopyDiagnostics.addEventListener("click", copyDiagnosticReport);

  if (el.fileInputLibraryBackup) el.fileInputLibraryBackup.addEventListener("change", (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (file && file.path) restoreLibraryBackup(file.path);
    ev.target.value = "";
  });

  if (el.fileInputRelinkFolder) el.fileInputRelinkFolder.addEventListener("change", (ev) => {
    relinkLibraryFromFiles(ev.target.files);
    ev.target.value = "";
  });

  el.fileInputFiles.addEventListener("change", (ev) => {
    const paths = Array.from(ev.target.files)
      .map((f) => f.path)
      .filter(Boolean);
    addFilePaths(paths);
    ev.target.value = "";
  });

  el.fileInputFolder.addEventListener("change", (ev) => {
    const paths = Array.from(ev.target.files)
      .map((f) => f.path)
      .filter(Boolean);
    addFilePaths(paths);
    ev.target.value = "";
  });

  el.pitch.addEventListener("input", () => {
    el.pitchVal.textContent = (el.pitch.value > 0 ? "+" : "") + el.pitch.value + " st";
    if (currentSource) currentSource.detune.value = parseFloat(el.pitch.value) * 100;
  });

  if (el.volume) {
    const savedVol = parseInt(localStorage.getItem("ccPreviewVolume") || "100", 10);
    const initialVol = isNaN(savedVol) ? 100 : Math.max(0, Math.min(200, savedVol));
    el.volume.value = String(initialVol);
    previewVolume = initialVol / 100;
    if (el.volumeVal) el.volumeVal.textContent = initialVol + "%";

    el.volume.addEventListener("input", () => {
      const v = Math.max(0, Math.min(200, parseInt(el.volume.value, 10) || 100));
      previewVolume = v / 100;
      if (el.volumeVal) el.volumeVal.textContent = v + "%";
      if (currentGain) currentGain.gain.value = previewVolume;
      try { localStorage.setItem("ccPreviewVolume", String(v)); } catch (e) { auditFallback("MAIN_WIRECARDSIZESLIDER_002", e); }
    });
  }

  if (el.btnFavorite) {
    el.btnFavorite.addEventListener("click", () => {
      const sfx = library.find((s) => s.id === selectedId);
      if (!sfx) return;
      sfx.favorite = !sfx.favorite;
      saveLibrary();
      el.btnFavorite.textContent = sfx.favorite ? "★ Favorited" : "☆ Favorite";
      render();
    });
  }

  if (el.btnInsert) el.btnInsert.addEventListener("click", insertToTimeline);

  // Volume + Pitch live in the bottom deck as always-visible sliders.
  // Legacy mixer popover toggles were removed from the Library toolbar.

  el.tabsRow.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".tab");
    if (!btn) return;
    currentView = btn.dataset.view;
    if (currentView !== "collections") activeCollection = null;
    render();
  });

  el.collectionsRow.addEventListener("click", (ev) => {
    const chip = ev.target.closest(".chip");
    if (!chip) return;
    const name = chip.dataset.collection;
    activeCollection = activeCollection === name ? null : name;
    render();
  });

  el.tagEditor.addEventListener("change", () => {
    const sfx = library.find((s) => s.id === selectedId);
    if (!sfx) return;
    sfx.tags = el.tagEditor.value
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    saveLibrary();
  });

  if (el.btnBatchMode) el.btnBatchMode.addEventListener("click", () => {
    batchMode = !batchMode;
    batchSelected.clear();
    el.btnBatchMode.classList.toggle("primary", batchMode);
    el.btnBatchMode.textContent = batchMode ? "×" : "✓";
    render();
  });

  el.btnReset.addEventListener("click", async () => {
    const ok = await showModal({
      title: "Reset Asset Library?",
      message: "This permanently removes every sound and MOGRT you've added, along with favorites, tags, colors, and collections. This cannot be undone.",
      okText: "Reset",
      cancelText: "Cancel",
      danger: true,
    });
    if (!ok) return;

    if (currentSource) stopPlayback();
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { auditFallback("MAIN_WIRECARDSIZESLIDER_003", e); }
    try { localStorage.removeItem(PRFPSET_DEFAULTS_FLAG); } catch (e) {}

    // Reset all in-memory state back to first-run defaults.
    library = [];
    assetType = "sfx";
    filterText = "";
    selectedId = null;
    currentView = "all";
    activeCollection = null;
    batchMode = false;
    batchSelected.clear();
    selectedFolder = "";
    viewMode = "grid";
    sortBy = "name";
    sidebarCollapsed = false;
    try { localStorage.setItem("compXLibraryFolders", "on"); } catch (e) {}

    el.search.value = "";
    el.sortBy.value = "name";
    el.breadcrumb.textContent = "All";
    el.tagEditorRow.style.display = "none";
    el.nowPlaying.innerHTML = '<span class="label">Selected:</span> —';
    if (el.btnBatchMode) {
      el.btnBatchMode.classList.remove("primary");
      el.btnBatchMode.textContent = "✓";
    }
    el.sidebar.classList.remove("collapsed");
    syncFolderToggle();

    const purged = ensureDefaultPrfpsets();
    saveLibrary();
    showToast(purged > 0 ? ("Library reset · removed " + purged + " presets") : "Library reset to default");
    render();
  });

  el.batchColor.addEventListener("click", () => {
    if (batchSelected.size === 0) return showToast("Select some " + assetNoun(assetType) + "s first", true);
    const items = library.filter((s) => batchSelected.has(s.id));
    items.forEach((sfx) => cycleColor(sfx));
  });

  el.batchCollection.addEventListener("click", () => {
    if (batchSelected.size === 0) return showToast("Select some " + assetNoun(assetType) + "s first", true);
    const items = library.filter((s) => batchSelected.has(s.id));
    promptAddToCollection(items);
  });

  async function removeSelectedAssets() {
    if (batchSelected.size === 0) return showToast("Select assets first (Ctrl+click)", true);
    const ok = await showModal({
      title: "Remove Items?",
      message: "Remove " + batchSelected.size + " item(s) from the library? This cannot be undone.",
      okText: "Remove",
      cancelText: "Cancel",
      danger: true,
    });
    if (!ok) return;
    if (currentSource && batchSelected.has(selectedId)) stopPlayback();
    library = library.filter((s) => !batchSelected.has(s.id));
    if (batchSelected.has(selectedId)) selectedId = null;
    batchSelected.clear();
    saveLibrary();
    render();
  }

  el.batchDelete.addEventListener("click", removeSelectedAssets);
  if (el.btnRemoveSelected) el.btnRemoveSelected.addEventListener("click", removeSelectedAssets);

  var btnRemoveMarkedSfx = document.getElementById("btnRemoveMarkedSfx");
  if (btnRemoveMarkedSfx) btnRemoveMarkedSfx.addEventListener("click", async function () {
    var marked = library.filter(function (s) { return s.type === assetType && s.favorite; });
    if (!marked.length) return showToast("No favorites marked", true);
    var ok = await showModal({
      title: "Remove Favorites?",
      message: "Remove " + marked.length + " favorite item(s) from the library?",
      okText: "Remove",
      cancelText: "Cancel",
      danger: true
    });
    if (!ok) return;
    var ids = {};
    marked.forEach(function (s) { ids[s.id] = true; });
    if (currentSource && ids[selectedId]) stopPlayback();
    library = library.filter(function (s) { return !ids[s.id]; });
    if (ids[selectedId]) selectedId = null;
    saveLibrary();
    render();
  });

  // Folder tree interactions
  el.folderTree.addEventListener("click", (ev) => {
    const row = ev.target.closest(".folder-row");
    if (!row) return;
    const folder = row.dataset.folder;
    
    // Toggle collapse if caret clicked
    const caret = ev.target.closest(".folder-caret");
    if (caret && caret.textContent !== "") {
      const node = row.closest(".folder-node");
      if (node) {
        const isCollapsed = node.classList.toggle("collapsed");
        if (isCollapsed) {
          collapsedFolders.add(folder);
          caret.textContent = ">";
        } else {
          collapsedFolders.delete(folder);
          caret.textContent = "v";
        }
        return;
      }
    }
    
    if (folder === "__favorites__") {
      currentView = "favorites";
      selectedFolder = "";
      el.breadcrumb.textContent = "Favorites";
      render();
      return;
    }

    currentView = "all";
    selectedFolder = folder;
    el.breadcrumb.textContent = selectedFolder ? selectedFolder.replace(/\//g, " / ") : "All";
    render();
  });

  function toggleFolderSidebar() {
    setFolderSidebar(!sidebarCollapsed);
  }
  if (el.btnCollapse) el.btnCollapse.addEventListener("click", toggleFolderSidebar);
  if (el.btnFolderView) el.btnFolderView.addEventListener("click", toggleFolderSidebar);
  syncFolderToggle();

  // Sorting
  el.sortBy.addEventListener("change", () => {
    sortBy = el.sortBy.value;
    render();
  });

  // View modes (buttons are optional — not every layout includes them)
  if (el.btnGridView) {
    el.btnGridView.addEventListener("click", () => {
      viewMode = "grid";
      el.btnGridView.classList.add("active");
      if (el.btnListView) el.btnListView.classList.remove("active");
      render();
    });
  }

  if (el.btnListView) {
    el.btnListView.addEventListener("click", () => {
      viewMode = "list";
      if (el.btnGridView) el.btnGridView.classList.remove("active");
      el.btnListView.classList.add("active");
      render();
    });
  }

  document.addEventListener("keydown", (ev) => {
    const target = ev.target;
    const tag = (target && target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || (target && target.isContentEditable)) return; // never hijack typing/editing controls
    if (ev.code === "Space") {
      ev.preventDefault();
      togglePlay();
    } else if (ev.code === "ArrowDown") {
      ev.preventDefault();
      stepSelection(1);
    } else if (ev.code === "ArrowUp") {
      ev.preventDefault();
      stepSelection(-1);
    } else if (ev.code === "Enter") {
      ev.preventDefault();
      playSelected();
    }
  });

  // ---------------- AE Tools tab ----------------

  const toolsHint = document.getElementById("toolsHint");

  const HOST_CALL_TIMEOUT_MS = 120000;

  function hostArg(value) {
    // JSON string literals safely preserve quotes, slashes, newlines and
    // Unicode separators when values cross the CEP -> ExtendScript bridge.
    return JSON.stringify(value == null ? "" : String(value))
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
  }

  function parseHostResult(result) {
    const raw = String(result == null ? "" : result);
    if (!raw || raw === "undefined" || raw === "EvalScript error.") {
      return { success: false, message: raw === "EvalScript error." ? "Adobe host script failed" : "Adobe host returned no response" };
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        return { success: false, message: "Adobe host returned an invalid result" };
      }
      return parsed;
    } catch (e) {
      return { success: false, message: "Adobe host response could not be parsed", detail: raw.slice(0, 500) };
    }
  }

  function callHostRaw(script, callback, timeoutMs) {
    let settled = false;
    const finish = (raw) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(String(raw == null ? "" : raw));
    };
    const timer = setTimeout(() => {
      recordDiagnostic("error", "HOST_TIMEOUT", "Adobe host action timed out", String(script).split("(")[0]);
      finish("ERR: Adobe host timed out while running this action");
    }, timeoutMs || HOST_CALL_TIMEOUT_MS);
    try {
      csInterface.evalScript(script, finish);
    } catch (e) {
      recordDiagnostic("error", "HOST_CONTACT", "Could not contact Adobe host", e.message || e);
      finish("ERR: Could not contact the Adobe host");
    }
  }

  function callHost(script, callback, timeoutMs) {
    callHostRaw(script, (raw) => callback(parseHostResult(raw)), timeoutMs);
  }

  function runTool(script, okMsg, onResult) {
    callHost(script, (parsed) => {
      const actionName = String(script || "").split("(")[0].slice(0, 80);
      if (parsed.success) {
        showToast(parsed.message || okMsg || "Done");
        recordDiagnostic("info", "HOST_ACTION", parsed.message || okMsg || "Host action completed", actionName, "applied");
      } else {
        showToast(parsed.message || "Action failed", true);
        recordDiagnostic("error", "HOST_ACTION_FAILED", parsed.message || "Host action failed", actionName + (parsed.detail ? " · " + parsed.detail : ""), "failed");
        try { console.error("CompX host action failed:", script.slice(0, 160), parsed.detail || parsed.message); } catch (consoleError) { auditFallback("MAIN_RUNTOOL_001", consoleError); }
      }
      if (onResult) onResult(parsed);
    });
  }

  // Shared by feature modules loaded after main.js. JSON-returning host APIs
  // use call(); legacy text protocols (Graph/Pasta path) use callRaw().
  window.CompXHostBridge = Object.freeze({
    call: callHost,
    callRaw: callHostRaw,
    arg: hostArg,
  });

  function wireAppTabs() {
    const row = document.getElementById("appTabsRow");
    if (!row) return;
    const activate = (target, persist) => {
      const btn = row.querySelector('[data-apptab="' + target + '"]');
      const panel = document.getElementById("panel-" + target);
      if (!btn || !panel) return false;
      row.querySelectorAll(".app-tab").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".app-panel").forEach((p) => p.classList.toggle("active", p === panel));
      if (persist !== false) { try { localStorage.setItem("compXActiveTab", target); } catch (e) { auditFallback("MAIN_WIREAPPTABS_001", e); } }
      return true;
    };
    row.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".app-tab");
      if (btn) activate(btn.dataset.apptab, true);
    });
    let saved = "tools";
    try { saved = localStorage.getItem("compXActiveTab") || "tools"; } catch (e) { auditFallback("MAIN_WIREAPPTABS_002", e); }
    if (!activate(saved, false)) activate("tools", false);
  }

  function wireToolButtons() {
    document.querySelectorAll(".tool-btn[data-tool]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tool = btn.dataset.tool;
        const arg = btn.dataset.arg;
        switch (tool) {
          case "align":
            runTool('ae_align("' + arg + '")', "Aligned");
            break;
          case "anchor":
            runTool('ae_setAnchor("' + arg + '")', "Anchor set");
            break;
          case "precompose":
            runTool("ae_precompose(" + arg + ")", "Precomposed");
            break;
          case "precomposeSeparate":
            runTool("ae_precomposeSeparate()", "Precomposed separately");
            break;
          case "unprecompose":
            runTool("ae_unprecompose()", "Unprecomposed");
            break;
          case "createLayer": {
            const matchChk = document.getElementById("chkMatchLayerDuration");
            const matchDur = !!(matchChk && matchChk.checked);
            runTool('ae_createLayer("' + arg + '", ' + (matchDur ? "true" : "false") + ')', "Layer created");
            break;
          }
          case "fitToComp":
            runTool("ae_fitToComp()", "Fit to comp");
            break;
          case "trueDuplicate":
            runTool("ae_trueDuplicate()", "Duplicated");
            break;
          case "sequenceLayers":
            runTool("ae_sequenceLayers(0)", "Sequenced");
            break;
          case "freezeFrame":
            runTool("ae_freezeFrame()", "Frame frozen");
            break;
          case "bounce":
            (async function () {
              const params = await showModal({
                title: "Bounce Settings",
                message: "Amplitude, Frequency, Decay (e.g. 0.06, 3.0, 6.0):",
                input: true,
                defaultValue: "0.06, 3.0, 6.0",
                placeholder: "0.06, 3.0, 6.0",
                okText: "Next",
              });
              if (params === null) return;
              const parts = String(params || "0.06, 3.0, 6.0").split(/[,\s]+/);
              const amp = parseFloat(parts[0]) || 0.06;
              const freq = parseFloat(parts[1]) || 3.0;
              const decay = parseFloat(parts[2]) || 6.0;
              const target = await showModal({
                title: "Bounce Target",
                message: "Property: auto / scale / position / rotation / opacity",
                input: true,
                defaultValue: "auto",
                placeholder: "auto",
                okText: "Apply",
              });
              if (target === null) return;
              const payload = JSON.stringify({ amp, freq, decay, target: target || "auto" })
                .replace(/\\/g, "\\\\").replace(/"/g, '\\"');
              runTool('ae_addBounce("' + payload + '")', "Bounce added");
            
  })();
            break;
          case "effect":
            runTool('ae_applyEffect("' + arg + '", "' + btn.textContent.trim() + '")', "Effect applied");
            break;
          case "createShape":
            runTool("ae_createShapeLayer()", "Shape layer created");
            break;
          case "capitalize":
            runTool("ae_capitalizeText()", "Text capitalized");
            break;
          case "trimOut":
            runTool("ae_trimOut()", "Trimmed");
            break;
          case "alignDown":
            runTool("ae_alignDown()", "Aligned down");
            break;
          case "removeFx":
            (async function () {
              const modeInput = await showModal({
                title: "FX Remove",
                message: "Mode: all / selected / disabled / duplicates",
                input: true,
                defaultValue: "all",
                placeholder: "all",
                okText: "Next",
              });
              if (modeInput === null) return;
              const mode = String(modeInput || "all").trim().toLowerCase();
              let effectName = "";
              if (mode === "selected") {
                const nameInput = await showModal({
                  title: "Selected Effect",
                  message: "Effect name to remove (e.g. Glow, Drop Shadow):",
                  input: true,
                  placeholder: "Glow",
                  okText: "Remove",
                });
                if (!nameInput) return;
                effectName = nameInput;
              }
              const payload = JSON.stringify({ mode: mode, effectName: effectName })
                .replace(/\\/g, "\\\\")
                .replace(/"/g, '\\"');
              runTool('ae_removeEffectsAdvanced("' + payload + '")', "Effects removed");
            
  })();
            break;
          case "trimBefore":
            runTool("ae_trimBefore()", "Trimmed before playhead");
            break;
          case "trimAfter":
            runTool("ae_trimAfter()", "Trimmed after playhead");
            break;
          case "deleteBeforeLayers":
            (async function () {
              const s1 = await showModal({
                title: "Delete Before",
                message: "Scope: selected / all  |  Ripple: y/n  (e.g. selected,y)",
                input: true,
                defaultValue: "selected,y",
                placeholder: "selected,y",
                okText: "Delete",
              });
              if (s1 === null) return;
              const p1 = String(s1 || "selected,y").split(",").map((s) => s.trim());
              const payload1 = JSON.stringify({
                scope: (p1[0] === "all") ? "all" : "selected",
                ripple: p1[1] === "y" || p1[1] === "yes" || p1[1] === "true"
              }).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
              runTool('ae_deleteBeforeLayers("' + payload1 + '")', "Deleted before playhead");
            
  })();
            break;
          case "deleteAfterLayers":
            (async function () {
              const s2 = await showModal({
                title: "Delete After",
                message: "Scope: selected / all  |  Ripple: y/n  (e.g. selected,y)",
                input: true,
                defaultValue: "selected,y",
                placeholder: "selected,y",
                okText: "Delete",
              });
              if (s2 === null) return;
              const p2 = String(s2 || "selected,y").split(",").map((s) => s.trim());
              const payload2 = JSON.stringify({
                scope: (p2[0] === "all") ? "all" : "selected",
                ripple: p2[1] === "y" || p2[1] === "yes" || p2[1] === "true"
              }).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
              runTool('ae_deleteAfterLayers("' + payload2 + '")', "Deleted after playhead");
            
  })();
            break;
          case "splitMasks":
            runTool("ae_splitMasks()", "Masks split");
            break;
          case "trackPath":
            runTool("ae_trackPath()", "Track null created");
            break;
          case "splitAtPlayhead":
            runTool("ae_splitAtPlayhead()", "Split at playhead");
            break;
          case "rippleDelete":
            runTool("ae_rippleDelete()", "Ripple deleted");
            break;
          case "sortLayers":
            runTool('ae_sortLayers("' + (arg || "nameAZ") + '")', "Layers sorted");
            break;
          case "autoOrganize":
            runTool("ae_autoOrganize()", "Layers auto-organized into groups");
            break;
          case "colorCodeLayers":
            runTool("ae_colorCodeByType()", "Layers color-coded by type");
            break;
          case "memoryPurge":
            runTool('ae_memoryPurge("' + (arg || "all") + '")', "Memory purged");
            break;
          case "toggleSolo":
            runTool("ae_toggleSolo()", "Solo toggled");
            break;
          case "toggleShy":
            runTool("ae_toggleShy()", "Shy toggled");
            break;
          case "curvePreset":
            runTool('ae_applyCurvePreset("' + arg + '")', "Curve applied");
            break;
          case "purge":
            runTool('ae_purge("' + arg + '")', "Purged " + arg);
            break;
          case "solidToPlayhead":
          case "solidFromPlayhead":
          case "solidBetweenLayers":
          case "solidFullComp": {
            const sc = document.getElementById("solidColor");
            const color = (sc && sc.value) || "#000000";
            runTool('ae_solidTool("' + tool + '","' + color + '")', "Solid created");
            break;
          }
          case "glowPreset": {
            const ga = document.getElementById("glowColorA");
            const gb = document.getElementById("glowColorB");
            const gm = document.getElementById("glowColorMode");
            const colA = (ga && ga.value) || "#ff4444";
            const colB = (gb && gb.value) || "#ffff00";
            const mode = (gm && gm.value) || "ab";
            const payload = JSON.stringify({ preset: arg || "medium", colorA: colA, colorB: colB, colorMode: mode })
              .replace(/\\/g, "\\\\").replace(/"/g, '\\"');
            runTool('ae_applyGlowPreset("' + payload + '")', "Glow preset applied");
            break;
          }
          case "gradientPlate": {
            const g1 = document.getElementById("gradColor1");
            const g2 = document.getElementById("gradColor2");
            const gt = document.getElementById("gradType");
            const ga2 = document.getElementById("gradAngle");
            const gp = JSON.stringify({
              preset: arg || "custom",
              color1: (g1 && g1.value) || "#ff416c",
              color2: (g2 && g2.value) || "#ff4b2b",
              type: (gt && gt.value) || "1",
              angle: parseFloat((ga2 && ga2.value) || 0)
            }).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
            runTool('ae_applyGradientPlate("' + gp + '")', "Gradient applied");
            break;
          }
          case "xCrop":
            runTool("ae_processXCrop()", "X Crop complete");
            break;
          case "xactCrop":
            runTool("ae_processBoltCrop(false)", "Xact Crop complete");
            break;
          case "xpertCrop":
            runTool("ae_processBoltCrop(true)", "Xpert Crop complete");
            break;
          default:
            break;
        }
      });
    });

    const counterStyle = document.getElementById("counterStyle");
    const counterCustomRow = document.getElementById("counterCustomRow");
    function syncCounterCustomRow() {
      if (!counterStyle || !counterCustomRow) return;
      counterCustomRow.style.display = counterStyle.value === "custom" ? "flex" : "none";
    }
    if (counterStyle) {
      counterStyle.addEventListener("change", syncCounterCustomRow);
      syncCounterCustomRow();
    }

    const btnCounter = document.getElementById("btnCreateCounter");
    if (btnCounter) {
      btnCounter.addEventListener("click", () => {
        const from = document.getElementById("counterFrom").value || "0";
        const to = document.getElementById("counterTo").value || "100";
        const decimals = document.getElementById("counterDecimals").value || "0";
        const prefix = document.getElementById("counterPrefix").value || "";
        const suffix = document.getElementById("counterSuffix").value || "";
        const style = (counterStyle && counterStyle.value) || "custom";
        const locale = document.getElementById("counterLocale").value || "us";
        const symbolPos = document.getElementById("counterSymbolPos").value || "prefix";
        const script =
          "ae_createNumberCounter(" + Number(from) + ", " + Number(to) + ", " + Number(decimals) +
          ", " + hostArg(prefix) + ", " + hostArg(suffix) + ", " + hostArg(style) + ", " + hostArg(locale) + ", " + hostArg(symbolPos) + ")";
        runTool(script, "Number counter created");
      });
    }

    const btnApplyPoz = document.getElementById("btnApplyPoz");
    if (btnApplyPoz) {
      btnApplyPoz.addEventListener("click", () => {
        const px = document.getElementById("counterPosStep").value || "0";
        runTool("ae_applyCounterPosition(" + Number(px) + ")", "Position linked to counter");
      });
    }
  }

  // ---------------- Property Clipboard ----------------

  let clipboardSlots = { 1: null, 2: null, 3: null };
  let activeClipSlot = 1;
  // Tracks which slots hold Copy FX data, which now lives only in AE's own
  // ExtendScript memory (see ae_copyEverything/ae_pasteEverything) so large
  // captures never have to cross the evalScript() bridge.
  let fxClipboardHasData = { 1: false, 2: false, 3: false };

  function wirePropertyClipboard() {
    const slotsRow = document.getElementById("clipSlotsRow");
    if (slotsRow) {
      slotsRow.addEventListener("click", (ev) => {
        const btn = ev.target.closest(".clip-slot");
        if (!btn) return;
        activeClipSlot = Number(btn.dataset.slot);
        slotsRow.querySelectorAll(".clip-slot").forEach((b) => b.classList.toggle("active", b === btn));
      });
    }

    const btnClear = document.getElementById("btnClipboardClear");
    if (btnClear) {
      btnClear.addEventListener("click", () => {
        clipboardSlots = { 1: null, 2: null, 3: null };
        fxClipboardHasData = { 1: false, 2: false, 3: false };
        callHost("ae_clearAllClipboardSlots()", (parsed) => {
          if (!parsed.success) showToast(parsed.message || "Host clipboard could not be cleared", true);
        });
        if (slotsRow) slotsRow.querySelectorAll(".clip-slot").forEach((b) => b.classList.remove("has-data"));
        showToast("Clipboard cleared");
      });
    }

    const btnCopy = document.getElementById("btnClipCopy");
    if (btnCopy) {
      btnCopy.addEventListener("click", () => {
        callHost("ae_copyProperty()", (parsed) => {
          if (parsed.success && parsed.data) {
            clipboardSlots[activeClipSlot] = parsed.data;
            if (slotsRow) {
              const slotBtn = slotsRow.querySelector('.clip-slot[data-slot="' + activeClipSlot + '"]');
              if (slotBtn) slotBtn.classList.add("has-data");
            }
            showToast(parsed.message || "Copied to slot " + activeClipSlot);
          } else {
            showToast(parsed.message || "Copy failed", true);
          }
        });
      });
    }

    const btnPaste = document.getElementById("btnClipPaste");
    if (btnPaste) {
      btnPaste.addEventListener("click", () => {
        const data = clipboardSlots[activeClipSlot];
        if (!data) {
          showToast("Slot " + activeClipSlot + " is empty — copy a property first", true);
          return;
        }
        const payload = JSON.stringify(data).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        runTool('ae_pasteProperty("' + payload + '")', "Pasted");
      });
    }

    const btnPropertyBounce = document.getElementById("btnPropertyBounce");
    if (btnPropertyBounce) {
      btnPropertyBounce.addEventListener("click", () => {
        runTool("ae_applyClipboardBounce()", "Bounce expression applied");
      });
    }

    const btnBefore = document.getElementById("btnDeleteBefore");
    if (btnBefore) {
      btnBefore.addEventListener("click", () => runTool('ae_deleteKeyframes("before")', "Keyframes deleted"));
    }
    const btnAfter = document.getElementById("btnDeleteAfter");
    if (btnAfter) {
      btnAfter.addEventListener("click", () => runTool('ae_deleteKeyframes("after")', "Keyframes deleted"));
    }

    // Enhanced Copy/Paste buttons — captures and restores everything applied
    // to the layer (transform, effects, masks, blending mode, styles, etc.)
    // Copy FX / Paste FX now stay entirely on the ExtendScript side: AE
    // keeps the captured data in its own memory (keyed by clipboard slot)
    // for the life of the session, so nothing large ever has to cross the
    // evalScript() bridge — that bridge silently truncates long strings in
    // both directions, which is what broke this feature before.
    // ── Copy Pasta ── frame copy/paste (replaces old Copy FX / Paste FX)
    const btnCopyPasta = document.getElementById("btnCopyPasta");
    if (btnCopyPasta) {
      btnCopyPasta.addEventListener("click", () => {
        btnCopyPasta.disabled = true;
        btnCopyPasta.textContent = "⏳ Copying…";
        callHost("ae_copyPastaCapture()", (parsed) => {
          btnCopyPasta.disabled = false;
          btnCopyPasta.textContent = "📋 Copy";
          if (parsed.success) {
            showToast(parsed.message || "Frame captured!");
            if (btnPastePasta) btnPastePasta.classList.add("has-data");
          } else {
            showToast(parsed.message || "Copy Pasta: capture failed", true);
          }
        });
      });
    }

    const btnPastePasta = document.getElementById("btnPastePasta");
    if (btnPastePasta) {
      btnPastePasta.addEventListener("click", () => {
        btnPastePasta.disabled = true;
        btnPastePasta.textContent = "⏳ Pasting…";
        callHost("ae_copyPastaPaste()", (parsed) => {
          btnPastePasta.disabled = false;
          btnPastePasta.textContent = "📌 Paste";
          if (parsed.success) {
            showToast(parsed.message || "Frame pasted as layer!");
          } else {
            showToast(parsed.message || "Copy Pasta: paste failed", true);
          }
        });
      });
    }

    const btnFxLock = document.getElementById("btnFxLock");
    if (btnFxLock) {
      btnFxLock.addEventListener("click", () => {
        runTool("ae_fxLock()", "FX Lock updated");
      });
    }

    const btnFxRemove = document.getElementById("btnFxRemove");
    if (btnFxRemove) {
      btnFxRemove.addEventListener("click", async () => {
        const confirmed = await showModal({
          title: "Remove all FX?",
          message: "This removes every effect from the selected layer(s). You can undo it in After Effects.",
          input: false,
          okText: "Remove FX",
          cancelText: "Cancel",
          danger: true,
        });
        if (!confirmed) return;
        runTool("ae_removeAllFx()", "All FX removed");
      });
    }

    const btnCopyEverything = document.getElementById("btnCopyEverything");
    if (btnCopyEverything) {
      btnCopyEverything.addEventListener("click", () => {
        callHost("ae_copyEverything()", (parsed) => {
          if (parsed.success && parsed.data) {
            clipboardSlots[activeClipSlot] = parsed.data;
            if (slotsRow) {
              const slotBtn = slotsRow.querySelector('.clip-slot[data-slot="' + activeClipSlot + '"]');
              if (slotBtn) slotBtn.classList.add("has-data");
            }
            showToast(parsed.message || "All copied to slot " + activeClipSlot);
          } else {
            showToast(parsed.message || "Copy All failed", true);
          }
        });
      });
    }

    const btnPasteEverything = document.getElementById("btnPasteEverything");
    if (btnPasteEverything) {
      btnPasteEverything.addEventListener("click", () => {
        const data = clipboardSlots[activeClipSlot];
        if (!data) {
          showToast("Slot " + activeClipSlot + " is empty — copy everything first", true);
          return;
        }
        const payload = JSON.stringify(data).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        runTool('ae_pasteEverything("' + payload + '")', "Everything pasted");
      });
    }

    // Curve Copy/Paste buttons
    const btnCurveCopy = document.getElementById("btnCurveCopy");
    if (btnCurveCopy) {
      btnCurveCopy.addEventListener("click", () => {
        callHost("ae_copyCurve()", (parsed) => {
          if (parsed.success && parsed.data) {
            clipboardSlots[activeClipSlot] = parsed.data;
            if (slotsRow) {
              const slotBtn = slotsRow.querySelector('.clip-slot[data-slot="' + activeClipSlot + '"]');
              if (slotBtn) slotBtn.classList.add("has-data");
            }
            showToast(parsed.message || "Curve copied to slot " + activeClipSlot);
          } else {
            showToast(parsed.message || "Copy Curve failed", true);
          }
        });
      });
    }

    const btnCurvePaste = document.getElementById("btnCurvePaste");
    if (btnCurvePaste) {
      btnCurvePaste.addEventListener("click", () => {
        const data = clipboardSlots[activeClipSlot];
        if (!data) {
          showToast("Slot " + activeClipSlot + " is empty — copy a curve first", true);
          return;
        }
        const payload = JSON.stringify(data).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        runTool('ae_pasteCurve("' + payload + '")', "Curve pasted");
      });
    }

    const btnExplode = document.getElementById("btnExplodeTextPro");
    const explodeModal = document.getElementById("explodeModal");
    if (btnExplode && explodeModal) {
      const explodeModeEl = document.getElementById("explodeMode");
      const explodePresetEl = document.getElementById("explodePreset");
      const explodeDirectionEl = document.getElementById("explodeDirection");
      const explodeDistanceEl = document.getElementById("explodeDistance");
      const explodeRotationEl = document.getElementById("explodeRotation");
      const explodeDelayEl = document.getElementById("explodeDelay");
      const explodeDurationEl = document.getElementById("explodeDuration");
      const explodeRandomPositionEl = document.getElementById("explodeRandomPosition");
      const explodeRandomRotationEl = document.getElementById("explodeRandomRotation");
      const explodeRandomScaleEl = document.getElementById("explodeRandomScale");
      const explodeOpacityFadeEl = document.getElementById("explodeOpacityFade");
      const explodeKeepOriginalEl = document.getElementById("explodeKeepOriginal");
      const explodeCancelBtn = document.getElementById("explodeModalCancel");
      const explodeApplyBtn = document.getElementById("explodeModalApply");

      const closeExplodeModal = () => { explodeModal.style.display = "none"; };

      btnExplode.addEventListener("click", () => { explodeModal.style.display = "flex"; });

      if (explodeCancelBtn) explodeCancelBtn.addEventListener("click", closeExplodeModal);
      explodeModal.addEventListener("mousedown", (ev) => {
        if (ev.target === explodeModal) closeExplodeModal();
      });
      document.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape" && explodeModal.style.display === "flex") closeExplodeModal();
      });

      if (explodeApplyBtn) {
        explodeApplyBtn.addEventListener("click", () => {
          const options = {
            mode: explodeModeEl ? explodeModeEl.value : "character",
            preset: explodePresetEl ? explodePresetEl.value : "explodeOut",
            direction: explodeDirectionEl ? explodeDirectionEl.value : "random",
            distance: Math.max(0, Number(explodeDistanceEl && explodeDistanceEl.value) || 300),
            rotationDeg: Number(explodeRotationEl && explodeRotationEl.value) || 0,
            delay: Math.max(0, Number(explodeDelayEl && explodeDelayEl.value) || 0.05),
            duration: Math.max(0.05, Number(explodeDurationEl && explodeDurationEl.value) || 1.0),
            randomPosition: explodeRandomPositionEl ? explodeRandomPositionEl.checked : true,
            randomRotation: explodeRandomRotationEl ? explodeRandomRotationEl.checked : true,
            randomScale: explodeRandomScaleEl ? explodeRandomScaleEl.checked : true,
            opacityFade: explodeOpacityFadeEl ? explodeOpacityFadeEl.checked : true,
            keepOriginal: explodeKeepOriginalEl ? explodeKeepOriginalEl.checked : false,
            autoRename: true,
            preserveStyle: true,
          };
          const payload = JSON.stringify(options).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          closeExplodeModal();
          runTool('ae_explodeTextPro("' + payload + '")', "Text exploded");
        });
      }
    }

    function jsArg(str) {
      return hostArg(str);
    }

    const btnRenameSequential = document.getElementById("btnRenameSequential");
    if (btnRenameSequential) {
      btnRenameSequential.addEventListener("click", () => {
        const base = document.getElementById("renameBase");
        const val = base ? base.value.trim() : "";
        if (!val) { showToast("Enter a base name first", true); return; }
        runTool('ae_renameLayers("sequential", ' + jsArg(val) + ")", "Renamed sequentially");
      });
    }
    const btnRenamePrefix = document.getElementById("btnRenamePrefix");
    if (btnRenamePrefix) {
      btnRenamePrefix.addEventListener("click", () => {
        const el = document.getElementById("renamePrefix");
        const val = el ? el.value : "";
        if (!val) { showToast("Enter a prefix first", true); return; }
        runTool('ae_renameLayers("prefix", ' + jsArg(val) + ")", "Prefix added");
      });
    }
    const btnRenameSuffix = document.getElementById("btnRenameSuffix");
    if (btnRenameSuffix) {
      btnRenameSuffix.addEventListener("click", () => {
        const el = document.getElementById("renameSuffix");
        const val = el ? el.value : "";
        if (!val) { showToast("Enter a suffix first", true); return; }
        runTool('ae_renameLayers("suffix", ' + jsArg(val) + ")", "Suffix added");
      });
    }
    const btnRenameReplace = document.getElementById("btnRenameReplace");
    if (btnRenameReplace) {
      btnRenameReplace.addEventListener("click", () => {
        const findEl = document.getElementById("renameFind");
        const replEl = document.getElementById("renameReplace");
        const find = findEl ? findEl.value : "";
        const repl = replEl ? replEl.value : "";
        if (!find) { showToast("Enter text to find first", true); return; }
        runTool('ae_renameLayers("replace", ' + jsArg(find) + ", " + jsArg(repl) + ")", "Names replaced");
      });
    }

    const btnCompStats = document.getElementById("btnGetCompStats");
    if (btnCompStats) {
      btnCompStats.addEventListener("click", () => {
        const display = document.getElementById("compStatsDisplay");
        if (!display) return;
        display.innerHTML = '<div class="studio-empty">Scanning comp…</div>';
        callHost("ae_getCompStats()", (parsed) => {
          if (!parsed.success) {
            display.innerHTML = '<div class="studio-empty" style="color:var(--danger);">' + escapeHtml(parsed.message || "Failed") + '</div>';
            return;
          }
          if (!parsed.data) {
            display.innerHTML = '<div class="studio-empty">No data returned.</div>';
            return;
          }
          const s = parsed.data;
          const lc = s.layerCounts || {};
          const totalLayers = lc.footage + lc.solid + lc.text + lc.shape + lc.null + lc.adjustment + lc.camera + lc.light + lc.precomp + lc.other;
          let html = '<div style="padding:4px 0;">';
          html += '<b>' + escapeHtml(s.name) + '</b>  —  ' + s.width + '×' + s.height + '  @  ' + s.frameRate.toFixed(2) + ' fps<br>';
          html += 'Duration: ' + s.duration.toFixed(2) + 's  |  Layers: ' + totalLayers + '  |  Effects: ' + s.totalEffects + '  |  Masks: ' + s.totalMasks + '<br>';
          html += '<span style="font-size:11px;opacity:0.7;">';
          if (lc.footage) html += '🎬' + lc.footage + ' ';
          if (lc.solid) html += '⬛' + lc.solid + ' ';
          if (lc.text) html += '🔤' + lc.text + ' ';
          if (lc.shape) html += '��' + lc.shape + ' ';
          if (lc.null) html += '⊙' + lc.null + ' ';
          if (lc.adjustment) html += '🔎' + lc.adjustment + ' ';
          if (lc.camera) html += '📷' + lc.camera + ' ';
          if (lc.light) html += '💡' + lc.light + ' ';
          if (lc.precomp) html += '���' + lc.precomp + ' ';
          if (lc.other) html += '…' + lc.other + ' ';
          html += '</span>';
          if (s.hasMissingFootage) html += '<br><span style="color:var(--danger);">⚠ Missing footage detected</span>';
          html += '</div>';
          display.innerHTML = html;
        });
      });
    }

    function showProjectDoctorReport(parsed, display) {
      if (!parsed.success) {
        display.innerHTML = '<div class="studio-empty" style="color:var(--danger);">' + escapeHtml(parsed.message || "Failed") + '</div>';
        return;
      }
      if (!parsed.data || !parsed.data.issues) {
        display.innerHTML = '<div class="studio-empty">No issues found — your project looks clean!</div>';
        return;
      }
      const d = parsed.data;
      let html = '<div style="padding:4px 0;">';
      html += '<b>' + d.totalIssues + ' issue(s)</b>  —  ' + d.fixable + ' fixable, ' + d.notFixable + ' not fixable';
      if (d.fixReport) html += '  |  Folders removed: ' + d.fixReport.foldersRemoved;
      html += '</div>';
      for (let i = 0; i < d.issues.length; i++) {
        const iss = d.issues[i];
        const color = iss.severity === "high" ? "var(--danger)" : iss.severity === "medium" ? "var(--warning)" : "inherit";
        html += '<div style="padding:2px 0;color:' + color + ';">';
        if (iss.type === "missingFootage") html += '⚠ Missing: ';
        else if (iss.type === "unusedFootage") html += '🗑 Unused: ';
        else if (iss.type === "emptyFolder") html += '📁 Empty folder: ';
        else html += '• ';
        html += escapeHtml(iss.itemName) + ' <span style="opacity:0.5;">' + escapeHtml(iss.path) + '</span></div>';
      }
      display.innerHTML = html;
    }

    const btnProjectScan = document.getElementById("btnProjectScan");
    const btnProjectFix = document.getElementById("btnProjectFix");
    const projectDisplay = document.getElementById("projectDoctorDisplay");
    if (btnProjectScan && projectDisplay) {
      btnProjectScan.addEventListener("click", () => {
        projectDisplay.innerHTML = '<div class="studio-empty">Scanning project…</div>';
        callHost("ae_projectDoctor('scan')", (parsed) => showProjectDoctorReport(parsed, projectDisplay));
      });
    }
    if (btnProjectFix && projectDisplay) {
      btnProjectFix.addEventListener("click", () => {
        projectDisplay.innerHTML = '<div class="studio-empty">Fixing issues…</div>';
        callHost("ae_projectDoctor('fix')", (parsed) => showProjectDoctorReport(parsed, projectDisplay));
      });
    }

    const btnMorph = document.getElementById("btnSuperMorph");
    const morphStatus = document.getElementById("morphStatus");
    const morphDuration = document.getElementById("morphDuration");
    const morphSmoothness = document.getElementById("morphSmoothness");
    const morphElasticity = document.getElementById("morphElasticity");
    const morphStyle = document.getElementById("morphStyle");
    const morphAutoEase = document.getElementById("morphAutoEase");
    const morphDurationVal = document.getElementById("morphDurationVal");
    const morphSmoothnessVal = document.getElementById("morphSmoothnessVal");
    const morphElasticityVal = document.getElementById("morphElasticityVal");
    const morphMode = document.getElementById("morphMode");
    const morphTrails = document.getElementById("morphTrails");
    const morphTrailAmount = document.getElementById("morphTrailAmount");
    const morphTrailAmountVal = document.getElementById("morphTrailAmountVal");
    const morphSlicer = document.getElementById("morphSlicer");
    const morphSliceCount = document.getElementById("morphSliceCount");
    const morphSliceCountVal = document.getElementById("morphSliceCountVal");
    function refreshMorphLabels() {
      if (morphDurationVal && morphDuration) morphDurationVal.textContent = Number(morphDuration.value).toFixed(1) + "s";
      if (morphSmoothnessVal && morphSmoothness) morphSmoothnessVal.textContent = morphSmoothness.value + "%";
      if (morphElasticityVal && morphElasticity) morphElasticityVal.textContent = morphElasticity.value + "%";
      if (morphTrailAmountVal && morphTrailAmount) morphTrailAmountVal.textContent = morphTrailAmount.value + "%";
      if (morphSliceCountVal && morphSliceCount) morphSliceCountVal.textContent = morphSliceCount.value;
    }
    [morphDuration, morphSmoothness, morphElasticity, morphTrailAmount, morphSliceCount].forEach((input) => { if (input) input.addEventListener("input", refreshMorphLabels); });
    refreshMorphLabels();
    if (btnMorph) {
      btnMorph.addEventListener("click", () => {
        const payload = {
          duration: Number(morphDuration && morphDuration.value) || 1.2,
          smoothness: Number(morphSmoothness && morphSmoothness.value) || 70,
          elasticity: Number(morphElasticity && morphElasticity.value) || 0,
          style: (morphStyle && morphStyle.value) || "clean",
          autoEase: !!(morphAutoEase && morphAutoEase.checked),
          mode: (morphMode && morphMode.value) || "liquid",
          trails: !!(morphTrails && morphTrails.checked),
          trailAmount: Number(morphTrailAmount && morphTrailAmount.value) || 60,
          slicer: !!(morphSlicer && morphSlicer.checked),
          sliceCount: Number(morphSliceCount && morphSliceCount.value) || 8,
        };
        const escaped = JSON.stringify(payload).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        if (morphStatus) { morphStatus.textContent = "Creating Super Morph…"; morphStatus.style.color = "#f5a623"; }
        runTool('ae_superMorphSmart("' + escaped + '")', "Super Morph created", (result) => {
          if (!morphStatus) return;
          morphStatus.textContent = result.message || (result.success ? "Super Morph created." : "Super Morph failed.");
          morphStatus.style.color = result.success ? "#6fdc8c" : "#ff6b6b";
        });
      });
    }

    // ---------------- Project Organizer (preview modal) ----------------
    const orgModal = document.getElementById("organizeModal");

    function orgBuildConfig(apply) {
      const cats = [];
      const boxes = document.querySelectorAll("#organizeModal input[data-org-cat]");
      for (let i = 0; i < boxes.length; i++) if (boxes[i].checked) cats.push(boxes[i].getAttribute("data-org-cat"));
      const presetEl = document.getElementById("orgPreset");
      const opt = (id) => { const e = document.getElementById(id); return e ? e.checked : false; };
      return {
        apply: !!apply,
        categories: cats,
        smart: presetEl && presetEl.value === "smart",
        rootOnly: opt("orgRootOnly"),
        preserve: opt("orgPreserve"),
        createMissing: opt("orgCreateMissing")
      };
    }

    function orgRun(apply) {
      const cfg = orgBuildConfig(apply);
      const payload = JSON.stringify(cfg).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const preview = document.getElementById("orgPreview");
      if (preview && !apply) preview.innerHTML = '<div class="org-preview-empty">Scanning\u2026</div>';
      callHost('ae_organizeProject("' + payload + '")', (parsed) => {
        if (!parsed.success) {
          showToast(parsed.message || "Organize failed", true);
          if (preview && !apply) preview.innerHTML = '<div class="org-preview-empty">' + escapeHtml(parsed.message || "Failed") + '</div>';
          return;
        }
        const data = parsed.data || {};
        const cats = data.categories || [];
        if (apply) {
          if (data.total) showToast("Organized " + data.total + " item(s) into " + cats.length + " folder(s)");
          else showToast("Nothing to organize with these options");
          orgClose();
          return;
        }
        if (!cats.length) { if (preview) preview.innerHTML = '<div class="org-preview-empty">Nothing to organize with these options.</div>'; return; }
        let html = '';
        for (let i = 0; i < cats.length; i++) {
          html += '<div class="org-preview-row"><span class="org-preview-count">' + cats[i].count + '</span><span class="org-preview-arrow">\u2192</span><span class="org-preview-folder">' + escapeHtml(cats[i].folder) + '</span></div>';
        }
        html += '<div class="org-preview-total">' + data.total + ' item(s) will be organized</div>';
        if (preview) preview.innerHTML = html;
      });
    }

    function orgOpen() {
      if (!orgModal) return;
      const pv = document.getElementById("orgPreview");
      if (pv) pv.innerHTML = '<div class="org-preview-empty">Press \u201cPreview Changes\u201d to scan the project.</div>';
      orgModal.style.display = "flex";
    }
    function orgClose() { if (orgModal) orgModal.style.display = "none"; }

    const btnOrgOpen = document.getElementById("btnOrganizeApply");
    if (btnOrgOpen) btnOrgOpen.addEventListener("click", orgOpen);
    const _orgPrev = document.getElementById("btnOrgPreview");
    if (_orgPrev) _orgPrev.addEventListener("click", () => orgRun(false));
    const _orgApply = document.getElementById("btnOrgApply");
    if (_orgApply) _orgApply.addEventListener("click", () => orgRun(true));
    const _orgCancel = document.getElementById("btnOrgCancel");
    if (_orgCancel) _orgCancel.addEventListener("click", orgClose);
    if (orgModal) orgModal.addEventListener("mousedown", (ev) => { if (ev.target === orgModal) orgClose(); });
    const _orgPreset = document.getElementById("orgPreset");
    if (_orgPreset) _orgPreset.addEventListener("change", () => {
      const h = document.getElementById("orgSmartHint");
      if (h) h.style.display = _orgPreset.value === "smart" ? "block" : "none";
    });

    function getColorValues() {
      const p = document.getElementById("colorPrimary");
      const s = document.getElementById("colorSecondary");
      return {
        primary: (p && p.value) || "#ff0000",
        secondary: (s && s.value) || "#0000ff"
      };
    }

    const btnFill = document.getElementById("btnColorFill");
    if (btnFill) {
      btnFill.addEventListener("click", () => {
        const c = getColorValues();
        const script = 'ae_colorTool("fill","' + c.primary + '","' + c.secondary + '")';
        runTool(script, "Fill applied");
      });
    }
    const btnTint = document.getElementById("btnColorTint");
    if (btnTint) {
      btnTint.addEventListener("click", () => {
        const c = getColorValues();
        const script = 'ae_colorTool("tint","' + c.primary + '","' + c.secondary + '")';
        runTool(script, "Tint applied");
      });
    }
    const btnReplace = document.getElementById("btnColorReplace");
    if (btnReplace) {
      btnReplace.addEventListener("click", () => {
        const c = getColorValues();
        const script = 'ae_colorTool("colorReplace","' + c.primary + '","' + c.secondary + '")';
        runTool(script, "Color replace applied");
      });
    }

    const btnResize = document.getElementById("btnResizeComp");
    if (btnResize) {
      btnResize.addEventListener("click", async () => {
        const wStr = await showModal({ title: "Resize Comp", message: "New width (px):", input: true, defaultValue: "1920", placeholder: "Width" });
        if (wStr === null || wStr === "") return;
        const hStr = await showModal({ title: "Resize Comp", message: "New height (px):", input: true, defaultValue: "1080", placeholder: "Height" });
        if (hStr === null || hStr === "") return;
        const scale = await showModal({
          title: "Resize Comp",
          message: "Scale existing layers to fit the new size?",
          okText: "Scale Layers",
          cancelText: "Keep As-Is",
        });
        const script = "ae_resizeComp(" + Number(wStr) + ", " + Number(hStr) + ", " + (scale ? "true" : "false") + ")";
        runTool(script, "Comp resized");
      });
    }

    const fileInputSRT = document.getElementById("fileInputSRT");
    const btnImportSRT = document.getElementById("btnImportSRT");
    if (btnImportSRT && fileInputSRT) {
      btnImportSRT.addEventListener("click", () => fileInputSRT.click());
      fileInputSRT.addEventListener("change", async (ev) => {
        const file = ev.target.files && ev.target.files[0];
        fileInputSRT.value = "";
        if (!file || !file.path) return;
        let text;
        try {
          text = await fs.promises.readFile(file.path, "utf8");
        } catch (e) {
          reportError("SRT_READ", e, "Could not read SRT file");
          return;
        }
        const cues = parseSRT(text);
        if (!cues.length) {
          showToast("No subtitle cues found in that file", true);
          return;
        }
        const payload = hostArg(JSON.stringify(cues));
        runTool("ae_importSRT(" + payload + ")", "SRT imported");
      });
    }
  }

  // Parses standard .srt subtitle text into [{start, end, text}] (seconds).
  function parseSRT(text) {
    const cues = [];
    const blocks = String(text).replace(/\r/g, "").split(/\n\n+/);
    for (const block of blocks) {
      const lines = block.split("\n").filter((l) => l.length > 0);
      if (lines.length < 2) continue;
      let timeLineIdx = 0;
      if (/^\d+$/.test(lines[0].trim())) timeLineIdx = 1;
      const m = lines[timeLineIdx] && lines[timeLineIdx].match(
        /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/
      );
      if (!m) continue;
      const start = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
      const end = Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000;
      const cueText = lines.slice(timeLineIdx + 1).join("\n");
      cues.push({ start, end, text: cueText });
    }
    return cues;
  }

  function detectHostForTools() {
    if (!toolsHint) return;
    try {
      const info = csInterface.getHostEnvironment();
      const appId = info && info.appId ? info.appId : "";
      if (appId === "AEFT") {
        toolsHint.textContent = "Connected to After Effects";
      } else if (info && info.appName) {
        toolsHint.textContent = info.appName + " detected — Tools tab requires After Effects.";
      } else {
        toolsHint.textContent = "Standalone preview (no host detected)";
      }
    } catch (e) {
      toolsHint.textContent = "Standalone preview (no host detected)";
    }
  }

  // ---------------- Auto Tracker ----------------

  let trackerLastSignature = null;
  let trackerLastActivityAt = Date.now();
  let trackerStreakSeconds = 0;
  let trackerTodaySeconds = 0;
  let trackerBreakActive = false;
  let trackerHasComp = false;
  let trackerWorkIntervalSec = 20 * 60;
  let trackerIdleThresholdSec = 45;
  let trackerBreakCountdown = 0;
  let trackerBreakCountdownTimer = null;
  let trackerBreakNotified = false;

  function trackerLoadState() {
    try {
      const todayStr = new Date().toDateString();
      const storedDay = localStorage.getItem("aeTrackerDay");
      if (storedDay === todayStr) {
        trackerTodaySeconds = parseInt(localStorage.getItem("aeTrackerTotalSeconds") || "0", 10) || 0;
      } else {
        // Day rolled over (or first run) — archive whatever was tracked
        // for the previous stored day into history before resetting.
        if (storedDay) {
          const prevSeconds = parseInt(localStorage.getItem("aeTrackerTotalSeconds") || "0", 10) || 0;
          if (prevSeconds > 0) trackerArchiveDay(storedDay, prevSeconds);
        }
        localStorage.setItem("aeTrackerDay", todayStr);
        localStorage.setItem("aeTrackerTotalSeconds", "0");
        trackerTodaySeconds = 0;
      }
      const wi = localStorage.getItem("aeTrackerWorkInterval");
      const it = localStorage.getItem("aeTrackerIdleThreshold");
      if (wi) trackerWorkIntervalSec = (parseInt(wi, 10) || 20) * 60;
      if (it) trackerIdleThresholdSec = parseInt(it, 10) || 45;
    } catch (e) { auditFallback("MAIN_TRACKERLOADSTATE_001", e); }
  }

  // ---------------- Tracker History ----------------
  // A simple archive of past days' totals, kept separately from "today"
  // (which lives in aeTrackerTotalSeconds until the day rolls over).

  const TRACKER_HISTORY_KEY = "aeTrackerHistory";
  const TRACKER_HISTORY_MAX_DAYS = 60;

  function trackerLoadHistory() {
    try {
      const raw = localStorage.getItem(TRACKER_HISTORY_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function trackerSaveHistory(list) {
    try { localStorage.setItem(TRACKER_HISTORY_KEY, JSON.stringify(list.slice(-TRACKER_HISTORY_MAX_DAYS))); } catch (e) { auditFallback("MAIN_TRACKERSAVEHISTORY_001", e); }
  }

  function trackerArchiveDay(dateStr, seconds) {
    const list = trackerLoadHistory();
    const existing = list.find((d) => d.date === dateStr);
    if (existing) existing.seconds = seconds;
    else list.push({ date: dateStr, seconds });
    trackerSaveHistory(list);
  }

  function trackerRenderHistory() {
    const listEl = document.getElementById("trackerHistoryList");
    const weekEl = document.getElementById("trackerWeekTotal");
    if (!listEl) return;

    const history = trackerLoadHistory().slice().reverse(); // most recent first
    const now = new Date();
    const weekAgo = now.getTime() - 7 * 24 * 60 * 60 * 1000;

    let weekSeconds = trackerTodaySeconds;
    history.forEach((d) => {
      const t = new Date(d.date).getTime();
      if (!isNaN(t) && t >= weekAgo) weekSeconds += d.seconds;
    });
    if (weekEl) weekEl.textContent = trackerFormatHHMMSS(weekSeconds);

    // Build last 7 days array (including today)
    const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const weekDays = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toDateString();
      const key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
      let secs = 0;
      if (i === 0) {
        secs = trackerTodaySeconds;
      } else {
        const found = history.find((h) => {
          const hd = new Date(h.date);
          return hd.getFullYear() === d.getFullYear() && hd.getMonth() === d.getMonth() && hd.getDate() === d.getDate();
        });
        if (found) secs = found.seconds;
      }
      weekDays.push({ date: d, label: i === 0 ? "Today" : dayLabels[d.getDay()], seconds: secs, key, isToday: i === 0 });
    }

    const maxSecs = Math.max(...weekDays.map((wd) => wd.seconds), 1);
    const averageSecs = weekDays.reduce((sum, wd) => sum + wd.seconds, 0) / 7;

    // Bar chart HTML
    let html = '<div class="tracker-bar-chart">';
    weekDays.forEach((wd) => {
      const pct = Math.max((wd.seconds / maxSecs) * 100, 2);
      const cls = wd.isToday ? "today" : wd.seconds > averageSecs ? "high" : wd.seconds > 0 ? "medium" : "low";
      html += '<div class="tracker-bar-day">';
      html += '<div class="tracker-bar-column">';
      html += '<div class="tracker-bar-fill ' + cls + '" style="height:' + pct + '%;"></div>';
      html += "</div>";
      html += '<div class="tracker-bar-time">' + trackerFormatMMSS(wd.seconds) + "</div>";
      html += '<div class="tracker-bar-label' + (wd.isToday ? " today-label" : "") + '">' + wd.label + "</div>";
      html += "</div>";
    });
    html += "</div>";

    // Stats row
    const bestDay = weekDays.reduce((best, wd) => (wd.seconds > best.seconds ? wd : best), { seconds: 0 });
    html += '<div class="tracker-stats-row">';
    html += '<div class="tracker-stat-box"><div class="tracker-stat-value">' + trackerFormatHHMMSS(Math.round(averageSecs)) + '</div><div class="tracker-stat-label">Daily Avg</div></div>';
    html += '<div class="tracker-stat-box"><div class="tracker-stat-value">' + trackerFormatHHMMSS(bestDay.seconds) + '</div><div class="tracker-stat-label">Best Day</div></div>';
    html += '<div class="tracker-stat-box"><div class="tracker-stat-value">' + trackerFormatHHMMSS(weekSeconds) + '</div><div class="tracker-stat-label">Total</div></div>';
    html += "</div>";

    // History list (past days beyond today's week)
    if (history.length > 0) {
      html += '<div style="margin-top:8px;padding-top:6px;border-top:1px solid var(--line);font-size:11px;color:var(--text-dim);font-weight:600;">OLDER DAYS</div>';
      history.slice(7).forEach((d) => {
        const dateObj = new Date(d.date);
        const label = isNaN(dateObj.getTime()) ? d.date : dateObj.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
        html += '<div class="studio-row" style="cursor:default;">' +
          '<div class="studio-row-main"><div class="studio-row-name">' + escapeHtml(label) + "</div></div>" +
          '<div class="studio-row-sub" style="flex-shrink:0;">' + trackerFormatHHMMSS(d.seconds) + "</div>" +
          "</div>";
      });
    }

    listEl.innerHTML = html;
  }

  // duplicate trackerFormatMMSS removed — canonical padded version defined below

  function trackerSaveTotal() {
    try {
      localStorage.setItem("aeTrackerDay", new Date().toDateString());
      localStorage.setItem("aeTrackerTotalSeconds", String(Math.floor(trackerTodaySeconds)));
    } catch (e) { auditFallback("MAIN_TRACKERSAVETOTAL_001", e); }
  }

  // CEP runs one evalScript at a time. A fixed-interval poll that does not
  // wait for its own reply queues a new call every tick, and once a single
  // reply is slow the backlog never drains — every later action (caption
  // apply, timeline tools) sits behind it forever. Poll one at a time and
  // back off whenever the host is busy.
  const TRACKER_POLL_MS = 4000;
  const TRACKER_POLL_TIMEOUT_MS = 8000;
  const TRACKER_POLL_MAX_MS = 60000;
  let trackerPollInFlight = false;
  let trackerPollBackoffMs = TRACKER_POLL_MS;
  let trackerPollTimer = null;

  function trackerSchedulePoll(delayMs) {
    if (trackerPollTimer) clearTimeout(trackerPollTimer);
    trackerPollTimer = setTimeout(trackerPoll, delayMs);
  }

  function trackerPollDone(ok) {
    trackerPollInFlight = false;
    trackerPollBackoffMs = ok
      ? TRACKER_POLL_MS
      : Math.min(TRACKER_POLL_MAX_MS, trackerPollBackoffMs * 2);
    trackerSchedulePoll(trackerPollBackoffMs);
  }

  function trackerPoll() {
    // A hidden panel cannot show the timer, and Premiere throttles background
    // scripting — polling then only buys a stalled bridge.
    if (trackerPollInFlight || document.hidden) {
      trackerSchedulePoll(trackerPollBackoffMs);
      return;
    }
    trackerPollInFlight = true;
    try {
      callHostRaw("ppro_getActivitySignature()", (result) => {
        let parsed;
        try {
          parsed = JSON.parse(result);
        } catch (e) {
          trackerHasComp = false;
          trackerSetStatus("nocomp", "Not connected to Premiere Pro");
          trackerPollDone(false);
          return;
        }
        trackerPollDone(true);
        if (!parsed.hasComp) {
          trackerHasComp = false;
          trackerSetStatus("nocomp", "No sequence open");
          const compNameEl = document.getElementById("trackerCompName");
          if (compNameEl) compNameEl.textContent = "";
          return;
        }
        trackerHasComp = true;
        const compNameEl = document.getElementById("trackerCompName");
        if (compNameEl) compNameEl.textContent = parsed.compName || "";
        if (parsed.signature !== trackerLastSignature) {
          trackerLastSignature = parsed.signature;
          trackerLastActivityAt = Date.now();
        }
      }, TRACKER_POLL_TIMEOUT_MS);
    } catch (e) {
      auditFallback("MAIN_TRACKERPOLL_001", e);
      trackerPollDone(false);
    }
  }

  function trackerTick() {
    if (!trackerHasComp) {
      trackerSetStatus("nocomp", "No sequence open");
      trackerRender();
      return;
    }
    if (trackerBreakActive) {
      trackerSetStatus("break", "On break — resting your eyes");
      trackerRender();
      return;
    }
    const idleForSec = (Date.now() - trackerLastActivityAt) / 1000;
    if (idleForSec > trackerIdleThresholdSec) {
      trackerSetStatus("idle", "Idle — timer paused");
    } else {
      trackerSetStatus("working", "Working");
      trackerStreakSeconds += 1;
      trackerTodaySeconds += 1;
      if (trackerStreakSeconds % 10 === 0) { trackerSaveTotal(); trackerRenderHistory(); }
      if (trackerStreakSeconds >= trackerWorkIntervalSec) {
        trackerStreakSeconds = trackerWorkIntervalSec;
        // Fire the break notification/beep exactly ONCE per completed streak
        // (not every second while the banner stays up).
        if (!trackerBreakNotified) {
          trackerBreakNotified = true;
          trackerShowBreakBanner();
        }
      }
    }
    trackerRender();
  }

  function trackerSetStatus(kind, text) {
    const dot = document.getElementById("trackerDot");
    const label = document.getElementById("trackerStatusText");
    if (dot) dot.className = "tracker-dot " + kind;
    if (label) label.textContent = text;
  }

  // ── Tracker Notification ─────────────────────────────────────────────────
  // Fires when work interval completes.
  // 1. OS-level Web Notification (visible even when AE is minimized)
  // 2. AE system beep via ExtendScript
  // 3. Panel toast as fallback
  // Reliable in-panel "ding" using Web Audio (works in CEP/CEF regardless of
  // host). Created lazily and resumed if the context starts suspended.
  let trackerAudioCtx = null;
  function trackerBeep() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!trackerAudioCtx) trackerAudioCtx = new AC();
      const ctx = trackerAudioCtx;
      if (ctx.state === "suspended") { try { ctx.resume(); } catch (e) { auditFallback("MAIN_TRACKERBEEP_001", e); } }
      const now = ctx.currentTime;
      // Two short rising tones: ding-ding.
      const tones = [[880, 0], [1174.7, 0.18]];
      for (let i = 0; i < tones.length; i++) {
        const freq = tones[i][0];
        const offset = tones[i][1];
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.3, now + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.16);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + offset);
        osc.stop(now + offset + 0.18);
      }
    } catch (e) { auditFallback("MAIN_TRACKERBEEP_002", e); }
  }

  function trackerNotify() {
    const mins = Math.round(trackerWorkIntervalSec / 60);
    const title = "⏱ CompX — Eye Break Time!";
    const body  = mins + " min work streak complete. Rest your eyes for 20 seconds.";

    // 1. OS Notification
    if ("Notification" in window) {
      if (Notification.permission === "granted") {
        try {
          new Notification(title, {
            body,
            icon: "icons/icon-normal.png",
            silent: false
          });
        } catch (e) { auditFallback("MAIN_TRACKERNOTIFY_001", e); }
      } else if (Notification.permission !== "denied") {
        Notification.requestPermission().then((perm) => {
          if (perm === "granted") {
            try { new Notification(title, { body, icon: "icons/icon-normal.png" }); } catch (e) { auditFallback("MAIN_TRACKERNOTIFY_002", e); }
          }
        });
      }
    }

    // 2. Audible beep — Web Audio, reliable inside CEP.
    //    NOTE: app.beep() is NOT a valid After Effects method (Photoshop only),
    //    so the previous evalScript("app.beep()") never produced any sound.
    //    We now synthesize the beep directly in the panel instead.
    trackerBeep();

    // 3. Panel toast (always shown as fallback)
    showToast("\uD83D\uDC41 " + mins + " min streak done — time for an eye break!");
  }

  function trackerShowBreakBanner() {
    const banner = document.getElementById("trackerBreakBanner");
    if (banner) banner.style.display = "flex";
    trackerNotify();
  }

  function trackerFormatMMSS(totalSec) {
    const m = Math.floor(totalSec / 60);
    const s = Math.floor(totalSec % 60);
    return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }

  function trackerFormatHHMMSS(totalSec) {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = Math.floor(totalSec % 60);
    return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }

  function trackerRender() {
    const streakEl = document.getElementById("trackerStreakTime");
    const totalEl = document.getElementById("trackerTodayTotal");
    const fill = document.getElementById("trackerProgressFill");
    const intervalLabel = document.getElementById("trackerIntervalLabel");
    if (streakEl) streakEl.textContent = trackerFormatMMSS(trackerStreakSeconds);
    if (totalEl) totalEl.textContent = trackerFormatHHMMSS(trackerTodaySeconds);
    if (intervalLabel) intervalLabel.textContent = trackerFormatMMSS(trackerWorkIntervalSec);
    if (fill) fill.style.width = Math.min(100, (trackerStreakSeconds / trackerWorkIntervalSec) * 100) + "%";
  }

  function trackerStartBreak() {
    trackerBreakActive = true;
    trackerBreakCountdown = 20;
    const btn = document.getElementById("btnStartBreak");
    if (btn) btn.disabled = true;

    trackerBreakCountdownTimer = setInterval(() => {
      trackerBreakCountdown -= 1;
      if (btn) btn.textContent = "Resting… " + trackerBreakCountdown + "s";
      if (trackerBreakCountdown <= 0) {
        clearInterval(trackerBreakCountdownTimer);
        trackerBreakCountdownTimer = null;
        trackerBreakActive = false;
        trackerStreakSeconds = 0;
        trackerBreakNotified = false;
        trackerLastActivityAt = Date.now();
        const banner = document.getElementById("trackerBreakBanner");
        if (banner) banner.style.display = "none";
        if (btn) {
          btn.disabled = false;
          btn.textContent = "Start 20s Eye Break";
        }
        showToast("Break done — back to work!");
      }
    }, 1000);
  }

  function wireTracker() {
    const btnBreak = document.getElementById("btnStartBreak");
    if (btnBreak) btnBreak.addEventListener("click", trackerStartBreak);

    const btnSkipBreak = document.getElementById("btnSkipBreak");
    if (btnSkipBreak) {
      btnSkipBreak.addEventListener("click", () => {
        const banner = document.getElementById("trackerBreakBanner");
        if (banner) banner.style.display = "none";
        trackerStreakSeconds = 0;
        trackerBreakNotified = false;
        trackerLastActivityAt = Date.now();
        trackerRender();
        showToast("⏩ Break skipped — streak reset");
      });
    }

    const btnReset = document.getElementById("btnResetToday");
    if (btnReset) {
      btnReset.addEventListener("click", () => {
        trackerTodaySeconds = 0;
        trackerSaveTotal();
        trackerRender();
        trackerRenderHistory();
        showToast("Today's tracked time reset");
      });
    }

    const wiInput = document.getElementById("settingWorkInterval");
    if (wiInput) {
      wiInput.value = Math.round(trackerWorkIntervalSec / 60);
      wiInput.addEventListener("change", () => {
        const mins = Math.max(1, Math.min(120, parseInt(wiInput.value, 10) || 20));
        trackerWorkIntervalSec = mins * 60;
        try { localStorage.setItem("aeTrackerWorkInterval", String(mins)); } catch (e) { auditFallback("MAIN_WIRETRACKER_001", e); }
        trackerRender();
      });
    }

    const itInput = document.getElementById("settingIdleThreshold");
    if (itInput) {
      itInput.value = trackerIdleThresholdSec;
      itInput.addEventListener("change", () => {
        const secs = Math.max(10, Math.min(300, parseInt(itInput.value, 10) || 45));
        trackerIdleThresholdSec = secs;
        try { localStorage.setItem("aeTrackerIdleThreshold", String(secs)); } catch (e) { auditFallback("MAIN_WIRETRACKER_002", e); }
      });
    }
  }

  function startTracker() {
    // Request OS notification permission early so it's ready when needed
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
    trackerLoadState();
    wireTracker();
    trackerRender();
    trackerRenderHistory();
    trackerPoll();
    setInterval(trackerTick, 1000);
    window.addEventListener("beforeunload", trackerSaveTotal);
  }

  function wireToolSubtabs() {
    const row = document.getElementById("toolSubtabsRow");
    if (!row) return;
    row.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".tool-subtab");
      if (!btn) return;
      showToolGroup(btn.dataset.toolgroup);
    });
  }

  function showToolGroup(group) {
    document.querySelectorAll(".tool-subtab").forEach((b) => b.classList.toggle("active", b.dataset.toolgroup === group));
    document.querySelectorAll(".tool-group").forEach((g) => g.classList.toggle("active", g.dataset.toolgroup === group));
  }

  // ================================================================
  // STUDIO — shared helpers
  // ================================================================

  function jsStr(v) {
    return hostArg(v);
  }

  function evalHost(script) {
    return new Promise((resolve) => {
      callHost(script, resolve);
    });
  }

  function currentHostAppId() {
    try {
      const info = csInterface.getHostEnvironment();
      return info && info.appId ? info.appId : "";
    } catch (e) {
      return "";
    }
  }

  // A Windows path ("C:\\Sounds\\hit.wav") has no leading slash, so the URL needs
  // three. A POSIX path ("/Users/x/hit.wav") already starts with one, and
  // "file:///" + that produced file:////Users/... — four slashes, which is not a
  // URL Premiere can resolve. That broke the drag-and-drop flavours on macOS.
  function libraryFileUrl(nativePath, encode) {
    const cleanPath = String(nativePath || "").replace(/\\/g, "/");
    const rooted = cleanPath.charAt(0) === "/" ? cleanPath : "/" + cleanPath;
    return "file://" + (encode ? encodeURI(rooted) : rooted);
  }

  function revealInFolder(filePath) {
    if (!filePath) return;
    try {
      if (process.platform === "darwin") {
        cp.execFile("open", ["-R", filePath]);
      } else if (process.platform === "win32") {
        cp.execFile("explorer.exe", ["/select,", filePath]);
      } else {
        cp.execFile("xdg-open", [path.dirname(filePath)]);
      }
    } catch (e) {
      showToast("Could not open file location", true);
    }
  }

  function copyToClipboard(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      showToast("Copied to clipboard");
    } catch (e) {
      showToast("Could not copy", true);
    }
  }

  function detectHostForStudio() {
    const hint = document.getElementById("studioHint");
    let text;
    try {
      const info = csInterface.getHostEnvironment();
      const appId = info && info.appId ? info.appId : "";
      if (appId === "AEFT") text = "Connected to After Effects — all Studio tools available.";
      else if (appId === "PPRO") text = "Connected to Premiere Pro — FFX Presets & Word Captions require After Effects.";
      else if (info && info.appName) text = info.appName + " detected.";
      else text = "Standalone preview (no host detected)";
    } catch (e) {
      text = "Standalone preview (no host detected)";
    }
    if (hint) hint.textContent = text;
  }

  // ---------------- FFX Preset Library (AE only) ----------------

  const FFX_STORAGE_KEY = "ccFfxPresets";
  let ffxPresets = [];
  let ffxSelectedId = null;
  let ffxSearchText = "";

  function loadFfxPresets() {
    try {
      const raw = localStorage.getItem(FFX_STORAGE_KEY);
      ffxPresets = raw ? JSON.parse(raw) : [];
    } catch (e) {
      ffxPresets = [];
    }
  }

  function saveFfxPresets() {
    try { localStorage.setItem(FFX_STORAGE_KEY, JSON.stringify(ffxPresets)); } catch (e) { auditFallback("MAIN_SAVEFFXPRESETS_001", e); }
  }

  function guessFfxCategory(filePath) {
    const parent = path.basename(path.dirname(filePath));
    return parent && parent !== "." ? parent : "Uncategorized";
  }

  function addFfxPaths(paths) {
    const validPaths = paths.filter((p) => path.extname(p).toLowerCase() === ".ffx");
    let added = 0;
    validPaths.forEach((p) => {
      if (ffxPresets.some((f) => f.path === p)) return;
      ffxPresets.push({
        id: uid(),
        name: path.basename(p, path.extname(p)),
        path: p,
        category: guessFfxCategory(p),
      });
      added++;
    });
    if (added > 0) {
      saveFfxPresets();
      renderFfxList();
      showToast(added + " preset" + (added > 1 ? "s" : "") + " added");
    } else {
      showToast("No new .ffx presets found", true);
    }
  }

  function renderFfxList() {
    const listEl = document.getElementById("ffxList");
    if (!listEl) return;
    const q = ffxSearchText.trim().toLowerCase();
    const filtered = ffxPresets.filter((f) => !q || (f.name + " " + f.category).toLowerCase().indexOf(q) !== -1);

    if (filtered.length === 0) {
      listEl.innerHTML = '<div class="studio-empty">' +
        (ffxPresets.length === 0 ? "No presets yet — add some .ffx files or a folder." : "No presets match your search.") +
        "</div>";
      return;
    }

    const byCategory = {};
    filtered.forEach((f) => {
      const cat = f.category || "Uncategorized";
      (byCategory[cat] = byCategory[cat] || []).push(f);
    });

    let html = "";
    Object.keys(byCategory).sort().forEach((cat) => {
      html += '<div class="studio-row-sub" style="padding:6px 10px 0;">' + escapeHtml(cat) + "</div>";
      byCategory[cat].forEach((f) => {
        html +=
          '<div class="studio-row' + (f.id === ffxSelectedId ? " active" : "") + '" data-ffx-id="' + f.id + '">' +
          '<div class="studio-row-main"><div class="studio-row-name">' + escapeHtml(f.name) + "</div></div>" +
          '<div class="studio-row-actions"><span class="studio-row-btn danger" data-ffx-remove="' + f.id + '">✕</span></div>' +
          "</div>";
      });
    });
    listEl.innerHTML = html;
  }

  function wireFfxPresets() {
    loadFfxPresets();
    renderFfxList();

    const search = document.getElementById("ffxSearch");
    if (search) search.addEventListener("input", () => { ffxSearchText = search.value; renderFfxList(); });

    const btnAdd = document.getElementById("btnFfxAdd");
    const fileInputFfx = document.getElementById("fileInputFfx");
    if (btnAdd && fileInputFfx) {
      btnAdd.addEventListener("click", () => fileInputFfx.click());
      fileInputFfx.addEventListener("change", (ev) => {
        const paths = Array.from(ev.target.files).map((f) => f.path).filter(Boolean);
        fileInputFfx.value = "";
        addFfxPaths(paths);
      });
    }

    const btnAddFolder = document.getElementById("btnFfxAddFolder");
    const fileInputFfxFolder = document.getElementById("fileInputFfxFolder");
    if (btnAddFolder && fileInputFfxFolder) {
      fileInputFfxFolder.setAttribute("webkitdirectory", "");
      btnAddFolder.addEventListener("click", () => fileInputFfxFolder.click());
      fileInputFfxFolder.addEventListener("change", (ev) => {
        const paths = Array.from(ev.target.files).map((f) => f.path).filter(Boolean);
        fileInputFfxFolder.value = "";
        addFfxPaths(paths);
      });
    }

    const listEl = document.getElementById("ffxList");
    if (listEl) {
      listEl.addEventListener("click", (ev) => {
        const removeBtn = ev.target.closest("[data-ffx-remove]");
        if (removeBtn) {
          ev.stopPropagation();
          const id = removeBtn.dataset.ffxRemove;
          ffxPresets = ffxPresets.filter((f) => f.id !== id);
          if (ffxSelectedId === id) ffxSelectedId = null;
          saveFfxPresets();
          renderFfxList();
          return;
        }
        const row = ev.target.closest("[data-ffx-id]");
        if (!row) return;
        ffxSelectedId = row.dataset.ffxId;
        renderFfxList();
      });
    }

    const btnApply = document.getElementById("btnFfxApply");
    if (btnApply) {
      btnApply.addEventListener("click", () => {
        const preset = ffxPresets.find((f) => f.id === ffxSelectedId);
        if (!preset) { showToast("Select a preset first", true); return; }
        runTool("ae_applyPreset(" + jsStr(preset.path) + ")", "Preset applied");
      });
    }
  }

  // ---------------- Word-by-Word Captions (AE only) ----------------

  let captionSrtCues = null; // [{start,end,text}] from an imported .srt, or null for even timing

  function splitWords(text) {
    return String(text || "").split(/\s+/).map((w) => w.trim()).filter(Boolean);
  }

  function buildEvenWordTiming(words, startSec, wps) {
    const perWord = 1 / Math.max(0.2, wps);
    return words.map((w, i) => ({ text: w, start: startSec + i * perWord, end: startSec + (i + 1) * perWord }));
  }

  function buildSrtWordTiming(cues) {
    const out = [];
    cues.forEach((cue) => {
      const words = splitWords(cue.text);
      if (words.length === 0) return;
      const span = Math.max(0.05, cue.end - cue.start);
      const per = span / words.length;
      words.forEach((w, i) => out.push({ text: w, start: cue.start + i * per, end: cue.start + (i + 1) * per }));
    });
    return out;
  }

  function wireShapeControls() {
    const modal = document.getElementById("shapeModal");
    if (!modal) return;
    const titleMap = { trim: "\u2702 Trim Paths", taper: "\ud83d\udccf Taper", dashes: "\u250a Dashes" };
    let curTab = "trim";

    function setTab(tab) {
      curTab = tab;
      const t = document.getElementById("shapeModalTitle");
      if (t) t.textContent = titleMap[tab] || "Shape Controls";
      modal.querySelectorAll(".shape-tab").forEach((b) => b.classList.toggle("active", b.getAttribute("data-shape-tab") === tab));
      modal.querySelectorAll(".shape-panel").forEach((p) => p.classList.toggle("active", p.getAttribute("data-shape-panel") === tab));
    }
    function openModal(tab) { setTab(tab || "trim"); modal.style.display = "flex"; }
    function closeModal() { modal.style.display = "none"; }
    function num(id) { const e = document.getElementById(id); return e ? Number(e.value) : 0; }
    function chk(id) { const e = document.getElementById(id); return e ? e.checked : false; }

    function apply(cfg) {
      const payload = JSON.stringify(cfg).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      runTool('ae_shapeControl("' + payload + '")', "Shape control applied", (res) => { if (res && res.success) closeModal(); });
    }

    document.querySelectorAll("[data-shape-ctrl]").forEach((b) => {
      b.addEventListener("click", () => openModal(b.getAttribute("data-shape-ctrl")));
    });
    modal.querySelectorAll("[data-shape-tab]").forEach((b) => b.addEventListener("click", () => setTab(b.getAttribute("data-shape-tab"))));
    modal.querySelectorAll('input[type="range"]').forEach((s) => {
      const out = document.getElementById(s.id + "V");
      const upd = () => { if (out) out.textContent = s.value; };
      s.addEventListener("input", upd); upd();
    });
    modal.querySelectorAll("[data-trim-preset]").forEach((b) => b.addEventListener("click", () => apply({ type: "trim", preset: b.getAttribute("data-trim-preset") })));
    modal.querySelectorAll("[data-taper-preset]").forEach((b) => b.addEventListener("click", () => apply({ type: "taper", preset: b.getAttribute("data-taper-preset") })));
    const applyBtn = document.getElementById("btnShapeApply");
    if (applyBtn) applyBtn.addEventListener("click", () => {
      if (curTab === "trim") apply({ type: "trim", preset: "custom", start: num("trimStart"), end: num("trimEnd"), offset: num("trimOffset"), animate: chk("trimAnimate") });
      else if (curTab === "taper") apply({ type: "taper", preset: "custom", startWidth: num("taperSW"), endWidth: num("taperEW"), startLength: num("taperSL"), endLength: num("taperEL"), ease: num("taperEase") });
      else apply({ type: "dashes", dash: num("dashDash"), gap: num("dashGap"), offset: num("dashOffset"), animate: chk("dashAnimate") });
    });
    const cancel = document.getElementById("btnShapeCancel");
    if (cancel) cancel.addEventListener("click", closeModal);
    const close = document.getElementById("btnShapeClose");
    if (close) close.addEventListener("click", closeModal);
    modal.addEventListener("mousedown", (ev) => { if (ev.target === modal) closeModal(); });
  }

  function wireShapeToolkit() {
    const sec = document.getElementById("shapeToolkit");
    if (!sec) return;
    sec.addEventListener("click", (ev) => {
      const opBtn = ev.target.closest("[data-shape-op]");
      if (opBtn) { runTool('ae_shapeOp("' + opBtn.getAttribute("data-shape-op") + '")', "Shape operator added"); return; }
      const preBtn = ev.target.closest("[data-shape-preset]");
      if (preBtn) { runTool('ae_shapePreset("' + preBtn.getAttribute("data-shape-preset") + '")', "Shape preset applied"); return; }
    });
  }

  function wireCaptions() {
    const fileInput = document.getElementById("fileInputCaptionSRT");
    const btnImportSrt = document.getElementById("btnCaptionImportSRT");
    const srtHint = document.getElementById("captionSrtHint");
    if (btnImportSrt && fileInput) {
      btnImportSrt.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", async (ev) => {
        const file = ev.target.files && ev.target.files[0];
        fileInput.value = "";
        if (!file || !file.path) return;
        let text;
        try { text = await fs.promises.readFile(file.path, "utf8"); } catch (e) { reportError("CAPTION_SRT_READ", e, "Could not read .srt file"); return; }
        const cues = parseSRT(text);
        if (!cues.length) { showToast("No subtitle cues found in that file", true); return; }
        captionSrtCues = cues;
        const textAreaFill = document.getElementById("captionText");
        if (textAreaFill) textAreaFill.value = cues.map((c) => c.text).join(" ");
        if (srtHint) srtHint.textContent = "Using timing from " + path.basename(file.path) + " (" + cues.length + " cues)";
        showToast("SRT timing loaded — Create Word Captions will use it");
      });
    }

    const textArea = document.getElementById("captionText");
    if (textArea) {
      textArea.addEventListener("input", () => {
        captionSrtCues = null; // manual edits invalidate imported timing
        if (srtHint) srtHint.textContent = "";
      });
    }

    const btnCreate = document.getElementById("btnCaptionCreate");
    if (btnCreate) {
      btnCreate.addEventListener("click", () => {
        const rawText = textArea ? textArea.value : "";
        const startSec = Number(document.getElementById("captionStart").value) || 0;
        const wps = Number(document.getElementById("captionWps").value) || 2.5;
        const fontSize = Number(document.getElementById("captionFontSize").value) || 90;
        const position = document.getElementById("captionPosition").value;
        const style = document.getElementById("captionStyle").value;
        const color = document.getElementById("captionColor").value;

        let words;
        if (captionSrtCues && captionSrtCues.length) {
          words = buildSrtWordTiming(captionSrtCues);
        } else {
          const wordList = splitWords(rawText);
          if (wordList.length === 0) { showToast("Enter some caption text first", true); return; }
          words = buildEvenWordTiming(wordList, startSec, wps);
        }
        if (words.length === 0) { showToast("No words to caption", true); return; }

        const payload = { words, fontSize, position, style, color };
        const escaped = hostArg(JSON.stringify(payload));
        runTool("ae_createWordCaptions(" + escaped + ")", words.length + " word captions created");
      });
    }
  }

  // ---------------- Color Panel ----------------

  function wireColorPanel() {
    // Sync hex input ↔ color picker
    const colorPicker = document.getElementById("colorPickerMain");
    const hexInput = document.getElementById("colorHexInput");
    if (colorPicker && hexInput) {
      colorPicker.addEventListener("input", () => { hexInput.value = colorPicker.value; });
      hexInput.addEventListener("input", () => {
        const v = hexInput.value.trim();
        if (/^#[0-9a-f]{6}$/i.test(v)) colorPicker.value = v;
      });
    }

    function getColorFromPicker() {
      return (colorPicker && colorPicker.value) || "#ff6600";
    }

    function renderSwatches(containerId, storageKey, emptyMsg) {
      const grid = document.getElementById(containerId);
      if (!grid) return;
      let colors = [];
      try { colors = JSON.parse(localStorage.getItem(storageKey)) || []; } catch (e) { auditFallback("MAIN_RENDERSWATCHES_001", e); }
      if (!colors.length) {
        grid.innerHTML = '<div class="studio-empty" style="font-size:11px;">' + emptyMsg + '</div>';
        return;
      }
      let html = "";
      colors.forEach((hex, idx) => {
        html += '<div class="swatch-chip" style="background:' + hex + ';" data-hex="' + hex + '" data-idx="' + idx + '" title="' + hex + '">' +
          '<span class="swatch-remove" data-idx="' + idx + '" data-storage="' + storageKey + '" data-container="' + containerId + '" data-empty="' + emptyMsg.replace(/"/g, "&quot;") + '">✕</span>' +
          '<span class="swatch-hex-tip">' + hex + '</span></div>';
      });
      grid.innerHTML = html;

      // Click to copy hex + apply fill instantly
      grid.querySelectorAll(".swatch-chip").forEach((chip) => {
        chip.addEventListener("click", (ev) => {
          if (ev.target.classList.contains("swatch-remove")) return;
          const hex = chip.dataset.hex;
          if (hex) {
            try { navigator.clipboard.writeText(hex); } catch (ce) { auditFallback("MAIN_RENDERSWATCHES_002", ce); }
            if (colorPicker) colorPicker.value = hex;
            if (hexInput) hexInput.value = hex;
            addColorToStorage("compXRecentColors", hex, 20);
            renderSwatches("recentColorGrid", "compXRecentColors", "No recent colors.");
            runTool('ae_applyColor("fill","' + hex + '")', "Fill applied: " + hex);
          }
        });
      });

      // Remove button handler (delegated)
      grid.addEventListener("click", (ev) => {
        const removeBtn = ev.target.closest(".swatch-remove");
        if (!removeBtn) return;
        const idx = Number(removeBtn.dataset.idx);
        const storageKey2 = removeBtn.dataset.storage;
        const containerId2 = removeBtn.dataset.container;
        const emptyMsg2 = removeBtn.dataset.empty;
        let colors2 = [];
        try { colors2 = JSON.parse(localStorage.getItem(storageKey2)) || []; } catch (e) { auditFallback("MAIN_RENDERSWATCHES_003", e); }
        if (idx >= 0 && idx < colors2.length) {
          colors2.splice(idx, 1);
          localStorage.setItem(storageKey2, JSON.stringify(colors2));
          renderSwatches(containerId2, storageKey2, emptyMsg2);
        }
      });
    }

    function addColorToStorage(storageKey, hex, max) {
      let colors = [];
      try { colors = JSON.parse(localStorage.getItem(storageKey)) || []; } catch (e) { auditFallback("MAIN_ADDCOLORTOSTORAGE_001", e); }
      colors = colors.filter((c) => c !== hex);
      colors.unshift(hex);
      if (colors.length > max) colors = colors.slice(0, max);
      localStorage.setItem(storageKey, JSON.stringify(colors));
    }

    function refreshColorUI() {
      renderSwatches("swatchGrid", "compXSwatches", "No swatches saved yet. Pick a color and click \"Save Swatch\".");
      renderSwatches("recentColorGrid", "compXRecentColors", "No recent colors.");
    }

    // Pick color from layer
    const btnPick = document.getElementById("btnColorPickFromLayer");
    if (btnPick) {
      btnPick.addEventListener("click", () => {
        callHost("ae_pickLayerColor()", (parsed) => {
          if (parsed.success && parsed.data) {
            const hex = String(parsed.data).toLowerCase();
            if (colorPicker) colorPicker.value = hex;
            if (hexInput) hexInput.value = hex;
            addColorToStorage("compXRecentColors", hex, 20);
            refreshColorUI();
            showToast("Picked " + hex);
          } else {
            showToast(parsed.message || "Could not pick color", true);
          }
        });
      });
    }

    // Apply Fill
    const btnApply = document.getElementById("btnColorApplyFill");
    if (btnApply) {
      btnApply.addEventListener("click", () => {
        const hex = getColorFromPicker();
        addColorToStorage("compXRecentColors", hex, 20);
        refreshColorUI();
        runTool('ae_applyColor("fill","' + hex + '")', "Fill applied");
      });
    }

    // Apply Solid
    const btnSolid = document.getElementById("btnColorApplySolid");
    if (btnSolid) {
      btnSolid.addEventListener("click", () => {
        const hex = getColorFromPicker();
        addColorToStorage("compXRecentColors", hex, 20);
        refreshColorUI();
        runTool('ae_applyColor("solid","' + hex + '")', "Solid color applied");
      });
    }

    // Save Swatch
    const btnSave = document.getElementById("btnColorSaveSwatch");
    if (btnSave) {
      btnSave.addEventListener("click", () => {
        const hex = getColorFromPicker();
        addColorToStorage("compXSwatches", hex, 48);
        addColorToStorage("compXRecentColors", hex, 20);
        refreshColorUI();
        showToast("Saved " + hex);
      });
    }

    // Clear Swatches
    const btnClearSwatches = document.getElementById("btnClearSwatches");
    if (btnClearSwatches) {
      btnClearSwatches.addEventListener("click", () => {
        localStorage.removeItem("compXSwatches");
        refreshColorUI();
        showToast("Swatches cleared");
      });
    }

    // Clear Recent
    const btnClearRecent = document.getElementById("btnClearRecent");
    if (btnClearRecent) {
      btnClearRecent.addEventListener("click", () => {
        localStorage.removeItem("compXRecentColors");
        refreshColorUI();
        showToast("Recent colors cleared");
      });
    }

    // ---------------- Color Library ----------------
    var GRADIENT_LIBRARY = [{"name": "Blend 001", "c1": "#EA2A2A", "c2": "#D1511A"}, {"name": "Blend 002", "c1": "#EA602A", "c2": "#EAC953"}, {"name": "Blend 003", "c1": "#EA972A", "c2": "#81D11A"}, {"name": "Blend 004", "c1": "#EACD2A", "c2": "#5FEA53"}, {"name": "Blend 005", "c1": "#D0EA2A", "c2": "#81D11A"}, {"name": "Blend 006", "c1": "#9AEA2A", "c2": "#5FEA53"}, {"name": "Blend 007", "c1": "#63EA2A", "c2": "#1AD181"}, {"name": "Blend 008", "c1": "#2DEA2A", "c2": "#53E2EA"}, {"name": "Blend 009", "c1": "#2AEA5D", "c2": "#1AD181"}, {"name": "Blend 010", "c1": "#2AEA93", "c2": "#53E2EA"}, {"name": "Blend 011", "c1": "#2AEACA", "c2": "#1A51D1"}, {"name": "Blend 012", "c1": "#2AD3EA", "c2": "#6E53EA"}, {"name": "Blend 013", "c1": "#2A9DEA", "c2": "#1A51D1"}, {"name": "Blend 014", "c1": "#2A66EA", "c2": "#6E53EA"}, {"name": "Blend 015", "c1": "#2A30EA", "c2": "#B21AD1"}, {"name": "Blend 016", "c1": "#5A2AEA", "c2": "#EA53BA"}, {"name": "Blend 017", "c1": "#902AEA", "c2": "#B21AD1"}, {"name": "Blend 018", "c1": "#C72AEA", "c2": "#EA53BA"}, {"name": "Blend 019", "c1": "#EA2AD7", "c2": "#D11A20"}, {"name": "Blend 020", "c1": "#EA2AA0", "c2": "#EA9753"}, {"name": "Blend 021", "c1": "#EA2A6A", "c2": "#D11A20"}, {"name": "Blend 022", "c1": "#EA2A33", "c2": "#EA9753"}, {"name": "Blend 023", "c1": "#EA562A", "c2": "#BED11A"}, {"name": "Blend 024", "c1": "#EA8D2A", "c2": "#92EA53"}, {"name": "Blend 025", "c1": "#EAC32A", "c2": "#BED11A"}, {"name": "Blend 026", "c1": "#DAEA2A", "c2": "#92EA53"}, {"name": "Blend 027", "c1": "#A3EA2A", "c2": "#1AD145"}, {"name": "Blend 028", "c1": "#6DEA2A", "c2": "#53EABF"}, {"name": "Blend 029", "c1": "#36EA2A", "c2": "#1AD145"}, {"name": "Blend 030", "c1": "#2AEA53", "c2": "#53EABF"}, {"name": "Blend 031", "c1": "#2AEA8A", "c2": "#1A8ED1"}, {"name": "Blend 032", "c1": "#2AEAC0", "c2": "#5369EA"}, {"name": "Blend 033", "c1": "#2ADDEA", "c2": "#1A8ED1"}, {"name": "Blend 034", "c1": "#2AA7EA", "c2": "#5369EA"}, {"name": "Blend 035", "c1": "#2A70EA", "c2": "#751AD1"}, {"name": "Blend 036", "c1": "#2A3AEA", "c2": "#E753EA"}, {"name": "Blend 037", "c1": "#502AEA", "c2": "#751AD1"}, {"name": "Blend 038", "c1": "#862AEA", "c2": "#E753EA"}, {"name": "Blend 039", "c1": "#BD2AEA", "c2": "#D11A5D"}, {"name": "Blend 040", "c1": "#EA2AE0", "c2": "#EA6453"}, {"name": "Blend 041", "c1": "#EA2AAA", "c2": "#D11A5D"}, {"name": "Blend 042", "c1": "#EA2A73", "c2": "#EA6453"}, {"name": "Blend 043", "c1": "#EA2A3D", "c2": "#D1A61A"}, {"name": "Blend 044", "c1": "#EA4D2A", "c2": "#C4EA53"}, {"name": "Blend 045", "c1": "#EA832A", "c2": "#D1A61A"}, {"name": "Blend 046", "c1": "#EABA2A", "c2": "#C4EA53"}, {"name": "Blend 047", "c1": "#E3EA2A", "c2": "#2CD11A"}, {"name": "Blend 048", "c1": "#ADEA2A", "c2": "#53EA8C"}, {"name": "Blend 049", "c1": "#76EA2A", "c2": "#2CD11A"}, {"name": "Blend 050", "c1": "#40EA2A", "c2": "#53EA8C"}, {"name": "Blend 051", "c1": "#2AEA4A", "c2": "#1ACBD1"}, {"name": "Blend 052", "c1": "#2AEA80", "c2": "#539CEA"}, {"name": "Blend 053", "c1": "#2AEAB7", "c2": "#1ACBD1"}, {"name": "Blend 054", "c1": "#2AE7EA", "c2": "#539CEA"}, {"name": "Blend 055", "c1": "#2AB0EA", "c2": "#381AD1"}, {"name": "Blend 056", "c1": "#2A7AEA", "c2": "#B553EA"}, {"name": "Blend 057", "c1": "#2A43EA", "c2": "#381AD1"}, {"name": "Blend 058", "c1": "#462AEA", "c2": "#B553EA"}, {"name": "Blend 059", "c1": "#7D2AEA", "c2": "#D11A9A"}, {"name": "Blend 060", "c1": "#B32AEA", "c2": "#EA5373"}, {"name": "Blend 061", "c1": "#EA2AEA", "c2": "#D11A9A"}, {"name": "Blend 062", "c1": "#EA2AB3", "c2": "#EA5373"}, {"name": "Blend 063", "c1": "#EA2A7D", "c2": "#D1691A"}, {"name": "Blend 064", "c1": "#EA2A46", "c2": "#EADD53"}, {"name": "Blend 065", "c1": "#EA432A", "c2": "#D1691A"}, {"name": "Blend 066", "c1": "#EA7A2A", "c2": "#EADD53"}, {"name": "Blend 067", "c1": "#EAB02A", "c2": "#69D11A"}, {"name": "Blend 068", "c1": "#EAE72A", "c2": "#53EA5A"}, {"name": "Blend 069", "c1": "#B7EA2A", "c2": "#69D11A"}, {"name": "Blend 070", "c1": "#80EA2A", "c2": "#53EA5A"}, {"name": "Blend 071", "c1": "#4AEA2A", "c2": "#1AD19A"}, {"name": "Blend 072", "c1": "#2AEA40", "c2": "#53CEEA"}, {"name": "Blend 073", "c1": "#2AEA76", "c2": "#1AD19A"}, {"name": "Blend 074", "c1": "#2AEAAD", "c2": "#53CEEA"}, {"name": "Blend 075", "c1": "#2AEAE3", "c2": "#1A38D1"}, {"name": "Blend 076", "c1": "#2ABAEA", "c2": "#8253EA"}, {"name": "Blend 077", "c1": "#2A83EA", "c2": "#1A38D1"}, {"name": "Blend 078", "c1": "#2A4DEA", "c2": "#8253EA"}, {"name": "Blend 079", "c1": "#3D2AEA", "c2": "#CB1AD1"}, {"name": "Blend 080", "c1": "#732AEA", "c2": "#EA53A6"}, {"name": "Blend 081", "c1": "#AA2AEA", "c2": "#CB1AD1"}, {"name": "Blend 082", "c1": "#E02AEA", "c2": "#EA53A6"}, {"name": "Blend 083", "c1": "#EA2ABD", "c2": "#D12C1A"}, {"name": "Blend 084", "c1": "#EA2A86", "c2": "#EAAB53"}, {"name": "Blend 085", "c1": "#EA2A50", "c2": "#D12C1A"}, {"name": "Blend 086", "c1": "#EA3A2A", "c2": "#EAAB53"}, {"name": "Blend 087", "c1": "#EA702A", "c2": "#A6D11A"}, {"name": "Blend 088", "c1": "#EAA72A", "c2": "#7DEA53"}, {"name": "Blend 089", "c1": "#EADD2A", "c2": "#A6D11A"}, {"name": "Blend 090", "c1": "#C0EA2A", "c2": "#7DEA53"}, {"name": "Blend 091", "c1": "#8AEA2A", "c2": "#1AD15D"}, {"name": "Blend 092", "c1": "#53EA2A", "c2": "#53EAD3"}, {"name": "Blend 093", "c1": "#2AEA36", "c2": "#1AD15D"}, {"name": "Blend 094", "c1": "#2AEA6D", "c2": "#53EAD3"}, {"name": "Blend 095", "c1": "#2AEAA3", "c2": "#1A75D1"}, {"name": "Blend 096", "c1": "#2AEADA", "c2": "#5355EA"}, {"name": "Blend 097", "c1": "#2AC3EA", "c2": "#1A75D1"}, {"name": "Blend 098", "c1": "#2A8DEA", "c2": "#5355EA"}, {"name": "Blend 099", "c1": "#2A56EA", "c2": "#8E1AD1"}, {"name": "Blend 100", "c1": "#332AEA", "c2": "#EA53D8"}, {"name": "Blend 101", "c1": "#6A2AEA", "c2": "#8E1AD1"}, {"name": "Blend 102", "c1": "#A02AEA", "c2": "#EA53D8"}, {"name": "Blend 103", "c1": "#D72AEA", "c2": "#D11A45"}, {"name": "Blend 104", "c1": "#EA2AC7", "c2": "#EA7853"}, {"name": "Blend 105", "c1": "#EA2A90", "c2": "#D11A45"}, {"name": "Blend 106", "c1": "#EA2A5A", "c2": "#EA7853"}, {"name": "Blend 107", "c1": "#EA302A", "c2": "#D1BE1A"}, {"name": "Blend 108", "c1": "#EA662A", "c2": "#B0EA53"}, {"name": "Blend 109", "c1": "#EA9D2A", "c2": "#D1BE1A"}, {"name": "Blend 110", "c1": "#EAD32A", "c2": "#B0EA53"}, {"name": "Blend 111", "c1": "#CAEA2A", "c2": "#1AD120"}, {"name": "Blend 112", "c1": "#93EA2A", "c2": "#53EAA1"}, {"name": "Blend 113", "c1": "#5DEA2A", "c2": "#1AD120"}, {"name": "Blend 114", "c1": "#2AEA2D", "c2": "#53EAA1"}, {"name": "Blend 115", "c1": "#2AEA63", "c2": "#1AB2D1"}, {"name": "Blend 116", "c1": "#2AEA9A", "c2": "#5387EA"}, {"name": "Blend 117", "c1": "#2AEAD0", "c2": "#1AB2D1"}, {"name": "Blend 118", "c1": "#2ACDEA", "c2": "#5387EA"}, {"name": "Blend 119", "c1": "#2A97EA", "c2": "#511AD1"}, {"name": "Blend 120", "c1": "#2A60EA", "c2": "#C953EA"}, {"name": "Blend 121", "c1": "#2A2AEA", "c2": "#511AD1"}, {"name": "Blend 122", "c1": "#602AEA", "c2": "#C953EA"}, {"name": "Blend 123", "c1": "#972AEA", "c2": "#D11A81"}, {"name": "Blend 124", "c1": "#CD2AEA", "c2": "#EA535F"}, {"name": "Blend 125", "c1": "#EA2AD0", "c2": "#D11A81"}, {"name": "Blend 126", "c1": "#EA2A9A", "c2": "#EA535F"}, {"name": "Blend 127", "c1": "#EA2A63", "c2": "#D1811A"}, {"name": "Blend 128", "c1": "#EA2A2D", "c2": "#E2EA53"}, {"name": "Blend 129", "c1": "#EA5D2A", "c2": "#D1811A"}, {"name": "Blend 130", "c1": "#EA932A", "c2": "#E2EA53"}, {"name": "Blend 131", "c1": "#EACA2A", "c2": "#51D11A"}, {"name": "Blend 132", "c1": "#D3EA2A", "c2": "#53EA6E"}, {"name": "Blend 133", "c1": "#9DEA2A", "c2": "#51D11A"}, {"name": "Blend 134", "c1": "#66EA2A", "c2": "#53EA6E"}, {"name": "Blend 135", "c1": "#30EA2A", "c2": "#1AD1B2"}, {"name": "Blend 136", "c1": "#2AEA5A", "c2": "#53BAEA"}, {"name": "Blend 137", "c1": "#2AEA90", "c2": "#1AD1B2"}, {"name": "Blend 138", "c1": "#2AEAC7", "c2": "#53BAEA"}, {"name": "Blend 139", "c1": "#2AD7EA", "c2": "#1A20D1"}, {"name": "Blend 140", "c1": "#2AA0EA", "c2": "#9753EA"}, {"name": "Blend 141", "c1": "#2A6AEA", "c2": "#1A20D1"}, {"name": "Blend 142", "c1": "#2A33EA", "c2": "#9753EA"}, {"name": "Blend 143", "c1": "#562AEA", "c2": "#D11ABE"}, {"name": "Blend 144", "c1": "#8D2AEA", "c2": "#EA5392"}, {"name": "Blend 145", "c1": "#C32AEA", "c2": "#D11ABE"}, {"name": "Blend 146", "c1": "#EA2ADA", "c2": "#EA5392"}, {"name": "Blend 147", "c1": "#EA2AA3", "c2": "#D1451A"}, {"name": "Blend 148", "c1": "#EA2A6D", "c2": "#EABF53"}, {"name": "Blend 149", "c1": "#EA2A36", "c2": "#D1451A"}, {"name": "Blend 150", "c1": "#EA532A", "c2": "#EABF53"}, {"name": "Blend 151", "c1": "#EA8A2A", "c2": "#8ED11A"}, {"name": "Blend 152", "c1": "#EAC02A", "c2": "#69EA53"}, {"name": "Blend 153", "c1": "#DDEA2A", "c2": "#8ED11A"}, {"name": "Blend 154", "c1": "#A7EA2A", "c2": "#69EA53"}, {"name": "Blend 155", "c1": "#70EA2A", "c2": "#1AD175"}, {"name": "Blend 156", "c1": "#3AEA2A", "c2": "#53EAE7"}, {"name": "Blend 157", "c1": "#2AEA50", "c2": "#1AD175"}, {"name": "Blend 158", "c1": "#2AEA86", "c2": "#53EAE7"}, {"name": "Blend 159", "c1": "#2AEABD", "c2": "#1A5DD1"}, {"name": "Blend 160", "c1": "#2AE0EA", "c2": "#6453EA"}, {"name": "Blend 161", "c1": "#2AAAEA", "c2": "#1A5DD1"}, {"name": "Blend 162", "c1": "#2A73EA", "c2": "#6453EA"}, {"name": "Blend 163", "c1": "#2A3DEA", "c2": "#A61AD1"}, {"name": "Blend 164", "c1": "#4D2AEA", "c2": "#EA53C4"}, {"name": "Blend 165", "c1": "#832AEA", "c2": "#A61AD1"}, {"name": "Blend 166", "c1": "#BA2AEA", "c2": "#EA53C4"}, {"name": "Blend 167", "c1": "#EA2AE3", "c2": "#D11A2C"}, {"name": "Blend 168", "c1": "#EA2AAD", "c2": "#EA8C53"}, {"name": "Blend 169", "c1": "#EA2A76", "c2": "#D11A2C"}, {"name": "Blend 170", "c1": "#EA2A40", "c2": "#EA8C53"}, {"name": "Blend 171", "c1": "#EA4A2A", "c2": "#CBD11A"}, {"name": "Blend 172", "c1": "#EA802A", "c2": "#9CEA53"}, {"name": "Blend 173", "c1": "#EAB72A", "c2": "#CBD11A"}, {"name": "Blend 174", "c1": "#E7EA2A", "c2": "#9CEA53"}, {"name": "Blend 175", "c1": "#B0EA2A", "c2": "#1AD138"}, {"name": "Blend 176", "c1": "#7AEA2A", "c2": "#53EAB5"}, {"name": "Blend 177", "c1": "#43EA2A", "c2": "#1AD138"}, {"name": "Blend 178", "c1": "#2AEA46", "c2": "#53EAB5"}, {"name": "Blend 179", "c1": "#2AEA7D", "c2": "#1A9AD1"}, {"name": "Blend 180", "c1": "#2AEAB3", "c2": "#5373EA"}, {"name": "Blend 181", "c1": "#2AEAEA", "c2": "#1A9AD1"}, {"name": "Blend 182", "c1": "#2AB3EA", "c2": "#5373EA"}, {"name": "Blend 183", "c1": "#2A7DEA", "c2": "#691AD1"}, {"name": "Blend 184", "c1": "#2A46EA", "c2": "#DD53EA"}, {"name": "Blend 185", "c1": "#432AEA", "c2": "#691AD1"}, {"name": "Blend 186", "c1": "#7A2AEA", "c2": "#DD53EA"}, {"name": "Blend 187", "c1": "#B02AEA", "c2": "#D11A69"}, {"name": "Blend 188", "c1": "#E72AEA", "c2": "#EA5A53"}, {"name": "Blend 189", "c1": "#EA2AB7", "c2": "#D11A69"}, {"name": "Blend 190", "c1": "#EA2A80", "c2": "#EA5A53"}, {"name": "Blend 191", "c1": "#EA2A4A", "c2": "#D19A1A"}, {"name": "Blend 192", "c1": "#EA402A", "c2": "#CEEA53"}, {"name": "Blend 193", "c1": "#EA762A", "c2": "#D19A1A"}, {"name": "Blend 194", "c1": "#EAAD2A", "c2": "#CEEA53"}, {"name": "Blend 195", "c1": "#EAE32A", "c2": "#38D11A"}, {"name": "Blend 196", "c1": "#BAEA2A", "c2": "#53EA82"}, {"name": "Blend 197", "c1": "#83EA2A", "c2": "#38D11A"}, {"name": "Blend 198", "c1": "#4DEA2A", "c2": "#53EA82"}, {"name": "Blend 199", "c1": "#2AEA3D", "c2": "#1AD1CB"}, {"name": "Blend 200", "c1": "#2AEA73", "c2": "#53A6EA"}, {"name": "Blend 201", "c1": "#2AEAAA", "c2": "#1AD1CB"}, {"name": "Blend 202", "c1": "#2AEAE0", "c2": "#53A6EA"}, {"name": "Blend 203", "c1": "#2ABDEA", "c2": "#2C1AD1"}, {"name": "Blend 204", "c1": "#2A86EA", "c2": "#AB53EA"}, {"name": "Blend 205", "c1": "#2A50EA", "c2": "#2C1AD1"}, {"name": "Blend 206", "c1": "#3A2AEA", "c2": "#AB53EA"}, {"name": "Blend 207", "c1": "#702AEA", "c2": "#D11AA6"}, {"name": "Blend 208", "c1": "#A72AEA", "c2": "#EA537D"}, {"name": "Blend 209", "c1": "#DD2AEA", "c2": "#D11AA6"}, {"name": "Blend 210", "c1": "#EA2AC0", "c2": "#EA537D"}, {"name": "Blend 211", "c1": "#EA2A8A", "c2": "#D15D1A"}, {"name": "Blend 212", "c1": "#EA2A53", "c2": "#EAD353"}, {"name": "Blend 213", "c1": "#EA362A", "c2": "#D15D1A"}, {"name": "Blend 214", "c1": "#EA6D2A", "c2": "#EAD353"}, {"name": "Blend 215", "c1": "#EAA32A", "c2": "#75D11A"}, {"name": "Blend 216", "c1": "#EADA2A", "c2": "#55EA53"}, {"name": "Blend 217", "c1": "#C3EA2A", "c2": "#75D11A"}, {"name": "Blend 218", "c1": "#8DEA2A", "c2": "#55EA53"}, {"name": "Blend 219", "c1": "#56EA2A", "c2": "#1AD18E"}, {"name": "Blend 220", "c1": "#2AEA33", "c2": "#53D8EA"}];
    var GRADIENT_4_LIBRARY = [{"name": "Fusion 001", "c1": "#C00C0C", "c2": "#EE5A1B", "c3": "#EDBA45", "c4": "#D5ED78"}, {"name": "Fusion 002", "c1": "#C0450C", "c2": "#EE9D1B", "c3": "#EAED45", "c4": "#B1ED78"}, {"name": "Fusion 003", "c1": "#C07E0C", "c2": "#EEE01B", "c3": "#B5ED45", "c4": "#8CED78"}, {"name": "Fusion 004", "c1": "#C0B70C", "c2": "#B9EE1B", "c3": "#80ED45", "c4": "#78ED8A"}, {"name": "Fusion 005", "c1": "#90C00C", "c2": "#77EE1B", "c3": "#4BED45", "c4": "#78EDAF"}, {"name": "Fusion 006", "c1": "#57C00C", "c2": "#34EE1B", "c3": "#45ED75", "c4": "#78EDD3"}, {"name": "Fusion 007", "c1": "#1EC00C", "c2": "#1BEE45", "c3": "#45EDAA", "c4": "#78E1ED"}, {"name": "Fusion 008", "c1": "#0CC033", "c2": "#1BEE88", "c3": "#45EDDF", "c4": "#78BCED"}, {"name": "Fusion 009", "c1": "#0CC06C", "c2": "#1BEECB", "c3": "#45C6ED", "c4": "#7897ED"}, {"name": "Fusion 010", "c1": "#0CC0A5", "c2": "#1BCEEE", "c3": "#4591ED", "c4": "#7E78ED"}, {"name": "Fusion 011", "c1": "#0CA2C0", "c2": "#1B8CEE", "c3": "#455CED", "c4": "#A378ED"}, {"name": "Fusion 012", "c1": "#0C69C0", "c2": "#1B49EE", "c3": "#6445ED", "c4": "#C878ED"}, {"name": "Fusion 013", "c1": "#0C30C0", "c2": "#301BEE", "c3": "#9945ED", "c4": "#ED78ED"}, {"name": "Fusion 014", "c1": "#210CC0", "c2": "#731BEE", "c3": "#CE45ED", "c4": "#ED78C8"}, {"name": "Fusion 015", "c1": "#5A0CC0", "c2": "#B61BEE", "c3": "#ED45D6", "c4": "#ED78A3"}, {"name": "Fusion 016", "c1": "#930CC0", "c2": "#EE1BE3", "c3": "#ED45A1", "c4": "#ED787E"}, {"name": "Fusion 017", "c1": "#C00CB4", "c2": "#EE1BA1", "c3": "#ED456C", "c4": "#ED9778"}, {"name": "Fusion 018", "c1": "#C00C7B", "c2": "#EE1B5E", "c3": "#ED5345", "c4": "#EDBC78"}, {"name": "Fusion 019", "c1": "#C00C42", "c2": "#EE1B1B", "c3": "#ED8845", "c4": "#EDE178"}, {"name": "Fusion 020", "c1": "#C00F0C", "c2": "#EE5E1B", "c3": "#EDBD45", "c4": "#D3ED78"}, {"name": "Fusion 021", "c1": "#C0480C", "c2": "#EEA11B", "c3": "#E7ED45", "c4": "#AFED78"}, {"name": "Fusion 022", "c1": "#C0810C", "c2": "#EEE31B", "c3": "#B2ED45", "c4": "#8AED78"}, {"name": "Fusion 023", "c1": "#C0BA0C", "c2": "#B6EE1B", "c3": "#7DED45", "c4": "#78ED8C"}, {"name": "Fusion 024", "c1": "#8DC00C", "c2": "#73EE1B", "c3": "#48ED45", "c4": "#78EDB1"}, {"name": "Fusion 025", "c1": "#54C00C", "c2": "#30EE1B", "c3": "#45ED78", "c4": "#78EDD5"}, {"name": "Fusion 026", "c1": "#1BC00C", "c2": "#1BEE49", "c3": "#45EDAD", "c4": "#78DFED"}, {"name": "Fusion 027", "c1": "#0CC036", "c2": "#1BEE8C", "c3": "#45EDE1", "c4": "#78BAED"}, {"name": "Fusion 028", "c1": "#0CC06F", "c2": "#1BEECE", "c3": "#45C3ED", "c4": "#7895ED"}, {"name": "Fusion 029", "c1": "#0CC0A8", "c2": "#1BCBEE", "c3": "#458EED", "c4": "#8078ED"}, {"name": "Fusion 030", "c1": "#0C9FC0", "c2": "#1B88EE", "c3": "#4559ED", "c4": "#A578ED"}, {"name": "Fusion 031", "c1": "#0C66C0", "c2": "#1B45EE", "c3": "#6745ED", "c4": "#CA78ED"}, {"name": "Fusion 032", "c1": "#0C2DC0", "c2": "#341BEE", "c3": "#9C45ED", "c4": "#ED78EB"}, {"name": "Fusion 033", "c1": "#240CC0", "c2": "#771BEE", "c3": "#D145ED", "c4": "#ED78C6"}, {"name": "Fusion 034", "c1": "#5D0CC0", "c2": "#B91BEE", "c3": "#ED45D4", "c4": "#ED78A1"}, {"name": "Fusion 035", "c1": "#960CC0", "c2": "#EE1BE0", "c3": "#ED459F", "c4": "#ED787C"}, {"name": "Fusion 036", "c1": "#C00CB1", "c2": "#EE1B9D", "c3": "#ED456A", "c4": "#ED9978"}, {"name": "Fusion 037", "c1": "#C00C78", "c2": "#EE1B5A", "c3": "#ED5645", "c4": "#EDBE78"}, {"name": "Fusion 038", "c1": "#C00C3F", "c2": "#EE1F1B", "c3": "#ED8B45", "c4": "#EDE378"}, {"name": "Fusion 039", "c1": "#C0120C", "c2": "#EE621B", "c3": "#EDC045", "c4": "#D2ED78"}, {"name": "Fusion 040", "c1": "#C04B0C", "c2": "#EEA41B", "c3": "#E4ED45", "c4": "#ADED78"}, {"name": "Fusion 041", "c1": "#C0840C", "c2": "#EEE71B", "c3": "#AFED45", "c4": "#88ED78"}, {"name": "Fusion 042", "c1": "#C0BD0C", "c2": "#B2EE1B", "c3": "#7AED45", "c4": "#78ED8E"}, {"name": "Fusion 043", "c1": "#8AC00C", "c2": "#70EE1B", "c3": "#45ED45", "c4": "#78EDB3"}, {"name": "Fusion 044", "c1": "#51C00C", "c2": "#2DEE1B", "c3": "#45ED7A", "c4": "#78EDD7"}, {"name": "Fusion 045", "c1": "#18C00C", "c2": "#1BEE4C", "c3": "#45EDAF", "c4": "#78DDED"}, {"name": "Fusion 046", "c1": "#0CC039", "c2": "#1BEE8F", "c3": "#45EDE4", "c4": "#78B8ED"}, {"name": "Fusion 047", "c1": "#0CC072", "c2": "#1BEED2", "c3": "#45C0ED", "c4": "#7893ED"}, {"name": "Fusion 048", "c1": "#0CC0AB", "c2": "#1BC7EE", "c3": "#458BED", "c4": "#8278ED"}, {"name": "Fusion 049", "c1": "#0C9CC0", "c2": "#1B85EE", "c3": "#4556ED", "c4": "#A778ED"}, {"name": "Fusion 050", "c1": "#0C63C0", "c2": "#1B42EE", "c3": "#6A45ED", "c4": "#CC78ED"}, {"name": "Fusion 051", "c1": "#0C2AC0", "c2": "#371BEE", "c3": "#9F45ED", "c4": "#ED78E9"}, {"name": "Fusion 052", "c1": "#270CC0", "c2": "#7A1BEE", "c3": "#D445ED", "c4": "#ED78C4"}, {"name": "Fusion 053", "c1": "#600CC0", "c2": "#BD1BEE", "c3": "#ED45D1", "c4": "#ED789F"}, {"name": "Fusion 054", "c1": "#990CC0", "c2": "#EE1BDC", "c3": "#ED459C", "c4": "#ED787A"}, {"name": "Fusion 055", "c1": "#C00CAE", "c2": "#EE1B9A", "c3": "#ED4567", "c4": "#ED9B78"}, {"name": "Fusion 056", "c1": "#C00C75", "c2": "#EE1B57", "c3": "#ED5945", "c4": "#EDC078"}, {"name": "Fusion 057", "c1": "#C00C3C", "c2": "#EE221B", "c3": "#ED8E45", "c4": "#EDE578"}, {"name": "Fusion 058", "c1": "#C0150C", "c2": "#EE651B", "c3": "#EDC345", "c4": "#D0ED78"}, {"name": "Fusion 059", "c1": "#C04E0C", "c2": "#EEA81B", "c3": "#E1ED45", "c4": "#ABED78"}, {"name": "Fusion 060", "c1": "#C0870C", "c2": "#EEEA1B", "c3": "#ADED45", "c4": "#86ED78"}, {"name": "Fusion 061", "c1": "#C0C00C", "c2": "#AFEE1B", "c3": "#78ED45", "c4": "#78ED90"}, {"name": "Fusion 062", "c1": "#87C00C", "c2": "#6CEE1B", "c3": "#45ED48", "c4": "#78EDB4"}, {"name": "Fusion 063", "c1": "#4EC00C", "c2": "#29EE1B", "c3": "#45ED7D", "c4": "#78EDD9"}, {"name": "Fusion 064", "c1": "#15C00C", "c2": "#1BEE50", "c3": "#45EDB2", "c4": "#78DBED"}, {"name": "Fusion 065", "c1": "#0CC03C", "c2": "#1BEE93", "c3": "#45EDE7", "c4": "#78B6ED"}, {"name": "Fusion 066", "c1": "#0CC075", "c2": "#1BEED5", "c3": "#45BDED", "c4": "#7892ED"}, {"name": "Fusion 067", "c1": "#0CC0AE", "c2": "#1BC4EE", "c3": "#4588ED", "c4": "#8478ED"}, {"name": "Fusion 068", "c1": "#0C99C0", "c2": "#1B81EE", "c3": "#4553ED", "c4": "#A978ED"}, {"name": "Fusion 069", "c1": "#0C60C0", "c2": "#1B3EEE", "c3": "#6C45ED", "c4": "#CE78ED"}, {"name": "Fusion 070", "c1": "#0C27C0", "c2": "#3B1BEE", "c3": "#A145ED", "c4": "#ED78E7"}, {"name": "Fusion 071", "c1": "#2A0CC0", "c2": "#7E1BEE", "c3": "#D645ED", "c4": "#ED78C2"}, {"name": "Fusion 072", "c1": "#630CC0", "c2": "#C01BEE", "c3": "#ED45CE", "c4": "#ED789D"}, {"name": "Fusion 073", "c1": "#9C0CC0", "c2": "#EE1BD9", "c3": "#ED4599", "c4": "#ED7878"}, {"name": "Fusion 074", "c1": "#C00CAB", "c2": "#EE1B96", "c3": "#ED4564", "c4": "#ED9D78"}, {"name": "Fusion 075", "c1": "#C00C72", "c2": "#EE1B53", "c3": "#ED5C45", "c4": "#EDC278"}, {"name": "Fusion 076", "c1": "#C00C39", "c2": "#EE261B", "c3": "#ED9145", "c4": "#EDE778"}, {"name": "Fusion 077", "c1": "#C0180C", "c2": "#EE691B", "c3": "#EDC645", "c4": "#CEED78"}, {"name": "Fusion 078", "c1": "#C0510C", "c2": "#EEAB1B", "c3": "#DFED45", "c4": "#A9ED78"}, {"name": "Fusion 079", "c1": "#C08A0C", "c2": "#EEEE1B", "c3": "#AAED45", "c4": "#84ED78"}, {"name": "Fusion 080", "c1": "#BDC00C", "c2": "#ABEE1B", "c3": "#75ED45", "c4": "#78ED92"}, {"name": "Fusion 081", "c1": "#84C00C", "c2": "#69EE1B", "c3": "#45ED4B", "c4": "#78EDB6"}, {"name": "Fusion 082", "c1": "#4BC00C", "c2": "#26EE1B", "c3": "#45ED80", "c4": "#78EDDB"}, {"name": "Fusion 083", "c1": "#12C00C", "c2": "#1BEE53", "c3": "#45EDB5", "c4": "#78D9ED"}, {"name": "Fusion 084", "c1": "#0CC03F", "c2": "#1BEE96", "c3": "#45EDEA", "c4": "#78B4ED"}, {"name": "Fusion 085", "c1": "#0CC078", "c2": "#1BEED9", "c3": "#45BAED", "c4": "#7890ED"}, {"name": "Fusion 086", "c1": "#0CC0B1", "c2": "#1BC0EE", "c3": "#4585ED", "c4": "#8678ED"}, {"name": "Fusion 087", "c1": "#0C96C0", "c2": "#1B7EEE", "c3": "#4551ED", "c4": "#AB78ED"}, {"name": "Fusion 088", "c1": "#0C5DC0", "c2": "#1B3BEE", "c3": "#6F45ED", "c4": "#D078ED"}, {"name": "Fusion 089", "c1": "#0C24C0", "c2": "#3E1BEE", "c3": "#A445ED", "c4": "#ED78E5"}, {"name": "Fusion 090", "c1": "#2D0CC0", "c2": "#811BEE", "c3": "#D945ED", "c4": "#ED78C0"}, {"name": "Fusion 091", "c1": "#660CC0", "c2": "#C41BEE", "c3": "#ED45CB", "c4": "#ED789B"}, {"name": "Fusion 092", "c1": "#9F0CC0", "c2": "#EE1BD5", "c3": "#ED4596", "c4": "#ED7A78"}, {"name": "Fusion 093", "c1": "#C00CA8", "c2": "#EE1B93", "c3": "#ED4561", "c4": "#ED9F78"}, {"name": "Fusion 094", "c1": "#C00C6F", "c2": "#EE1B50", "c3": "#ED5E45", "c4": "#EDC478"}, {"name": "Fusion 095", "c1": "#C00C36", "c2": "#EE291B", "c3": "#ED9345", "c4": "#EDE978"}, {"name": "Fusion 096", "c1": "#C01B0C", "c2": "#EE6C1B", "c3": "#EDC845", "c4": "#CCED78"}, {"name": "Fusion 097", "c1": "#C0540C", "c2": "#EEAF1B", "c3": "#DCED45", "c4": "#A7ED78"}, {"name": "Fusion 098", "c1": "#C08D0C", "c2": "#EAEE1B", "c3": "#A7ED45", "c4": "#82ED78"}, {"name": "Fusion 099", "c1": "#BAC00C", "c2": "#A8EE1B", "c3": "#72ED45", "c4": "#78ED93"}, {"name": "Fusion 100", "c1": "#81C00C", "c2": "#65EE1B", "c3": "#45ED4E", "c4": "#78EDB8"}, {"name": "Fusion 101", "c1": "#48C00C", "c2": "#22EE1B", "c3": "#45ED83", "c4": "#78EDDD"}, {"name": "Fusion 102", "c1": "#0FC00C", "c2": "#1BEE57", "c3": "#45EDB8", "c4": "#78D7ED"}, {"name": "Fusion 103", "c1": "#0CC042", "c2": "#1BEE9A", "c3": "#45EDED", "c4": "#78B2ED"}, {"name": "Fusion 104", "c1": "#0CC07B", "c2": "#1BEEDC", "c3": "#45B8ED", "c4": "#788EED"}, {"name": "Fusion 105", "c1": "#0CC0B4", "c2": "#1BBDEE", "c3": "#4583ED", "c4": "#8878ED"}, {"name": "Fusion 106", "c1": "#0C93C0", "c2": "#1B7AEE", "c3": "#454EED", "c4": "#AD78ED"}, {"name": "Fusion 107", "c1": "#0C5AC0", "c2": "#1B37EE", "c3": "#7245ED", "c4": "#D278ED"}, {"name": "Fusion 108", "c1": "#0C21C0", "c2": "#421BEE", "c3": "#A745ED", "c4": "#ED78E3"}, {"name": "Fusion 109", "c1": "#300CC0", "c2": "#851BEE", "c3": "#DC45ED", "c4": "#ED78BE"}, {"name": "Fusion 110", "c1": "#690CC0", "c2": "#C71BEE", "c3": "#ED45C8", "c4": "#ED7899"}, {"name": "Fusion 111", "c1": "#A20CC0", "c2": "#EE1BD2", "c3": "#ED4593", "c4": "#ED7C78"}, {"name": "Fusion 112", "c1": "#C00CA5", "c2": "#EE1B8F", "c3": "#ED455E", "c4": "#EDA178"}, {"name": "Fusion 113", "c1": "#C00C6C", "c2": "#EE1B4C", "c3": "#ED6145", "c4": "#EDC678"}, {"name": "Fusion 114", "c1": "#C00C33", "c2": "#EE2D1B", "c3": "#ED9645", "c4": "#EDEB78"}, {"name": "Fusion 115", "c1": "#C01E0C", "c2": "#EE701B", "c3": "#EDCB45", "c4": "#CAED78"}, {"name": "Fusion 116", "c1": "#C0570C", "c2": "#EEB21B", "c3": "#D9ED45", "c4": "#A5ED78"}, {"name": "Fusion 117", "c1": "#C0900C", "c2": "#E7EE1B", "c3": "#A4ED45", "c4": "#80ED78"}, {"name": "Fusion 118", "c1": "#B7C00C", "c2": "#A4EE1B", "c3": "#6FED45", "c4": "#78ED95"}, {"name": "Fusion 119", "c1": "#7EC00C", "c2": "#62EE1B", "c3": "#45ED51", "c4": "#78EDBA"}, {"name": "Fusion 120", "c1": "#45C00C", "c2": "#1FEE1B", "c3": "#45ED85", "c4": "#78EDDF"}, {"name": "Fusion 121", "c1": "#0CC00C", "c2": "#1BEE5A", "c3": "#45EDBA", "c4": "#78D5ED"}, {"name": "Fusion 122", "c1": "#0CC045", "c2": "#1BEE9D", "c3": "#45EAED", "c4": "#78B1ED"}, {"name": "Fusion 123", "c1": "#0CC07E", "c2": "#1BEEE0", "c3": "#45B5ED", "c4": "#788CED"}, {"name": "Fusion 124", "c1": "#0CC0B7", "c2": "#1BB9EE", "c3": "#4580ED", "c4": "#8A78ED"}, {"name": "Fusion 125", "c1": "#0C90C0", "c2": "#1B77EE", "c3": "#454BED", "c4": "#AF78ED"}, {"name": "Fusion 126", "c1": "#0C57C0", "c2": "#1B34EE", "c3": "#7545ED", "c4": "#D378ED"}, {"name": "Fusion 127", "c1": "#0C1EC0", "c2": "#451BEE", "c3": "#AA45ED", "c4": "#ED78E1"}, {"name": "Fusion 128", "c1": "#330CC0", "c2": "#881BEE", "c3": "#DF45ED", "c4": "#ED78BC"}, {"name": "Fusion 129", "c1": "#6C0CC0", "c2": "#CB1BEE", "c3": "#ED45C6", "c4": "#ED7897"}, {"name": "Fusion 130", "c1": "#A50CC0", "c2": "#EE1BCE", "c3": "#ED4591", "c4": "#ED7E78"}, {"name": "Fusion 131", "c1": "#C00CA2", "c2": "#EE1B8C", "c3": "#ED455C", "c4": "#EDA378"}, {"name": "Fusion 132", "c1": "#C00C69", "c2": "#EE1B49", "c3": "#ED6445", "c4": "#EDC878"}, {"name": "Fusion 133", "c1": "#C00C30", "c2": "#EE301B", "c3": "#ED9945", "c4": "#EDED78"}, {"name": "Fusion 134", "c1": "#C0210C", "c2": "#EE731B", "c3": "#EDCE45", "c4": "#C8ED78"}, {"name": "Fusion 135", "c1": "#C05A0C", "c2": "#EEB61B", "c3": "#D6ED45", "c4": "#A3ED78"}, {"name": "Fusion 136", "c1": "#C0930C", "c2": "#E3EE1B", "c3": "#A1ED45", "c4": "#7EED78"}, {"name": "Fusion 137", "c1": "#B4C00C", "c2": "#A1EE1B", "c3": "#6CED45", "c4": "#78ED97"}, {"name": "Fusion 138", "c1": "#7BC00C", "c2": "#5EEE1B", "c3": "#45ED53", "c4": "#78EDBC"}, {"name": "Fusion 139", "c1": "#42C00C", "c2": "#1BEE1B", "c3": "#45ED88", "c4": "#78EDE1"}, {"name": "Fusion 140", "c1": "#0CC00F", "c2": "#1BEE5E", "c3": "#45EDBD", "c4": "#78D3ED"}, {"name": "Fusion 141", "c1": "#0CC048", "c2": "#1BEEA1", "c3": "#45E7ED", "c4": "#78AFED"}, {"name": "Fusion 142", "c1": "#0CC081", "c2": "#1BEEE3", "c3": "#45B2ED", "c4": "#788AED"}, {"name": "Fusion 143", "c1": "#0CC0BA", "c2": "#1BB6EE", "c3": "#457DED", "c4": "#8C78ED"}, {"name": "Fusion 144", "c1": "#0C8DC0", "c2": "#1B73EE", "c3": "#4548ED", "c4": "#B178ED"}, {"name": "Fusion 145", "c1": "#0C54C0", "c2": "#1B30EE", "c3": "#7845ED", "c4": "#D578ED"}, {"name": "Fusion 146", "c1": "#0C1BC0", "c2": "#491BEE", "c3": "#AD45ED", "c4": "#ED78DF"}, {"name": "Fusion 147", "c1": "#360CC0", "c2": "#8C1BEE", "c3": "#E145ED", "c4": "#ED78BA"}, {"name": "Fusion 148", "c1": "#6F0CC0", "c2": "#CE1BEE", "c3": "#ED45C3", "c4": "#ED7895"}, {"name": "Fusion 149", "c1": "#A80CC0", "c2": "#EE1BCB", "c3": "#ED458E", "c4": "#ED8078"}, {"name": "Fusion 150", "c1": "#C00C9F", "c2": "#EE1B88", "c3": "#ED4559", "c4": "#EDA578"}, {"name": "Fusion 151", "c1": "#C00C66", "c2": "#EE1B45", "c3": "#ED6745", "c4": "#EDCA78"}, {"name": "Fusion 152", "c1": "#C00C2D", "c2": "#EE341B", "c3": "#ED9C45", "c4": "#EBED78"}, {"name": "Fusion 153", "c1": "#C0240C", "c2": "#EE771B", "c3": "#EDD145", "c4": "#C6ED78"}, {"name": "Fusion 154", "c1": "#C05D0C", "c2": "#EEB91B", "c3": "#D4ED45", "c4": "#A1ED78"}, {"name": "Fusion 155", "c1": "#C0960C", "c2": "#E0EE1B", "c3": "#9FED45", "c4": "#7CED78"}, {"name": "Fusion 156", "c1": "#B1C00C", "c2": "#9DEE1B", "c3": "#6AED45", "c4": "#78ED99"}, {"name": "Fusion 157", "c1": "#78C00C", "c2": "#5AEE1B", "c3": "#45ED56", "c4": "#78EDBE"}, {"name": "Fusion 158", "c1": "#3FC00C", "c2": "#1BEE1F", "c3": "#45ED8B", "c4": "#78EDE3"}, {"name": "Fusion 159", "c1": "#0CC012", "c2": "#1BEE62", "c3": "#45EDC0", "c4": "#78D2ED"}, {"name": "Fusion 160", "c1": "#0CC04B", "c2": "#1BEEA4", "c3": "#45E4ED", "c4": "#78ADED"}];
    var SOLID_LIBRARY = ["#520A0A", "#52180A", "#52270A", "#52350A", "#52430A", "#52520A", "#43520A", "#35520A", "#27520A", "#18520A", "#0A520A", "#0A5218", "#0A5227", "#0A5235", "#0A5243", "#0A5252", "#0A4352", "#0A3552", "#0A2752", "#0A1852", "#0A0A52", "#180A52", "#270A52", "#350A52", "#430A52", "#520A52", "#520A43", "#520A35", "#520A27", "#520A18", "#760F0F", "#76230F", "#76380F", "#764D0F", "#76610F", "#76760F", "#61760F", "#4D760F", "#38760F", "#23760F", "#0F760F", "#0F7623", "#0F7638", "#0F764D", "#0F7661", "#0F7676", "#0F6176", "#0F4D76", "#0F3876", "#0F2376", "#0F0F76", "#230F76", "#380F76", "#4D0F76", "#610F76", "#760F76", "#760F61", "#760F4D", "#760F38", "#760F23", "#9A1313", "#9A2E13", "#9A4913", "#9A6413", "#9A7F13", "#9A9A13", "#7F9A13", "#649A13", "#499A13", "#2E9A13", "#139A13", "#139A2E", "#139A49", "#139A64", "#139A7F", "#139A9A", "#137F9A", "#13649A", "#13499A", "#132E9A", "#13139A", "#2E139A", "#49139A", "#64139A", "#7F139A", "#9A139A", "#9A137F", "#9A1364", "#9A1349", "#9A132E", "#BF1818", "#BF3918", "#BF5A18", "#BF7C18", "#BF9D18", "#BFBF18", "#9DBF18", "#7CBF18", "#5ABF18", "#39BF18", "#18BF18", "#18BF39", "#18BF5A", "#18BF7C", "#18BF9D", "#18BFBF", "#189DBF", "#187CBF", "#185ABF", "#1839BF", "#1818BF", "#3918BF", "#5A18BF", "#7C18BF", "#9D18BF", "#BF18BF", "#BF189D", "#BF187C", "#BF185A", "#BF1839", "#E31C1C", "#E3441C", "#E36C1C", "#E3931C", "#E3BB1C", "#E3E31C", "#BBE31C", "#93E31C", "#6CE31C", "#44E31C", "#1CE31C", "#1CE344", "#1CE36C", "#1CE393", "#1CE3BB", "#1CE3E3", "#1CBBE3", "#1C93E3", "#1C6CE3", "#1C44E3", "#1C1CE3", "#441CE3", "#6C1CE3", "#931CE3", "#BB1CE3", "#E31CE3", "#E31CBB", "#E31C93", "#E31C6C", "#E31C44", "#E74040", "#E76240", "#E78340", "#E7A540", "#E7C640", "#E7E740", "#C6E740", "#A5E740", "#83E740", "#62E740", "#40E740", "#40E762", "#40E783", "#40E7A5", "#40E7C6", "#40E7E7", "#40C6E7", "#40A5E7", "#4083E7", "#4062E7", "#4040E7", "#6240E7", "#8340E7", "#A540E7", "#C640E7", "#E740E7", "#E740C6", "#E740A5", "#E74083", "#E74062", "#FFFFFF", "#F8FAFC", "#E2E8F0", "#CBD5E1", "#94A3B8", "#64748B", "#475569", "#334155", "#1E293B", "#0F172A", "#000000"];
    window.__compXLibTab = window.__compXLibTab || "solids";

    function applyLibColor(hex) {
      if (colorPicker) colorPicker.value = hex;
      if (hexInput) hexInput.value = hex;
      try { navigator.clipboard.writeText(hex); } catch (e) { auditFallback("MAIN_APPLYLIBCOLOR_001", e); }
      addColorToStorage("compXRecentColors", hex, 20);
      renderSwatches("recentColorGrid", "compXRecentColors", "No recent colors.");
      runTool('ae_applyColor("fill","' + hex + '")', "Fill applied: " + hex);
    }

    function applyLibGradient(g) {
      var cfg = { preset: "2color-linear", c1: g.c1, c2: g.c2, rampType: 1, angle: 0 };
      var payload = JSON.stringify(cfg).replace(/\\/g, "\\\\").replace(/"/g, '\"');
      runTool('ae_applyGradientPlate("' + payload + '")', g.name + " gradient applied");
    }

    function applyLib4ColorGradient(g) {
      var cfg = { preset: "4color", c1: g.c1, c2: g.c2, c3: g.c3, c4: g.c4, rampType: 1, angle: 0 };
      var payload = JSON.stringify(cfg).replace(/\\/g, "\\\\").replace(/"/g, '\"');
      runTool('ae_applyGradientPlate("' + payload + '")', g.name + " 4-color gradient applied");
    }

    function renderColorLibrary() {
      var grid = document.getElementById("colorLibraryGrid");
      if (!grid) return;
      var searchEl = document.getElementById("colorLibSearch");
      var search = searchEl ? String(searchEl.value || "").trim().toLowerCase() : "";
      var tab = window.__compXLibTab || "solids";
      var html = "";
      var shown = 0;
      if (tab === "solids") {
        SOLID_LIBRARY.forEach(function (hex) {
          if (search && hex.toLowerCase().indexOf(search) === -1) return;
          shown++;
          html += '<div class="lib-solid" data-hex="' + hex + '" title="' + hex + ' — click to apply">' +
            '<span class="lib-solid-sw" style="background:' + hex + ';"></span>' +
            '<span class="lib-solid-hex">' + hex + '</span></div>';
        });
      } else if (tab === "gradients4") {
        GRADIENT_4_LIBRARY.forEach(function (g, gi) {
          if (search && g.name.toLowerCase().indexOf(search) === -1) return;
          shown++;
          html += '<div class="lib-grad4" data-g4i="' + gi + '" title="' + g.name + ' — click to apply 4-color gradient">' +
            '<span class="lib-grad-sw" style="background:linear-gradient(135deg,' + g.c1 + ' 0%,' + g.c2 + ' 33%,' + g.c3 + ' 66%,' + g.c4 + ' 100%);"></span>' +
            '<span class="lib-grad-name">' + g.name + '</span></div>';
        });
      } else {
        GRADIENT_LIBRARY.forEach(function (g, gi) {
          if (search && g.name.toLowerCase().indexOf(search) === -1) return;
          shown++;
          html += '<div class="lib-grad" data-gi="' + gi + '" title="' + g.name + ' — click to apply 2-color gradient">' +
            '<span class="lib-grad-sw" style="background:linear-gradient(135deg,' + g.c1 + ',' + g.c2 + ');"></span>' +
            '<span class="lib-grad-name">' + g.name + '</span></div>';
        });
      }
      if (!shown) html = '<div class="studio-empty" style="font-size:11px;grid-column:1/-1;">No matches.</div>';
      grid.innerHTML = html;
      grid.className = tab === "solids" ? "color-library-grid solids-mode" : (tab === "gradients4" ? "color-library-grid grad-mode grad4-mode" : "color-library-grid grad-mode");
    }

    var libGrid = document.getElementById("colorLibraryGrid");
    if (libGrid) {
      libGrid.addEventListener("click", function (ev) {
        var g4 = ev.target.closest(".lib-grad4");
        if (g4) {
          var g4i = Number(g4.dataset.g4i);
          if (GRADIENT_4_LIBRARY[g4i]) applyLib4ColorGradient(GRADIENT_4_LIBRARY[g4i]);
          return;
        }
        var g = ev.target.closest(".lib-grad");
        if (g) {
          var gi = Number(g.dataset.gi);
          if (GRADIENT_LIBRARY[gi]) applyLibGradient(GRADIENT_LIBRARY[gi]);
          return;
        }
        var s = ev.target.closest(".lib-solid");
        if (s && s.dataset.hex) applyLibColor(s.dataset.hex);
      });
    }
    var libSearch = document.getElementById("colorLibSearch");
    if (libSearch) libSearch.addEventListener("input", renderColorLibrary);
    var libFilterRow = document.getElementById("colorLibFilters");
    if (libFilterRow) {
      libFilterRow.addEventListener("click", function (ev) {
        var b = ev.target.closest("[data-lib-tab]");
        if (!b) return;
        window.__compXLibTab = b.dataset.libTab;
        libFilterRow.querySelectorAll("[data-lib-tab]").forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        renderColorLibrary();
      });
    }
    renderColorLibrary();

    refreshColorUI();
  }



  // TEXT STYLE LIBRARY (Library tab)
  function wireTextAnimLibrary() {
    var searchEl = document.getElementById("tanimSearch");
    var listEl = document.getElementById("tanimList");
    if (!listEl) return;

    // Bundled .ffx text-animation presets (files live in presets/text-animations/).
    // `anim` drives the looping visual preview shown on each card.
    var TEXT_STYLES = [
      { id:"alphabetBlink", name:"Alphabet Blink", desc:"Letter-by-letter blink-on reveal", sample:"BLINK", anim:"blink", file:"Alphabet Blink.ffx" },
      { id:"blurUp", name:"Blur Up", desc:"Soft blur rises up into focus", sample:"BLUR", anim:"blur", file:"Blur Up.ffx" },
      { id:"bounceSlideDown", name:"Bounce Slide Down", desc:"Word bounces in sliding downward", sample:"DOWN", anim:"down", file:"Bounce Slide Down Word.ffx" },
      { id:"bounceSlideLeft", name:"Bounce Slide Left", desc:"Word bounces in from the right", sample:"LEFT", anim:"left", file:"Bounce Slide Left Word.ffx" },
      { id:"bounceSlideRight", name:"Bounce Slide Right", desc:"Word bounces in from the left", sample:"RIGHT", anim:"right", file:"Bounce Slide Right Word.ffx" },
      { id:"bounceSlideUp", name:"Bounce Slide Up", desc:"Word bounces in sliding upward", sample:"UP", anim:"up", file:"Bounce Slide Up Word.ffx" },
      { id:"characterDown", name:"Character Down", desc:"Characters drop in one by one", sample:"CHAR", anim:"down", file:"Character Down.ffx" },
      { id:"characterRight", name:"Character Right", desc:"Characters slide in from the left", sample:"CHAR", anim:"right", file:"Character Right.ffx" },
      { id:"eduBounce", name:"Bounce Text", desc:"Playful springy bounce reveal", sample:"BOUNCE", anim:"bounce", file:"EduPohren - Bounce Text.ffx" },
      { id:"fadeUpOut", name:"Fade Up And Out", desc:"Smooth fade up then fade out", sample:"FADE", anim:"fade", file:"Fade Up And Out Smooth.ffx" },
      { id:"letterFlicker", name:"Letter Flicker", desc:"Nervous per-letter flicker-on", sample:"FLICK", anim:"blink", file:"Letter Flicker Text Animation.ffx" },
      { id:"miMainText", name:"Main Text", desc:"Clean punchy main-title pop", sample:"MAIN", anim:"pop", file:"mi main text.ffx" },
      { id:"oneByOne", name:"One By One", desc:"Characters pop in one by one", sample:"1BY1", anim:"pop", file:"OneByOne Text.ffx" },
      { id:"opacityFade", name:"Opacity Fade", desc:"Simple clean opacity fade-in", sample:"FADE", anim:"fade", file:"Opacity Fade.ffx" },
      { id:"rainbowText", name:"Rainbow Text", desc:"Animated rainbow color sweep", sample:"COLOR", anim:"rainbow", file:"Rainbow Text.ffx" },
      { id:"smoothFade", name:"Smooth Fade In/Out", desc:"Gentle fade in and out", sample:"SMOOTH", anim:"fade", file:"Smooth Fade In And Out.ffx" },
      { id:"wordByWordAnim", name:"Word By Word", desc:"Reveals one word at a time", sample:"WORDS", anim:"pop", file:"text animation word by word.ffx" },
      { id:"textBounceDown", name:"Text Bounce Down", desc:"Bouncy drop-in from above", sample:"DOWN", anim:"down", file:"Text Bounce down.ffx" },
      { id:"textBounceUp", name:"Text Bounce Up", desc:"Bouncy rise-in from below", sample:"UP", anim:"up", file:"text Bounce up.ffx" },
      { id:"textBounce", name:"Text Bounce", desc:"Elastic scale bounce reveal", sample:"BOUNCE", anim:"bounce", file:"Text Bounce.ffx" },
      { id:"textFlicker", name:"Text Flicker", desc:"Stylized flicker-on entrance", sample:"FLICK", anim:"blink", file:"Text Flicker.ffx" },
      { id:"textLift", name:"Text Lift", desc:"Smooth cinematic lift up", sample:"LIFT", anim:"up", file:"Text Preset lift.ffx" },
      { id:"textSlideUp", name:"Text Slide Up", desc:"Word slides up into place", sample:"SLIDE", anim:"up", file:"Text Slide Up Word.ffx" },
      { id:"textStyle1", name:"Text Style 1", desc:"Preset style one entrance", sample:"STYLE1", anim:"pop", file:"Text Style 1.ffx" },
      { id:"textStyle2", name:"Text Style 2", desc:"Preset style two entrance", sample:"STYLE2", anim:"bounce", file:"Text Style 2.ffx" },
      { id:"textStyle3", name:"Text Style 3", desc:"Preset style three entrance", sample:"STYLE3", anim:"up", file:"Text Style 3.ffx" },
      { id:"textStyle4", name:"Text Style 4", desc:"Preset style four entrance", sample:"STYLE4", anim:"fade", file:"Text Style 4.ffx" },
      { id:"viralText", name:"Viral Text", desc:"Bold social-ready viral pop", sample:"VIRAL", anim:"pop", file:"VIRAL TEXT ANIMATION.ffx" },
      { id:"wordBlink", name:"Word Blink", desc:"Whole word blinks on", sample:"WORD", anim:"blink", file:"Word Blink.ffx" },
      { id:"wordByWordDown", name:"Word By Word Down", desc:"Each word drops in downward", sample:"DOWN", anim:"down", file:"Word By Word Down.ffx" },
      { id:"wordByWordLeft", name:"Word By Word Left", desc:"Each word slides in from right", sample:"LEFT", anim:"left", file:"Word By Word Left.ffx" },
      { id:"wordByWordRight", name:"Word By Word Right", desc:"Each word slides in from left", sample:"RIGHT", anim:"right", file:"Word By Word Right.ffx" },
      { id:"wordByWordUp", name:"Word By Word Up", desc:"Each word rises in upward", sample:"UP", anim:"up", file:"Word By Word Up.ffx" },
      { id:"wordDown", name:"Word Down", desc:"Word drops in from above", sample:"DOWN", anim:"down", file:"Word Down.ffx" },
      { id:"wordRampBlur", name:"Word Ramp + Blur", desc:"Word ramps up with blur", sample:"RAMP", anim:"blur", file:"word ramp up + blur (1).ffx" },
      { id:"wordRight", name:"Word Right", desc:"Word slides in from the left", sample:"RIGHT", anim:"right", file:"Word Right.ffx" }
    ];

    function esc(str) {
      return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
    }

    function previewChars(sample) {
      return String(sample || "TEXT").slice(0, 7).split("").map(function(ch) {
        return '<span class="tanim-pchar">' + esc(ch) + '</span>';
      }).join('');
    }

    function previewCard(style) {
      return '<div class="tanim-card-preview tanim-fx-' + (style.anim || 'pop') + '">' +
        '<div class="tanim-card-badge">TEXT</div>' +
        '<div class="tanim-card-stage">' +
          '<div class="tanim-card-word">' + previewChars(style.sample || style.name) + '</div>' +
          '<div class="tanim-card-glow"></div>' +
        '</div>' +
      '</div>';
    }

    function render() {
      var q = searchEl ? String(searchEl.value || "").trim().toLowerCase() : "";
      var items = TEXT_STYLES.filter(function(t) {
        return !q || t.name.toLowerCase().indexOf(q) !== -1 || t.desc.toLowerCase().indexOf(q) !== -1;
      });
      if (!items.length) {
        listEl.innerHTML = '<div class="studio-empty" style="grid-column:1/-1;">No text styles found.</div>';
        return;
      }
      listEl.innerHTML = items.map(function(t) {
        return '<div class="tanim-card" data-tanim="' + t.id + '" data-file="' + esc(t.file) + '">' +
          previewCard(t) +
          '<div class="tanim-card-meta">' +
            '<div class="tanim-card-title" title="' + esc(t.name) + '">' + esc(t.name) + '</div>' +
            '<div class="tanim-card-sub">' + esc(t.desc) + '</div>' +
          '</div>' +
          '<div class="tanim-card-actions">' +
            '<button class="tanim-card-btn" data-action="apply">Apply</button>' +
          '</div>' +
        '</div>';
      }).join('');

      listEl.querySelectorAll('[data-tanim]').forEach(function(card) {
        card.addEventListener('click', function(ev) {
          var btn = ev.target.closest('button');
          var action = btn ? btn.getAttribute('data-action') : 'apply';
          if (action !== 'apply' && action !== null) return;
          runTool('ae_applyTextAnimPreset(' + jsStr(card.dataset.file) + ')', card.querySelector('.tanim-card-title').textContent + ' applied');
        });
      });
    }

    if (searchEl) searchEl.addEventListener('input', render);
    render();
  }

  // ---------------- Visual motion libraries & tracker workspace ----------------
  function wireVisualMotionLibraries() {
    const shakes = [
      { id: "micro", name: "Micro Handheld", meta: "1.2 Hz · 8 px", glyph: "⌁" },
      { id: "documentary", name: "Documentary", meta: "2.1 Hz · 14 px", glyph: "≈" },
      { id: "impact", name: "Impact Hit", meta: "6 Hz · 28 px", glyph: "✦" },
      { id: "nervous", name: "Nervous Energy", meta: "5 Hz · 12 px", glyph: "≋" },
      { id: "drift", name: "Slow Drift", meta: "0.45 Hz · 18 px", glyph: "〜" },
      { id: "glitch", name: "Glitch Burst", meta: "12 Hz · 20 px", glyph: "▥" }
    ];
    const expressions = [
      { id: "loop", name: "Loop Cycle", meta: "Repeat selected keys", glyph: "↻" },
      { id: "pingpong", name: "Ping Pong", meta: "Reverse on each loop", glyph: "↔" },
      { id: "wiggle", name: "Organic Wiggle", meta: "3 Hz · 20 units", glyph: "〰" },
      { id: "posterize", name: "Posterize Time", meta: "Stylized 12 fps", glyph: "▦" },
      { id: "hold", name: "Hold & Pop", meta: "Step-style motion", glyph: "▮" },
      { id: "bounce", name: "Velocity Bounce", meta: "Overshoot settle", glyph: "↗" }
    ];
    function renderCards(targetId, items, type) {
      const root = document.getElementById(targetId); if (!root) return;
      root.innerHTML = items.map((item, i) => '<article class="motion-card motion-' + type + '" data-motion="' + item.id + '">' +
        '<div class="motion-preview motion-preview-' + item.id + '"><span class="motion-orb orb-a"></span><span class="motion-orb orb-b"></span><b>' + item.glyph + '</b><i></i></div>' +
        '<div class="motion-card-meta"><strong>' + escapeHtml(item.name) + '</strong><span>' + escapeHtml(item.meta) + '</span></div><button class="tanim-card-btn">Apply</button></article>').join('');
      root.addEventListener('click', (ev) => { const card=ev.target.closest('[data-motion]'); if (!card) return; const id=card.dataset.motion; if (type === 'shake') runTool('ae_applyShakePreset("' + id + '")', 'Shake preset applied'); else runTool('ae_applyExpressionPreset("' + id + '")', 'Expression preset applied'); });
    }
    var FL = window.COMPXLIB || { shakes: [], exprCats: [] };
    (function renderShakes(){
      var root = document.getElementById('shakeList'); if (!root) return;
      root.innerHTML = FL.shakes.map(function(s){ return '<article class="fxlib-card fxlib-shake" data-shake="'+s.id+'"><div class="fxlib-thumb fxlib-anim fxlib-anim-'+s.ch+' fxlib-shake-'+String(s.id).toLowerCase()+'"><span class="fxlib-preview-badge">SHAKE</span><span class="fxlib-trail t1"></span><span class="fxlib-trail t2"></span><span class="fxlib-orb a"></span><span class="fxlib-orb b"></span><span class="fxlib-orb c"></span><b class="fxlib-wave">〰</b></div><div class="fxlib-cardmeta"><strong>'+escapeHtml(s.name)+'</strong><span>'+escapeHtml(s.meta)+'</span></div><button class="fxlib-apply">Apply</button></article>'; }).join('');
      root.onclick = function(ev){ var c=ev.target.closest('[data-shake]'); if(!c) return; runTool('ae_applyShakePreset("'+c.dataset.shake+'")', c.querySelector('strong').textContent+' applied'); };
    })();
    (function renderExpr(){
      var root = document.getElementById('expressionList'); if (!root) return;
      var total = FL.exprCats.reduce(function(a,c){return a+c.items.length;},0);
      if (!document.getElementById('fxlibExprTabs')) {
        var bar = document.createElement('div'); bar.id='fxlibExprTabs'; bar.className='fxlib-cattabs';
        bar.innerHTML = FL.exprCats.map(function(c,i){ return '<button data-cat="'+c.key+'" class="'+(i===0?'active':'')+'">'+escapeHtml(c.label)+'<em>'+c.items.length+'</em></button>'; }).join('');
        var search = document.createElement('input'); search.id='fxlibExprSearch'; search.className='fxlib-search'; search.type='text'; search.placeholder='Search '+total+' expressions...';
        root.parentNode.insertBefore(search, root); root.parentNode.insertBefore(bar, search);
      }
      var bar2 = document.getElementById('fxlibExprTabs');
      var state = { cat: FL.exprCats.length?FL.exprCats[0].key:'', q:'' };
      function exprPreviewKind(e,catKey){
        var s=String((e.name||'')+' '+(e.desc||'')).toLowerCase();
        /* combined/specific behaviors first */
        if(/rgb split/.test(s))return 'rgb';
        if(/glow|electrify/.test(s))return 'glow';
        if(/flicker|strobe|flash|blinking/.test(s))return 'flicker';
        if(/digital noise|signal noise|data corrupt|glitch position|frame stutter/.test(s))return 'glitch';
        if(/heat shimmer|distortion wave/.test(s))return 'wave';
        if(/bounce rotation|bounce spin/.test(s))return 'bounce-rotate';
        if(/bounce scale|bounce full/.test(s))return 'bounce-scale';
        if(/bounce tracking/.test(s))return 'tracking';
        if(/bounce horizontal/.test(s))return 'bounce-x';
        if(/bounce vertical|gravity drop|bouncy drop/.test(s))return 'bounce-y';
        if(/bounce skew|bounce diagonal/.test(s))return 'skew';
        if(/bounce reverse|bounce random|bounce center/.test(s))return 'scatter';
        if(/spiral/.test(s))return 'spiral';
        if(/magnet/.test(s))return 'magnet';
        if(/elastic stretch|squash.*stretch/.test(s))return 'stretch';
        if(/elastic|spring|rubber|jelly|wobble/.test(s))return 'elastic';
        if(/overshoot|arrive.*settle|whip.*settle/.test(s))return 'overshoot';
        if(/typewriter|cursor/.test(s))return 'type';
        if(/percentage|currency|counter|countdown|timer|time display|date display|stopwatch|number/.test(s))return 'counter';
        if(/slot machine|ellipsis loader/.test(s))return 'slot';
        if(/decode|random reveal|word by word/.test(s))return 'reveal';
        if(/tracking|spacing/.test(s))return 'tracking';
        if(/wave characters|sine wave|square wave|triangle wave|sawtooth wave/.test(s))return 'wave';
        if(/pendulum|swing/.test(s))return 'swing';
        if(/rotation|rotate|spin|roll/.test(s))return 'rotate';
        if(/orbit|figure 8/.test(s))return 'orbit';
        if(/look at/.test(s))return 'lookat';
        if(/dolly zoom|zoom pulse/.test(s))return 'zoom';
        if(/scale|squeeze|stretch|pulse|heartbeat|breathing|throb/.test(s))return 'scale';
        if(/x-axis/.test(s))return 'wiggle-x';
        if(/y-axis/.test(s))return 'wiggle-y';
        if(/separate xy/.test(s))return 'wiggle-xy';
        if(/snapping|jumpy|jitter|random jump|stagger/.test(s))return 'step';
        if(/decay wiggle|friction|air drag|inertia/.test(s))return 'decay';
        if(/smooth wiggle|drift|float|hover|wind sway|handheld|camera drift/.test(s))return 'drift';
        if(/wiggle|shake/.test(s))return 'wiggle';
        if(/loop|cycle/.test(s))return 'loop';
        if(/mirror/.test(s))return 'mirror';
        if(/follow|chain|connect|rope/.test(s))return 'follow';
        if(/throw|catch|collision|impact/.test(s))return 'impact';
        if(/slide|parallax/.test(s))return 'slide-x';
        if(/fade|opacity|rack focus|depth fade/.test(s))return 'fade';
        if(/rainbow|color|hue|saturation/.test(s))return 'color';
        if(/pop in|anticipation/.test(s))return 'pop';
        if(/bounce|drop|land/.test(s))return 'bounce';
        if(catKey==='glitch')return 'glitch';
        if(catKey==='physics')return 'bounce';
        if(catKey==='transform')return 'rotate';
        if(catKey==='effects')return 'wave';
        if(catKey==='motion')return 'path';
        return 'text';
      }
      function exprPreviewValue(e,kind){
        var n=String(e.name||'FX');
        if(kind==='counter'){
          if(/percentage/i.test(n))return '75%'; if(/currency/i.test(n))return '$99';
          if(/countdown|timer|time|stopwatch/i.test(n))return '00:10'; return '0123';
        }
        if(kind==='tracking')return 'W I D E';
        if(kind==='color')return 'COLOR';
        if(kind==='glow')return 'GLOW';
        if(kind==='glitch')return 'GLITCH';
        return n.split(/\s+/)[0].slice(0,8).toUpperCase();
      }
      function exprPreview(e,catKey){
        var kind=exprPreviewKind(e,catKey),word=escapeHtml(exprPreviewValue(e,kind));
        return '<div class="fxlib-thumb fxlib-exprthumb expr-'+catKey+' expr-k-'+kind+'" data-preview="'+kind+'">'+
          '<span class="fxlib-preview-badge">'+escapeHtml(kind.replace('-', ' ').toUpperCase())+'</span>'+
          '<span class="expr-gridline gx"></span><span class="expr-gridline gy"></span>'+
          '<div class="expr-word"><i>'+word+'</i><span class="expr-cursor"></span></div>'+
          '<div class="expr-shape"><span></span></div><div class="expr-ball"></div><div class="expr-ground"></div>'+
          '<div class="expr-ring r1"></div><div class="expr-ring r2"></div>'+
          '<div class="expr-rgb red">'+word+'</div><div class="expr-rgb cyan">'+word+'</div>'+
          '<svg class="expr-path" viewBox="0 0 120 55" preserveAspectRatio="none"><path d="M5,43 C25,8 43,48 62,24 S96,7 115,21"/><circle cx="62" cy="24" r="3"/></svg>'+
        '</div>';
      }
      function paint(){
        var cat=FL.exprCats.filter(function(c){return c.key===state.cat;})[0];
        if(!cat){root.innerHTML='';return;}
        var q=state.q.toLowerCase();
        var items=cat.items.filter(function(e){return !q||e.name.toLowerCase().indexOf(q)!==-1||(e.desc||'').toLowerCase().indexOf(q)!==-1;});
        root.__items=items;
        root.innerHTML=items.length?items.map(function(e,idx){
          return '<article class="fxlib-card fxlib-expr" data-idx="'+idx+'">'+exprPreview(e,cat.key)+'<div class="fxlib-cardmeta"><strong>'+escapeHtml(e.name)+'</strong><span>'+escapeHtml(e.desc||'')+'</span></div><button class="fxlib-apply">Apply</button></article>';
        }).join(''):'<div class="studio-empty" style="grid-column:1/-1;">No expressions found.</div>';
      }
      bar2.onclick = function(ev){ var b=ev.target.closest('[data-cat]'); if(!b) return; state.cat=b.dataset.cat; bar2.querySelectorAll('[data-cat]').forEach(function(x){x.classList.remove('active');}); b.classList.add('active'); paint(); };
      document.getElementById('fxlibExprSearch').oninput = function(e){ state.q=e.target.value||''; paint(); };
      root.onclick = function(ev){ var c=ev.target.closest('[data-idx]'); if(!c) return; var it=(root.__items||[])[Number(c.dataset.idx)]; if(!it) return; var enc=encodeURIComponent(it.code).replace(/'/g,'%27'); runTool('ae_applyExpressionCode(\''+enc+'\')', it.name+' applied'); };
      paint();
    })();
  }

  function wireRemoveBg() {
    const color = document.getElementById('bgKeyColor');
    const preview = document.querySelector('.remove-bg-preview');
    if (color && preview) color.addEventListener('input', () => preview.style.setProperty('--key-color', color.value));
    const apply = (soft) => { const hex = color ? color.value : '#00b140'; runTool('ae_removeBackground("' + hex + '",' + (soft ? 'true' : 'false') + ')', soft ? 'Soft Keylight applied' : 'Keylight applied'); };
    const b=document.getElementById('btnRemoveBg'), s=document.getElementById('btnRemoveBgSoft'); if(b)b.addEventListener('click',()=>apply(false)); if(s)s.addEventListener('click',()=>apply(true));
  }

  function wireTrackerWorkspace() {
    const key='compXTrackerWorkspace'; const todoEl=document.getElementById('trackerTodoList'); const input=document.getElementById('trackerTodoInput'); const notes=document.getElementById('trackerNotes'); const count=document.getElementById('trackerNoteCount');
    let state={todos:[], notes:''}; try { state=Object.assign(state, JSON.parse(localStorage.getItem(key)||'{}')); } catch (e) { auditFallback("MAIN_WIRETRACKERWORKSPACE_001", e); }
    const save=()=>localStorage.setItem(key, JSON.stringify(state));
    const words=(text)=>String(text||'').trim().match(/\S+/g)?.length||0;
    function render(){ if(todoEl) todoEl.innerHTML=state.todos.length?state.todos.map((t,i)=>'<label class="tracker-todo '+(t.done?'done':'')+'"><input type="checkbox" data-todo="'+i+'" '+(t.done?'checked':'')+'/><span>'+escapeHtml(t.text)+'</span><button data-delete="'+i+'" title="Delete">×</button></label>').join(''):'<div class="studio-empty">No tasks yet — add your next step.</div>'; if(notes)notes.value=state.notes; if(count)count.textContent=words(state.notes)+' / 500 words'; }
    function add(){const text=(input?.value||'').trim(); if(!text)return; state.todos.push({text:text.slice(0,160),done:false}); input.value='';save();render();}
    document.getElementById('btnTrackerTodoAdd')?.addEventListener('click',add); input?.addEventListener('keydown',(e)=>{if(e.key==='Enter'){e.preventDefault();add();}});
    todoEl?.addEventListener('change',(e)=>{const i=Number(e.target.dataset.todo);if(state.todos[i]){state.todos[i].done=e.target.checked;save();render();}}); todoEl?.addEventListener('click',(e)=>{const i=e.target.dataset.delete;if(i!==undefined){state.todos.splice(Number(i),1);save();render();}});
    notes?.addEventListener('input',()=>{let tokens=String(notes.value||'').match(/\S+\s*/g)||[]; if(tokens.length>500) notes.value=tokens.slice(0,500).join('').trimEnd(); state.notes=notes.value;save();if(count)count.textContent=words(state.notes)+' / 500 words';}); render();
  }

  // ---------------- Init ----------------

  function safeInit(label, fn) {
    try { fn(); }
    catch (e) { try { console.error("CompX init failed [" + label + "]", e); } catch (ignore) { auditFallback("MAIN_SAFEINIT_001", ignore); } }
  }

  safeInit("app tabs", wireAppTabs);
  safeInit("tool subtabs", wireToolSubtabs);
  safeInit("tool buttons", wireToolButtons);
  safeInit("property clipboard", wirePropertyClipboard);
  const textAnimatorGrid = document.getElementById("textAnimatorGrid");
  if (textAnimatorGrid) textAnimatorGrid.addEventListener("click", (ev) => { const b=ev.target.closest("[data-text-anim]"); if(b) runTool('ae_applyTextAnimator("'+b.dataset.textAnim+'")', "Text Animator applied"); });

  const expressionToolGrid=document.getElementById("expressionToolGrid");
  if(expressionToolGrid) expressionToolGrid.addEventListener("click",(ev)=>{const b=ev.target.closest("[data-expression-tool]");if(b)runTool('ae_applyLoopExpression("'+b.dataset.expressionTool+'")',"Expression applied");});

  const transitionToolGrid=document.getElementById("transitionToolGrid");
  if(transitionToolGrid) transitionToolGrid.addEventListener("click",(ev)=>{const b=ev.target.closest("[data-transition]");if(b)runTool('ae_buildSmartTransition("'+b.dataset.transition+'")',"Transition applied");});

  const layoutToolGrid=document.getElementById("layoutToolGrid");if(layoutToolGrid)layoutToolGrid.addEventListener("click",e=>{const b=e.target.closest("[data-layout]");if(b)runTool('ae_quickLayout("'+b.dataset.layout+'")',"Layout applied");});
  const advancedDock = document.getElementById("advancedToolkitDock");
  const advancedPopover = document.getElementById("advancedToolPopover");
  const advancedPopoverTitle = document.getElementById("advancedPopoverTitle");
  const closeAdvancedPopover = () => {
    if (advancedPopover) { advancedPopover.classList.remove("open"); advancedPopover.setAttribute("aria-hidden", "true"); }
    document.querySelectorAll("#advancedToolkitDock [data-dock]").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".advanced-popover-panel").forEach((p) => p.classList.remove("active"));
  };
  if (advancedDock && advancedPopover) {
    advancedDock.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-dock]");
      if (!btn) return;
      const key = btn.dataset.dock;
      const wasOpen = advancedPopover.classList.contains("open") && btn.classList.contains("active");
      closeAdvancedPopover();
      if (wasOpen) return;
      const panel = advancedPopover.querySelector('[data-dock-panel="' + key + '"]');
      if (!panel) return;
      panel.classList.add("active"); btn.classList.add("active");
      advancedPopoverTitle.textContent = btn.dataset.title || "Quick Tools";
      advancedPopover.classList.add("open"); advancedPopover.setAttribute("aria-hidden", "false");
    });
    advancedPopover.addEventListener("click", (ev) => { if (ev.target.closest(".advanced-popover-panel .tool-btn")) setTimeout(closeAdvancedPopover, 0); });
  }
  const btnCloseAdvancedPopover = document.getElementById("btnCloseAdvancedPopover");
  if (btnCloseAdvancedPopover) btnCloseAdvancedPopover.addEventListener("click", closeAdvancedPopover);

  safeInit("colors", wireColorPanel);
  safeInit("tools host", detectHostForTools);
  safeInit("library host", detectHost);
  safeInit("tracker", startTracker);

  safeInit("text styles", wireTextAnimLibrary);
  safeInit("ffx", wireFfxPresets);
  safeInit("captions", wireCaptions);
  safeInit("remove background", wireRemoveBg);
  safeInit("motion libraries", wireVisualMotionLibraries);
  safeInit("todo and notes", wireTrackerWorkspace);
  safeInit("shape toolkit", wireShapeToolkit);
  safeInit("shape controls", wireShapeControls);
  safeInit("studio host", detectHostForStudio);

  safeInit("initial library render", render);
  safeInit("diagnostic summary", renderDiagnosticSummary);
  safeInit("MOGRT cache info", () => { refreshMogrtCacheInfo(); });
  safeInit("IndexedDB library", () => { initializeIndexedDbLibrary(); });
  safeInit("restore library shelf", () => {
    let shelf = "library";
    try { shelf = localStorage.getItem("compXLibraryShelf") || "library"; } catch (e) { auditFallback("MAIN_SAFEINIT_002", e); }
    // Older builds persisted the removed top-level SFX/MOGRT/Tools routes.
    if (shelf === "sfx" || shelf === "mogrt" || shelf === "prfpset" || shelf === "composer") {
      assetType = shelf === "mogrt" ? "mogrt" : "sfx";
      shelf = "library";
      try { localStorage.setItem("compXLibraryShelf", "library"); } catch (e) { auditFallback("MAIN_SAFEINIT_003", e); }
    }
    try {
      const savedType = localStorage.getItem("compXLibraryType");
      if (savedType === "mogrt") assetType = "mogrt";
      else assetType = "sfx";
      if (savedType === "prfpset") localStorage.setItem("compXLibraryType", "sfx");
    } catch (e) {}
    const button = document.querySelector('#assetTypeRow [data-type="' + shelf + '"]');
    if (button) button.click();
  });

  })();
