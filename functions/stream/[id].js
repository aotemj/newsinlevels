/**
 * Pages Function: mounts the resolver from ../../../worker/index.js at
 * /stream/:id  ->  the mp3 bytes themselves, proxied through Cloudflare.
 *
 * Only needed if the client cannot reach cf-media.sndcdn.com directly.  Measured
 * from a mainland-China connection, that CDN *is* reachable (CloudFront), while
 * the SoundCloud API and feed hosts are not -- so the plain /audio 302 is enough
 * there and this stays a fallback.  Range requests are forwarded, so seeking and
 * the sentence-boundary decode keep working.
 */
import worker from "../../worker/index.js";

export const onRequest = (ctx) => worker.fetch(ctx.request, ctx.env, ctx);
