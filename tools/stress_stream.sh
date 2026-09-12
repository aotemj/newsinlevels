#!/usr/bin/env bash
# Is /stream reliable? If it sometimes fails, the client falls through to the
# redirect mode, which is what produces the cf-media 403 in the console.
set -u
BASE="${1:-https://nil-audio.pages.dev}"
TRACK="${2:-2127857220}"
N="${3:-8}"

echo "连续请求 $BASE/stream/$TRACK 共 $N 次"
echo
for i in $(seq 1 "$N"); do
  # no -f: we want the status code even on failure
  out=$(curl -sS -o /tmp/s.bin -w '%{http_code}|%{size_download}|%{content_type}' \
        -H 'Range: bytes=0-2047' --max-time 40 --noproxy '*' "$BASE/stream/$TRACK" 2>/tmp/s.err)
  rc=$?
  if [ $rc -ne 0 ]; then
    printf "  %2d. curl 失败: %s\n" "$i" "$(head -1 /tmp/s.err)"
    continue
  fi
  code=${out%%|*}; rest=${out#*|}; size=${rest%%|*}; ctype=${rest#*|}
  b=$(head -c 3 /tmp/s.bin | xxd -p 2>/dev/null)
  audio="是"
  case "$b" in 494433|fffb|fffa|fff3) ;; *) audio="否(前3字节 $b)";; esac
  body=$(head -c 70 /tmp/s.bin | tr -d '\0' | tr '\n' ' ')
  printf "  %2d. HTTP %-4s %-7s %-11s 音频:%s  %s\n" "$i" "$code" "$size" "$ctype" "$audio" \
    "$( [ "$code" = "200" ] || [ "$code" = "206" ] || [ "$code" = "304" ] && echo "" || echo "$body" )"
done
