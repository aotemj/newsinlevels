#!/usr/bin/env python3
"""Does in-browser sentence segmentation of a News-in-Levels audio clip work?

Resolves a real SoundCloud clip to its CDN mp3, then runs a headless Chrome page
that (a) fetches it cross-origin, (b) decodes it with Web Audio, (c) finds
silence gaps, and (d) compares the resulting spans with the actual sentences of
the article text.  This is the feasibility gate for "loop one sentence" and
"shadowing" features -- if it fails, the app falls back to manual A-B markers.

Usage:  python tools/segment_probe.py [--level 1] [--slug messi-stops-playing-for-argentina]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "scraper"))
import nil  # noqa: E402

CLIENT_ID = "Pb72ranhoyt6gw7hM7TkzUItXlMWSNSo"
DATA = os.path.join(ROOT, "docs", "data")


def http_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": nil.UA})
    return json.loads(urllib.request.urlopen(req, timeout=45).read())


def resolve_mp3(track: str, secret: str | None) -> str:
    q = f"&secret_token={secret}" if secret else ""
    meta = http_json(f"https://api-v2.soundcloud.com/tracks/{track}?client_id={CLIENT_ID}{q}")
    prog = [t for t in meta.get("media", {}).get("transcodings", [])
            if t["format"]["protocol"] == "progressive"]
    if not prog:
        raise RuntimeError("no progressive transcoding")
    return http_json(prog[0]["url"] + f"?client_id={CLIENT_ID}{q}")["url"]


def sentences_of(paragraphs):
    out = []
    for p in paragraphs:
        txt = re.sub(r"<[^>]+>", "", p)
        for s in re.split(r"(?<=[.!?])\s+", txt.strip()):
            s = s.strip()
            if s:
                out.append(s)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--slug", default="paris-butter-shop")
    ap.add_argument("--level", type=int, default=1)
    args = ap.parse_args()

    story = json.load(open(os.path.join(DATA, "s", f"{args.slug}.json"), encoding="utf-8"))
    lvl = story["levels"][str(args.level)]
    track = lvl["audio"]["track"]
    secret = lvl["audio"].get("secret")
    sents = sentences_of(lvl["paragraphs"])

    mp3 = resolve_mp3(track, secret)
    print(f"story={args.slug} L{args.level} track={track}")
    print(f"signed mp3: {mp3[:90]}...")
    print(f"article sentences: {len(sents)}")

    page = PAGE.replace("__MP3__", json.dumps(mp3)).replace(
        "__SENTENCES__", json.dumps(sents, ensure_ascii=False))
    os.makedirs("/tmp/segprobe", exist_ok=True)
    page_path = "/tmp/segprobe/seg.html"
    with open(page_path, "w", encoding="utf-8") as fh:
        fh.write(page)

    out = subprocess.run([sys.executable, os.path.join(HERE, "browser_probe.py"),
                          page_path, "--wait", "90", "--port", "8793"],
                         capture_output=True, text=True, timeout=180)
    raw = out.stdout.strip()
    try:
        r = json.loads(raw)
    except Exception:
        print(raw[-3000:] or out.stderr[-2000:])
        return None
    keep = ["sentences", "fetch_ok", "bytes", "duration", "frames", "noise_floor",
            "speech_level", "threshold", "raw_spans", "segments",
            "ratio_segments_per_sentence", "avg_segment_sec", "avg_sentence_chars",
            "sec_per_char", "sec_per_char_sd", "cv_percent",
            "corr_duration_vs_chars", "trailing_silence", "error"]
    print(json.dumps({k: r.get(k) for k in keep if k in r}, indent=1))
    return r


PAGE = r"""<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<pre id="out">running…</pre>
<script>
const MP3 = __MP3__;
const SENTS = __SENTENCES__;
const report = {sentences: SENTS.length, finished:false};
function send(){ document.getElementById('out').textContent = JSON.stringify(report,null,1).slice(0,4000);
  fetch('/report',{method:'POST',body:JSON.stringify(report)}); }
function finish(){ report.finished = true; send(); }

