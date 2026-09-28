/* CompX IndexedDB storage — local asset metadata only. */
(function (root) {
  "use strict";

  const DB_NAME = "CompXDB";
  const DB_VERSION = 1;
  const ASSET_STORE = "assets";
  const META_STORE = "meta";
  const MIGRATION_KEY = "localStorageLibraryV1";
  let dbPromise = null;

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
    });
  }

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!root.indexedDB) {
        reject(new Error("IndexedDB is unavailable"));
        return;
      }
      const request = root.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(ASSET_STORE)) {
          const assets = db.createObjectStore(ASSET_STORE, { keyPath: "id" });
          assets.createIndex("pathType", "pathType", { unique: true });
          assets.createIndex("type", "type", { unique: false });
          assets.createIndex("name", "name", { unique: false });
          assets.createIndex("lastPlayedAt", "lastPlayedAt", { unique: false });
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => {
        dbPromise = null;
        reject(request.error || new Error("Could not open CompXDB"));
      };
      request.onblocked = () => {
        dbPromise = null;
        reject(new Error("CompXDB upgrade is blocked by another panel"));
      };
    });
    return dbPromise;
  }

  function normalizeAssets(items) {
    const out = [];
    const seen = new Set();
    (Array.isArray(items) ? items : []).forEach((item) => {
      if (!item || !item.id || !item.path) return;
      const type = item.type || "sfx";
      const pathType = type + "|" + item.path;
      if (seen.has(pathType)) return;
      seen.add(pathType);
      out.push(Object.assign({}, item, {
        type: type,
        pathType: pathType,
        thumbnail: null,
        thumbnailChecked: false,
      }));
    });
    return out;
  }

  async function getAllAssets() {
    const db = await openDB();
    const tx = db.transaction(ASSET_STORE, "readonly");
    const done = transactionDone(tx);
    const result = await requestResult(tx.objectStore(ASSET_STORE).getAll());
    await done;
    return normalizeAssets(result);
  }

  async function replaceAllAssets(items) {
    const records = normalizeAssets(items);
    const db = await openDB();
    const tx = db.transaction(ASSET_STORE, "readwrite");
    const store = tx.objectStore(ASSET_STORE);
    store.clear();
    records.forEach((record) => store.put(record));
    await transactionDone(tx);
    return records.length;
  }

  async function clearAssets() {
    const db = await openDB();
    const tx = db.transaction(ASSET_STORE, "readwrite");
    tx.objectStore(ASSET_STORE).clear();
    await transactionDone(tx);
  }

  async function getMeta(key) {
    const db = await openDB();
    const tx = db.transaction(META_STORE, "readonly");
    const done = transactionDone(tx);
    const result = await requestResult(tx.objectStore(META_STORE).get(key));
    await done;
    return result || null;
  }

  async function migrateFromLocalStorage(storageKey) {
    const previous = await getMeta(MIGRATION_KEY);
    if (previous && previous.completed) {
      return { assets: await getAllAssets(), migrated: false, count: previous.count || 0 };
    }

    let raw = null;
    let oldAssets = [];
    try { raw = root.localStorage ? root.localStorage.getItem(storageKey) : null; } catch (e) { if (root.CompXDiagnostics) root.CompXDiagnostics.fallback("STORAGE_MIGRATEFROMLOCALSTORAGE_001", e); }
    if (raw) {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("Legacy CompX library is not an array");
      oldAssets = parsed;
    }
    const records = normalizeAssets(oldAssets);
    const db = await openDB();
    const tx = db.transaction([ASSET_STORE, META_STORE], "readwrite");
    const assets = tx.objectStore(ASSET_STORE);
    const meta = tx.objectStore(META_STORE);
    assets.clear();
    records.forEach((record) => assets.put(record));
    if (raw) meta.put({ key: "legacyLocalStorageBackup", raw: raw, savedAt: new Date().toISOString() });
    meta.put({ key: MIGRATION_KEY, completed: true, count: records.length, completedAt: new Date().toISOString() });
    await transactionDone(tx);

    const verified = await getAllAssets();
    if (verified.length !== records.length) throw new Error("IndexedDB migration verification failed");
    if (raw && root.localStorage) {
      try { root.localStorage.removeItem(storageKey); } catch (e) { if (root.CompXDiagnostics) root.CompXDiagnostics.fallback("STORAGE_MIGRATEFROMLOCALSTORAGE_002", e); }
    }
    return { assets: verified, migrated: !!raw, count: verified.length };
  }

  root.CompXStorage = {
    openDB,
    getAllAssets,
    replaceAllAssets,
    clearAssets,
    migrateFromLocalStorage,
  };
})(window);
