/**
 * Audio engine: one <audio> element for the whole app so playback survives
 * navigation, plus the listening modes that make this worth building —
 * speed control, whole-clip loop, A-B loop, single-sentence loop and shadowing.
 *
 * Sentence timings come from segment.js and are only available when the audio
 * can be fetched with CORS, i.e. through the Worker.  Without them the sentence
 * and shadowing buttons stay disabled rather than silently doing the wrong thing.
 */
import { settings } from "./store.js";
import { audioCache, segCache } from "./store.js";
import { segmentUrl } from "./segment.js";
import { WORKER_BASES, PODCAST_BASE, AUDIO_MODE } from "./config.js";

/** Sentinel meaning "explicitly run without a resolver, even if one is configured". */
export const OFF = "__off__";

const $ = (s, r = document) => r.querySelector(s);
const fmt = (t) => {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/** Error messages end up in the status line, so escape before interpolating. */
const esc = (s) => String(s).replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ---------------------------------------------------------------- resolver */

const stripSlash = (u) => String(u || "").replace(/\/+$/, "");

// Delivery attempts, in order: every base with every mode.
//
// Two independent things can fail, and conflating them was a bug:
//   * the base host is unreachable (workers.dev is DNS-poisoned in China), and
//   * the base answers but the bytes it points at are not usable here (the
//     client's route to cf-media.sndcdn.com can return a cached 403 even though
//     the signed url is valid -- proven by fetching the same url from Cloudflare
//     and getting 206 audio/mpeg).
// So the walk is base x mode, and both the <audio> element and the sentence
// timing fetch share it.  Previously only the audio element advanced, so the
// timings stayed permanently missing with nothing recording why.
let _cacheKey = null;
let _attempts = [];
let attemptIdx = 0;

function attemptList() {
  const s = settings.worker || "";
  if (s === OFF) return [];
  const bases = (s ? [s] : WORKER_BASES).filter(Boolean).map(stripSlash);
  const modes = AUDIO_MODE === "redirect" ? ["redirect", "stream"] : ["stream", "redirect"];
  const key = bases.join("|");
  if (key !== _cacheKey) {
    // settings changed (e.g. the user saved a new base) -- start over
    _cacheKey = key;
    _attempts = [];
    attemptIdx = 0;
    for (const b of bases) for (const m of modes) _attempts.push({ base: b, mode: m });
  }
  return _attempts;
}

const attempt = () => {
  const l = attemptList();
  return l[Math.min(attemptIdx, l.length - 1)] || { base: "", mode: AUDIO_MODE };
};

export const workerBase = () => attempt().base;
/** "stream" (bytes proxied through Cloudflare) or "redirect" (302 to the CDN). */
export const audioMode = () => attempt().mode;

/**
 * Give up on the current base+mode and move to the next attempt.  Returns true
 * only while an untried attempt remains, which bounds every caller's retry.
 */
export const advanceResolver = () => {
  const l = attemptList();
  if (attemptIdx >= l.length - 1) return false;
  attemptIdx += 1;
  return true;
};

/** For diagnostics and the setup sheet. */
export const resolverState = () => ({
  current: workerBase(),
  mode: audioMode(),
  index: attemptIdx,
  attempts: attemptList().map((a) => `${a.base || "(none)"} / ${a.mode}`),
  all: WORKER_BASES.filter(Boolean).map(stripSlash),
});

export const hasCors = () => !!workerBase();

export function audioUrlFor(track, secret) {
  const base = workerBase();
  if (!base) return `${PODCAST_BASE}/${track}-newsinlevels-x.mp3`;
  const path = audioMode() === "redirect" ? "audio" : "stream";
  return `${base}/${path}/${track}${secret ? `?s=${encodeURIComponent(secret)}` : ""}`;
}

const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M8 5h3v14H8zM13 5h3v14h-3z" fill="currentColor" stroke="none"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M18 5v14L8 12zM6 5v14"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M6 5v14l10-7zM18 5v14"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M11 5L4 12l7 7M20 12H4"/></svg>',
  fwd: '<svg viewBox="0 0 24 24"><path d="M13 5l7 7-7 7M4 12h16"/></svg>',
  repeat: '<svg viewBox="0 0 24 24"><path d="M17 2l4 4-4 4"/><path d="M3 12V10a4 4 0 014-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 12v2a4 4 0 01-4 4H3"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14"/></svg>',
  chevUp: '<svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>',
  chevDown: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>',
};

