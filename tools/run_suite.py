#!/usr/bin/env python3
"""Run the browser harnesses and print a readable summary.

Every harness POSTs a list of [key, value] steps; this prints them all instead of
a hand-picked subset (picking keys by hand has twice hidden a result behind a
nested dict).

Usage:
    python tools/run_suite.py                 # all harnesses
    python tools/run_suite.py pin app         # a subset by name
"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = os.path.join(ROOT, ".venv", "bin", "python")
PROBE = os.path.join(ROOT, "tools", "browser_probe.py")
REPORT = "/tmp/probe_report.json"
W = "https://nil-audio.automj-nil.workers.dev"

SUITE = [
    # name,        harness,                  query,                  wait, port
    ("pin",   "tools/player_pin_probe.html", f"worker={W}",          160, 8871),
    ("app",   "tools/app_smoke.html",        "worker=off",           190, 8872),
    ("full",  "tools/worker_path_smoke.html", f"worker={W}",         230, 8873),
]


def run(name, harness, query, wait, port):
    subprocess.run(["pkill", "-f", "Google Chrome.*headless"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["rm", "-rf", "/tmp/probe_chrome_profile"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if os.path.exists(REPORT):
        os.remove(REPORT)
    subprocess.run([PY, PROBE, harness, "--root", "docs", "--wait", str(wait),
                    "--port", str(port), "--query", query],
                   cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    stale = os.path.join(ROOT, "docs", "_probe_page.html")
    if os.path.exists(stale):
        os.remove(stale)

    if not os.path.exists(REPORT):
        print(f"########## {name}: NO REPORT (chrome never posted) ##########\n")
        return False, 0, 0
    with open(REPORT, encoding="utf-8") as fh:
        r = json.load(fh)

    print(f"########## {name}  ({harness}) ##########")
    print(f"  errors : {r.get('errors')}")
    print(f"  fatal  : {r.get('fatal')}")
    if r.get("boot_failed"):
        print(f"  BOOT FAILED: {json.dumps(r['boot_failed'])[:400]}")
    if r.get("timeout"):
        print("  !! page hit its own timeout")
    if not r.get("finished"):
        print("  !! report is INCOMPLETE (page was still running)")

    passed = 0
    for step in r.get("steps", []):
        key, val = step[0], step[1]
        if isinstance(val, dict):
            print(f"  {key}")
            for k, v in val.items():
                print(f"      {k:28} {v}")
        elif isinstance(val, list) and val and isinstance(val[0], dict):
            print(f"  {key}")
            for item in val:
                print(f"      {item}")
        else:
            print(f"  {key:30} {val}")
        passed += 1
    print()
    return bool(r.get("finished")) and not r.get("fatal") and not r.get("boot_failed"), passed, len(r.get("steps", []))


def main():
    wanted = sys.argv[1:]
    ok = True
    for name, harness, query, wait, port in SUITE:
        if wanted and name not in wanted:
            continue
        good, _, _ = run(name, harness, query, wait, port)
        ok = ok and good
    print("SUITE:", "OK" if ok else "PROBLEMS")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
