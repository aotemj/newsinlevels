#!/usr/bin/env bash
# Verify the freshly deployed Pages project, and find out why the browser saw
# ERR_SSL_VERSION_OR_CIPHER_MISMATCH.
set -u
CANON="nil-audio.pages.dev"
PREVIEW="8498794e.nil-audio.pages.dev"

echo "=== 0. 本机代理状态（结果是否可信的前提）==="
TUN=0
for i in $(ifconfig -l 2>/dev/null | tr ' ' '\n' | grep -E '^(utun|tun|ppp)'); do
  ip=$(ipconfig getifaddr "$i" 2>/dev/null)
  [ -n "$ip" ] && { echo "  隧道 $i -> $ip"; TUN=1; }
done
[ $TUN -eq 0 ] && echo "  无活跃隧道（裸网络路径）"

echo
echo "=== 1. DNS ==="
for h in "$CANON" "$PREVIEW"; do
  printf "  %-34s %s\n" "$h" "$(dig +short +time=3 +tries=1 "$h" 2>/dev/null | grep -E '^[0-9.]+$' | tr '\n' ' ')"
done

echo
echo "=== 2. TLS 握手（看 SNI 与协商结果）==="
for h in "$CANON" "$PREVIEW"; do
  echo "--- $h"
  echo | openssl s_client -connect "$h:443" -servername "$h" 2>&1 \
    | grep -E "subject=|issuer=|Protocol|Cipher|Verify return code|alert|error" | head -8
done

echo
echo "=== 3. HTTP 行为 ==="
for h in "$CANON" "$PREVIEW"; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 12 --noproxy '*' "https://$h/health" 2>/tmp/e)
  rc=$?
  if [ $rc -ne 0 ]; then
    printf "  %-34s FAIL: %s\n" "$h" "$(head -1 /tmp/e)"
  else
    printf "  %-34s HTTP %s\n" "$h" "$code"
  fi
done

echo
echo "=== 4. 解析器是否真的工作（规范域名）==="
echo "--- /health"
curl -sS --max-time 15 --noproxy '*' "https://$CANON/health" 2>&1 | head -c 400
echo
echo "--- /audio/2127857220?probe=1  (解析测试，应返回 JSON 含 host)"
curl -sS --max-time 25 --noproxy '*' "https://$CANON/audio/2127857220?probe=1" 2>&1 | head -c 400
echo
echo "--- /audio/2127857220  (应 302 到 cf-media)"
curl -sS -o /dev/null -w 'status=%{http_code} redirect=%{redirect_url}\n' --max-time 25 --noproxy '*' "https://$CANON/audio/2127857220" 2>&1 | head -c 300
