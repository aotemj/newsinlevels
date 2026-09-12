#!/usr/bin/env python3
"""Sanity-check the deploy workflow without pushing it.

  python tools/check_workflows.py

Catches the mistakes that otherwise only show up as a red X in the Actions tab:
unparseable YAML, a `uses:` pointing at a file that does not exist, a workflow
that would be triggered recursively, and a build-stamp extraction that no longer
matches the real config.js.
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WF = os.path.join(ROOT, ".github", "workflows")
problems = []


def ok(msg):
    print(f"  ok    {msg}")


def bad(msg):
    problems.append(msg)
    print(f"  FAIL  {msg}")


try:
    import yaml
except ImportError:
    yaml = None

print("=== YAML parses ===")
docs = {}
for name in sorted(os.listdir(WF)):
    if not name.endswith((".yml", ".yaml")):
        continue
    path = os.path.join(WF, name)
    text = open(path, encoding="utf-8").read()
    if yaml is None:
        print(f"  skip  {name} (PyYAML not installed)")
        continue
    try:
        d = yaml.safe_load(text)
        docs[name] = d
        # `on:` is parsed as the boolean True by YAML 1.1 -- accept either
        trig = d.get("on", d.get(True))
        ok(f"{name} — triggers {list(trig) if hasattr(trig, '__iter__') else trig}")
    except Exception as e:
        bad(f"{name} is not valid YAML: {e}")

print("=== local `uses:` targets exist ===")
for name, d in docs.items():
    for job_name, job in (d.get("jobs") or {}).items():
        uses = job.get("uses") if isinstance(job, dict) else None
        if uses and uses.startswith("./"):
            # NOT lstrip("./") -- that strips the leading dot of ".github" too,
            # which made this check report a missing file that was right there.
            target = os.path.join(ROOT, uses[2:])
            if os.path.exists(target):
                ok(f"{name}:{job_name} -> {uses}")
            else:
                bad(f"{name}:{job_name} uses {uses} but that file does not exist")

print("=== the called workflow can still be called ===")
dep = docs.get("deploy-pages.yml")
if dep:
    trig = dep.get("on", dep.get(True))
    names = list(trig) if hasattr(trig, "__iter__") else [trig]
    if "workflow_call" in names:
        ok("deploy-pages.yml declares workflow_call, so sync.yml can call it")
    else:
        bad(f"deploy-pages.yml does not declare workflow_call (has {names}) — "
            "sync.yml's `uses:` would be rejected")

print("=== no push-triggered workflow is expected to fire from sync's commit ===")
# sync pushes with the default GITHUB_TOKEN, which GitHub will not chain into
# another workflow. That is why it calls the deploy directly -- guard that.
sy = docs.get("sync.yml")
if sy:
    jobs = sy.get("jobs") or {}
    has_call = any(isinstance(j, dict) and str(j.get("uses", "")).startswith("./")
                   for j in jobs.values())
    if has_call:
        ok("sync.yml deploys by calling the shared workflow (not by relying on push)")
    else:
        bad("sync.yml does not call the deploy workflow — the daily data commit "
            "would never reach Cloudflare Pages")

print("=== build-stamp extraction matches docs/config.js ===")
cfg = open(os.path.join(ROOT, "docs", "config.js"), encoding="utf-8").read()
want = re.search(r'export const BUILD = "([^"]+)"', cfg)
want = want.group(1) if want else None
if not want:
    bad("docs/config.js has no `export const BUILD = \"...\"`")
else:
    # exactly the sed the workflow runs, so a drift in either is caught here
    out = subprocess.run(
        ["sed", "-n", r's/.*export const BUILD = "\([^"]*\)".*/\1/p',
         os.path.join(ROOT, "docs", "config.js")],
        capture_output=True, text=True).stdout.strip()
    (ok if out == want else bad)(
        f"the workflow's sed extracts {out!r} from config.js (expected {want!r})")

print("=== version.json agrees (the workflow asserts against it) ===")
import json
vj = json.load(open(os.path.join(ROOT, "docs", "version.json"), encoding="utf-8"))
(ok if vj.get("build") == want else bad)(
    f"version.json build={vj.get('build')!r} vs config.js {want!r}")

print("=== secret names used by workflows match the README ===")
# A secret is created by hand in GitHub, so a rename in the workflow cannot be
# verified there -- but it CAN be checked that the docs still name the same one.
# Drift here means someone follows the README and the run still says "Not logged in".
readme = ""
for candidate in ("README.md",):
    p = os.path.join(ROOT, candidate)
    if os.path.exists(p):
        readme = open(p, encoding="utf-8").read()
used = set()
for name in sorted(os.listdir(WF)):
    if name.endswith((".yml", ".yaml")):
        used |= set(re.findall(r"secrets\.([A-Za-z_][A-Za-z0-9_]*)",
                               open(os.path.join(WF, name), encoding="utf-8").read()))
used.discard("GITHUB_TOKEN")
if not used:
    bad("no secrets.* references found — the deploy cannot authenticate")
for s in sorted(used):
    (ok if s in readme else bad)(f"{s} referenced in a workflow and documented: {s in readme}")

print()
if problems:
    print(f"{len(problems)} problem(s):")
    for p in problems:
        print(" -", p)
    sys.exit(1)
print("workflows look consistent")
