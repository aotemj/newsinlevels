/** Reader: everything in one place. */
import { settings, favorites, progress, vocab, audioCache, segCache } from "./store.js";
import { player, hasCors, workerBase, OFF } from "./player.js";
import { WORKER_BASE } from "./config.js";

/* ------------------------------------------------------------------ helpers */
const $ = (s, r = document) => r.querySelector(s);
const view = $("#view");
const topTitle = $("#topbar-title");
const backBtn = $("#back");

const esc = (s) => String(s ?? "");
/** Paragraphs come from our own crawler and only ever contain <strong>/<em>;
 *  every other "<" is escaped so injected markup can never execute. */
const safe = (h) => esc(h).replace(/<(?!\/?(?:strong|em)\s*>)/gi, "&lt;");
const stripTags = (h) => esc(h).replace(/<[^>]*>/g, "");

const fmtDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((today - d) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
};
const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ------------------------------------------- split paragraphs into sentences */
const OPEN_TAG = /<(\/?)(strong|em)\s*>/i;
const TOKEN = /<\/?(?:strong|em)\s*>|[^<]+/gi;

/** [{html, text}] — sentence boundaries that respect inline <strong>/<em>. */
export function splitHtmlSentences(html) {
  const out = [];
  let buf = "";
  const open = [];
  const push = () => {
    const text = stripTags(buf).replace(/\s+/g, " ").trim();
    if (text) out.push({ html: buf.trim(), text });
    buf = open.map((t) => `<${t}>`).join("");   // carry inline tags into the next sentence
  };
  let m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(html)) !== null) {
    const tok = m[0];
    if (tok[0] === "<") {
      const g = OPEN_TAG.exec(tok);
      if (g) { g[1] === "/" ? open.splice(open.lastIndexOf(g[2]), 1) : open.push(g[2]); }
      buf += tok;
      continue;
    }
    let rest = tok;
    for (;;) {
      const hit = rest.match(/^([\s\S]*?[.!?]+)(\s+|$)/);
      if (!hit) { buf += rest; break; }
      let head = hit[1], tail = rest.slice(hit[0].length);
      // don't break on "Dr." / "U.S." style abbreviations followed by a capital-less word
      buf += head;
      if (/[.!?]$/.test(head) && /^\s*$/.test(hit[2] || "")) { buf += hit[2] || ""; }
      push();
      rest = tail;
      if (!rest.trim()) break;
    }
  }
  if (stripTags(buf).trim()) push();
  return out;
}

/* ------------------------------------------------------------------ data */
let INDEX = null;
async function loadIndex() {
  if (INDEX) return INDEX;
  const r = await fetch("data/index.json", { cache: "no-cache" });
  if (!r.ok) throw new Error("index.json missing");
  INDEX = await r.json();
  return INDEX;
}
const storyCache = new Map();
async function loadStory(id) {
  if (storyCache.has(id)) return storyCache.get(id);
  const r = await fetch(`data/s/${id}.json`);
  if (!r.ok) throw new Error("story missing");
  const d = await r.json();
  storyCache.set(id, d);
  return d;
}

/* ------------------------------------------------------------------ router */
let route = { name: "list", id: null };
function nav(hash) { location.hash = hash; }

