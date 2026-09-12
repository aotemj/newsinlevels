#!/usr/bin/env bash
# Inspect the files GitHub Pages is ACTUALLY serving, and locate the frames named
# in the console stack trace. This distinguishes "server has the new build but the
# phone cached the old one" from "the new build is failing on its own".
set -u
SRC="https://aotemj.github.io/newsinlevels"

dl () { curl -sS --max-time 20 --noproxy '*' "$SRC/$1" 2>/dev/null; }

echo "=== 线上 segment.js ==="
dl segment.js > /tmp/live_segment.js
echo "  行数: $(wc -l < /tmp/live_segment.js | tr -d ' ')"
echo "  含 err.delivery（新版标记）: $(grep -c 'err.delivery' /tmp/live_segment.js)"
echo "  fetch 调用所在行号: $(grep -n 'await fetch(url' /tmp/live_segment.js | head -1)"
echo "  --- 第 186-198 行（栈里报的是 191）---"
sed -n '186,198p' /tmp/live_segment.js | sed 's/^/    /'

echo
echo "=== 线上 player.js ==="
dl player.js > /tmp/live_player.js
echo "  行数: $(wc -l < /tmp/live_player.js | tr -d ' ')"
for pat in 'advanceResolver' 'AUDIO_MODE' 'audioMode' '/stream/'; do
  printf "  含 %-18s : %s\n" "$pat" "$(grep -c -- "$pat" /tmp/live_player.js)"
done
echo "  --- 第 195 行（栈: load）---"; sed -n '195p' /tmp/live_player.js | sed 's/^/    /'
echo "  --- 第 209 行（栈: segmentNow）---"; sed -n '209p' /tmp/live_player.js | sed 's/^/    /'

echo
echo "=== 线上 app.js 第 431 行（栈: openLevel）==="
dl app.js > /tmp/live_app.js
sed -n '431p' /tmp/live_app.js | sed 's/^/    /'

echo
echo "=== 线上 config.js ==="
dl config.js > /tmp/live_config.js
grep -E 'AUDIO_MODE|WORKER_BASES' -A2 /tmp/live_config.js | sed 's/^/  /' | head -8

echo
echo "=== 线上 sw.js 版本 ==="
dl sw.js | grep -oE 'VERSION = "[^"]+"' | sed 's/^/  /'
