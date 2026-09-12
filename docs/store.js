/** Persistence: localStorage for small state, IndexedDB for blobs and derived data. */

const LS = "nil.";
const read = (k, dflt) => {
  try { const v = localStorage.getItem(LS + k); return v === null ? dflt : JSON.parse(v); }
  catch { return dflt; }
};
const write = (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch {} };

/* ------------------------------------------------------------------ settings */
const DEFAULTS = {
  theme: "auto",          // auto | light | dark
  rate: 1,                // playback speed; must be one of the presets the rate
                          // button cycles (0.75/1/1.25/1.5/2), since that button
                          // cannot step to a value off the grid
  gap: 1.6,               // seconds of silence in shadowing mode
  reps: 2,                // how many times a sentence is read in shadowing mode
  size: 18,               // reader font size
  level: 0,               // list filter (0 = all)
  readLevel: 1,           // the level a story opens at
  cat: "",                // "" = all categories
  worker: "",             // overrides config.WORKER_BASE
  autoSeg: true,          // compute sentence timings on open
  cacheAudio: true,       // keep every clip you play for offline use
};

export const settings = new Proxy({}, {
  get(_, k) { return k === "all" ? { ...DEFAULTS, ...read("settings", {}) } : read("settings", {})[k] ?? DEFAULTS[k]; },
  set(_, k, v) { const s = read("settings", {}); s[k] = v; write("settings", s); return true; },
});

/* ------------------------------------------------------------------ favorites */
export const favorites = {
  all: () => read("fav", []),
  has: (id) => read("fav", []).includes(id),
  toggle(id) {
    const a = read("fav", []);
    const i = a.indexOf(id);
    i === -1 ? a.push(id) : a.splice(i, 1);
    write("fav", a);
    return i === -1;
  },
};

/* ------------------------------------------------------------------ progress */
export const progress = {
  get: (id) => read("prog", {})[id] || null,
  set(id, patch) {
    const all = read("prog", {});
    all[id] = { ...(all[id] || {}), ...patch, at: Date.now() };
    write("prog", all);
  },
  recent(limit = 40) {
    return Object.entries(read("prog", {}))
      .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
      .slice(0, limit)
      .map(([id, v]) => ({ id, ...v }));
  },
};

/* ------------------------------------------------------------------ vocabulary */
export const vocab = {
  all: () => read("vocab", []),
  has: (w) => read("vocab", []).some((v) => v.w.toLowerCase() === w.toLowerCase()),
  add(entry) {
    const a = read("vocab", []);
    if (!a.some((v) => v.w.toLowerCase() === entry.w.toLowerCase())) {
      a.unshift({ ...entry, at: Date.now() });
      write("vocab", a);
      return true;
    }
    return false;
  },
  remove(w) {
    write("vocab", read("vocab", []).filter((v) => v.w.toLowerCase() !== w.toLowerCase()));
  },
  levelsSeen: () => read("levelsSeen", []),
  markLevelSeen(id, lv) {
    const a = read("levelsSeen", []);
    const key = `${id}:${lv}`;
    if (!a.includes(key)) { a.push(key); write("levelsSeen", a); }
  },
  streak() {
    const days = new Set(read("days", []));
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let n = 0;
    for (let i = 0; ; i++) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      if (days.has(key)) n++;
      else if (i > 0) break;
    }
    return n;
  },
  touchDay() {
    const a = read("days", []);
    const key = new Date().toISOString().slice(0, 10);
    if (!a.includes(key)) { a.push(key); write("days", a); }
  },
};

/* ------------------------------------------------------------------ IndexedDB */
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open("nil", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv", { keyPath: "k" });
      if (!d.objectStoreNames.contains("blob")) d.createObjectStore("blob", { keyPath: "k" });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

async function put(store, k, v) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(store, "readwrite");
    tx.objectStore(store).put({ k, v });
    tx.oncomplete = () => res(v);
    tx.onerror = () => rej(tx.error);
  });
}

async function get(store, k) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(store, "readonly");
    const rq = tx.objectStore(store).get(k);
    rq.onsuccess = () => res(rq.result ? rq.result.v : null);
    rq.onerror = () => rej(rq.error);
  });
}

async function keys(store) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(store, "readonly");
    const rq = tx.objectStore(store).getAllKeys();
    rq.onsuccess = () => res(rq.result || []);
    rq.onerror = () => rej(rq.error);
  });
}