/* --------------------------------------------------------------- playback speed */

/** Clicking the rate button cycles these. Fixed presets beat a slider here: one
 *  tap is unambiguous, and none of these are reachable by accident. */
const RATES = [0.75, 1, 1.25, 1.5, 2];
const RATE_DEFAULT = 1;

/**
 * Snap a stored value onto the nearest preset. Older builds shipped a slider with
 * `|| 0.9` as the default and 0.05 steps, so a saved 0.9 (or anything else off the
 * list) has to land on a preset or the button would read a value it cannot cycle to.
 */
export const nearestRate = (v) => {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return RATE_DEFAULT;
  return RATES.reduce((best, r) => (Math.abs(r - n) < Math.abs(best - n) ? r : best), RATES[0]);
};

/** The preset after the current one, wrapping. */
export const nextRate = (v) => RATES[(RATES.indexOf(nearestRate(v)) + 1) % RATES.length];

/** "1×", "0.75×", "1.25×" -- no trailing zeros. */
export const rateLabel = (v) => `${nearestRate(v)}×`;

class Player extends EventTarget {
  constructor() {
    super();
    this.el = null;
    this.audio = document.getElementById("audio");
    this.track = null;
    this.secret = null;
    this.sid = null;
    this.level = 1;
    this.title = "";
    this.image = "";
    this.times = null;
    this.confidence = 0;
    this.active = -1;
    this.knownDur = 0;       // duration from the index, used until the media loads
    this.loopIndex = -1;
    this.shadowIndex = -1;
    this.loopClip = false;
    this.ab = null;          // {a, b|null}
    this.shadow = false;
    this.shadowReps = 0;
    this.busy = null;
    this.blobUrl = null;
    this.wantPlay = false;
    // The controls start folded away: expanded by default they sat on top of the
    // last lines of every article. Collapsed, only a slim row shows and nothing is
    // covered; expanding is a deliberate tap and overlays the article rather than
    // reflowing it, so the text never jumps.
    this.collapsed = true;
    // Escape folds it back on desktop. Bound once on the singleton, not per repaint.
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.collapsed) this.setCollapsed(true);
    });
    this._wire();
  }

  /* ------------------------------------------------------------- plumbing */
  _wire() {
    const a = this.audio;
    a.addEventListener("timeupdate", () => this._tick());
    a.addEventListener("play", () => this._repaint());
    a.addEventListener("pause", () => this._repaint());
    a.addEventListener("ended", () => this._onEnded());
    a.addEventListener("loadedmetadata", () => { this._repaint(); this._emit("meta"); });
    // `duration` can still be 0/NaN when the timings finish computing, which made
    // _paintMarks bail and never retry -- so the sentence marks on the scrub bar
    // silently went missing. Repaint once the duration actually settles.
    a.addEventListener("durationchange", () => { this._paintMarks(); this._emit("meta"); });
    a.addEventListener("progress", () => this._paintBuffer());
    a.addEventListener("error", () => this._fail());
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _fail() {
    // An unusable delivery route fails right here: the base can be unreachable
    // (workers.dev is DNS-poisoned in China) or reachable but pointing at bytes
    // this network cannot get (cf-media hanging the client a cached 403).  Both
    // look like a media error, so step to the next attempt and retry before
    // reporting anything to the user.
    if (!this.blobUrl && this.track && advanceResolver()) {
      this.audio.src = audioUrlFor(this.track, this.secret);
      this.audio.load();
      this._repaint();
      this._emit("resolver-switch", { base: workerBase(), mode: audioMode() });
      if (this.wantPlay) this.play();
      return;
    }
    const e = this.audio.error;
    const code = e ? e.code : 0;
    const reason = { 1: "aborted", 2: "network", 3: "decode", 4: "source not supported" }[code] || "unknown";
    this.busy = null;
    this._repaint();
    this._emit("failed", { reason, track: this.track });
  }

  /* ------------------------------------------------------- load a clip */
  async load({ sid, level, track, secret, title, image, sentences, dur, autoplay = true }) {
    const same = this.track === track && this.sid === sid && this.level === level;
    this.sid = sid; this.level = level; this.track = track; this.secret = secret || null;
    this.title = title; this.image = image; this.sentences = sentences || [];
    // duration baked from the podcast feed: lets the sentence marks be drawn
    // immediately instead of waiting for the media to load
    this.knownDur = Number(dur) > 0 ? Number(dur) : 0;
    if (same) { if (autoplay) this.play(); this._repaint(); return; }

    this.times = null; this.confidence = 0; this.active = -1;
    this.segError = null;
    this.loopIndex = -1; this.shadowIndex = -1;
    this.ab = null; this.shadowReps = 0;
    this.collapsed = true;      // a new story opens with the controls folded away
    this._revoke();

    // offline copy wins over the network
    let src = null;
    let hadOffline = false;
    try {
      const blob = await audioCache.get(track);
      if (blob) { this.blobUrl = URL.createObjectURL(blob); src = this.blobUrl; hadOffline = true; }
    } catch {}
    if (!src) src = audioUrlFor(track, secret);
    if (hadOffline) this._refreshSaved();

    this.audio.src = src;
    // Snap a stored value onto a preset: the old slider allowed 0.05 steps and
    // defaulted to 0.9, neither of which the cycler can reach.
    this.audio.playbackRate = nearestRate(settings.rate);
    settings.rate = this.audio.playbackRate;
    this._repaint();
    if (autoplay) this.play();

    // cached timings, else compute them when we are allowed to read the bytes
    if (this.sentences.length && hasCors()) {
      const cached = await segCache.get(track).catch(() => null);
      if (cached) { this._applySegments(cached, true); }
      // segmentNow() records the reason on failure and repaints, so swallowing the
      // rejection here is safe -- the reader shows why, instead of leaving a
      // misleading "install the Worker" hint.
      else if (settings.autoSeg) { this.segmentNow().catch(() => {}); }
    }

    // Offline copy, and deliberately the LAST thing here: caching must never delay
    // playback. When the timing pass runs it downloads the whole clip anyway and
    // hands the bytes over, so this costs nothing extra; only when it will not run
    // is a separate background fetch needed.
    const timingWillFetch = !this.times && this.sentences.length && hasCors() && settings.autoSeg;
    if (!hadOffline && settings.cacheAudio && !timingWillFetch) {
      this._cacheFromNetwork(this.track, this.secret);
    }
  }

  async segmentNow(force = false) {
    if (!hasCors()) throw new Error("no audio resolver is configured (setup → resolver URL)");
    if (!this.sentences || !this.sentences.length) throw new Error("no text to align");
    if (this.times && !force) return this.times;
    this.busy = "analysing audio";
    this.segError = null;
    this._repaint();
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await segmentUrl(audioUrlFor(this.track, this.secret), this.sentences,
            (m) => { this.busy = m; this._repaint(); },
            // Already-downloaded bytes: this is where offline caching costs nothing.
            (blob) => this._autoCache(this.track, blob));
          if (!res.times) throw new Error(res.reason || "could not align audio to text");
          await segCache.put(this.track, res).catch(() => {});
          this._applySegments(res, false);
          return res;
        } catch (e) {
          // This fetch is its own request, so an unusable delivery route fails
          // here independently of the <audio> element.  Walk the remaining
          // attempts instead of leaving the timings permanently missing -- but
          // only when the bytes never arrived, never for an alignment failure.
          if (e && e.delivery && advanceResolver()) continue;
          throw e;
        }
      }
    } catch (e) {
      this.segError = e && e.message ? e.message : String(e);
      // The timing pass failed, so its bytes never came through. Fetch separately, so
      // a broken alignment still leaves the clip available offline.
      this._cacheFromNetwork(this.track, this.secret);
      throw e;
    } finally {
      this.busy = null;
      this._repaint();
    }
  }

  /**
   * Why there are no sentence timings, phrased so the user can act on it.
   * Returns null when the timings are in fact available.  The reader used to say
   * "install the Worker" for every one of these cases, which was wrong whenever a
   * resolver WAS configured and the real cause was elsewhere.
   */
  timingsReason() {
    if (this.times) return null;
    if (!hasCors()) return "no audio resolver is set up — open setup and paste its URL";
    if (this.busy) return `still analysing the audio (${this.busy}) — try again in a moment`;
    if (this.segError) return `timing analysis failed: ${this.segError}`;
    if (!settings.autoSeg) return "automatic timings are off — press ⟳ in the player";
    if (!this.sentences || !this.sentences.length) return "this level has no text to align";
    return "not computed yet — press ⟳ in the player";
  }

  _applySegments(res, cached) {
    this.times = res.times;
    this.confidence = res.confidence ?? 0;
    this.segInfo = { spans: res.spans, sentences: res.sentences, exact: res.exactCount,
                     cached: !!cached };
    this._repaint();
    this._emit("segments", { times: this.times, confidence: this.confidence, info: this.segInfo });
  }

  /* ------------------------------------------------------------- controls */
  play() {
    this.wantPlay = true;
    const p = this.audio.play();
    if (p && p.catch) p.catch(() => this._emit("blocked"));
  }
  pause() { this.wantPlay = false; this.audio.pause(); }
  toggle() { this.audio.paused ? this.play() : this.pause(); }
  seek(t, keepPaused = false) {
    this.audio.currentTime = clamp(t, 0, this.audio.duration || t);
    if (!keepPaused) this._repaint();
  }
  /** Accepts a preset or anything else; anything else snaps to the nearest preset. */
  setRate(r) {
    const v = nearestRate(r);
    this.audio.playbackRate = v;
    settings.rate = v;
    this._repaint();
  }

  /** One tap of the rate button: 0.75 -> 1 -> 1.25 -> 1.5 -> 2 -> 0.75. */
  cycleRate() {
    this.setRate(nextRate(this.audio.playbackRate));
    this._emit("rate", { rate: this.audio.playbackRate });
  }

  /** Fold the controls away, or bring them back. */
  setCollapsed(v) {
    const next = !!v;
    if (this.collapsed === next) return;
    this.collapsed = next;
    this._repaint();
    this._emit("collapsed", { collapsed: this.collapsed });
  }
  toggleCollapsed() { this.setCollapsed(!this.collapsed); }

  /** Jump to a sentence and (optionally) keep looping just that sentence. */
  goto(index, { loop = false } = {}) {
    if (!this.times || !this.times[index]) return;
    this.active = index;
    this.loopIndex = index;
    this.shadowIndex = index;
    if (loop) this.loopSentence = true;
    this.shadowReps = 0;
    this.seek(Math.max(0, this.times[index][0] - 0.06));
    this.play();
    this._emit("segment", { index });
    this._repaint();
  }

  nextSentence() { if (this._hasSeg()) this.goto(Math.min(this.active + 1, this.times.length - 1)); }
  prevSentence() { if (this._hasSeg()) this.goto(Math.max(this.active - 1, 0)); }
  _hasSeg() { return !!(this.times && this.times.length); }

  setAB(a, b) {
    this.ab = { a: clamp(a, 0, this.audio.duration || a), b: b == null ? null : clamp(b, 0, this.audio.duration || b) };
    this._repaint();
  }
  clearAB() { this.ab = null; this._repaint(); }

  /**
   * Keep a copy of this clip for offline use. Automatic on load.
   *
   * Skipped when the user turned caching off, when they explicitly removed this clip
   * before (a delete that silently reappears is worse than no delete at all), or when
   * the browser reports Data Saver.
   */
  async _autoCache(track, blob) {
    if (!track || !blob || !blob.size) return false;
    if (!settings.cacheAudio) return false;
    if (audioCache.isDismissed(track)) return false;
    const conn = navigator.connection;
    if (conn && conn.saveData) return false;
    try {
      await audioCache.put(track, blob);
      this._emit("cached", { track, bytes: blob.size });
      this._refreshSaved();
      return true;
    } catch (e) {
      // Quota is the interesting failure: shed the evictable entries and retry once
      // rather than letting one full disk silently disable offline audio.
      if (e && /quota|storage/i.test(`${e.name} ${e.message}`)) {
        await audioCache.enforceCap(64 * 1024 * 1024).catch(() => {});
        try {
          await audioCache.put(track, blob);
          this._emit("cached", { track, bytes: blob.size, afterEviction: true });
          this._refreshSaved();
          return true;
        } catch { /* fall through to the report below */ }
      }
      this._emit("cache-failed", { track, reason: String((e && e.message) || e) });
      return false;
    }
  }

  /**
   * Fetch the clip purely to cache it -- used only when the timing pass will not run,
   * since that pass downloads the same bytes anyway. Never awaited by load(), because
   * a download must not delay playback.
   */
  async _cacheFromNetwork(track, secret) {
    if (!settings.cacheAudio || !track) return;
    try {
      if (await audioCache.has(track)) return;
      const r = await fetch(audioUrlFor(track, secret));
      if (!r.ok) return;                 // the media element reports real failures
      await this._autoCache(track, await r.blob());
    } catch { /* offline or blocked: playback is unaffected, so stay quiet */ }
  }

  /** Is this clip PINNED (the trash button only makes sense for those)? */
  async _refreshSaved() {
    const m = this.track ? await audioCache.meta(this.track).catch(() => null) : null;
    const v = !!(m && m.pinned);
    if (v !== this.saved) { this.saved = v; this._repaint(); }
    return v;
  }

  /** "Keep this offline": stores it, and excludes it from eviction. */
  async download() {
    if (!this.track) return;
    this.busy = "saving audio";
    this._repaint();
    try {
      // Auto-caching usually already stored it, in which case keeping it is pure
      // bookkeeping -- no reason to download the same clip twice.
      let blob = await audioCache.get(this.track).catch(() => null);
      if (!blob) {
        const r = await fetch(audioUrlFor(this.track, this.secret));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        blob = await r.blob();
      }
      await audioCache.undismiss(this.track);
      await audioCache.put(this.track, blob, { pinned: true });
      this.saved = true;
      this._emit("saved", { bytes: blob.size, pinned: true });
    } catch (e) {
      this._emit("saved", { error: String(e.message || e) });
    } finally {
      this.busy = null;
      this._repaint();
    }
  }

  /** Remove the offline copy AND mark it as not-wanted, so auto-caching respects it. */
  async unsave() {
    if (!this.track) return;
    await audioCache.dismiss(this.track).catch(() => {});
    this.saved = false;
    this._emit("saved", { removed: true });
    this._repaint();
  }

  /* --------------------------------------------------------- time loop */
  _tick() {
    const t = this.audio.currentTime, d = this.audio.duration;

    if (this.loopClip && d && t >= d - 0.12) { this.seek(0); return; }

    if (this.ab && this.ab.b != null && t >= this.ab.b) {
      this.seek(this.ab.a);
      return;
    }

    if (this._hasSeg()) {
      const i = this._indexAt(t);
      if (i !== this.active) {
        this.active = i;
        this._emit("segment", { index: i });
        this._paintNow();
      }

      // Looping must follow the sentence the user pinned, not whichever
      // sentence the playhead happens to sit in: seeking to "start - 0.06"
      // lands inside the pause *before* the sentence, where a playhead-derived
      // index still points at the previous sentence and its end already passed,
      // which yanked playback straight back to the top.
      const locked = this.shadow ? this.shadowIndex
                    : (this.loopSentence ? this.loopIndex : -1);
      const span = (locked != null && locked >= 0) ? this.times[locked] : null;

      if (span) {
        const [s, e] = span;
        if (this.shadow && !this.shadowTimer && e != null && t >= e - 0.04) {
          this._shadowHold(s, locked);
        } else if (!this.shadow && e != null && t >= e - 0.04
                   && (i >= locked || i === -1)) {
          this.seek(Math.max(0, s - 0.06));
        }
      }
    }
    this._paintNow();
  }

  /** shadowing: stop at the end of the sentence, wait, then repeat or advance */
  _shadowHold(start, index) {
    this.pause();
    this.shadowReps++;
    const reps = Number(settings.reps) || 2;
    const gap = Number(settings.gap) || 1.6;
    const advance = this.shadowReps >= reps;
    this._repaint();
    this.shadowTimer = setTimeout(() => {
      this.shadowTimer = null;
      if (!this.shadow) return;
      if (advance) {
        this.shadowReps = 0;
        if (index + 1 < this.times.length) this.goto(index + 1);
        else { this.shadow = false; this._repaint(); }
      } else {
        this.seek(Math.max(0, start - 0.06));
        this.play();
      }
    }, gap * 1000);
  }

  /**
   * The sentence the playhead is in.  Inside the pause *before* a sentence this
   * reports that upcoming sentence, so a loop that starts a hair early does not
   * think it has already overrun the previous one.
   */
  _indexAt(t) {
    const T = this.times;
    if (!T || !T.length) return -1;
    const LEAD = 0.12;
    let cand = 0;
    for (let i = 0; i < T.length; i++) if (t >= T[i][0] - LEAD) cand = i;
    return cand;
  }

  _onEnded() {
    if (this.loopClip) { this.seek(0); this.play(); return; }
    this._repaint();
    this._emit("ended");
  }

  _revoke() {
    if (this.blobUrl) { URL.revokeObjectURL(this.blobUrl); this.blobUrl = null; }
  }

  /* ------------------------------------------------------------- media session */
  _mediaSession() {
    if (!("mediaSession" in navigator)) return;
    const lv = `Level ${this.level}`;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: this.title || "News in Levels",
        artist: lv,
        album: "News in Levels",
        artwork: this.image
          ? [{ src: this.image, sizes: "600x300", type: "image/jpeg" }] : [],
      });
      const H = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
      const safe = (name, fn) => { try { H(name, fn); } catch {} };
      safe("play", () => this.play());
      safe("pause", () => this.pause());
      safe("seekbackward", () => this.seek(this.audio.currentTime - 5));
      safe("seekforward", () => this.seek(this.audio.currentTime + 5));
      safe("seekto", (d) => { if (d.seekTime != null) this.seek(d.seekTime); });
      safe("previoustrack", () => this.prevSentence());
      safe("nexttrack", () => this.nextSentence());
      safe("stop", () => this.pause());
    } catch {}
  }

  /* ------------------------------------------------------------- rendering */
  mount(el) { this.el = el; this._repaint(); }

  _repaint() {
    if (!this.el) return;
    this._mediaSession();
    const a = this.audio;
    const d = this._effectiveDuration(), t = a.currentTime || 0;
    const seg = this._hasSeg();
    const rate = a.playbackRate || 1;
    const saved = this.saved;

    this.el.classList.toggle("collapsed", this.collapsed);

    // Collapsed: one slim row above the tabs -- play/pause, times, a 2px progress
    // line, and the chevron. Deliberately NOT the full panel, which used to sit on
    // the last lines of every article. The `.now` / [data-t] hooks are the same
    // ones _paintNow() already drives, so the progress line and times stay live
    // without a per-tick repaint of the whole panel.
    const collapsedRow = `
      <div class="pbar" data-a="bar">
        <button class="pbtn primary" data-a="toggle" aria-label="Play or pause">
          ${a.paused ? ICON.play : ICON.pause}
        </button>
        <span class="ptime" data-t="now">${fmt(t)}</span>
        <span class="ptime dim">/</span>
        <span class="ptime" data-t="dur">${fmt(d)}</span>
        <div class="minitrack"><div class="now"></div></div>
        ${this.busy ? `<span class="ptime busy" title="${esc(this.busy)}">⋯</span>` : ""}
        <button class="pbtn chev" data-a="togglecollapse" aria-expanded="false"
                aria-label="Show player controls">${ICON.chevUp}</button>
      </div>`;

    const expandedPanel = `
      <div class="prow">
        <button class="pbtn" data-a="prev" ${seg ? "" : "disabled"} aria-label="Previous sentence">${ICON.prev}</button>
        <button class="pbtn primary" data-a="toggle" aria-label="Play or pause">
          ${a.paused ? ICON.play : ICON.pause}
        </button>
        <button class="pbtn" data-a="next" ${seg ? "" : "disabled"} aria-label="Next sentence">${ICON.next}</button>
        <span class="ptime" data-t="now">${fmt(t)}</span>
        <div class="scrub" data-a="scrub">
          <div class="track">
            <div class="buf"></div><div class="now"></div>
            ${seg ? '<div class="marks"></div>' : ""}
            ${this.ab ? '<div class="mrk" data-m="a"></div>' : ""}
            ${this.ab && this.ab.b != null ? '<div class="mrk" data-m="b"></div>' : ""}
            <div class="knob"></div>
          </div>
        </div>
        <span class="ptime" data-t="dur">${fmt(d)}</span>
      </div>
      <div class="prow2">
        <button class="pill-btn rate-btn" data-a="rate" aria-label="Playback speed"
                title="Speed ${rateLabel(rate)} — tap to change">${rateLabel(rate)}</button>
        <button class="pill-btn" data-a="clip" aria-pressed="${this.loopClip}">Loop clip</button>
        <button class="pill-btn" data-a="segloop" ${seg ? "" : "disabled"}
                aria-pressed="${this.loopSentence}" title="Repeat the current sentence">Sentence</button>
        <button class="pill-btn" data-a="shadow" ${seg ? "" : "disabled"}
                aria-pressed="${this.shadow}" title="Listen, repeat out loud, move on">Shadow</button>
        <button class="pill-btn" data-a="ab">A–B</button>
        ${this.ab ? `<button class="pill-btn warn" data-a="abclear">clear</button>` : ""}
        <button class="pill-btn" data-a="seg" ${hasCors() ? "" : "disabled"}
                title="Recompute sentence timings">${this.busy ? "…" : "⟳"}</button>
        <button class="pill-btn" data-a="save">${ICON.down}</button>
        ${saved ? `<button class="pill-btn warn" data-a="unsave">${ICON.trash}</button>` : ""}
        <button class="pbtn chev" data-a="togglecollapse" aria-expanded="true"
                aria-label="Hide player controls">${ICON.chevDown}</button>
      </div>
      ${this.busy ? `<div class="pstatus">${this.busy}…</div>` : ""}
      ${this._statusLine()}`;

    this.el.innerHTML = this.collapsed ? collapsedRow : expandedPanel;
    this._bind();
    this._paintNow();
    this._paintBuffer();
    this._paintMarks();
    if (this.ab) {
      const tot = d || 1;
      const ka = this.el.querySelector('[data-m="a"]');
      const kb = this.el.querySelector('[data-m="b"]');
      if (ka) ka.style.left = `${(this.ab.a / tot) * 100}%`;
      if (kb && this.ab.b != null) kb.style.left = `${(this.ab.b / tot) * 100}%`;
    }
  }

  _statusLine() {
    if (this._hasSeg()) {
      const c = this.confidence;
      const label = c >= 0.7 ? "good" : c >= 0.4 ? "approximate" : "rough — check the boundaries";
      const det = this.segInfo ? ` (${this.segInfo.spans} pauses / ${this.segInfo.sentences} sentences)` : "";
      return `<div class="pnote">Sentence timings: ${label}${det}${this.segInfo && this.segInfo.cached ? " · cached" : ""}</div>`;
    }
    // Say what is actually wrong.  Blaming the missing Worker when a resolver IS
    // configured sent the reader looking in the wrong place.
    if (!hasCors()) {
      return `<div class="pnote">Playing from the public podcast feed. Install the resolver
        (setup → resolver URL) to unlock sentence looping and tap-to-seek.</div>`;
    }
    const why = this.timingsReason();
    return why ? `<div class="pnote">Sentence timings: ${esc(why)}</div>` : "";
  }

  _bind() {
    const el = this.el;
    const on = (sel, ev, fn) => {
      const n = el.querySelector(sel);
      if (n) n.addEventListener(ev, fn);
    };
    on('[data-a="toggle"]', "click", () => this.toggle());
    on('[data-a="prev"]', "click", () => this.prevSentence());
    on('[data-a="next"]', "click", () => this.nextSentence());
    on('[data-a="clip"]', "click", () => { this.loopClip = !this.loopClip; this._repaint(); });
    on('[data-a="segloop"]', "click", () => {
      this.loopSentence = !this.loopSentence;
      if (this.loopSentence) {
        this.shadow = false;
        if (this.active >= 0) this.loopIndex = this.active;
        else this.goto(0, { loop: true });
      }
      this._repaint();
    });
    on('[data-a="shadow"]', "click", () => {
      this.shadow = !this.shadow;
      if (this.shadow) {
        this.loopSentence = false;
        this.shadowReps = 0;
        if (this.active >= 0) this.shadowIndex = this.active;
        else this.goto(0);
      } else if (this.shadowTimer) { clearTimeout(this.shadowTimer); this.shadowTimer = null; }
      this._repaint();
    });
    on('[data-a="rate"]', "click", () => this.cycleRate());
    on('[data-a="togglecollapse"]', "click", () => this.toggleCollapsed());
    // Tapping the folded bar brings the controls back, but a click on one of its
    // own buttons (play/pause) must not also expand it.
    on('[data-a="bar"]', "click", (e) => {
      if (e.target.closest("button")) return;
      this.setCollapsed(false);
    });
    on('[data-a="ab"]', "click", () => {
      const t = this.audio.currentTime;
      if (!this.ab) this.setAB(t, null);
      else if (this.ab.b == null && t > this.ab.a + 0.3) this.setAB(this.ab.a, t);
      else this.clearAB();
    });
    on('[data-a="abclear"]', "click", () => this.clearAB());
    on('[data-a="seg"]', "click", () => this.segmentNow(true).catch((e) => this._emit("failed", { reason: e.message })));
    on('[data-a="save"]', "click", () => this.download());
    on('[data-a="unsave"]', "click", () => this.unsave());

    const scrub = el.querySelector('[data-a="scrub"]');
    if (scrub) {
      let dragging = false;
      const at = (ev) => {
        const r = scrub.getBoundingClientRect();
        const x = clamp((ev.clientX - r.left) / r.width, 0, 1);
        return x * (this.audio.duration || 0);
      };
      const down = (ev) => { dragging = true; scrub.setPointerCapture(ev.pointerId); this.seek(at(ev)); this._paintNow(at(ev)); };
      scrub.addEventListener("pointerdown", down);
      scrub.addEventListener("pointermove", (ev) => { if (dragging) { this.seek(at(ev)); this._paintNow(at(ev)); } });
      scrub.addEventListener("pointerup", (ev) => { dragging = false; this.seek(at(ev)); });
      scrub.addEventListener("pointercancel", () => { dragging = false; });
      scrub.addEventListener("click", (ev) => this.seek(at(ev)));
    }
  }

  _paintNow(forced) {
    if (!this.el) return;
    const a = this.audio, d = this._effectiveDuration();
    const t = forced != null ? forced : (a.currentTime || 0);
    const pct = d ? (t / d) * 100 : 0;
    const now = this.el.querySelector(".now");
    const knob = this.el.querySelector(".knob");
    if (now) now.style.width = `${pct}%`;
    if (knob) knob.style.left = `${pct}%`;
    const tn = this.el.querySelector('[data-t="now"]');
    if (tn) tn.textContent = fmt(t);
    const td = this.el.querySelector('[data-t="dur"]');
    if (td && d) td.textContent = fmt(d);
  }

  _paintBuffer() {
    if (!this.el) return;
    const a = this.audio, d = a.duration || 0;
    if (!d || !a.buffered.length) return;
    const end = a.buffered.end(a.buffered.length - 1);
    const buf = this.el.querySelector(".buf");
    if (buf) buf.style.width = `${clamp((end / d) * 100, 0, 100)}%`;
  }

  /** The duration to show and to lay sentence marks out against: the real one
   *  once the media has loaded, otherwise the duration baked into the index, so
   *  the player reads correctly as soon as the timings exist instead of
   *  depending on a media load that a headless/background tab may never do. */
  _effectiveDuration() {
    const d = this.audio.duration;
    if (isFinite(d) && d > 0) return d;
    return this.knownDur || 0;
  }

  _paintMarks() {
    if (!this.el || !this._hasSeg()) return;
    const box = this.el.querySelector(".marks");
    const d = this._effectiveDuration();
    if (!box || !d) return;                 // retried on durationchange
    box.innerHTML = this.times
      .map(([s]) => `<i style="left:${(s / d) * 100}%"></i>`).join("");
  }
}

export const player = new Player();
