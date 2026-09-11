/**
 * Pages Function: mounts the resolver from ../../../worker/index.js at
 * /audio/:id  ->  302 to a fresh signed SoundCloud CDN url.
 *
 * See worker/index.js for why the 302 exists (CORS on the redirect chain) and
 * functions/stream/[id].js for the byte-proxying alternative.
 */
import worker from "../../worker/index.js";

export const onRequest = (ctx) => worker.fetch(ctx.request, ctx.env, ctx);