async function routeChanged() {
  const h = location.hash.replace(/^#/, "") || "/";
  const [, , id] = h.split("/");
  player.el = $("#player");
  if (h.startsWith("/s/") && id) route = { name: "reader", id };
  else if (h.startsWith("/vocab")) route = { name: "vocab" };
  else if (h.startsWith("/saved")) route = { name: "saved" };
  else route = { name: "list" };

  backBtn.hidden = route.name === "list";
  document.querySelectorAll("#tabs a").forEach((a) => {
    const tab = a.dataset.tab;
    const cur = (route.name === "vocab" && tab === "vocab")
      || (route.name === "saved" && tab === "saved")
      || (route.name === "list" && tab === "read")
      || (route.name === "reader" && tab === "read");
    a.setAttribute("aria-current", cur ? "page" : "false");
  });

  if (route.name === "reader") await renderReader(route.id);
  else if (route.name === "vocab") renderVocab();
  else if (route.name === "saved") renderSaved();
  else renderList();
  if (route.name !== "reader") { $("#player").hidden = true; document.body.classList.remove("has-player"); }
  window.scrollTo({ top: 0 });
}

/* ------------------------------------------------------------------ list */
let shown = 0;
const PAGE = 30;

function filtered() {
  const S = INDEX.stories;
  const lv = Number(settings.level) || 0;
  const cat = settings.cat || "";
  const q = (listQuery || "").trim().toLowerCase();
  return S.filter((s) => {
    if (lv && !s.lv.includes(lv)) return false;
    if (cat && s.cat !== cat) return false;
    if (q) {
      const hay = `${s.title} ${s.id} ${s.cat || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
let listQuery = "";

async function renderList() {
  const idx = await loadIndex();
  topTitle.textContent = "News in Levels";
  const cats = idx.categories || [];

  view.innerHTML = `
    <div class="filters">
      <div class="chips" id="lvchips">
        ${[0, 1, 2, 3].map((l) => `<button class="chip" data-lv="${l}"
           aria-pressed="${Number(settings.level) === l}">${l ? "Level " + l : "All levels"}</button>`).join("")}
      </div>
      <div class="chips" id="catchips">
        <button class="chip" data-cat="" aria-pressed="${!settings.cat}">All topics</button>
        ${cats.map((c) => `<button class="chip" data-cat="${c}"
           aria-pressed="${settings.cat === c}">${c[0].toUpperCase() + c.slice(1)}</button>`).join("")}
      </div>
      <div class="chips">
        <input id="q" class="chip" style="min-width:190px" placeholder="Search titles…"
               value="${esc(listQuery)}" aria-label="Search">
      </div>
    </div>
    <div id="cards" class="list"></div>
    <div id="sentinel"></div>
  `;

  view.querySelectorAll("#lvchips .chip").forEach((b) => b.addEventListener("click", () => {
    const lv = Number(b.dataset.lv);
    settings.level = lv;
    // every story in the window has all three levels, so a level chip is not a
    // useful list filter -- it selects the level a story opens at instead
    if (lv) settings.readLevel = lv;
    shown = 0; renderList();
  }));
  view.querySelectorAll("#catchips .chip").forEach((b) => b.addEventListener("click", () => {
    settings.cat = b.dataset.cat; shown = 0; renderList();
  }));
  const qi = $("#q");
  let qt;
  qi.addEventListener("input", () => {
    clearTimeout(qt);
    qt = setTimeout(() => { listQuery = qi.value; shown = 0; paintCards(true); }, 160);
  });
  qi.addEventListener("keydown", (e) => { if (e.key === "Enter") qi.blur(); });

  // stop the filter bar from stealing focus on every re-render
  if (listQuery) { const n = $("#q"); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }

  shown = 0;
  paintCards(true);
  observeSentinel();
}

let sentinelObserver = null;
function observeSentinel() {
  if (sentinelObserver) sentinelObserver.disconnect();
  const s = $("#sentinel");
  if (!s) return;
  sentinelObserver = new IntersectionObserver((e) => {
    if (e[0].isIntersecting) paintCards(false);
  }, { rootMargin: "600px" });
  sentinelObserver.observe(s);
}

function paintCards(reset) {
  const box = $("#cards");
  if (!box) return;
  const rows = filtered();
  if (reset) box.innerHTML = "";
  if (!rows.length) {
    box.innerHTML = `<div class="empty">Nothing matches those filters.</div>`;
    return;
  }
  const next = rows.slice(shown, shown + PAGE);
  shown += next.length;
  const html = next.map((s) => {
    const noaud = (s.noaud || []).length;
    return `<a class="card" href="#/s/${s.id}">
      ${s.img ? `<img class="thumb" src="${esc(s.img)}" alt="" loading="lazy" decoding="async">` : `<div class="thumb"></div>`}
      <div class="body">
        <div class="t">${esc(s.title)}</div>
        <div class="meta">
          <span>${fmtDate(s.date)}</span>
          ${s.cat ? `<span class="pill">${esc(s.cat)}</span>` : ""}
          <span>${s.lv.map((l) => `<span class="badge l${l}">L${l}</span>`).join(" ")}</span>
          ${s.dur && s.dur["1"] ? `<span>${fmtDur(s.dur["1"])}</span>` : ""}
          ${favorites.has(s.id) ? `<span title="saved">★</span>` : ""}
          ${noaud ? `<span class="badge off">${noaud} without audio</span>` : ""}
        </div>
      </div>
    </a>`;
  }).join("");
  box.insertAdjacentHTML("beforeend", html);
  const s = $("#sentinel");
  if (s && shown >= rows.length) s.innerHTML = `<div class="empty" style="padding:20px">— end of the window —</div>`;
}

/* ------------------------------------------------------------------ reader */
let current = null;
let compare = false;

async function renderReader(id) {
  view.innerHTML = `<div class="spinner"><i></i></div>`;
  let data;
  try { data = await loadStory(id); }
  catch { view.innerHTML = `<div class="empty">Could not load that story.</div>`; return; }

  const idx = await loadIndex();
  const meta = idx.stories.find((s) => s.id === id) || {};
  const stored = progress.get(id);
  const lv = String(stored && stored.level && data.levels[stored.level] ? stored.level
    : (data.levels[String(settings.readLevel)]
       ? String(settings.readLevel)
       : (data.levels["1"] ? "1" : Object.keys(data.levels)[0])));

  current = { data, meta, lv };
  compare = compare && Object.keys(data.levels).length > 1;
  topTitle.textContent = meta.title || data.title || "Story";

  paintReaderView();
  openLevel(lv, { autoplay: false, restore: stored });
}

function paintReaderView() {
  const { data, meta, lv } = current;
  const levels = Object.keys(data.levels).sort();
  const l = data.levels[lv];
  const fav = favorites.has(data.id);
  const savedAudio = !!(l.audio && l.audio.track);

  view.innerHTML = `
    ${data.img ? `<img class="hero" src="${esc(data.img)}" alt="" decoding="async">` : ""}
    <div class="reader-head">
      <h2>${esc(meta.title || data.title)}</h2>
      <div class="meta">
        <span>${esc(data.date || "")}</span>
        ${data.cat ? `<span class="pill">${esc(data.cat)}</span>` : ""}
        <span>${fmtDur((meta.dur || {})[lv])}</span>
      </div>
    </div>
    <div class="seg-tabs">
      ${levels.map((n) => `<button data-lv="${n}" aria-pressed="${n === lv}">Level ${n}</button>`).join("")}
    </div>
    <div class="tools">
      ${levels.length > 1 ? `<button data-a="compare" aria-pressed="${compare}">Compare levels</button>` : ""}
      <button data-a="fav" aria-pressed="${fav}">${fav ? "★ Saved" : "☆ Save"}</button>
      ${savedAudio ? `<button data-a="audiofile">…</button>` : ""}
    </div>
    <div id="reader-body"></div>
    <div class="src">
      Text and audio belong to
      <a href="${esc(l.url || "https://www.newsinlevels.com/")}" target="_blank" rel="noopener">newsinlevels.com</a>.
      Reading is for personal study.
    </div>
  `;
  bindReaderTools();
  paintBody();
  markAudioButton();
}

function markAudioButton() {
  const l = current.data.levels[current.lv];
  const b = view.querySelector('[data-a="audiofile"]');
  if (!b || !l.audio || !l.audio.track) return;
  audioCache.has(l.audio.track).then((has) => {
    b.textContent = has ? "Audio offline ✓" : "Keep audio offline";
    b.setAttribute("aria-pressed", has ? "true" : "false");
  });
}

function bindReaderTools() {
  view.querySelectorAll(".seg-tabs button").forEach((b) => b.addEventListener("click", () => {
    openLevel(b.dataset.lv);
  }));
  const c = view.querySelector('[data-a="compare"]');
  if (c) c.addEventListener("click", () => { compare = !compare; paintBody(); c.setAttribute("aria-pressed", compare); });
  const f = view.querySelector('[data-a="fav"]');
  if (f) f.addEventListener("click", () => {
    const on = favorites.toggle(current.data.id);
    f.textContent = on ? "★ Saved" : "☆ Save";
    f.setAttribute("aria-pressed", on);
    toast(on ? "Saved" : "Removed");
  });
  const af = view.querySelector('[data-a="audiofile"]');
  if (af) af.addEventListener("click", async () => {
    const l = current.data.levels[current.lv];
    if (!l.audio || !l.audio.track) return;
    if (await audioCache.has(l.audio.track)) { await audioCache.del(l.audio.track); toast("Offline copy removed"); }
    else { toast("Saving…"); await player.download(); }
    markAudioButton();
  });
}

function paintBody() {
  const { data, lv } = current;
  const levels = Object.keys(data.levels).sort();
  const body = $("#reader-body");

  if (compare) {
    body.innerHTML = `<div class="cols">${levels.map((n) => {
      const L = data.levels[n];
      return `<div class="col">
        <h4 class="l${n}">Level ${n}${n === lv ? " · playing" : ""}</h4>
        ${(L.paragraphs || []).map((p) => `<p>${safe(p)}</p>`).join("")}
      </div>`;
    }).join("")}</div>`;
    return;
  }

  const L = data.levels[lv];
  const sentences = [];
  const paraHtml = (L.paragraphs || []).map((p) => {
    const parts = splitHtmlSentences(p);
    const inner = parts.map((s) => {
      const i = sentences.length;
      sentences.push(s.text);
      return `<span class="s" data-i="${i}">${safe(s.html)}</span>`;
    }).join(" ");
    return `<p>${inner}</p>`;
  }).join("");

  body.innerHTML = `
    <div class="article">${paraHtml}</div>
    ${(L.words || []).length ? `<dl class="words">
      <h3>Difficult words · level ${lv}</h3>
      ${L.words.map((w) => `<dt>${esc(w.w)}<button class="add" data-w="${esc(w.w)}">+ my words</button></dt>
        <dd>${esc(w.d)}</dd>`).join("")}
    </dl>` : ""}
  `;
  current.sentences = sentences;

  // clicking a sentence jumps the audio there and loops it
  body.querySelectorAll(".article .s").forEach((sp) => sp.addEventListener("click", () => {
    const i = Number(sp.dataset.i);
    player.goto(i, { loop: true });
    toast(player.times ? `Sentence ${i + 1} · looping` : "Sentence timings not ready — install the Worker");
  }));
  // bold words inside the text open the definition sheet
  body.querySelectorAll(".article strong").forEach((st) => {
    st.classList.add("w");
    st.addEventListener("click", (e) => { e.stopPropagation(); openWord(st.textContent.trim(), null); });
  });
  body.querySelectorAll(".words .add").forEach((b) => b.addEventListener("click", () => {
    const w = b.dataset.w;
    const def = (L.words.find((x) => x.w === w) || {}).d || "";
    vocab.add({ w, d: def, sid: data.id, title: current.meta.title || data.title, lv, at: Date.now() });
    toast(`“${w}” added to your words`);
  }));

  player.onSegIndex = (i) => {
    body.querySelectorAll(".article .s.on").forEach((n) => n.classList.remove("on"));
    const n = body.querySelector(`.article .s[data-i="${i}"]`);
    if (n) n.classList.add("on");
  };
}

/* -------------------------------------------------------- level switch + audio */
async function openLevel(lv, { autoplay = true, restore = null } = {}) {
  const { data, meta } = current;
  const L = data.levels[lv];
  if (!L) return;
  current.lv = lv;
  vocab.markLevelSeen(data.id, lv);
  progress.set(data.id, { level: lv, at: Date.now() });
  view.querySelectorAll(".seg-tabs button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.lv === lv));
  if (!compare) paintBody();

  const pl = $("#player");
  pl.hidden = false;
  document.body.classList.add("has-player");

  const words = L.words || [];
  if (!L.audio || !L.audio.track) {
    pl.innerHTML = `<div class="pnote">This level has no audio on the site — text only.</div>`;
    player.el = pl;
    return;
  }
  player.el = pl;
  await player.load({
    sid: data.id, level: Number(lv), track: L.audio.track, secret: L.audio.secret,
    title: meta.title || data.title, image: data.img,
    sentences: current.sentences || [],
    dur: (meta.dur || {})[lv] || 0,
    autoplay,
  });
  if (restore && restore.pos && player.audio.duration) player.seek(restore.pos, true);
}

/* ------------------------------------------------------------- word sheet */
async function openWord(word, definition) {
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  const back = document.createElement("div");
  back.className = "sheet-back";
  document.body.append(back, sheet);
  const close = () => { sheet.remove(); back.remove(); };
  back.addEventListener("click", close);

  const mine = vocab.has(word);
  sheet.innerHTML = `
    <h3>${esc(word)}</h3>
    <p class="def" id="def">${definition ? esc(definition) : "looking up…"}</p>
    <div class="row">
      ${mine ? "" : `<button class="primary" id="addw">+ my words</button>`}
      <a href="https://www.newsinlevels.com/?s=${encodeURIComponent(word)}"
         target="_blank" rel="noopener">In context</a>
      <a href="https://www.google.com/search?q=${encodeURIComponent("define " + word)}"
         target="_blank" rel="noopener">Look up</a>
      <button id="close">Close</button>
    </div>`;
  sheet.querySelector("#close").addEventListener("click", close);
  const add = sheet.querySelector("#addw");
  if (add) add.addEventListener("click", () => {
    vocab.add({ w: word, d: definition || "", sid: current ? current.data.id : "", lv: current ? current.lv : "", at: Date.now() });
    toast(`“${word}” added to your words`);
    close();
  });

  // if we have no gloss yet, ask the free dictionary API
  if (!definition) {
    try {
      const r = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
      const j = await r.json();
      const def = j && j[0] && j[0].meanings && j[0].meanings[0]
        && j[0].meanings[0].definitions[0] && j[0].meanings[0].definitions[0].definition;
      $("#def").textContent = def || "No definition found.";
    } catch { $("#def").textContent = "No definition found."; }
  }
}

/* ------------------------------------------------------------------ words */
function renderVocab() {
  topTitle.textContent = "My words";
  const list = vocab.all();
  const streak = vocab.streak();
  view.innerHTML = `
    <div class="pad">
      <div class="sec-title" style="padding-left:0">
        ${list.length} word${list.length === 1 ? "" : "s"} ·
        ${streak} day streak
      </div>
      ${list.length ? list.map((v) => `
        <div class="card" style="padding-left:0;padding-right:0">
          <div class="body">
            <div class="t">${esc(v.w)}</div>
            <div class="meta">${esc(v.d || "")}</div>
            ${v.sid ? `<div class="meta"><a href="#/s/${esc(v.sid)}" style="color:var(--accent)">${esc(v.title || v.sid)} · L${esc(v.lv || "")}</a></div>` : ""}
          </div>
          <button class="icon-btn" data-del="${esc(v.w)}" aria-label="Remove">✕</button>
        </div>`).join("")
      : `<div class="empty">Tap a bold word while reading to add it here.</div>`}
    </div>`;
  view.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
    vocab.remove(b.dataset.del); renderVocab();
  }));
}

/* ------------------------------------------------------------------ saved */
async function renderSaved() {
  topTitle.textContent = "Saved";
  const idx = await loadIndex();
  const favs = idx.stories.filter((s) => favorites.has(s.id));
  const recent = progress.recent(20)
    .map((p) => ({ p, s: idx.stories.find((x) => x.id === p.id) }))
    .filter((x) => x.s);
  const tracks = new Set(await audioCache.keys().catch(() => []));
  const bytes = await audioCache.size().catch(() => 0);
  const mb = (bytes / 1048576).toFixed(1);

  view.innerHTML = `
    <div class="pad">
      <div class="sec-title" style="padding-left:0">Saved stories (${favs.length})</div>
      ${favs.length ? favs.map(cardRow).join("") : `<div class="empty">Nothing saved yet — tap ☆ Save while reading.</div>`}
      <div class="sec-title" style="padding-left:0">Continue reading</div>
      ${recent.length ? recent.map(({ p, s }) => cardRow(s, p.level)).join("") : `<div class="empty">No reading history yet.</div>`}
      <div class="sec-title" style="padding-left:0">Offline audio · ${tracks.size} clip${tracks.size === 1 ? "" : "s"} · ${mb} MB</div>
      <div class="empty" style="padding:6px 0;text-align:left">
        ${tracks.size
          ? "These play with no network. Remove one from a story's player."
          : "Use “Keep audio offline” in the player to save a clip to this device."}
      </div>
    </div>`;
}
function cardRow(s, lv) {
  return `<a class="card" href="#/s/${s.id}">
    ${s.img ? `<img class="thumb" src="${esc(s.img)}" alt="" loading="lazy">` : `<div class="thumb"></div>`}
    <div class="body"><div class="t">${esc(s.title)}</div>
      <div class="meta"><span>${fmtDate(s.date)}</span>${lv ? `<span class="pill">L${lv}</span>` : ""}</div>
    </div></a>`;
}

/* ------------------------------------------------------------------ setup */
function openSetup() {
  const cur = settings.worker || WORKER_BASE || "";
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  const back = document.createElement("div");
  back.className = "sheet-back";
  document.body.append(back, sheet);
  const close = () => { sheet.remove(); back.remove(); };
  back.addEventListener("click", close);

  sheet.innerHTML = `
    <h3>Audio Worker</h3>
    <p class="def">Paste the URL that <code>wrangler deploy</code> printed for the Worker in
      <code>worker/</code>. It resolves each clip to a playable mp3 and adds the CORS header that
      sentence timings need. Leave it empty to keep playing through the public podcast feed.</p>
    <input id="wu" value="${esc(cur)}" placeholder="https://nil-audio.you.workers.dev"
           style="width:100%;padding:11px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);font-size:14px">
    <div class="pstatus" id="wstat"></div>
    <div class="row" style="margin-top:12px">
      <button class="primary" id="wtest">Test</button>
      <button id="wsave">Save</button>
      <button id="wclear">Clear</button>
      <button id="wclose">Close</button>
    </div>
    <div class="pnote" style="margin-top:12px">
      Auto sentence timings:
      <button class="pill-btn" id="wauto" aria-pressed="${settings.autoSeg}">
        ${settings.autoSeg ? "on" : "off"}</button>
    </div>`;
  const stat = (m) => { sheet.querySelector("#wstat").textContent = m; };
  sheet.querySelector("#wclose").addEventListener("click", close);
  sheet.querySelector("#wsave").addEventListener("click", () => {
    settings.worker = sheet.querySelector("#wu").value.trim().replace(/\/+$/, "");
    stat("Saved."); toast("Worker URL saved");
  });
  sheet.querySelector("#wclear").addEventListener("click", () => {
    settings.worker = ""; sheet.querySelector("#wu").value = ""; stat("Cleared.");
  });
  sheet.querySelector("#wtest").addEventListener("click", async () => {
    const u = sheet.querySelector("#wu").value.trim().replace(/\/+$/, "");
    if (!u) return stat("Enter a URL first.");
    stat("Testing…");
    try {
      const h = await fetch(u + "/health");
      const j = await h.json();
      stat(j.ok ? `OK — ${j.service} (client id: ${j.clientIdSource})` : "Unexpected reply.");
    } catch (e) { stat("Failed: " + (e.message || e)); }
  });
  sheet.querySelector("#wauto").addEventListener("click", (e) => {
    settings.autoSeg = !settings.autoSeg;
    e.target.setAttribute("aria-pressed", settings.autoSeg);
    e.target.textContent = settings.autoSeg ? "on" : "off";
  });
}

/* ------------------------------------------------------------------ chrome */
backBtn.addEventListener("click", () => history.back());
$("#setup").addEventListener("click", openSetup);
$("#theme").addEventListener("click", () => {
  const order = ["auto", "light", "dark"];
  const next = order[(order.indexOf(settings.theme) + 1) % 3];
  settings.theme = next;
  applyTheme();
  toast(`Theme: ${next}`);
});
function applyTheme() {
  document.documentElement.dataset.theme = settings.theme || "auto";
  const meta = document.querySelector('meta[name="theme-color"]');
  const dark = settings.theme === "dark" ||
    (settings.theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  if (meta) meta.content = dark ? "#101413" : "#0f766e";
}

window.addEventListener("hashchange", routeChanged);

/* the player widget lives outside the router and pushes state into the view */
player.addEventListener("segment", (e) => {
  if (player.onSegIndex) player.onSegIndex(e.detail.index);
});
player.addEventListener("failed", (e) => {
  toast(`Audio problem: ${e.detail.reason}`);
  // podcast-feed fallback can 404 for very fresh uploads; explain instead of hanging
  if (e.detail.reason === "source not supported" || e.detail.reason === "network") {
    const pl = $("#player");
    if (pl && current && !hasCors()) {
      pl.insertAdjacentHTML("beforeend",
        `<div class="pnote">If this keeps failing, the clip may not be in the public feed yet — set up the Worker.</div>`);
    }
  }
});
player.addEventListener("saved", (e) => {
  if (e.detail.error) toast(`Could not save: ${e.detail.error}`);
  else if (e.detail.removed) toast("Offline copy removed");
  else toast(`Saved ${(e.detail.bytes / 1024 / 1024).toFixed(1)} MB for offline`);
  markAudioButton();
});

/* ------------------------------------------------------------------ boot */
applyTheme();

// Allow ?worker=https://… to configure the resolver directly.  Handy for the
// smoke tests and for pointing a device at a different Worker without editing
// config.js.
try {
  const qp = new URLSearchParams(location.search);
  const w = qp.get("worker");
  if (w) settings.worker = /^(off|none|false|0)$/i.test(w) ? OFF : w.replace(/\/+$/, "");
  if (qp.get("level")) settings.readLevel = Number(qp.get("level")) || 1;
} catch {}

// Debug handle: the app is meant to be poked at from a device console and from
// the headless smoke tests, so the internals are exposed on purpose.
window.__nil = { player, settings, favorites, progress, vocab, audioCache, segCache,
  route: () => route, current: () => current, index: () => INDEX };

loadIndex().then(() => {
  if (!settings.worker && !WORKER_BASE) {
    // first run: nudge once, quietly
    if (!localStorage.getItem("nil.seenSetup")) {
      localStorage.setItem("nil.seenSetup", "1");
      setTimeout(() => toast("Tap the ⚙ icon to set up the audio Worker"), 1500);
    }
  }
  routeChanged();
}).catch(() => {
  view.innerHTML = `<div class="empty">Could not load <code>data/index.json</code>.<br>
    Run <code>python scraper/sync.py</code> first, then reload.</div>`;
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
