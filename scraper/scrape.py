#!/usr/bin/env python3
"""Crawl newsinlevels.com product pages into per-level JSON records.

Usage:
    python scraper/scrape.py                 # incremental full crawl
    python scraper/scrape.py --limit 200     # smoke test
    python scraper/scrape.py --refresh       # ignore stored lastmod, re-fetch all
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nil  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
RAW = os.path.join(BUILD, "raw")
STATE = os.path.join(BUILD, "state.json")

SITEMAPS = ["https://www.newsinlevels.com/products-sitemap.xml"] + [
    f"https://www.newsinlevels.com/products-sitemap{i}.xml" for i in range(2, 18)
]

_print_lock = threading.Lock()


def log(*a):
    with _print_lock:
        print(*a, flush=True)


def fetch(url: str, tries: int = 4, timeout: int = 45) -> str | None:
    delay = 1.0
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": nil.UA,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            })
            with urllib.request.urlopen(req, timeout=timeout) as r:
                charset = r.headers.get_content_charset() or "utf-8"
                return r.read().decode(charset, "ignore")
        except urllib.error.HTTPError as e:
            if e.code in (404, 410):
                return None
            delay = min(delay * 2, 20) + random.random()
        except Exception:
            delay = min(delay * 2, 20) + random.random()
        time.sleep(delay)
    return None


def load_state() -> dict:
    if os.path.exists(STATE):
        with open(STATE, encoding="utf-8") as fh:
            return json.load(fh)
    return {}


def collect_urls() -> list[tuple[str, str]]:
    """Return [(url, lastmod)] from every product sitemap (newest first)."""
    out: list[tuple[str, str]] = []
    for sm in SITEMAPS:
        xml = fetch(sm)
        if not xml:
            log("  !! could not fetch", sm)
            continue
        entries = re.findall(r"<url>(.*?)</url>", xml, re.S)
        for e in entries:
            m = re.search(r"<loc>(.*?)</loc>", e)
            if not m:
                continue
            url = m.group(1).strip()
            if "/products/" not in url or not re.search(r"-level-\d/?$", url):
                continue
            lm = re.search(r"<lastmod>(.*?)</lastmod>", e)
            out.append((url, lm.group(1).strip() if lm else ""))
        log(f"  sitemap {sm.rsplit('/', 1)[-1]}: running total {len(out)}")
    # de-duplicate, keeping first (newest) occurrence
    seen, uniq = set(), []
    for u, lm in out:
        if u in seen:
            continue
        seen.add(u)
        uniq.append((u, lm))
    return uniq


def raw_path(url: str) -> str:
    slug = url.rstrip("/").split("/products/")[-1]
    return os.path.join(RAW, slug.replace("/", "_") + ".json")


def worker(url: str, lastmod: str, refresh: bool) -> str:
    dst = raw_path(url)
    if not refresh and os.path.exists(dst):
        try:
            with open(dst, encoding="utf-8") as fh:
                old = json.load(fh)
            if old.get("_lastmod") == lastmod:
                return "skip"
        except Exception:
            pass
    html = fetch(url)
    if html is None:
        return "fail"
    try:
        rec = nil.parse_page(url, html)
    except Exception as e:  # noqa: BLE001
        log("  parse error", url, e)
        return "fail"
    if not rec["paragraphs"] and not rec["title"]:
        return "empty"
    rec["_lastmod"] = lastmod
    tmp = dst + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(rec, fh, ensure_ascii=False)
    os.replace(tmp, dst)
    return "ok"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--refresh", action="store_true")
    args = ap.parse_args()

    os.makedirs(RAW, exist_ok=True)
    log(f"==> collecting URL list ({len(SITEMAPS)} sitemaps)")
    urls = collect_urls()
    log(f"==> {len(urls)} product URLs")

    state = load_state()
    todo = [(u, lm) for u, lm in urls if args.refresh or state.get(u) != lm]
    if args.limit:
        todo = todo[: args.limit]
    todo_map = dict(todo)
    log(f"==> {len(todo)} URLs need fetching ({len(urls) - len(todo)} up to date)")
    if not todo:
        return

    counts = {"ok": 0, "skip": 0, "fail": 0, "empty": 0}
    fails: list[str] = []
    t0 = time.time()
    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(worker, u, lm, args.refresh): u for u, lm in todo}
        for fut in as_completed(futs):
            u = futs[fut]
            try:
                r = fut.result()
            except Exception as e:  # noqa: BLE001
                r = "fail"
                log("  worker crash", u, e)
            counts[r] += 1
            if r == "fail":
                fails.append(u)
            done += 1
            if r != "skip":
                state[u] = todo_map.get(u, "")
                if done % 25 == 0 or done == len(todo):
                    rate = done / max(time.time() - t0, 0.001)
                    eta = (len(todo) - done) / max(rate, 0.001)
                    log(f"  [{done}/{len(todo)}] {rate:.1f}/s eta {eta/60:.1f}m "
                        f"ok={counts['ok']} fail={counts['fail']} empty={counts['empty']}")
                if done % 200 == 0:
                    with open(STATE, "w", encoding="utf-8") as fh:
                        json.dump(state, fh)

    with open(STATE, "w", encoding="utf-8") as fh:
        json.dump(state, fh)
    log(f"==> done in {(time.time()-t0)/60:.1f} min: {counts}")
    if fails:
        with open(os.path.join(BUILD, "failed.txt"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(fails))
        log(f"==> {len(fails)} failures written to build/failed.txt")


if __name__ == "__main__":
    main()
