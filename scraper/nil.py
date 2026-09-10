"""HTML -> structured data parser for newsinlevels.com product pages."""
import html
import json
import re

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

CUT_MARKERS = ("addthis_native_toolbox",)
# boilerplate paragraphs that are not part of the story
DROP_PARA = re.compile(
    r"^\s*(?:You can watch|Watch the video|Difficult words:|Original video:|"
    r"Read more:|The post )",
    re.I)


def _clean(s: str) -> str:
    s = html.unescape(s)
    s = s.replace("\u00a0", " ")
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def _strip_tags_keep_strong(frag: str) -> str:
    """Drop every tag except <strong>/<em>, unwrap anchors, de-duplicate nested strongs."""
    frag = re.sub(r"<script.*?</script>", "", frag, flags=re.S | re.I)
    frag = re.sub(r"<a\b[^>]*>", "", frag, flags=re.I)
    frag = re.sub(r"</a\s*>", "", frag, flags=re.I)
    # normalise <b>/<i>
    frag = re.sub(r"<(/?)(b)\s*>", r"<\1strong>", frag, flags=re.I)
    frag = re.sub(r"<(/?)(i)\s*>", r"<\1em>", frag, flags=re.I)
    # drop all remaining tags except strong/em
    frag = re.sub(r"<(?!\/?(?:strong|em)\b)[^>]+>", "", frag, flags=re.I)
    # collapse duplicated nested markers: <strong><strong>x</strong></strong>
    for _ in range(3):
        frag = re.sub(r"<strong>\s*<strong>(.*?)</strong>\s*</strong>", r"<strong>\1</strong>", frag, flags=re.S)
        frag = re.sub(r"<em>\s*<em>(.*?)</em>\s*</em>", r"<em>\1</em>", frag, flags=re.S)
    return frag.strip()


def _text_of(frag: str) -> str:
    return _clean(re.sub(r"<[^>]+>", " ", frag))


WORD_RE = re.compile(r"<(strong|em)>(.*?)</\1>\s*\(([^()]*)\)", re.S)


def parse_words(html_frag: str):
    """Extract {'w': word, 'd': definition} pairs from the 'Difficult words' paragraph."""
    i = html_frag.lower().find("difficult words")
    if i == -1:
        return []
    frag = html_frag[i:]
    frag = frag.split("</p>")[0]
    # unwrap the nested anchors first so <strong>w</strong></a></a> (d) matches
    frag = _strip_tags_keep_strong(frag)
    out, seen = [], set()
    for _, w, d in WORD_RE.findall(frag):
        w, d = _text_of(w), _text_of(d)
        if not w or not d:
            continue
        k = w.lower()
        if k in seen:
            continue
        seen.add(k)
        out.append({"w": w, "d": d})
    return out


def parse_content_block(page_html: str):
    """Return the raw inner HTML of <div id='nContent'> ('' when the paywall/None)."""
    m = re.search(r'<div\s+id="nContent"\s*>', page_html, re.I)
    if not m:
        return ""
    body = page_html[m.end():]
    cut = len(body)
    for marker in CUT_MARKERS:
        j = body.find(marker)
        if j != -1:
            cut = min(cut, j)
    body = body[:cut]
    # drop the trailing structural </div>s
    body = re.sub(r"(?:\s*</div>\s*)+$", "", body)
    return body.strip()


def parse_paragraphs(block_html: str):
    """Split the content block into paragraphs + the date stamp."""
    paras = re.findall(r"<p\b[^>]*>(.*?)</p>", block_html, re.S)
    date = None
    out = []
    for p in paras:
        txt = _text_of(p)
        if not txt:
            continue
        m = re.match(r"^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})", txt)
        if m and date is None:
            date = f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
            rest = txt[m.end():].strip()
            if not rest:
                continue
            p = p  # keep original markup, body continues below
        if DROP_PARA.match(txt):
            continue
        clean = _strip_tags_keep_strong(p)
        if _text_of(clean):
            out.append(clean)
    return date, out


