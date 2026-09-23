#!/usr/bin/env python3
"""Does GitHub link this repo's commits to a GitHub account?

The public commits API returns `author: {login: ...}` when GitHub has matched the
commit's email to an account, and `author: null` when it has not. A null means the
commit can never appear on anyone's contribution graph -- which is the whole point
of asking.

  python3 tools/check_contribution_attribution.py [owner/repo] [github-login]
"""
import json
import sys
import urllib.request

REPO = sys.argv[1] if len(sys.argv) > 1 else "aotemj/newsinlevels"
LOGIN = sys.argv[2] if len(sys.argv) > 2 else "aotemj"


def get(url):
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "contribution-check",
    })
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.load(r)


print(f"=== {REPO} 的最近提交，以及 GitHub 是否把它们归属到账号 ===")
commits = get(f"https://api.github.com/repos/{REPO}/commits?per_page=30")

emails = {}
unattributed = 0
for c in commits:
    ca = c.get("commit", {}).get("author") or {}
    email = (ca.get("email") or "").lower()
    login = (c.get("author") or {}).get("login")
    emails.setdefault(email, {"n": 0, "login": login})
    emails[email]["n"] += 1
    if not login:
        unattributed += 1

for email, info in sorted(emails.items(), key=lambda kv: -kv[1]["n"]):
    tag = info["login"] or "NONE  <-- 未关联任何账号，不计入任何贡献图"
    print(f"  {info['n']:>3} 个提交   {email or '(空)'}   -> {tag}")

print()
print(f"  未归属的提交: {unattributed} / {len(commits)}")

print()
print(f"=== 账号 {LOGIN} ===")
try:
    u = get(f"https://api.github.com/users/{LOGIN}")
    print(f"  存在 : {u.get('login')}  ({u.get('type')})")
    print(f"  名字 : {u.get('name')}")
    print(f"  仓库 : {u.get('public_repos')}  创建于 {str(u.get('created_at'))[:10]}")
except Exception as e:
    print(f"  查不到这个账号: {e}")

for other in ("losidk",):
    if other == LOGIN:
        continue
    print()
    print(f"=== 账号 {other} 是否存在（提交邮箱是 {other}@gmail.com）===")
    try:
        u = get(f"https://api.github.com/users/{other}")
        print(f"  存在 : {u.get('login')}  仓库 {u.get('public_repos')} 个")
    except Exception as e:
        print(f"  查不到: {e}")
