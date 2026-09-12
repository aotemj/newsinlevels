#!/usr/bin/env bash
#
# Reproduce the Cloudflare API calls the deploy workflow makes, from your machine,
# so a permissions problem is answered in two seconds instead of a CI round trip.
#
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... bash tools/check_cloudflare_token.sh
#
# Answers, in order:
#   1. is the token itself valid and active?
#   2. which accounts can it see?  (if your account id is NOT in this list, the
#      token belongs to a different Cloudflare account and no permission tweak
#      will help -- the secret or the token is the wrong one)
#   3. can it read the Pages project?  (the exact call wrangler fails on)
#
# The token is never printed.
set -u
API="https://api.cloudflare.com/client/v4"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN first}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID first}"
PROJECT="${PAGES_PROJECT:-nil-audio}"

hr () { printf '%s\n' "------------------------------------------------------------"; }
curl_cf () { curl -sS --max-time 25 -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$@"; }

echo "=== 1. token 是否有效  /user/tokens/verify ==="
curl_cf "$API/user/tokens/verify" | python3 -c '
import sys, json
d = json.load(sys.stdin)
r = d.get("result") or {}
print("  success :", d.get("success"))
print("  status  :", r.get("status"))
for e in (d.get("errors") or []):
    print("  error   :", e.get("code"), e.get("message"))
'

echo
hr
echo "=== 2. 这个 token 能看到哪些账户  /accounts ==="
curl_cf "$API/accounts?per_page=50" > /tmp/cf_accounts.json
python3 - "$CLOUDFLARE_ACCOUNT_ID" <<'PY'
import json, sys
want = sys.argv[1]
d = json.load(open("/tmp/cf_accounts.json"))
if not d.get("success"):
    print("  FAILED:", json.dumps(d.get("errors"))[:400])
    print("  -> the token lacks even account read; add Account -> Account Settings -> Read")
    raise SystemExit(0)
rows = d.get("result") or []
print(f"  token can see {len(rows)} account(s):")
for a in rows:
    mark = "  <== matches CLOUDFLARE_ACCOUNT_ID" if a["id"] == want else ""
    print(f"    {a['id']}  {a.get('name','')}{mark}")
if not any(a["id"] == want for a in rows):
    print()
    print("  !! Your CLOUDFLARE_ACCOUNT_ID is NOT among them.")
    print("     Either the token belongs to a different Cloudflare account, or the")
    print("     secret holds a different id. Fix that before touching permissions.")
PY

echo
hr
echo "=== 3. 读取 Pages 项目（wrangler 失败的那一步）==="
code=$(curl -sS --max-time 25 -o /tmp/cf_pages.json -w '%{http_code}' \
        -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
        "$API/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$PROJECT")
echo "  HTTP $code"
python3 - <<'PY'
import json
try:
    d = json.load(open("/tmp/cf_pages.json"))
except Exception:
    print("  (unparseable body)"); raise SystemExit(0)
if d.get("success"):
    r = d.get("result") or {}
    print("  project      :", r.get("name"))
    print("  prod branch  :", r.get("production_branch"))
    print("  subdomain    :", r.get("subdomain"))
    print("  VERDICT      : token is fine — the Pages permission works.")
else:
    for e in (d.get("errors") or []):
        print("  error   :", e.get("code"), e.get("message"))
    print()
    print("  VERDICT: the token cannot read Pages. Add to the token:")
    print("           Account -> Cloudflare Pages -> Edit   (resource: your account)")
    print("           https://dash.cloudflare.com/profile/api-tokens -> the token -> Edit")
PY

echo
hr
echo "若第 3 步通过，部署应当能成功。改完 token 后先在本地跑通，再推 CI。"