def parse_audio(page_html: str):
    """Return (soundcloud_meta, youtube_id).

    The widget src is double-encoded, so the track id shows up as
    ``soundcloud%253Atracks%253A<id>`` and the private-track token as
    ``secret_token%253D<token>``.  Older pages embed the widget with a single
    level of encoding instead, so both forms are handled.
    """
    decoded = html.unescape(page_html)
    for pattern in (
        r"api\.soundcloud\.com/tracks/(\d+)(?:[?%]3Fsecret_token[=%]3D(s-[A-Za-z0-9]+))?",
        r"api\.soundcloud\.com/tracks/(\d+)(?:\?secret_token=(s-[A-Za-z0-9]+))?",
    ):
        m = re.search(pattern, decoded)
        if m:
            sc = {"type": "soundcloud", "track": m.group(1), "secret": m.group(2) or None}
            break
    else:
        m = re.search(r"soundcloud%253Atracks%253A(\d+)", page_html)
        if m:
            sec = re.search(r"secret_token%253D(s-[A-Za-z0-9]+)", page_html)
            sc = {"type": "soundcloud", "track": m.group(1), "secret": sec.group(1) if sec else None}
        else:
            sc = None

    yt = None
    m = re.search(r"youtube(?:-nocookie)?\.com/embed/([A-Za-z0-9_-]{11})", page_html)
    if m:
        yt = m.group(1)
    return sc, yt


def parse_page(url: str, page_html: str) -> dict:
    """Parse one product page into a per-level record."""
    lvl_m = re.search(r"-level-(\d)/?$", url.rstrip("/"))
    level = int(lvl_m.group(1)) if lvl_m else None

    title = None
    m = re.search(r'<div class="article-title">\s*<h2>(.*?)</h2>', page_html, re.S)
    if m:
        title = _clean(m.group(1))

    img = None
    m = re.search(r'property="og:image"\s+content="([^"]+)"', page_html)
    if m:
        img = m.group(1)

    block = parse_content_block(page_html)
    date, paragraphs = parse_paragraphs(block)
    if date is None:
        m = re.search(r'property="og:description"\s+content="(\d{2})-(\d{2})-(\d{4})', page_html)
        if m:
            date = f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
        else:
            m = re.search(r'"datePublished":"(\d{4}-\d{2}-\d{2})', page_html)
            if m:
                date = m.group(1)

    sc, yt = parse_audio(page_html)
    slug = url.rstrip("/").split("/products/")[-1]
    story_id = re.sub(r"-level-\d$", "", slug)

    return {
        "url": url,
        "story_id": story_id,
        "level": level,
        "title": title,
        "date": date,
        "image": img,
        "paragraphs": paragraphs,
        "words": parse_words(block),
        "audio": sc,
        "video": yt,
    }


def sitemap_urls(xml_text: str):
    return re.findall(r"<loc>(.*?)</loc>", xml_text)


def feed_stories(feed_xml: str):
    """Parse newsinlevels RSS: full text for all three levels."""
    items = re.findall(r"<item>(.*?)</item>", feed_xml, re.S)
    out = []
    for it in items:
        t = re.search(r"<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</title>", it, re.S)
        l = re.search(r"<link>(.*?)</link>", it, re.S)
        c = re.search(r"<category><!\[CDATA\[(.*?)\]\]></category>", it, re.S)
        cd = re.search(r"<content:encoded><!\[CDATA\[(.*?)\]\]></content:encoded>", it, re.S)
        if not (t and l):
            continue
        out.append({
            "title": html.unescape(t.group(1)).strip(),
            "url": l.group(1).strip(),
            "category": html.unescape(c.group(1)) if c else None,
            "content": cd.group(1) if cd else "",
        })
    return out


def sc_feed_url(track: str) -> str:
    """SoundCloud's permanent podcast mp3 URL for a public track."""
    return f"https://feeds.soundcloud.com/stream/{track}-newsinlevels-x.mp3"


def category_of_url(url: str) -> str:
    parts = url.rstrip("/").split("/products/")[-1]
    return re.sub(r"-level-\d$", "", parts)


if __name__ == "__main__":
    import sys
    # usage: nil.py <url> <saved.html> [<url> <saved.html> ...]
    args = sys.argv[1:]
    for url, path in zip(args[0::2], args[1::2]):
        with open(path, encoding="utf-8", errors="ignore") as fh:
            rec = parse_page(url, fh.read())
        print("=" * 70)
        print(json.dumps({k: v for k, v in rec.items() if k != "paragraphs"},
                         ensure_ascii=False, indent=1))
        print(" paragraphs:", len(rec["paragraphs"]))
        for p in rec["paragraphs"]:
            print("   P:", p[:170])
        for w in rec["words"]:
            print("   W:", w["w"], "=>", w["d"])
