/**
 * Deployment config.
 *
 * WORKER_BASES — bases to try, in order, for the audio resolver.
 *
 *   The resolver is in ../worker (shared by two deploy targets, same code):
 *
 *     1. Cloudflare Pages  -> https://<project>.pages.dev/
 *        Deploy: npx wrangler pages deploy        (reads ./wrangler.toml)
 *        USE THIS ONE IF YOU ARE IN MAINLAND CHINA.  The `workers.dev` domain is
 *        DNS-poisoned there (it resolves to Twitter's network and times out),
 *        while `pages.dev` resolves normally.  Both run the same Worker runtime.
 *
 *     2. Cloudflare Workers -> https://<name>.<subdomain>.workers.dev/
 *        Deploy: cd worker && npx wrangler deploy
 *
 *   The app walks base x mode attempts in order (see AUDIO_MODE) and moves on
 *   when one fails, so a blocked host degrades instead of breaking playback.
 *
 * Leave the list empty and the app still plays audio (via the public SoundCloud
 * podcast URL on feeds.soundcloud.com), it just cannot decode the bytes, so
 * per-sentence looping and tap-a-sentence-to-seek stay switched off.  You can
 * also set a base at runtime in the setup sheet (stored in localStorage), or
 * with ?worker=https://… on the URL.
 */
export const WORKER_BASES = [
  "https://nil-audio.pages.dev",
  "https://nil-audio.automj-nil.workers.dev",
];

/** First entry, kept for convenience. */
export const WORKER_BASE = WORKER_BASES[0];

/**
 * How the resolver hands over the audio bytes.  Both work; they differ in who
 * fetches from SoundCloud's CDN.
 *
 *   "stream"   GET <base>/stream/<track>  — the resolver fetches the signed url
 *              and streams the bytes back through Cloudflare, forwarding Range.
 *              The client only ever talks to one origin.
 *
 *   "redirect" GET <base>/audio/<track>   — the resolver answers 302 and the
 *              CLIENT fetches cf-media.sndcdn.com itself.  Cheaper (no bandwidth
 *              through the resolver) but it only works where that CDN is usable.
 *
 * Measured from a mainland-China connection: "redirect" fails.  The signed url is
 * provably good -- fetching the SAME url from Cloudflare returns 206 audio/mpeg
 * while the client's own request gets a 403 whose body is a 10-byte S3 object
 * ("Forbidden", cached by CloudFront, x-amz-cf-pop LAX54-P3).  The TLS cert is a
 * genuine *.sndcdn.com one, so nothing is being intercepted; that network path
 * just gets a bad cached object.  "stream" sidesteps it entirely, so it is the
 * default.  The app flips to "redirect" only if "stream" fails, and vice versa.
 */
export const AUDIO_MODE = "stream";

/**
 * Build stamp. Shown in the setup sheet, in the Test report, and on __nil.build.
 *
 * Why it exists: a stale service-worker cache once left a phone running a MIXED
 * shell -- a new player.js alongside an old segment.js -- and the only clue was a
 * line number in a console stack trace. That is far too expensive to diagnose, so
 * the app now states which build it is. BUMP THIS with sw.js VERSION on every
 * shell change; the two are the same build.
 */
export const BUILD = "nil-v8";

/**
 * Fallback used when no resolver is configured: the public podcast feed mp3.
 * NOTE: feeds.soundcloud.com is itself blocked in mainland China, so this path
 * only works outside it.
 */
export const PODCAST_BASE = "https://feeds.soundcloud.com/stream";
