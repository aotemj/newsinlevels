/**
 * Runs the real Worker module behind a plain Node HTTP server, so the PWA can be
 * exercised against a CORS-clean resolver without a Cloudflare account.
 * Same code path as production; only the transport differs.
 *
 *   node tools/local_worker.mjs [port]
 */
import http from "node:http";
import worker from "../worker/index.js";

const port = Number(process.argv[2] || 8787);

const server = http.createServer(async (req, res) => {
  try {
    const url = `http://127.0.0.1:${port}${req.url}`;
    const request = new Request(url, { method: req.method, headers: req.headers });
    const out = await worker.fetch(request);
    const headers = {};
    out.headers.forEach((v, k) => { headers[k] = v; });
    if (out.status === 302) {
      res.writeHead(302, headers);
      res.end();
      return;
    }
    const body = out.body ? Buffer.from(await out.arrayBuffer()) : Buffer.alloc(0);
    res.writeHead(out.status, headers);
    res.end(body);
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("worker error: " + (e && e.message));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`local worker listening on http://127.0.0.1:${port}`);
  console.log(`  health : http://127.0.0.1:${port}/health`);
  console.log(`  audio  : http://127.0.0.1:${port}/audio/2396246388`);
});