async function del(store, k) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(store, "readwrite");
    tx.objectStore(store).delete(k);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

/** Derived sentence timings, keyed by track id (the audio is the same clip). */
export const segCache = {
  get: (track) => get("kv", `seg:${track}`),
  put: (track, v) => put("kv", `seg:${track}`, v),
};

/* --------------------------------------------------------------- audio cache */

// Downloads are automatic now: a clip you have listened to once keeps working with
// no network. That makes unbounded growth a real risk (roughly 1 MB per level of a
// story), so records carry a timestamp and are evicted least-recently-USED past a
// byte cap.
//
// Record shape is { blob, at, pinned }. A bare Blob is what older builds wrote for
// a manual save, and is treated as pinned -- an offline library someone built by
// hand must not be the first thing evicted.
const AUDIO_CAP_BYTES = 150 * 1024 * 1024;
const DISMISSED_KEY = "audioOff";
const DISMISSED_MAX = 400;

const asRecord = (r) => (!r ? null : (r.blob ? r : { blob: r, at: 0, pinned: true }));

export const audioCache = {
  keys: () => keys("blob"),

  async get(track) {
    const r = asRecord(await get("blob", track));
    if (!r) return null;
    if (!r.pinned) put("blob", track, { ...r, at: Date.now() }).catch(() => {});
    return r.blob;
  },

  meta: async (track) => asRecord(await get("blob", track)),

  /** Store a clip. Pinned entries are never evicted, whatever the cap says. */
  async put(track, blob, { pinned = false } = {}) {
    await put("blob", track, { blob, at: Date.now(), pinned });
    await audioCache.enforceCap();
  },

  del: (track) => del("blob", track),

  /**
   * Remove it AND remember the choice, so automatic caching does not put it back
   * on the next play. Without this an explicit delete would look like it had been
   * ignored, which is worse than not offering the delete.
   */
  async dismiss(track) {
    await del("blob", track).catch(() => {});
    const list = read(DISMISSED_KEY, []).filter((t) => t !== track);
    list.unshift(track);
    write(DISMISSED_KEY, list.slice(0, DISMISSED_MAX));
  },
  isDismissed: (track) => read(DISMISSED_KEY, []).includes(track),
  undismiss(track) {
    write(DISMISSED_KEY, read(DISMISSED_KEY, []).filter((t) => t !== track));
  },
  dismissed: () => read(DISMISSED_KEY, []),
  /** Forget every "do not cache this" choice, so those clips cache again. */
  clearDismissed() {
    const n = read(DISMISSED_KEY, []).length;
    write(DISMISSED_KEY, []);
    return n;
  },

  /** Keep this one regardless of eviction, or release it. */
  async pin(track, v = true) {
    const r = asRecord(await get("blob", track));
    if (!r) return false;
    await put("blob", track, { ...r, pinned: !!v });
    return true;
  },

  has: async (track) => (await get("blob", track)) != null,

  async stats() {
    const ks = await keys("blob");
    let bytes = 0, pinned = 0;
    for (const k of ks) {
      const r = asRecord(await get("blob", k));
      if (!r) continue;
      bytes += r.blob.size || 0;
      if (r.pinned) pinned += 1;
    }
    return { count: ks.length, bytes, pinned, cap: AUDIO_CAP_BYTES };
  },
  size: async () => (await audioCache.stats()).bytes,

  /** Drop least-recently-used unpinned entries until the total fits the cap. */
  async enforceCap(maxBytes = AUDIO_CAP_BYTES) {
    const rows = [];
    for (const k of await keys("blob")) {
      const r = asRecord(await get("blob", k));
      if (r) rows.push({ k, at: r.at || 0, size: r.blob.size || 0, pinned: !!r.pinned });
    }
    let total = rows.reduce((a, r) => a + r.size, 0);
    if (total <= maxBytes) return { evicted: 0, bytes: total };
    rows.sort((a, b) => a.at - b.at);            // oldest first
    let evicted = 0;
    for (const r of rows) {
      if (total <= maxBytes) break;
      if (r.pinned) continue;                    // "keep this one" means exactly that
      await del("blob", r.k).catch(() => {});
      total -= r.size;
      evicted += 1;
    }
    return { evicted, bytes: total };
  },

  async clear() {
    const ks = await keys("blob");
    for (const k of ks) await del("blob", k).catch(() => {});
    return ks.length;
  },
};
