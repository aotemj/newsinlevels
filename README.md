# News in Levels — reader

A self-hosted reading + listening app for [newsinlevels.com](https://www.newsinlevels.com/),
built because the official free app is awkward. It keeps the newest ~150 stories
(three levels each), plays the real audio, and adds the thing that actually helps
when you're learning: **per-sentence audio control** — tap a sentence to hear it,
loop one sentence, or shadow it out loud.

No server, no build step, no dependencies. It runs as a PWA from GitHub Pages.

| Reading list | Story + player | Level 3 with sentence timings |
|---|---|---|
| ![list](screenshots/01-list.png) | ![reader](screenshots/02-reader.png) | ![level 3](screenshots/03-level3.png) |

<p align="center"><em>Read · listen · loop one sentence · shadow · keep a word list</em></p>

---

## What it does

**Listening**
- 0.5×–1.5× speed, remembered as your default
- **Whole-clip loop** for passive listening
- **A–B loop** — drop two markers on the scrub bar and loop that exact span
- **Per-sentence loop** — loop just the sentence you're stuck on
- **Shadowing mode** — plays a sentence, goes quiet so you can repeat it out loud, plays it again, then moves on (repeats and gap length are configurable)
- **Tap any sentence in the text** to jump the audio there
- Background playback with lock-screen / notification controls (Media Session)

**Reading**
- Switch between Level 1 / 2 / 3 instantly, or put all three side by side
- Difficult words are highlighted — tap one for its definition, add it to your word list
- Reading position, font size, light/dark/auto theme

**Keeping track**
- Saved stories, word list with a day streak, continue-reading history
- Offline: the app shell always works offline, and any clip you tap *Keep audio offline* plays with no network

---

## Quick start (local)

```bash
cd scraper && pip install -r requirements.txt   # nothing outside the stdlib
python scraper/sync.py --window 150             # ~3 min, writes docs/data/
cd docs && python3 -m http.server 8000
# open http://localhost:8000
```

At this point audio plays through the public SoundCloud podcast feed, but
sentence looping and tap-to-seek are switched off — see the next section for why.

---

## Deploy

### 1. The app (GitHub Pages)

```bash
git init && git add -A && git commit -m "initial"
git remote add origin git@github.com:<you>/<repo>.git
git push -u origin main
```

Then **Settings → Pages → Source: Deploy from a branch → `main` / `/docs`**.

The daily workflow in `.github/workflows/sync.yml` refreshes the story window
each morning (~1 min once the committed raw cache is warm) and commits the result.

### 2. The audio resolver (Cloudflare, free)

**给中国大陆用户：用 Pages 部署，不要用 Workers。** 实测（大陆家宽，无代理）：

| 主机 | 结果 |
|---|---|
| `aotemj.github.io` | ✅ HTTP 200 |
| `nil-audio.<sub>.workers.dev` | ❌ 超时 —— DNS 被污染，解析到 `192.133.77.59`（Twitter 地址段） |
| `*.pages.dev` | ✅ 可达（`cloudflare-pages.pages.dev` → 真实 Cloudflare IP + HTTP 522） |
| `api-v2.soundcloud.com` | ❌ 超时 —— 污染为 Dropbox / Facebook 地址 |
| `feeds.soundcloud.com` | ❌ 超时 |
| `cf-media.sndcdn.com` | ✅ **HTTP 403**（TLS 握手完成、服务器正常应答，只是路径无效） |

被墙的是 **Worker 自己的域名** 和 **SoundCloud 的 API/feed**；**音频字节所在的 CDN 是通的**。
也就是说 302 跳转的字节投递本来没问题，卡住的是"解析"这一步。
`pages.dev` 和 `workers.dev` 同为 Cloudflare，但只有前者没被污染，而 Pages Functions
跑的就是同一套 Worker 运行时 —— 所以搬到 Pages 即可，零成本、不用买域名。

```bash
npx wrangler login          # 一次性
npx wrangler pages deploy   # 在仓库根目录运行（读根目录的 wrangler.toml）
```

部署到 `https://nil-audio.pages.dev`：静态资源来自 `docs/`，解析器由 `functions/` 挂载在
`/audio/<id>`、`/stream/<id>`、`/health`。把该 URL 填进 `docs/config.js` 的
`WORKER_BASES[0]`，或在 App 的 setup 面板里粘贴。

> Worker 的部署方式仍然保留（`cd worker && npx wrangler deploy`）——两者共用
> `worker/index.js` 同一份实现。`WORKER_BASES` 是有序列表，音频报错时 App 会自动切到
> 下一个，所以填错、或某个域名日后被封，都不会让播放器直接死掉。

#### 两种交付方式

- `/audio/<id>` —— **302** 跳到新的签名 CDN 地址。开销最小，浏览器直连 CloudFront。
  `cf-media.sndcdn.com` 可达时用这个。
- `/stream/<id>` —— 直接**代理字节流**，并转发 `Range`。会消耗 Cloudflare 带宽，但客户端
  只跟一个域名通信 —— 万一 CDN 哪天被封就用它。

#### Why this exists

The site embeds SoundCloud players. Their public podcast feed
gives a permanent mp3 URL, but it **lags behind new uploads** and its first
redirect carries **no CORS header** — so the browser cannot read the bytes, which
is exactly what sentence detection needs. Verified against a real browser:
`<audio>` plays it fine, `<audio crossOrigin="anonymous">` fails with
`MEDIA_ELEMENT_ERROR: Format error`. Resolving through the Worker fixes both.

**Option A — API token (recommended; no OAuth callback to time out)**

1. <https://dash.cloudflare.com/profile/api-tokens> → **Create Token** →
   template **Edit Cloudflare Workers** → copy the token.
2. Then:

```bash
cd worker
CLOUDFLARE_API_TOKEN=<paste-token> npx wrangler deploy
```

If it asks which account, add `CLOUDFLARE_ACCOUNT_ID=<id>` (right-hand sidebar of
the dashboard) to the same command.

**Option B — OAuth**

```bash
cd worker
npx wrangler login     # opens a browser; you have ~2 minutes to approve
npx wrangler deploy
```

`wrangler login` failing with *"Timed out waiting for authorization code"* means
the browser step did not finish in time — usually because you were not signed in
to Cloudflare yet (signing up mid-flow blows the window). Finish signing in
first, then retry, or use Option A.

Either way it prints something like `https://nil-audio.you.workers.dev`. Check
the config without deploying at any point:

```bash
npx wrangler deploy --dry-run      # validates, uploads nothing
```

Then confirm the deployment actually works before touching the app:

```bash
python tools/check_worker.py https://nil-audio.you.workers.dev
```

It asserts six things (health, 302, CORS header, real MPEG bytes, private-track
support, clean failure on a bogus id) and tells you what a failure means. Only
paste the URL into the app once it says all good.

Then either:
- open the app → **⚙ → Audio Worker** → paste the URL → **Test** → **Save**, or
- put it in `docs/config.js` as `WORKER_BASE` before pushing, or
- open the app with `?worker=https://nil-audio.you.workers.dev`

> This checkout already has a working deployment's URL in `docs/config.js`
> (`https://nil-audio.automj-nil.workers.dev`). Replace it with yours, or clear it
> and configure at runtime from the ⚙ sheet.

**Right after the first deploy, TLS can fail for a minute or two** while the
`workers.dev` certificate and DNS settle — you get
`sslv3 alert handshake failure`, which looks alarming but is transient. `wrangler`
says the same thing ("It may take a few minutes for DNS records to update"). Wait,
then re-run `check_worker.py`. Note that macOS's built-in clients (curl, and the
system Python's LibreSSL) can be slowest to pick the change up; a browser will
usually connect first.

The Worker only resolves a track id to a fresh signed CDN URL and relays a 302.
It stores nothing, proxies no bytes, and re-hosts no audio. It is, however, a
public endpoint — anyone who finds the URL can resolve SoundCloud tracks through
it. That is what the 100k requests/day free allowance is for; add a Cloudflare
rate-limiting rule if it ever becomes a problem.

### 3. Install on the phone

Open the Pages URL in Chrome (Android) or Safari (iOS) → **Add to Home screen**.
It then behaves like an app, including background playback.

---

## How it works

```
newsinlevels.com ──► scraper/sync.py ──► docs/data/index.json
   sitemaps            (daily,          docs/data/s/<story>.json
   product pages        GitHub Action)         │
                                               ▼
                                       PWA (GitHub Pages)
                                               │  audio track id
                                               ▼
                                    Cloudflare Worker ──► SoundCloud CDN
                                       (resolves + CORS)
```

**Sentence timings.** The clips are one speaker reading slowly, so sentence ends
show up as short silences. The app fetches the clip, decodes it with Web Audio,
measures energy every 20 ms, finds the quiet runs, then aligns those spans to the
real sentences with a dynamic program (the counts often match exactly — but
**not always**: one sample gave 10 spans for 9 sentences, so the alignment is a
real DP, not an index-for-index zip). Results are cached per clip and reused.

Because the alignment is a measurement, not a guarantee, the player reports it:
*timings: good / approximate / rough*. When it says rough, fall back to the A–B
markers.

**What is deliberately not here.** Video. The original news video lives on
Level 3 pages as a YouTube embed; this app is audio-only by choice.

---

## Repo layout

```
docs/                 the app (GitHub Pages root, no build step)
  index.html app.css app.js
  player.js           audio engine: speed, A–B, sentence loop, shadowing
  segment.js          silence detection + sentence alignment
  store.js            settings, favourites, vocabulary, IndexedDB
  sw.js               service worker
  data/               generated: index.json + s/<story>.json
scraper/
  nil.py              product-page parser
  sync.py             the sync pipeline
  scrape.py           shared fetch/state helpers
worker/index.js       the resolver itself — ONE implementation, two deploy targets
wrangler.toml         Cloudflare Pages target (root) -> <name>.pages.dev
worker/wrangler.toml  Cloudflare Workers target      -> <name>.<sub>.workers.dev
functions/            Pages Functions: thin delegates to worker/index.js
  health.js audio/[id].js stream/[id].js
tools/                headless-Chrome test harnesses (not shipped)
build/raw/            committed page cache, so daily syncs are incremental
```

## Tests

Everything below runs the real code in a real browser via headless Chrome —
nothing is mocked.

```bash
# everything at once (this is the one to run after a change)
python tools/run_suite.py
python tools/run_suite.py fallback pin       # a subset by name
#   fallback — resolver base failover (offline; proves the app steps to the next
#              base from both the <audio> element AND the timings fetch)
#   pin      — the bottom bar stays pinned across six scroll/nav states
#   app      — the degraded path (asserts sentence controls are DISABLED + say why)
#   full     — the resolver path end to end (needs network access)

# or drive one harness directly
python tools/browser_probe.py tools/player_pin_probe.html --root docs --wait 160 \
    --query "worker=https://nil-audio.you.workers.dev"   # bottom-bar pinning
# degraded path -- asserts the sentence controls are DISABLED and say why
python tools/browser_probe.py tools/app_smoke.html --root docs --wait 190 \
    --query "worker=off"
# the same suite against the live resolver
python tools/browser_probe.py tools/app_smoke.html --root docs --wait 190 \
    --query "worker=https://nil-audio.you.workers.dev"

python tools/browser_probe.py tools/worker_path_smoke.html --root docs --wait 230
# ...or against a real deployment instead of the local wrapper:
python tools/browser_probe.py tools/worker_path_smoke.html --root docs --wait 230 \
    --query "worker=https://nil-audio.you.workers.dev"
python tools/browser_probe.py tools/cors_audio_probe.html --root docs --wait 170
node worker/test_local.mjs 2396246388                  # public track
node worker/test_local.mjs 1494651385 s-sfkIGtrpGXf    # private track
node worker/test_pages_functions.mjs                   # Pages Functions wiring (no deploy)
node tools/diagnose_hosts.sh                           # what is reachable from THIS network
node tools/local_worker.mjs 8787                       # Worker behind plain node
python tools/check_worker.py http://127.0.0.1:8787     # verify a deployment
python tools/segment_probe.py --slug paris-butter-shop --level 3
python tools/shots.py                                  # refresh the README screenshots
python tools/make_icons.py                             # regenerate PNG icons
```

`?worker=off` disables the resolver **even when `config.js` has one**, so the
degraded path stays testable after you deploy.

## Maintenance

```bash
python scraper/sync.py --window 150      # refresh
python scraper/sync.py --window 60       # a smaller window, e.g. for a slower phone
python scraper/sync.py --no-categories   # skip the topic crawl
```

### Layout note — one trap worth not re-introducing

The player and the tab bar live inside a single `position: fixed; bottom: 0`
container (`.bottombar`) and stack as ordinary blocks. Keep it that way.

The obvious alternative — `#player { position: fixed; bottom: calc(56px +
var(--safe-b)) }` with `--safe-b: env(safe-area-inset-bottom, 0px)` — breaks in
the wild: if that substitution cannot resolve it is invalid **at computed-value
time**, which *resets* the property (`bottom` -> `auto`), and a fixed element with
`bottom: auto` sits at its static-flow position, i.e. parked in the middle of the
article while the tab bar (literal `bottom: 0`) stays correctly pinned. It looks
exactly like "the play button doesn't stay at the bottom".

If you do need `env()` somewhere, never route it through a custom property into
`calc()`. Write the literal first and the `env()` version second, so an
unsupported `env()` drops only that declaration:

```css
.toast { bottom: 120px; bottom: calc(120px + env(safe-area-inset-bottom, 0px)); }
```

`sync.py` refuses to publish and exits non-zero if the scrape looks broken
(too few stories, or the newest story is stale), so a bad run fails the Action
instead of silently emptying the app.

## Limitations, honestly

- The window is the newest ~150 stories. Older ones are not in the app, and an
  article that scrolls out stays readable only if you saved it.
- Sentence timings can be off by a segment on unusual clips; the confidence
  label says so rather than pretending otherwise.
- A brand-new upload can be missing from the public podcast feed for a day. The
  Worker covers that case; without a Worker you may see a "source not supported"
  toast on the very latest story.
- The site occasionally injects non-story pages under `/products/`. The sync
  drops anything with no audio or a non-Latin title (a Turkish SEO-spam article
  used to slip through).

## Scope and etiquette

Personal study use. The app reads public pages, streams audio from the official
CDN, and never re-hosts the audio or the images. Text and audio belong to
News in Levels / English in Levels. If you want to redistribute anything, ask
them first.
