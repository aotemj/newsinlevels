#!/usr/bin/env python3
"""Phone-sized screenshots of the app, straight from headless Chrome.

Serves docs/ (and optionally the Worker from tools/local_worker.mjs) on
localhost, then captures a few routes.  Used to eyeball the layout and to make
the images in the README.

Usage:  python tools/shots.py [outdir]         # default: screenshots/
"""
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

SHOTS = [
    # name, extra query, hash route, virtual-time budget (ms)
    ("01-list.png", "", "#/", 9000),
    ("02-reader.png", "", "#/s/paris-butter-shop", 9000),
    ("03-level3.png", "&level=3", "#/s/chimpanzees-are-back-in-the-wild", 9000),
]


def free_port(start):
    for p in range(start, start + 50):
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", p)) != 0:
                return p
    raise RuntimeError("no free port")


def capture(cmd, out, timeout=75):
    """Chrome writes the screenshot and then sits there (the service worker keeps
    the page alive), so watch for the file instead of waiting for an exit."""
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + timeout
    last = 0
    stable = 0
    try:
        while time.time() < deadline:
            if os.path.exists(out):
                n = os.path.getsize(out)
                if n > 2000 and n == last:
                    stable += 1
                    if stable >= 3:            # unchanged for ~0.6s => written
                        return True
                last = n
            time.sleep(0.2)
        return os.path.exists(out) and os.path.getsize(out) > 2000
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()


def serve(directory, port):
    class H(SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=directory, **k)
        def log_message(self, *a):
            pass
    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "screenshots")
    os.makedirs(outdir, exist_ok=True)

    web_port = free_port(8890)
    worker_port = free_port(8787)
    serve(DOCS, web_port)

    worker = subprocess.Popen(
        ["node", os.path.join(ROOT, "tools", "local_worker.mjs"), str(worker_port)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.2)

    base = f"http://127.0.0.1:{web_port}/?worker=http://127.0.0.1:{worker_port}"
    failures = []
    for name, extra, route, budget in SHOTS:
        out = os.path.join(outdir, name)
        cmd = [CHROME, "--headless=new", "--disable-gpu", "--no-first-run",
               "--no-default-browser-check", "--hide-scrollbars",
               "--force-device-scale-factor=1",
               f"--user-data-dir=/tmp/shots_profile_{name[:2]}",
               "--window-size=390,844",
               f"--virtual-time-budget={budget}",
               f"--screenshot={out}", base + extra + route]
        # Chrome occasionally writes nothing on the first try; retry before
        # declaring failure, and never delete the previous good file until a new
        # one has actually been written.
        ok = False
        attempt = 0
        for attempt in range(2):
            if os.path.exists(out):
                os.remove(out)
            ok = capture(cmd, out, timeout=75 + attempt * 30)
            if ok:
                break
            time.sleep(1.5)
        if ok:
            print(f"{name:16} {os.path.getsize(out)/1024:7.1f} KB   {route}"
                  + ("" if attempt == 0 else f"   (retry {attempt})"))
        else:
            failures.append((name, "no/blank file"))
            print(f"{name:16} FAILED                {route}", file=sys.stderr)

    worker.send_signal(signal.SIGTERM)
    for name, why in failures:
        print(f"!! {name}: {why}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
