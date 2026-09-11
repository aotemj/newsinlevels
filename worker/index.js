/**
 * News in Levels — audio resolver (Cloudflare Worker)
 *
 *   GET /audio/<trackId>?s=<secret>    -> 302 to a fresh signed CDN mp3 (cheap)
 *   GET /stream/<trackId>?s=<secret>   -> the mp3 bytes themselves, proxied
 *   GET /audio/<trackId>?probe=1       -> { url, host } instead of the redirect
 *   GET /health                        -> { ok, clientIdSource }
 *
 * Why this exists
 *   The site embeds SoundCloud players. Their podcast RSS exposes a permanent
 *   mp3 URL for public tracks, but (a) it lags behind new uploads, (b) it omits
 *   private tracks, and (c) its first redirect hop carries no CORS header, so a
 *   browser cannot read the bytes (needed to decode audio and find sentence
 *   boundaries).  Resolving through api-v2 fixes all three.
 *
 * Why /stream exists as well as /audio
 *   A 302 makes the *browser* fetch the bytes from cf-media.sndcdn.com, and the
 *   whole SoundCloud family (soundcloud.com, api-v2.soundcloud.com,
 *   feeds.soundcloud.com) is blocked in mainland China, as is the workers.dev
 *   domain itself.  /stream pulls the bytes on Cloudflare's side and hands them
 *   to the browser from a single origin, so nothing on the client has to reach
 *   SoundCloud.  Range requests are forwarded, so seeking still works.
 */

const DEFAULT_CLIENT_ID = 'Pb72ranhoyt6gw7hM7TkzUItXlMWSNSo';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers':
    'Content-Length,Content-Range,Accept-Ranges,Content-Type',
  'Access-Control-Max-Age': '86400',
};

// Survives between requests inside one isolate, so the fallback scrape is rare.
let cachedClientId = null;
let clientIdSource = 'default';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
  });

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' } });
  if (!r.ok) throw new Error(`GET ${url.slice(0, 90)} -> ${r.status}`);
  return r;
}

/** Pull the public apiClient id out of SoundCloud's own page/hydration blob. */
async function clientId(forceRefresh = false) {
  if (cachedClientId && !forceRefresh) return cachedClientId;
  const r = await get('https://soundcloud.com/');
  const html = await r.text();
  const patterns = [
    /"apiClient"\s*:\s*\{[^}]*?"id"\s*:\s*"([A-Za-z0-9]{32})"/,
    /client_id\s*[:=]\s*"([A-Za-z0-9]{32})"/,
    /client_id=([A-Za-z0-9]{32})/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      cachedClientId = m[1];
      clientIdSource = 'scraped';
      return cachedClientId;
    }
  }
  cachedClientId = DEFAULT_CLIENT_ID;
  clientIdSource = 'default(fallback)';
  return cachedClientId;
}

/** Resolve one track id to a directly playable progressive mp3 URL. */
async function resolveTrack(trackId, secret, cid) {
  const sec = secret ? `&secret_token=${encodeURIComponent(secret)}` : '';
  const meta = await (await get(
    `https://api-v2.soundcloud.com/tracks/${trackId}?client_id=${cid}${sec}`
  )).json();

  const transcodings = (meta.media && meta.media.transcodings) || [];
  const pick =
    transcodings.find((t) => t.format && t.format.protocol === 'progressive') ||
    transcodings.find((t) => t.format && /progressive/.test(t.format.protocol));
  if (!pick) throw new Error('track has no progressive transcoding');

  // NB: for private tracks the transcoding url already carries ?secret_token=…
  // so merging has to happen through URLSearchParams -- appending "?client_id=…"
  // by hand produced a second "?" and a 401.
  const tu = new URL(pick.url);
  tu.searchParams.set('client_id', cid);
  if (secret && !tu.searchParams.get('secret_token')) {
    tu.searchParams.set('secret_token', secret);
  }

  const resolved = await (await get(tu.toString())).json();
  if (!resolved.url) throw new Error('transcoding returned no url');
  return { url: resolved.url, title: meta.title, duration: meta.full_duration };
}

export default {
  async fetch(request) {
    const { pathname, searchParams } = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (pathname === '/health' || pathname === '/') {
      return json({
        ok: true,
        service: 'news-in-levels audio resolver',
        clientIdSource,
        clientId: cachedClientId ? `${cachedClientId.slice(0, 6)}…` : null,
        routes: ['/audio/<trackId>?s=<secret_token>', '/audio/<trackId>?probe=1',
                 '/stream/<trackId>?s=<secret_token>', '/health'],
      });
    }

    const m = pathname.match(/^\/(audio|stream)\/(\d{3,})$/);
    if (!m) return json({ error: 'not found', pathname }, 404);

    const mode = m[1];
    const trackId = m[2];
    const secret = searchParams.get('s') || null;

    let lastErr = null;
    for (const attempt of [0, 1]) {
      try {
        let cid = await clientId(attempt === 1);
        if (attempt === 0 && cid === DEFAULT_CLIENT_ID) {
          // a stale baked-in id is the most likely cause of a 401/403
          try { cid = await clientId(false); } catch { /* keep default */ }
        }
        const { url, title, duration } = await resolveTrack(trackId, secret, cid);

        // ?probe=1 hands the caller the resolved URL instead of the audio, so a
        // client-side diagnostic can test whether *it* can reach the CDN host.
        if (searchParams.get('probe')) {
          return json({
            ok: true, trackId, host: new URL(url).host, url,
            title: title || null, durationMs: duration || null, mode,
          });
        }

        if (mode === 'stream') {
          // Forward Range so seeking works, and stream the body straight through
          // rather than buffering it (clips are small, but this keeps memory flat
          // and starts playback immediately).
          const range = request.headers.get('Range');
          const upstream = await fetch(url, {
            headers: range ? { Range: range } : {},
            redirect: 'follow',
          });
          if (!upstream.ok && upstream.status !== 206) {
            throw new Error(`upstream ${upstream.status}`);
          }
          const h = new Headers(CORS);
          h.set('Content-Type', upstream.headers.get('Content-Type') || 'audio/mpeg');
          h.set('Accept-Ranges', 'bytes');
          h.set('Cache-Control', 'no-store');
          for (const k of ['Content-Length', 'Content-Range']) {
            const v = upstream.headers.get(k);
            if (v) h.set(k, v);
          }
          h.set('X-Track-Title', encodeURIComponent(title || ''));
          h.set('X-Track-Duration-Ms', String(duration || ''));
          return new Response(request.method === 'HEAD' ? null : upstream.body, {
            status: upstream.status === 206 ? 206 : 200,
            headers: h,
          });
        }

        return new Response(null, {
          status: 302,
          headers: {
            Location: url,
            'Cache-Control': 'no-store',
            'X-Track-Title': encodeURIComponent(title || ''),
            'X-Track-Duration-Ms': String(duration || ''),
            ...CORS,
          },
        });
      } catch (e) {
        lastErr = e;
        cachedClientId = null;   // force a rediscovery on the retry
        clientIdSource = 'retry';
      }
    }

    return json({
      error: 'could not resolve track',
      trackId,
      detail: String(lastErr && lastErr.message || lastErr),
    }, 502);
  },
};
