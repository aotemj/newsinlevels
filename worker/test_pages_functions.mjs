/**
 * Checks the Cloudflare Pages Functions wiring without deploying.
 *
 * Pages hands a Function a context object and expects it to delegate to the
 * shared resolver in worker/index.js.  What this proves:
 *   - every function imports cleanly (a wrong ../ depth throws at import time)
 *   - the request reaches the resolver's router rather than 404-ing, which is
 *     what would happen if the delegation or the path handling were wrong
 *
 * It does NOT prove the SoundCloud resolve succeeds -- that needs outbound
 * access to api-v2.soundcloud.com, which is blocked in mainland China.  A 502
 * "could not resolve track" from /audio is therefore a PASS here: it means the
 * router ran and only the upstream call failed.
 *
 *   node worker/test_pages_functions.mjs
 */
const ORIGIN = 'https://nil-audio.pages.dev';
const results = [];

const load = async (path, url) => {
  const mod = await import(new URL('../' + path, import.meta.url).href);
  const request = new Request(ORIGIN + url);
  const res = await mod.onRequest({ request, env: {}, waitUntil: () => {} });
  return res;
};

const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

console.log('--- /health (functions/health.js)');
try {
  const res = await load('functions/health.js', '/health');
  const body = await res.json();
  check('health returns 200', res.status === 200, `status ${res.status}`);
  check('health identifies the service', body.service === 'news-in-levels audio resolver',
        JSON.stringify(body).slice(0, 90));
  check('health advertises both routes',
        Array.isArray(body.routes) && body.routes.some((r) => r.includes('/audio/')),
        JSON.stringify(body.routes));
} catch (e) {
  check('functions/health.js imports and runs', false, e.message);
}

console.log('\n--- /audio/:id reaches the resolver (functions/audio/[id].js)');
try {
  const res = await load('functions/audio/[id].js', '/audio/2396246388');
  const text = await res.text();
  // 302 = resolved (needs upstream access); 502 = router ran, upstream blocked.
  // Either way this is NOT the worker's {"error":"not found"} page.
  const routed = res.status === 302 || (res.status === 502 && text.includes('could not resolve track'));
  check('request is routed to the resolver, not 404', routed, `status ${res.status}`);
  check('CORS header present on the response',
        res.headers.get('access-control-allow-origin') === '*',
        String(res.headers.get('access-control-allow-origin')));
  if (res.status === 502) {
    console.log('        (502 = upstream blocked from this network; expected in mainland China)');
  }
  if (res.status === 302) {
    const loc = res.headers.get('location') || '';
    console.log('        (resolved -> ' + new URL(loc).host + ')');
  }
} catch (e) {
  check('functions/audio/[id].js imports and runs', false, e.message);
}

console.log('\n--- a non-numeric id must NOT be swallowed by the route');
try {
  const res = await load('functions/audio/[id].js', '/audio/not-a-track');
  check('router still 404s bad ids', res.status === 404, `status ${res.status}`);
} catch (e) {
  check('bad-id path', false, e.message);
}

console.log('\n--- /stream/:id reaches the resolver (functions/stream/[id].js)');
try {
  const res = await load('functions/stream/[id].js', '/stream/2396246388');
  const text = await res.text().catch(() => '');
  const routed = res.status === 200 || (res.status === 502 && text.includes('could not resolve track'));
  check('stream route is wired', routed, `status ${res.status}`);
} catch (e) {
  check('functions/stream/[id].js imports and runs', false, e.message);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(failed.length ? 'FAILED: ' + failed.map((f) => f.name).join('; ') : 'PASS: pages functions wired correctly');
process.exit(failed.length ? 1 : 0);
