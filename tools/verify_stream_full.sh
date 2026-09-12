#!/usr/bin/env bash
# Verify /stream end to end: a full GET (needed for duration + seeking) as well as
# a Range request, and compare the size against what the resolver reports.
set -u
BASE="https://nil-audio.pages.dev"
TRACK="${1:-2127857220}"

echo "=== 1. 完整下载（模拟播放器首次加载：需要 Content-Length 才能得到时长）==="
curl -sS -o /tmp/full.mp3 -D /tmp/full.hdr -w '  status=%{http_code}  bytes=%{size_download}  time=%{time_total}s  speed=%{speed_download}B/s\n' \
  --max-time 90 --noproxy '*' "$BASE/stream/$TRACK"
echo "  --- 关键响应头 ---"
grep -iE "^(HTTP|content-type|content-length|accept-ranges|content-range|x-track)" /tmp/full.hdr | sed 's/^/  /'
echo "  --- 是否真音频 ---"
printf "  首 3 字节: %s  (49 44 33=ID3)\n" "$(head -c 3 /tmp/full.mp3 | xxd -p)"

echo
echo "=== 2. Range 请求（模拟拖进度条）==="
curl -sS -o /tmp/part.mp3 -D /tmp/part.hdr -w '  status=%{http_code}  bytes=%{size_download}\n' \
  -H 'Range: bytes=100000-101023' --max-time 40 --noproxy '*' "$BASE/stream/$TRACK"
grep -iE "^(HTTP|content-range|content-length)" /tmp/part.hdr | sed 's/^/  /'

echo
echo "=== 3. 用文件大小推算播放时长（128kbps ≈ 16KB/秒）==="
SZ=$(wc -c < /tmp/full.mp3 | tr -d ' ')
echo "  文件大小: $SZ 字节  ->  约 $((SZ / 16000)) 秒"
echo "  索引里该曲目时长（用于对照）:"
curl -sS --max-time 20 --noproxy '*' "$BASE/health" >/dev/null 2>&1
python3 - "$TRACK" <<'PY'
import json, sys, pathlib
track = sys.argv[1]
d = pathlib.Path("docs/data/s")
for f in d.glob("*.json"):
    j = json.loads(f.read_text())
    for lv, v in (j.get("levels") or {}).items():
        if str((v.get("audio") or {}).get("track")) == track:
            print(f"  {j['id']} L{lv}: dur={v.get('audio',{}).get('dur')}s")
PY
