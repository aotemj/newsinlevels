/**
 * Pages Function: mounts the resolver from ../../worker/index.js at /health.
 *
 * Pages serves static assets from docs/ first and only hands a request to a
 * Function when no asset matches, so this does not shadow anything.  The
 * Function is deliberately a one-line delegate: worker/index.js stays the single
 * implementation, shared with the Workers deploy in worker/wrangler.toml.
 */
import worker from "../worker/index.js";

export const onRequest = (ctx) => worker.fetch(ctx.request, ctx.env, ctx);
