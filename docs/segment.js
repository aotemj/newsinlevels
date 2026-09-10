/**
 * Sentence timing from audio.
 *
 * The clips are a single speaker reading the article slowly, so sentence ends
 * show up as short silences.  We decode the mp3 (needs a CORS-clean URL, which
 * is what the Worker provides), measure energy per 20 ms frame, find the quiet
 * runs, and then align the detected spans with the real sentences.
 *
 * Measured on real clips: the span count equals the sentence count most of the
 * time but NOT always (one sample gave 10 spans for 9 sentences), so the
 * alignment is a proper dynamic program rather than an index-for-index zip, and
 * the result carries a confidence the UI is expected to surface.
 */

const FRAME = 0.02;          // 20 ms analysis hop
const MIN_SILENCE = 0.22;    // shorter gaps are breaths inside a sentence
const MIN_SPEECH = 0.25;     // ignore blips
const MERGE_GAP = 0.45;      // glue spans separated by less than this

let ctx = null;
function audioCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

/** Decode raw bytes to an AudioBuffer. */
export async function decode(arrayBuffer) {
  const c = audioCtx();
  return await c.decodeAudioData(arrayBuffer);
}

/** Energy-based speech spans [[startSec, endSec], …]. */
export function findSpans(buffer) {
  const data = buffer.getChannelData(0);
  const F = Math.max(1, Math.round(buffer.sampleRate * FRAME));
  const rms = new Float32Array(Math.floor(data.length / F));
  for (let f = 0; f < rms.length; f++) {
    let s = 0;
    const off = f * F;
    for (let j = 0; j < F; j++) { const v = data[off + j]; s += v * v; }
    rms[f] = Math.sqrt(s / F);
  }

  const sorted = Float32Array.from(rms).sort();
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const floor = pct(0.10), speech = pct(0.90);
  const thr = Math.max(floor * 3, speech * 0.06);

  const minSil = Math.round(MIN_SILENCE / FRAME);
  const minSp = Math.round(MIN_SPEECH / FRAME);
  const spans = [];
  let run = 0, start = null;
  for (let i = 0; i < rms.length; i++) {
    if (rms[i] >= thr) { if (start === null) start = i; run = 0; }
    else if (start !== null) {
      run++;
      if (run >= minSil) {
        const end = i - run + 1;
        if (end - start >= minSp) spans.push([start, end]);
        start = null; run = 0;
      }
    }
  }
  if (start !== null && rms.length - start >= minSp) spans.push([start, rms.length]);

  const merge = Math.round(MERGE_GAP / FRAME);
  const merged = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp[0] - last[1] < merge) last[1] = sp[1];
    else merged.push([sp[0], sp[1]]);
  }
  return {
    spans: merged.map(([a, b]) => [+(a * FRAME).toFixed(3), +(b * FRAME).toFixed(3)]),
    noiseFloor: +floor.toFixed(5), speechLevel: +speech.toFixed(5), threshold: +thr.toFixed(5),
    frames: rms.length,
  };
}

const dur = (s) => s[1] - s[0];

/**
 * Align N sentences to M spans, monotonically and covering both fully.
 * Fewer spans than sentences -> several sentences share one span, and vice versa.
 * Returns per-sentence [start, end] plus a confidence in [0, 1].
 */
