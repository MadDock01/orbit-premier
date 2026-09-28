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

  function isExcludedLibraryPrfpset(entry) {
    const pack = String((entry && (entry.pack || entry.folderPath || entry.path)) || "");
    const name = String((entry && entry.name) || "");
    return PRFPSET_LIBRARY_EXCLUDE.test(pack) || PRFPSET_LIBRARY_EXCLUDE.test(name);
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

  async function insertToTimeline() {
    const item = library.find((s) => s.id === selectedId);
    if (!item) {
      showToast("Select a " + assetNoun(assetType) + " first", true);
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

  // Shared by feature modules loaded after main.js. JSON-returning host APIs
  // use call(); legacy text protocols (Graph/Pasta path) use callRaw().
  window.CompXHostBridge = Object.freeze({
    call: callHost,
    callRaw: callHostRaw,
    arg: hostArg,
  });

  // ================================================================
  // STUDIO — shared helpers
  // ================================================================

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

  // ---------------- Init ----------------

  function safeInit(label, fn) {
    try { fn(); }
    catch (e) { try { console.error("CompX init failed [" + label + "]", e); } catch (ignore) { auditFallback("MAIN_SAFEINIT_001", ignore); } }
  }

  safeInit("library host", detectHost);

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
