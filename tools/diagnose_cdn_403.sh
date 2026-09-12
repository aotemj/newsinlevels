#!/usr/bin/env bash
# Why does cf-media.sndcdn.com answer 403?
#
# Get a FRESH signed url from the deployed Pages resolver (?probe=1), then fetch
# it immediately -- so expiry cannot be the explanation -- and print the response
# BODY, which is where CloudFront names the actual reason.
set -u
BASE="https://nil-audio.pages.dev"
TRACK="${1:-2127857220}"

echo "=== 1. 拿一个全新的签名地址 ==="
J=$(curl -sS --max-time 30 --noproxy '*' "$BASE/audio/$TRACK?probe=1" 2>&1)
echo "$J" | head -c 500
echo
URL=$(printf '%s' "$J" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("url",""))' 2>/dev/null)
if [ -z "$URL" ]; then echo "拿不到 url，后续测试无法进行"; exit 1; fi

echo
echo "=== 2. Policy 里的过期时间 vs 现在 ==="
POL=$(printf '%s' "$URL" | sed -E 's/.*[?&]Policy=([^&]*).*/\1/' | tr '_-' '/+')
POL="$POL$(printf '%*s' $(( (4 - ${#POL} % 4) % 4 )) '' | tr ' ' '=')"
printf '%s' "$POL" | base64 -d 2>/dev/null | head -c 300
echo
EXP=$(printf '%s' "$POL" | base64 -d 2>/dev/null | grep -oE 'EpochTime":[0-9]+' | grep -oE '[0-9]+')
NOW=$(date +%s)
echo "  策略过期时刻 : $EXP  ($(date -r "$EXP" '+%Y-%m-%d %H:%M:%S %z' 2>/dev/null))"
echo "  本机当前时刻 : $NOW  ($(date '+%Y-%m-%d %H:%M:%S %z'))"
[ -n "$EXP" ] && echo "  剩余有效     : $((EXP - NOW)) 秒"

echo
echo "=== 3. 立刻取字节：不带任何额外请求头 ==="
curl -sS -o /tmp/body_raw.txt -w '  status=%{http_code}  size=%{size_download}  type=%{content_type}\n' \
  --max-time 30 --noproxy '*' "$URL"
echo "  --- 响应体前 400 字节（CloudFront 会在这里说明原因）---"
head -c 400 /tmp/body_raw.txt
echo

echo
echo "=== 4. 带 Range（模拟播放器/解码器）==="
curl -sS -o /tmp/body_rng.txt -w '  status=%{http_code}  size=%{size_download}\n' \
  -H 'Range: bytes=0-2047' --max-time 30 --noproxy '*' "$URL"
head -c 400 /tmp/body_rng.txt
echo

echo
echo "=== 5. 带浏览器 UA + Origin（模拟真实页面）==="
curl -sS -o /tmp/body_ua.txt -w '  status=%{http_code}  size=%{size_download}\n' \
  -H 'Range: bytes=0-2047' -H 'Origin: https://aotemj.github.io' \
  -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' \
  --max-time 30 --noproxy '*' "$URL"
head -c 400 /tmp/body_ua.txt
echo
echo "=== 6. 若拿到字节，确认是音频 ==="
for f in /tmp/body_raw.txt /tmp/body_rng.txt; do
  if [ -s "$f" ]; then
    printf "  %s 首 3 字节: %s\n" "$f" "$(head -c 3 "$f" | xxd -p 2>/dev/null)"
  fi
done