export function align(sentenceTexts, spans) {
  const N = sentenceTexts.length, M = spans.length;
  if (!N || !M) return { times: [], confidence: 0, reason: "no spans" };

  const chars = sentenceTexts.map((s) => Math.max(s.length, 1));
  const totalChars = chars.reduce((a, b) => a + b, 0);
  const speechTotal = spans.reduce((a, s) => a + dur(s), 0);

  // Zipping straight across is only valid when the counts agree; the spread of
  // seconds-per-character is then a real quality signal.
  let zipCv = null, countPenalty = Math.abs(M - N) / Math.max(N, 1);
  if (M === N) {
    const cps = spans.map((s, i) => dur(s) / chars[i]);
    const mean = cps.reduce((a, b) => a + b, 0) / cps.length;
    const sd = Math.sqrt(cps.reduce((a, b) => a + (b - mean) ** 2, 0) / cps.length);
    zipCv = mean ? sd / mean : 1;
  }

  const times = new Array(N).fill(null);

  if (M >= N) {
    // give each sentence a contiguous, non-empty block of spans
    const INF = Infinity;
    const dp = Array.from({ length: N + 1 }, () => new Float64Array(M + 1).fill(INF));
    const back = Array.from({ length: N + 1 }, () => new Int32Array(M + 1).fill(-1));
    dp[0][0] = 0;
    for (let i = 1; i <= N; i++) {
      const expected = speechTotal * (chars[i - 1] / totalChars);
      for (let j = i; j <= M - (N - i); j++) {
        for (let k = 1; k <= j - (i - 1); k++) {
          const prev = dp[i - 1][j - k];
          if (prev === INF) continue;
          let block = 0;
          for (let t = j - k; t < j; t++) block += dur(spans[t]);
          const cost = prev + Math.abs(block - expected) / Math.max(expected, 0.01);
          if (cost < dp[i][j]) { dp[i][j] = cost; back[i][j] = k; }
        }
      }
    }
    let j = M;
    for (let i = N; i >= 1; i--) {
      const k = back[i][j];
      if (k <= 0) return { times: null, confidence: 0, reason: "alignment failed" };
      times[i - 1] = [spans[j - k][0], spans[j - 1][1]];
      j -= k;
    }
  } else {
    // fewer spans than sentences: share each span across a contiguous run
    const INF = Infinity;
    const dp = Array.from({ length: M + 1 }, () => new Float64Array(N + 1).fill(INF));
    const back = Array.from({ length: M + 1 }, () => new Int32Array(N + 1).fill(-1));
    dp[0][0] = 0;
    for (let j = 1; j <= M; j++) {
      for (let i = j; i <= N - (M - j); i++) {
        for (let k = 1; k <= i - (j - 1); k++) {
          const prev = dp[j - 1][i - k];
          if (prev === INF) continue;
          let blockChars = 0;
          for (let t = i - k; t < i; t++) blockChars += chars[t];
          const expected = speechTotal * (blockChars / totalChars);
          const cost = prev + Math.abs(dur(spans[j - 1]) - expected) / Math.max(expected, 0.01);
          if (cost < dp[j][i]) { dp[j][i] = cost; back[j][i] = k; }
        }
      }
    }
    let i = N;
    for (let j = M; j >= 1; j--) {
      const k = back[j][i];
      if (k <= 0) return { times: null, confidence: 0, reason: "alignment failed" };
      for (let t = i - k; t < i; t++) times[t] = [spans[j - 1][0], spans[j - 1][1]];
      i -= k;
    }
  }

  if (times.some((t) => !t)) return { times: null, confidence: 0, reason: "incomplete" };

  // Confidence: an exact count match with an even seconds-per-character spread is
  // the strong case.  Anything else is usable but is presented as approximate.
  let confidence;
  if (M === N) {
    confidence = zipCv === null ? 0.5 : Math.max(0.15, Math.min(1, 1 - zipCv / 0.6));
  } else {
    confidence = Math.max(0.1, 0.6 * (1 - countPenalty));
  }
  if (N < 3) confidence = Math.min(confidence, 0.45);   // too few to cross-check

  const secPerChar = times.map((t, i) => dur(t) / chars[i]);
  const mean = secPerChar.reduce((a, b) => a + b, 0) / secPerChar.length;
  const sd = Math.sqrt(secPerChar.reduce((a, b) => a + (b - mean) ** 2, 0) / secPerChar.length);

  return {
    times,
    confidence: +confidence.toFixed(3),
    spans: M,
    sentences: N,
    secPerChar: +mean.toFixed(4),
    cvAfterAlign: +(mean ? sd / mean : 0).toFixed(3),
    exactCount: M === N,
  };
}

/** Full pipeline: fetch bytes -> decode -> spans -> align. */
export async function segmentUrl(url, sentenceTexts, onProgress = () => {}) {
  onProgress("downloading audio");
  const resp = await fetch(url, { mode: "cors" });
  if (!resp.ok) throw new Error(`audio fetch ${resp.status}`);
  const buf = await resp.arrayBuffer();
  onProgress(`decoding ${(buf.byteLength / 1024 | 0)} KB`);
  const decoded = await decode(buf);
  onProgress("finding sentence pauses");
  const { spans, noiseFloor, speechLevel, threshold } = findSpans(decoded);
  const a = align(sentenceTexts, spans);
  return { duration: decoded.duration, spans, noiseFloor, speechLevel, threshold, ...a };
}

/** Split a paragraph into sentences, keeping it usable for display too. */
export function splitSentences(html) {
  const text = html.replace(/<[^>]+>/g, "");
  const out = [];
  const re = /[^.!?]*[.!?]+(?:\s+|$)|[^.!?]+$/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const s = m[0].trim();
    if (s) out.push(s);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out.length ? out : [text.trim()];
}
