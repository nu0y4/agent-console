/* Parsed-session cache backed by IndexedDB. Keyed by backend file path;
   stores the parsed { messages, stats, title, firstTs, lastTs, sessionId }
   plus the file's mtime so a later scan can detect changes cheaply. */
const SessionCache = (() => {
  const DB_NAME = "agent-console";
  const STORE = "sessions";
  const META = "meta";

  let db = null;

  function open() {
    return new Promise((resolve, reject) => {
      if (db) return resolve(db);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
        if (!d.objectStoreNames.contains(META)) d.createObjectStore(META);
      };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode) {
    return db.transaction(store, mode).objectStore(store);
  }

  function get(key) {
    return open().then(() => new Promise((resolve, reject) => {
      const r = tx(STORE, "readonly").get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    }));
  }

  function put(key, val) {
    return open().then(() => new Promise((resolve, reject) => {
      const r = tx(STORE, "readwrite").put(val, key);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    }));
  }

  // store scan metadata (mtime snapshot) so we can diff later
  function putMeta(val) {
    return open().then(() => new Promise((resolve, reject) => {
      const r = tx(META, "readwrite").put(val, "scan");
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    }));
  }
  function getMeta() {
    return open().then(() => new Promise((resolve, reject) => {
      const r = tx(META, "readonly").get("scan");
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    }));
  }

  return { get, put, putMeta, getMeta };
})();

window.SessionCache = SessionCache;
