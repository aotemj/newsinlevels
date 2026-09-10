#!/usr/bin/env python3
"""Verify a deployed audio Worker end to end.

Run this right after `wrangler deploy` and you will know whether the app's
sentence features will work, instead of finding out later through the UI.

    python tools/check_worker.py https://nil-audio.you.workers.dev

Checks, in order:
  1. /health answers and reports itself
  2. a public track resolves to a 302 that carries Access-Control-Allow-Origin
  3. following that redirect returns real MPEG audio
  4. a private track (secret_token) resolves too
  5. a bogus track id fails cleanly (502), it does not hang or 500
"""
import json
import sys
import urllib.error
import urllib.request

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

PUBLIC_TRACK = ("2396246388", None)          # paris-butter-shop level 1
PRIVATE_TRACK = ("1494651385", "s-sfkIGtrpGXf")   # mission-to-jupiter level 3
BOGUS_TRACK = ("999999999999", None)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def request(url, *, follow=True, range_bytes=None, timeout=45):
    """Returns (status, headers, body). On a transport failure status is 0."""
    hdrs = {"User-Agent": UA, "Origin": "https://example.github.io"}
    if range_bytes:
        hdrs["Range"] = f"bytes={range_bytes}"
    opener = urllib.request.build_opener() if follow else \
        urllib.request.build_opener(NoRedirect)
    req = urllib.request.Request(url, headers=hdrs)
    try:
        r = opener.open(req, timeout=timeout)
        return r.status, dict(r.headers), r.read(4096)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read(2048)
    except urllib.error.URLError as e:
        return 0, {"X-Error": str(e.reason)}, b""
    except Exception as e:                      # noqa: BLE001
        return 0, {"X-Error": str(e)}, b""


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    base = sys.argv[1].rstrip("/")
    ok = True

    def check(label, passed, detail=""):
        nonlocal ok
        ok = ok and passed
        print(f"{'PASS' if passed else 'FAIL'}  {label}" + (f"  — {detail}" if detail else ""))

    print(f"→ {base}\n")

    status, headers, body = request(base + "/health")
    try:
        health = json.loads(body)
    except Exception:
        health = {}
    detail = (f"HTTP {status} {str(body[:90], 'utf-8', 'replace')}" if status
              else f"no response — {headers.get('X-Error', 'unreachable')}")
    check("/health answers", status == 200 and health.get("ok") is True, detail)

    status, headers, _ = request(f"{base}/audio/{PUBLIC_TRACK[0]}", follow=False)
    acao = headers.get("Access-Control-Allow-Origin") or headers.get("access-control-allow-origin")
    check("public track → 302", status == 302, f"HTTP {status}")
    check("302 carries CORS header", acao == "*", f"ACAO={acao!r}")

    if status == 302:
        location = headers.get("Location") or headers.get("location")
        s2, h2, b2 = request(location, range_bytes="0-2047")
        ctype = (h2.get("Content-Type") or h2.get("content-type") or "")
        is_audio = ("audio" in ctype or b2[:3] in (b"\xff\xfb\x90", b"ID3"))
        check("redirect target is real audio", s2 in (200, 206) and is_audio,
              f"HTTP {s2} {ctype} {b2[:3]!r}")

    tid, secret = PRIVATE_TRACK
    q = f"?s={secret}" if secret else ""
    status, headers, body = request(f"{base}/audio/{tid}{q}", follow=False)
    check("private track (secret_token) → 302", status == 302,
          f"HTTP {status} {str(body[:80], 'utf-8', 'replace')}" if status != 302 else "HTTP 302")

    status, _, body = request(f"{base}/audio/{BOGUS_TRACK[0]}", follow=False)
    check("bogus track fails cleanly", status == 502,
          f"HTTP {status} (want 502, not 500/hang)")

    print()
    if ok:
        print("All good. Paste this URL into the app: ⚙ → Audio Worker → Test → Save")
    else:
        print("Something is off — see the FAIL lines above.")
        print("  · health fails / connection refused  → the deploy did not take; re-run wrangler deploy")
        print("  · track checks fail with 401/403     → the Worker is up but SoundCloud rejected the\n"
              "                                         client id; it should self-heal, retry once")
        print("  · CORS header missing                → you may be hitting a cached/other deployment")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
