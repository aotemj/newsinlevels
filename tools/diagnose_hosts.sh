#!/usr/bin/env bash
#
# What can this network actually reach?
#
# Written after a false conclusion: every "it works live" check had been run on a
# machine with a TUN-mode proxy up, so the tests never touched the real network
# path. This script prints the proxy state FIRST, because the result is
# meaningless without it.
#
# Run it before and after a deploy, and any time playback breaks.
#
#   bash tools/diagnose_hosts.sh [resolver-base]
#
# Exit 0 if the app and the resolver are both reachable, 1 otherwise.

set -u
RESOLVER="${1:-https://nil-audio.pages.dev}"
FAILED=0

hr () { printf '%s\n' "------------------------------------------------------------"; }
ok () { printf '  \033[32mOK  \033[0m %s\n' "$1"; }
no () { printf '  \033[31mFAIL\033[0m %s\n' "$1"; }

echo "=== 1. 先确认代理状态（否则下面的结果不可信）==="
PAC=$(scutil --proxy 2>/dev/null | awk '/ProxyAutoConfigEnable/{print $3}')
PACURL=$(scutil --proxy 2>/dev/null | awk '/ProxyAutoConfigURLString/{print $3}')
echo "  PAC enabled : ${PAC:-?}  ${PACURL:-}"
TUNNEL=0
for i in $(ifconfig -l 2>/dev/null | tr ' ' '\n' | grep -E '^(utun|tun|ppp)'); do
  ip=$(ipconfig getifaddr "$i" 2>/dev/null)
  if [ -n "$ip" ]; then echo "  隧道 $i -> $ip"; TUNNEL=1; fi
done
echo "  默认路由 :"
netstat -rn -f inet 2>/dev/null | awk '$1=="default"{printf "    %s (%s)\n", $2, $NF}'
if [ -n "${http_proxy:-}${https_proxy:-}${ALL_PROXY:-}" ]; then
  echo "  代理环境变量: $(env | grep -iE '^(http_proxy|https_proxy|all_proxy)=' | tr '\n' ' ')"
  TUNNEL=1
fi
if [ $TUNNEL -eq 1 ]; then
  echo "  → 检测到活跃隧道/代理：本次测的【不是】裸网络路径，关掉它再跑一次才有意义。"
else
  echo "  → 没有活跃隧道（PAC 配置存在但未承载流量）：本次测的是裸网络路径。"
fi

hr
echo "=== 2. 逐跳可达性（真实 TLS 握手，不是只连 TCP）==="
# Only -w, -o, --max-time are used, so this works with any recent curl.
probe () {
  local url="$1" label="$2" required="${3:-no}"
  local code err rc
  err=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 --noproxy '*' "$url" 2>&1 >/dev/null)
  rc=$?
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 --noproxy '*' "$url" 2>/dev/null)
  if [ $rc -ne 0 ]; then
    no "$label"
    printf '       %s\n' "$(echo "$err" | head -1)"
    [ "$required" = yes ] && FAILED=1
    return
  fi
  # 401/403/404/522 still mean DNS+TLS+HTTP all worked -- that is the question here.
  ok "$label  (HTTP $code)"
}

probe "https://aotemj.github.io/"        "app        github.io"                 yes
probe "$RESOLVER/health"                 "resolver   $RESOLVER"                yes
probe "https://cf-media.sndcdn.com/"     "audio CDN  cf-media.sndcdn.com"      no
probe "https://api-v2.soundcloud.com/"   "soundcloud api-v2.soundcloud.com"    no
probe "https://feeds.soundcloud.com/"    "soundcloud feeds.soundcloud.com"     no

hr
echo "=== 3. DNS 是否被污染（辅助证据 —— 以第 2 节的超时为准）==="
# 污染池是随机轮换的，实测同一域名先后解析到过 Twitter/Dropbox/Facebook 段和
# 随机 IDC 地址（47.88.x.x、103.97.x.x…），所以下面的已知网段只能命中一部分。
# 【真正的判据是第 2 节：域名能解析、但 TLS 握手超时】。无标记 ≠ 未被污染。
#   Twitter   192.133.77.x / 199.59.148-149.x
#   Dropbox   108.160.165.x
#   Facebook  31.13.x.x / 157.240.x.x / 179.60.x.x / 2a03:2880:...:face:b00c
RESOLVER_HOST=$(printf '%s' "$RESOLVER" | sed -E 's|^https?://||; s|/.*$||')
for h in "$RESOLVER_HOST" api-v2.soundcloud.com feeds.soundcloud.com cf-media.sndcdn.com; do
  ips=$(dig +short +time=3 +tries=1 "$h" 2>/dev/null | grep -E '^[0-9a-f.:]+$' | tr '\n' ' ')
  flag=""
  case "$ips" in
    *192.133.77.*|*199.59.14[89].*)    flag="  <-- Twitter 段，典型污染" ;;
    *108.160.165.*)                    flag="  <-- Dropbox 段，典型污染" ;;
    *31.13.*|*157.240.*|*179.60.*)     flag="  <-- Facebook 段，典型污染" ;;
    *face:b00c*)                       flag="  <-- Facebook 段，典型污染" ;;
    "")                                flag="  <-- 无解析（未部署的项目也会这样）" ;;
  esac
  printf '  %-34s %s%s\n' "$h" "${ips:-none}" "$flag"
done

hr
if [ $FAILED -eq 0 ]; then
  echo "结论：应用和解析器都可达。"
else
  echo "结论：有必需的主机不可达 —— 上面标 FAIL 的那几行就是断点。"
  echo "      · resolver 不可达 → 若域名型如 *.workers.dev，改用 *.pages.dev（见 README）"
  echo "      · 只有 soundcloud api/feed 不可达而 cf-media 可达 → 属正常，播放不受影响"
fi
exit $FAILED
