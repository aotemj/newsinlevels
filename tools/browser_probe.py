#!/usr/bin/env python3
"""Headless-Chrome harness: serves a page and collects whatever it POSTs back.

Usage:  .venv/bin/python tools/browser_probe.py path/to/page.html [--wait 25]
"""
import argparse
import http.server
import json
import os
import socketserver
import subprocess
import sys
import threading
import time

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
REPORT = os.path.join("/tmp", "probe_report.json")


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n)
        with open(REPORT, "wb") as fh:
            fh.write(body)
        self.send_response(204)
        self.end_headers()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("page")
    ap.add_argument("--wait", type=float, default=25)
    ap.add_argument("--port", type=int, default=8791)
    ap.add_argument("--root", default=None,
                    help="directory to serve (default: the page's own directory)")
    ap.add_argument("--query", default="",
                    help="query string appended to the harness page URL, e.g. 'worker=https://x.workers.dev'")
    args = ap.parse_args()

    page_dir = os.path.abspath(args.root or os.path.dirname(os.path.abspath(args.page)))
    page_name = os.path.basename(args.page)
    if args.root:
        # the page may live outside the served root; copy it in as a temp name
        import shutil
        tmp_name = "_probe_page.html"
        shutil.copy(os.path.abspath(args.page), os.path.join(page_dir, tmp_name))
        page_name = tmp_name
    if os.path.exists(REPORT):
        os.remove(REPORT)

    os.chdir(page_dir)
    socketserver.TCPServer.allow_reuse_address = True
    srv = socketserver.TCPServer(("127.0.0.1", args.port), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    profile = "/tmp/probe_chrome_profile"
    errfile = "/tmp/probe_chrome_err.log"
    cmd = [CHROME, "--headless=new", "--disable-gpu", "--no-first-run",
           "--no-default-browser-check", f"--user-data-dir={profile}",
           "--autoplay-policy=no-user-gesture-required",
           "--enable-logging=stderr", "--v=0",
           f"http://127.0.0.1:{args.port}/{page_name}"
           + (f"?{args.query}" if args.query else "")]
    err = open(errfile, "wb")
    proc = subprocess.Popen(cmd, stdout=err, stderr=err)
    deadline = time.time() + args.wait
    data = None
    while time.time() < deadline:
        if os.path.exists(REPORT):
            try:
                with open(REPORT, encoding="utf-8") as fh:
                    data = json.load(fh)
            except Exception:
                data = None
            if isinstance(data, dict) and data.get("finished"):
                break
        time.sleep(0.3)
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except Exception:
        proc.kill()
    srv.shutdown()

    if data is not None:
        print(json.dumps(data, indent=1, ensure_ascii=False)[:8000])
    else:
        print("NO REPORT RECEIVED")
        sys.exit(1)


if __name__ == "__main__":
    main()
