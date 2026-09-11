/**
 * Deployment config.
 *
 * WORKER_BASES — bases to try, in order, for the audio resolver.
 *
 *   The resolver is in ../worker (shared by two deploy targets, same code):
 *
 *     1. Cloudflare Pages  -> https://<project>.pages.dev/audio/<trackId>
 *        Deploy: npx wrangler pages deploy        (reads ./wrangler.toml)
 *        USE THIS ONE IF YOU ARE IN MAINLAND CHINA.  The `workers.dev` domain is
 *        DNS-poisoned there (it resolves to Twitter's network and times out),
 *        while `pages.dev` resolves normally.  Both run the same Worker runtime.
 *
 *     2. Cloudflare Workers -> https://<name>.<subdomain>.workers.dev/audio/…
 *        Deploy: cd worker && npx wrangler deploy
 *
 *   The app tries them in order and moves to the next one when the audio element
 *   reports a network error, so a blocked base degrades instead of breaking.
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
 * Fallback used when no resolver is configured: the public podcast feed mp3.
 * NOTE: feeds.soundcloud.com is itself blocked in mainland China, so this path
 * only works outside it.
 */
export const PODCAST_BASE = "https://feeds.soundcloud.com/stream";
