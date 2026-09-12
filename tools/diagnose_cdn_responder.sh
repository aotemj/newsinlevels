#!/usr/bin/env bash
# Who is actually answering cf-media.sndcdn.com, and is the signed url itself good?
#
# The 403 body is plain-text "Forbidden", NOT CloudFront's XML AccessDenied, which
# points at an intercepting middlebox rather than a signature problem. Two checks:
#   A. TLS certificate + response headers  -> identifies the responder
#   B. /stream/<track> on the resolver     -> fetches the SAME signed url from
#      Cloudflare's network. If that returns real audio, the url is valid and the
#      fault is purely client-side reachability.
set -u
BASE="https://nil-audio.pages.dev"
TRACK="${1:-2127857220}"

echo "=== A1. 我们实际连到哪个 IP ==="
dig +short +time=3 +tries=1 cf-media.sndcdn.com 2>/dev/null | grep -E '^[0-9.]+$' | head -4

echo
echo "=== A2. TLS 证书是谁签的（中间人拦截会露出马脚）==="
echo | openssl s_client -connect cf-media.sndcdn.com:443 -servername cf-media.sndcdn.com 2>&1 \
  | grep -E "subject=|issuer=|Verify return code|Protocol *:|Cipher *:" | head -8

echo
echo "=== A3. 响应头（CloudFront 会带 x-amz-cf-id / via / x-cache）==="
URL=$(curl -sS --max-time 30 --noproxy '*' "$BASE/audio/$TRACK?probe=1" 2>/dev/null \
      | python3 -c 'import sys,json;print(json.load(sys.stdin).get("url",""))' 2>/dev/null)
if [ -z "$URL" ]; then echo "  拿不到签名地址"; exit 1; fi
curl -sS -D - -o /dev/null --max-time 30 --noproxy '*' "$URL" 2>&1 | head -20

echo
echo "=== A4. 换个已知的 CloudFront 站点作对照（排除是 CloudFront 整体被劫持）==="
curl -sS -o /dev/null -w '  d1.awsstatic.com  status=%{http_code} type=%{content_type}\n' \
  --max-time 20 --noproxy '*' "https://d1.awsstatic.com/" 2>&1

echo
echo "=== B. 让 Cloudflare 侧取同一个签名地址（/stream 会转发 Range）==="
curl -sS -o /tmp/stream_out.bin -w '  status=%{http_code}  size=%{size_download}  type=%{content_type}\n' \
  -H 'Range: bytes=0-4095' --max-time 40 --noproxy '*' "$BASE/stream/$TRACK"
echo "  --- 若不是音频，看响应体 ---"
if [ -s /tmp/stream_out.bin ]; then
  head -c 300 /tmp/stream_out.bin
  echo
  echo "  首 3 字节: $(head -c 3 /tmp/stream_out.bin | xxd -p 2>/dev/null)  (49 44 33=ID3 / ff fb=MPEG)"
fi
