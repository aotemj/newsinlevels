#!/usr/bin/env bash
#
# Is the deployed resolver actually working, from THIS network?
#
#   bash tools/verify_deploy.sh [trackId] [base]
#
# Answers the questions that took a long time to untangle, in order, so the
# broken hop is obvious:
#   1. is a proxy/tunnel up (results are meaningless if it is and you care about
#      the un-proxied path)
#   2. does each host resolve, and is the TLS cert genuine (a forged cert means a
#      middlebox, not a blocking mistake)
#   3. do the resolver endpoints answer
#   4. do the BYTES arrive -- via /stream (proxied) and via the direct CDN
#
# The /stream vs direct split is the important one: in mainland China the direct
# CDN returns a cached 403 while the identical signed url fetches fine through
# Cloudflare, which is why the app defaults to /stream.
set -u
TRACK="${1:-2127857220}"
BASE="${2:-https://nil-audio.pages.dev}"
PROBLEMS=0
fail () { PROBLEMS=$((PROBLEMS + 1)); }

hr () { printf '%s\n' "------------------------------------------------------------"; }
hdr () { printf '\n\033[1m%s\033[0m\n' "$1"; }

hdr "1. 代理状态（决定本次结果代表哪条路径）"
TUN=0
for i in $(ifconfig -l 2>/dev/null | tr ' ' '\n' | grep -E '^(utun|tun|ppp)'); do
  ip=$(ipconfig getifaddr "$i" 2>/dev/null)
  [ -n "$ip" ] && { echo "  tunnel $i -> $ip"; TUN=1; }
done
proxy_env=$(env | grep -iE '^(http_proxy|https_proxy|all_proxy)=' | tr '\n' ' ')
[ -n "$proxy_env" ] && { echo "  $proxy_env"; TUN=1; }
[ $TUN -eq 1 ] && echo "  → 有隧道/代理：本次测的不是裸网络路径。" \
               || echo "  → 无隧道：本次测的是裸网络路径。"

hdr "2. 域名与证书"
HOST=$(printf '%s' "$BASE" | sed -E 's|^https?://||; s|/.*$||')
for h in "$HOST" cf-media.sndcdn.com; do
  ips=$(dig +short +time=3 +tries=1 "$h" 2>/dev/null | grep -E '^[0-9.]+$' | head -3 | tr '\n' ' ')
  printf "  %-30s %s\n" "$h" "${ips:-（无解析）}"
  case "$ips" in
    *192.133.77.*|*199.59.14[89].*) echo "        ^ Twitter 段，典型 DNS 污染" ;;
    *108.160.165.*)                 echo "        ^ Dropbox 段，典型 DNS 污染" ;;
    *31.13.*|*157.240.*)            echo "        ^ Facebook 段，典型 DNS 污染" ;;
  esac
  cert=$(echo | openssl s_client -connect "$h:443" -servername "$h" 2>/dev/null \
         | grep -E "^(subject|issuer)=" | tr '\n' ' ')
  [ -n "$cert" ] && echo "        证书: $cert" || echo "        证书: 拿不到（可能被阻断）"
done

hdr "3. 解析器端点"
code=$(curl -sS -o /tmp/vd_health.json -w '%{http_code}' --max-time 15 --noproxy '*' "$BASE/health" 2>/dev/null) \
  && echo "  /health            HTTP $code  $(head -c 120 /tmp/vd_health.json)" \
  || { echo "  /health            失败（解析器不可达）"; fail; }

curl -sS --max-time 30 --noproxy '*' "$BASE/audio/$TRACK?probe=1" -o /tmp/vd_probe.json 2>/dev/null
CDN=$(python3 -c 'import json;print(json.load(open("/tmp/vd_probe.json")).get("url",""))' 2>/dev/null)
if [ -n "$CDN" ]; then
  echo "  /audio?probe=1     解析成功 -> $(python3 -c 'import json;print(json.load(open("/tmp/vd_probe.json")).get("host",""))' 2>/dev/null)"
else
  echo "  /audio?probe=1     解析失败：$(head -c 160 /tmp/vd_probe.json 2>/dev/null)"; fail
fi

hdr "4. 字节是否真的到手"
curl -sS -o /tmp/vd_stream.bin -D /tmp/vd_stream.hdr \
  -w '  /stream            HTTP %{http_code}  %{size_download} bytes  %{content_type}\n' \
  -H 'Range: bytes=0-4095' --max-time 45 --noproxy '*' "$BASE/stream/$TRACK" 2>/dev/null || { echo "  /stream            失败"; fail; }
if [ -s /tmp/vd_stream.bin ]; then
  b=$(head -c 3 /tmp/vd_stream.bin | xxd -p)
  case "$b" in
    494433|fffb|fffa|fff3) echo "        真实音频 ✓ (首 3 字节 $b)" ;;
    *) echo "        不是音频 ✗ (首 3 字节 $b) —— /stream 有问题"; fail ;;
  esac
  grep -iE "^content-range" /tmp/vd_stream.hdr | sed 's/^/        /'
fi

if [ -n "${CDN:-}" ]; then
  s=$(curl -sS -o /tmp/vd_direct.txt -w '%{http_code}' --max-time 25 --noproxy '*' "$CDN" 2>/dev/null)
  echo "  直连 CDN           HTTP ${s:-失败}  $(head -c 40 /tmp/vd_direct.txt | tr -d '\n')"
  case "$s" in
    200|206) echo "        → 直连可用，两种模式都行" ;;
    403)     echo "        → 直连被拒（大陆常见）：这是 /stream 存在的理由，App 已默认用它" ;;
    *)       echo "        → 直连异常" ;;
  esac
fi

hr
if [ $PROBLEMS -eq 0 ]; then
  echo "结论：解析器和 /stream 都正常。播放应可用。"
else
  echo "结论：有 $PROBLEMS 处问题，见上面标 ✗ / 失败 的行。"
fi
exit $PROBLEMS