(async function(){
  try {
    const t0 = performance.now();
    const resp = await fetch(MP3, {mode:'cors'});
    report.fetch_ok = resp.ok; report.fetch_status = resp.status;
    const buf = await resp.arrayBuffer();
    report.bytes = buf.byteLength;
    report.fetch_ms = Math.round(performance.now()-t0);

    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const t1 = performance.now();
    const audio = await ctx.decodeAudioData(buf);
    report.decode_ms = Math.round(performance.now()-t1);
    report.duration = +audio.duration.toFixed(2);
    report.sample_rate = audio.sampleRate;

    // ---- energy analysis: 20 ms frames over channel 0 ----
    const data = audio.getChannelData(0);
    const F = Math.round(audio.sampleRate * 0.02);
    const rms = [];
    for (let i = 0; i + F <= data.length; i += F) {
      let s = 0;
      for (let j = 0; j < F; j++) { const v = data[i+j]; s += v*v; }
      rms.push(Math.sqrt(s / F));
    }
    report.frames = rms.length;

    const sorted = Float32Array.from(rms).sort();
    const pct = p => sorted[Math.min(sorted.length-1, Math.floor(sorted.length*p))];
    const floor = pct(0.10), speech = pct(0.90);
    const thr = Math.max(floor * 3, speech * 0.06);   // adaptive
    report.noise_floor = +floor.toFixed(5);
    report.speech_level = +speech.toFixed(5);
    report.threshold = +thr.toFixed(5);

    // ---- silence runs ----
    const MIN_SIL_SEC = 0.22, MIN_SPEECH_SEC = 0.25;
    const minSil = Math.round(MIN_SIL_SEC / 0.02);
    const minSp  = Math.round(MIN_SPEECH_SEC / 0.02);
    const spans = [];           // speech spans [startFrame, endFrame]
    let run = 0, start = null;
    for (let i = 0; i < rms.length; i++) {
      const loud = rms[i] >= thr;
      if (loud) { if (start === null) start = i; run = 0; }
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

    // merge spans separated by gaps < the minimum silence (breaths inside a sentence)
    const MERGE = Math.round(0.45/0.02);
    const merged = [];
    for (const sp of spans) {
      const last = merged[merged.length-1];
      if (last && sp[0] - last[1] < MERGE) last[1] = sp[1];
      else merged.push([sp[0], sp[1]]);
    }
    report.raw_spans = spans.length;
    report.segments = merged.length;
    report.seg_seconds = merged.map(s => [
      +(s[0]*0.02).toFixed(2), +(s[1]*0.02).toFixed(2)
    ]);
    report.seg_lengths = merged.map(s => +((s[1]-s[0])*0.02).toFixed(2));
    report.trailing_silence = +((rms.length - (merged.length? merged[merged.length-1][1]:0))*0.02).toFixed(2);

    // alignment sanity: ratio of detected spans to real sentences
    report.ratio_segments_per_sentence = +(merged.length / SENTS.length).toFixed(2);
    report.avg_segment_sec = +(report.duration / Math.max(merged.length,1)).toFixed(2);
    report.avg_sentence_chars = Math.round(SENTS.join(' ').length / Math.max(SENTS.length,1));

    // if segments really map 1:1 onto sentences, then duration/chars must be
    // roughly constant across the clip -- report the spread of that ratio
    if (merged.length === SENTS.length) {
      const cps = merged.map((s, i) =>
        +(((s[1]-s[0])*0.02) / Math.max(SENTS[i].length,1)).toFixed(3));
      const mean = cps.reduce((a,b)=>a+b,0)/cps.length;
      const sd = Math.sqrt(cps.reduce((a,b)=>a+(b-mean)**2,0)/cps.length);
      report.sec_per_char = +mean.toFixed(3);
      report.sec_per_char_sd = +sd.toFixed(4);
      report.cv_percent = +(100*sd/mean).toFixed(1);   // <25% is a strong alignment
      // Pearson correlation between segment duration and sentence length
      const durs = merged.map(s => (s[1]-s[0])*0.02);
      const lens = SENTS.map(s => s.length);
      const md = durs.reduce((a,b)=>a+b,0)/durs.length;
      const ml = lens.reduce((a,b)=>a+b,0)/lens.length;
      let num=0, dd=0, dl=0;
      for (let i=0;i<durs.length;i++){ num+=(durs[i]-md)*(lens[i]-ml); dd+=(durs[i]-md)**2; dl+=(lens[i]-ml)**2; }
      report.corr_duration_vs_chars = +(num/Math.sqrt(dd*dl)).toFixed(3);
    }
    report.samples = SENTS.slice(0, 6);
  } catch (e) {
    report.error = String(e);
  }
  finish();
})();
setTimeout(finish, 80000);
</script></body></html>
"""

if __name__ == "__main__":
    main()
