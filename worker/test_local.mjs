/**
 * Runs the Worker module in plain Node (no wrangler, no Cloudflare account) to
 * prove the resolve chain actually produces playable audio -- both the 302 mode
 * and the byte-proxying /stream mode, which is what a client behind the GFW has
 * to use (SoundCloud and workers.dev are both unreachable from mainland China).
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
console.log(id3 || mpeg ? 'PASS: worker resolves to playable audio' : 'FAIL: not audio data');

console.log(`\n--- /audio/${track}?probe=1  (diagnostic JSON)`);
const probe = await call(`/audio/${track}${secret ? `?s=${secret}&` : '?'}probe=1`);
console.log('status :', probe.status);
const pinfo = await probe.json();
console.log('host   :', pinfo.host);
console.log('url    :', pinfo.url ? pinfo.url.slice(0, 70) + '…' : null);

let streamOk = false;
console.log(`\n--- /stream/${track}${qs}  (bytes proxied, nothing on the client touches SoundCloud)`);
const s1 = await call(`/stream/${track}${qs}`);
const b1 = new Uint8Array(await s1.arrayBuffer());
console.log('status :', s1.status, '(want 200)');
console.log('type   :', s1.headers.get('content-type'));
console.log('length :', s1.headers.get('content-length'));
console.log('ranges :', s1.headers.get('accept-ranges'), '(want bytes)');
console.log('acao   :', s1.headers.get('access-control-allow-origin'), '(want *)');
console.log('bytes  :', b1.length);
const s1audio = (b1[0] === 0x49 && b1[1] === 0x44 && b1[2] === 0x33) ||
                (b1[0] === 0xff && (b1[1] & 0xe0) === 0xe0);
console.log('audio  :', s1audio);

console.log('\n--- Range request through /stream  (seeking must work)');
const s2 = await call(`/stream/${track}${secret ? `?s=${secret}&` : '?'}r=1`,
                      { headers: { Range: 'bytes=1000-1999' } });
const b2 = new Uint8Array(await s2.arrayBuffer());
console.log('status :', s2.status, '(want 206)');
console.log('range  :', s2.headers.get('content-range'), '(want bytes 1000-1999/...)');
console.log('bytes  :', b2.length, '(want 1000)');
streamOk = s1.status === 200 && s1audio && s1.headers.get('accept-ranges') === 'bytes' &&
           s2.status === 206 && b2.length === 1000 &&
           /^bytes 1000-1999\//.test(s2.headers.get('content-range') || '');

console.log(streamOk ? '\nPASS: /stream proxies real audio and honours Range'
                     : '\nFAIL: /stream did not behave');
process.exit(id3 || mpeg ? (streamOk ? 0 : 1) : 1);
