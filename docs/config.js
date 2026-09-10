/**
 * Deployment config.
 *
 * WORKER_BASE — base URL of the Cloudflare Worker from ../worker (audio resolver).
 *   Deploy it with:  cd worker && npx wrangler login && npx wrangler deploy
 *   It prints something like https://nil-audio.you.workers.dev — paste it below.
 *
 * Leave it empty and the app still plays audio (via the public SoundCloud
 * podcast URL), it just cannot decode the audio, so per-sentence looping and
 * tap-a-sentence-to-seek stay switched off.  You can also set it at runtime
 * from the setup banner, which stores it in localStorage.
 */
export const WORKER_BASE = "https://nil-audio.automj-nil.workers.dev";

/** Fallback used when no Worker is configured: public podcast feed mp3. */
export const PODCAST_BASE = "https://feeds.soundcloud.com/stream";
