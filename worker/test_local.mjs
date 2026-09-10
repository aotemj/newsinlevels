/**
 * Runs the Worker module in plain Node (no wrangler, no Cloudflare account) to
 * prove the resolve chain actually produces playable audio.
 *
 *   node worker/test_local.mjs [trackId] [secretToken]
 */
import worker from './index.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const track = process.argv[2] || '2396246388';          // paris-butter-shop L1
const secret = process.argv[3] || '';
const qs = secret ? `?s=${encodeURIComponent(secret)}` : '';
const BASE = 'https://worker.test';

const call = (path, init) => worker.fetch(new Request(BASE + path, init));

console.log('--- /health');
const health = await call('/health');
console.log(health.status, await health.text());

console.log(`\n--- /audio/${track}${qs}`);
const res = await call(`/audio/${track}${qs}`);
console.log('status :', res.status, '(want 302)');
console.log('ACAO   :', res.headers.get('access-control-allow-origin'), '(want *)');
console.log('title  :', decodeURIComponent(res.headers.get('x-track-title') || ''));
console.log('dur ms :', res.headers.get('x-track-duration-ms'));
const loc = res.headers.get('location');
console.log('location:', loc ? loc.slice(0, 80) + '…' : null);

if (res.status !== 302 || !loc) {
  console.error('\nFAIL: no redirect produced');
  process.exit(1);
}

// follow it like a browser would, and confirm real MPEG audio comes back
const head = await fetch(loc, { headers: { 'User-Agent': UA, Range: 'bytes=0-2047' } });
const buf = new Uint8Array(await head.arrayBuffer());
console.log('\n--- following the redirect');
console.log('status :', head.status, '(want 206 or 200)');
console.log('type   :', head.headers.get('content-type'));
console.log('ranges :', head.headers.get('accept-ranges'));
console.log('bytes  :', buf.length);
console.log('header :', [...buf.slice(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join(' '),
            '  (ff fb .. or 49 44 33 = valid MPEG/ID3)');

const id3 = buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33;
const mpeg = buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
console.log(id3 || mpeg ? '\nPASS: worker resolves to playable audio' : '\nFAIL: not audio data');
process.exit(id3 || mpeg ? 0 : 1);
