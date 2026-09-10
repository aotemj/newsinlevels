#!/usr/bin/env python3
"""Sync the newest N stories into docs/data/ as static JSON for the PWA.

Pipeline
  1. walk the product sitemaps newest-first until N stories are collected
  2. fetch only pages whose lastmod changed (resumable via build/state.json)
  3. build a slug -> category map from the category archive listings
  4. write docs/data/index.json + docs/data/s/<story>.json, pruning outside the window

Usage
  python scraper/sync.py                 # full sync (default window 150)
  python scraper/sync.py --window 60
  python scraper/sync.py --no-categories
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nil  # noqa: E402
from scrape import BUILD, RAW, fetch, log, load_state  # noqa: E402

ROOT = os.path.dirname(BUILD)
DOCS = os.path.join(ROOT, "docs")
DATA = os.path.join(DOCS, "data")
STORE = os.path.join(DATA, "s")

# sitemap chunks are numbered oldest -> newest; sitemap.xml is the oldest.
NEWEST_CHUNK = 16
# fetch this many extra stories so the quality gates can drop a few spam/manual
# pages without shrinking the window the user asked for
OVERFETCH = 15
CATEGORIES = ["news", "sport", "funny", "nature", "history",
              "interesting", "information", "exercises"]


# --------------------------------------------------------------------------- #
# 1. discover the newest stories
# --------------------------------------------------------------------------- #
def chunk_url(sm: str, index: int) -> str:
    if index == 1:
        return f"https://www.newsinlevels.com/{sm}.xml"
    return f"https://www.newsinlevels.com/{sm}{index}.xml"


def story_id_of(url: str) -> str:
    return re.sub(r"-level-\d/?$", "", url.rstrip("/").split("/products/")[-1])


def collect_newest(story_window: int) -> list[tuple[str, str]]:
    """Return [(url, lastmod)] for every level page of the newest story_window stories.

    Sitemap chunks are numbered oldest -> newest and, inside a chunk, entries run
    oldest -> newest, so walking chunks downwards and reversing each one gives a
    newest-first stream.  The three levels of one story are NOT adjacent in that
    stream, so the window is chosen on distinct story ids first and every page of
    a selected story is then taken -- otherwise a story can arrive half-fetched.
    """
    target = int(story_window * 1.5)          # headroom so no story is cut off
    uniq: list[tuple[str, str]] = []
    seen_urls: set[str] = set()
    seen_stories: list[str] = []

    for idx in range(NEWEST_CHUNK, 0, -1):
        url = chunk_url("products-sitemap", idx)
        xml = fetch(url)
        if not xml:
            log(f"  !! could not fetch {url}")
            continue
        order: list[tuple[str, str]] = []
        for e in re.findall(r"<url>(.*?)</url>", xml, re.S):
            m = re.search(r"<loc>(.*?)</loc>", e)
            if not m:
                continue
            u = m.group(1).strip()
            if "/products/" not in u or not re.search(r"-level-\d/?$", u):
                continue
            lm = re.search(r"<lastmod>(.*?)</lastmod>", e)
            order.append((u, lm.group(1).strip() if lm else ""))
        order.reverse()                        # newest first inside the chunk
        for u, lm in order:
            if u in seen_urls:
                continue
            seen_urls.add(u)
            uniq.append((u, lm))
            sid = story_id_of(u)
            if sid not in seen_stories:
                seen_stories.append(sid)
        log(f"  chunk {idx}: {len(order)} pages, {len(seen_stories)} distinct stories so far")
        if len(seen_stories) >= target:
            break

    picked = seen_stories[:story_window]
    keep = set(picked)
    sel = [(u, lm) for u, lm in uniq if story_id_of(u) in keep]
    by_story: dict[str, set[int]] = {}
    for u, _ in sel:
        m = re.search(r"-level-(\d)/?$", u)
        if m:
            by_story.setdefault(story_id_of(u), set()).add(int(m.group(1)))
    thin = {s: sorted(lv) for s, lv in by_story.items() if len(lv) < 3}
    if thin:
        log(f"  note: {len(thin)} stories have fewer than 3 levels: "
            f"{list(thin.items())[:6]}")
    return sel


# --------------------------------------------------------------------------- #
# 2. fetch pages
# --------------------------------------------------------------------------- #
def raw_path(url: str) -> str:
    slug = url.rstrip("/").split("/products/")[-1]
    return os.path.join(RAW, slug.replace("/", "_") + ".json")


def fetch_one(url: str, lastmod: str, state: dict) -> str:
    dst = raw_path(url)
    if os.path.exists(dst):
        try:
            with open(dst, encoding="utf-8") as fh:
                if json.load(fh).get("_lastmod") == lastmod:
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
    if not rec["paragraphs"] or not rec["title"]:
        # the site answers unknown product URLs with a 200 redirect to the homepage,
        # so a missing article title/body means "not a product page", not "empty story"
        log("  !! not a product page (soft 404?):", url)
        return "empty"
    rec["_lastmod"] = lastmod
    tmp = dst + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(rec, fh, ensure_ascii=False)
    os.replace(tmp, dst)
    return "ok"


# --------------------------------------------------------------------------- #
# 3. categories
# --------------------------------------------------------------------------- #
CAT_MAP = os.path.join(BUILD, "categories.json")


def _listing_items(html: str):
    """[(story_slug, 'YYYY-MM-DD')] from one category archive page."""
    out = []
    for blk in re.findall(r'<div class="news-block">(.*?)(?=<div class="news-block">|</div>\s*</div>\s*</div>)',
                          html, re.S):
        m = re.search(r'<h3><a href="([^"]+/products/[^"]+)"', blk)
        d = re.search(r'<div class="news-excerpt">\s*<p>(\d{2})-(\d{2})-(\d{4})', blk)
        if not (m and d):
            continue
        out.append((story_id_of(m.group(1)), f"{d.group(3)}-{d.group(2)}-{d.group(1)}"))
    return out


def crawl_categories(before_date: str, workers: int = 8) -> dict:
    """Map story slug -> category by walking each archive newest-first.

    Stops as soon as a page runs past ``before_date`` (the oldest date in our
    window), so a daily run reads ~50 pages instead of the whole archive.
    """
    mapping: dict[str, str] = {}

    def walk(cat: str):
        got = {}
        for page in range(1, 65):
            url = (f"https://www.newsinlevels.com/category/{cat}/" if page == 1
                   else f"https://www.newsinlevels.com/category/{cat}/page/{page}/")
            html = fetch(url, tries=2)
            if not html:
                break
            items = _listing_items(html)
            if not items:
                break
            for slug, d in items:
                got.setdefault(slug, (cat, d))
            if min(d for _, d in items) < before_date:
                break
        return got

    with ThreadPoolExecutor(max_workers=workers) as ex:
        for got in ex.map(walk, CATEGORIES):
            for slug, (cat, _d) in got.items():
                mapping.setdefault(slug, cat)
    log(f"  categories: {len(mapping)} slugs mapped")
    return mapping


# --------------------------------------------------------------------------- #
# 4. durations from the SoundCloud podcast feed (free, covers ~167 stories)
# --------------------------------------------------------------------------- #
def podcast_durations() -> dict:
    xml = fetch("https://feeds.soundcloud.com/users/soundcloud:users:1060338772/sounds.rss")
    if not xml:
        return {}
    out = {}
    for it in re.findall(r"<item>(.*?)</item>", xml, re.S):
        enc = re.search(r'<enclosure[^>]*url="[^"]*?/stream/(\d+)-', it)
        dur = re.search(r"<itunes:duration>(.*?)</itunes:duration>", it)
        if not (enc and dur):
            continue
        parts = [int(p) for p in dur.group(1).split(":") if p.strip().isdigit()]
        secs = 0
        for p in parts:
            secs = secs * 60 + p
        out[enc.group(1)] = secs
    return out


# --------------------------------------------------------------------------- #
# 5. build the static data
# --------------------------------------------------------------------------- #
def title_without_level(title: str, level: int) -> str:
    if not title:
        return ""
    for dash in ("–", "—", "-"):
        suffix = f" {dash} level {level}"
        if title.endswith(suffix):
            return title[: -len(suffix)].strip()
    return re.sub(r"\s*[-–—]\s*level\s*\d\s*$", "", title, flags=re.I).strip()


# pages that exist under /products/ but are not news stories
NON_NEWS_SLUGS = {"how-to-use-news-in-levels"}


def looks_non_english(title: str) -> bool:
    """Guard against injected spam: real stories have Latin-script titles.

    The site has been hit by SEO injection (a Turkish article about shrinking
    PDFs showed up under /products/), so anything whose letters are mostly
    outside Latin ranges is dropped rather than shipped into the reader.
    """
    letters = [c for c in (title or "") if c.isalpha()]
    if len(letters) < 4:
        return True
    outside_latin = sum(1 for c in letters if ord(c) > 0x024F)   # past Latin Extended-B
    return outside_latin / len(letters) > 0.20


def level_has_audio(rec: dict) -> bool:
    return bool((rec.get("audio") or {}).get("track"))


def prepare_stories(story_records: dict, categories: dict, durations: dict, window: int):
    """Pure: apply the quality gates and cut the window. Writes nothing."""
    stories, payloads, dropped = [], {}, []
    for sid, levels in story_records.items():
        base = levels.get(1) or next(iter(levels.values()))
        title = title_without_level(base.get("title"), base.get("level") or 1)

        # --- quality gates -------------------------------------------------
        if sid in NON_NEWS_SLUGS:
            dropped.append((sid, "not a news page"))
            continue
        if looks_non_english(title):
            dropped.append((sid, "title is not Latin-script (spam?)"))
            continue
        if not any(level_has_audio(r) for r in levels.values()):
            dropped.append((sid, "no audio on any level"))
            continue

        entry = {
            "id": sid,
            "title": title,
            "date": base.get("date"),
            "cat": categories.get(sid),
            "img": base.get("image"),
            "lv": sorted(levels),
            "noaud": sorted(lv for lv, r in levels.items() if not level_has_audio(r)),
            "dur": {},
        }
        for lv, rec in levels.items():
            tr = (rec.get("audio") or {}).get("track")
            if tr and tr in durations:
                entry["dur"][str(lv)] = durations[tr]
        stories.append(entry)
        payloads[sid] = {
            "id": entry["id"],
            "title": entry["title"],
            "date": entry["date"],
            "cat": entry["cat"],
            "img": entry["img"],
            "levels": {
                str(lv): {
                    "url": rec.get("url"),
                    "paragraphs": rec.get("paragraphs") or [],
                    "words": rec.get("words") or [],
                    "audio": rec.get("audio"),
                } for lv, rec in levels.items()
            },
        }

    stories.sort(key=lambda s: (s["date"] or "", s["id"]), reverse=True)
    stories = stories[:window]
    return stories, payloads, dropped


def check_publishable(stories, story_records, window) -> list:
    """Refuse obviously broken syncs *before* anything is written."""
    problems = []
    if len(stories) < max(10, int(window * 0.6)):
        problems.append(f"only {len(stories)} of ~{window} stories built")
    dated = [r[1]["date"] for r in story_records.values()
             if (r.get(1) or {}).get("date")]
    if not dated:
        problems.append("no story carries a date")
    else:
        newest = max(dated)
        age = (time.time() - time.mktime(time.strptime(newest, "%Y-%m-%d"))) / 86400
        if age > 21:
            problems.append(f"newest story is {age:.0f} days old ({newest})")
    return problems


def write_data(stories, payloads, window):
    os.makedirs(STORE, exist_ok=True)
    for f in os.listdir(STORE):
        if f.endswith(".json"):
            os.remove(os.path.join(STORE, f))
    for s in stories:
        with open(os.path.join(STORE, f"{s['id']}.json"), "w", encoding="utf-8") as fh:
            json.dump(payloads[s["id"]], fh, ensure_ascii=False)
    index = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "count": len(stories),
        "window": window,
        "categories": CATEGORIES,
        "stories": stories,
    }
    with open(os.path.join(DATA, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(index, fh, ensure_ascii=False, separators=(",", ":"))
    return index


# --------------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", type=int, default=150)
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--no-categories", action="store_true")
    ap.add_argument("--no-prune-raw", action="store_true")
    args = ap.parse_args()

    os.makedirs(RAW, exist_ok=True)
    state = load_state()

    log(f"==> discovering newest {args.window} stories (+{OVERFETCH} headroom for filtering)")
    urls = collect_newest(args.window + OVERFETCH)
    story_slugs = {re.sub(r"-level-\d/?$", "", u.rstrip("/").split("/products/")[-1])
                   for u, _ in urls}
    log(f"==> {len(urls)} pages for {len(story_slugs)} stories")

    todo = [(u, lm) for u, lm in urls if state.get(u) != lm or not os.path.exists(raw_path(u))]
    log(f"==> {len(todo)} pages need fetching")
    counts = {"ok": 0, "skip": 0, "fail": 0, "empty": 0}
    failed = []
    if todo:
        t0 = time.time()
        with ThreadPoolExecutor(max_workers=args.workers) as ex:
            for (u, lm), r in zip(todo, ex.map(lambda a: fetch_one(*a, state), todo)):
                counts[r] += 1
                if r == "fail":
                    failed.append(u)
                else:
                    state[u] = lm
        log(f"==> fetched in {time.time()-t0:.0f}s {counts}")
    with open(os.path.join(BUILD, "state.json"), "w", encoding="utf-8") as fh:
        json.dump(state, fh)

    # group raw records by story
    story_records: dict[str, dict[int, dict]] = {}
    for u, _ in urls:
        p = raw_path(u)
        if not os.path.exists(p):
            continue
        with open(p, encoding="utf-8") as fh:
            rec = json.load(fh)
        sid, lv = rec["story_id"], rec["level"]
        if sid and lv:
            story_records.setdefault(sid, {})[lv] = rec
    log(f"==> {len(story_records)} stories parsed from disk")

    before = min((r.get("date") or "9999") for lv in story_records.values() for r in lv.values())
    categories = {}
    if not args.no_categories and os.path.exists(CAT_MAP):
        with open(CAT_MAP, encoding="utf-8") as fh:
            categories = json.load(fh)
    if not args.no_categories:
        log(f"==> crawling category archives (window starts {before})")
        fresh = crawl_categories(before)
        categories.update(fresh)
        with open(CAT_MAP, "w", encoding="utf-8") as fh:
            json.dump(categories, fh)
    log(f"==> {sum(1 for s in story_records if s in categories)}/{len(story_records)} stories have a category")

    log("==> fetching podcast durations")
    durations = podcast_durations()
    log(f"==> {len(durations)} track durations known")

    # --- decide what to publish BEFORE touching docs/ -----------------------
    stories, payloads, dropped = prepare_stories(
        story_records, categories, durations, args.window)
    if dropped:
        log(f"==> dropped {len(dropped)} non-story pages:")
        for sid, why in dropped[:10]:
            log(f"      - {sid[:60]} ({why})")

    problems = check_publishable(stories, story_records, args.window)
    if problems:
        log("!! ABORT — refusing to publish, docs/ left untouched:")
        for p in problems:
            log("     -", p)
        sys.exit(2)

    idx = write_data(stories, payloads, args.window)
    size = sum(os.path.getsize(os.path.join(STORE, f)) for f in os.listdir(STORE))
    log(f"==> wrote {idx['count']} stories, data/s = {size/1024:.0f} KB, "
        f"index.json = {os.path.getsize(os.path.join(DATA,'index.json'))/1024:.0f} KB")
    newest = max(r[1]["date"] for r in story_records.values()
                 if (r.get(1) or {}).get("date"))
    log(f"==> ok: {idx['count']} stories, newest {newest}")

    if failed:
        with open(os.path.join(BUILD, "failed.txt"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(failed))
        log(f"==> {len(failed)} failures -> build/failed.txt")


if __name__ == "__main__":
    main()
