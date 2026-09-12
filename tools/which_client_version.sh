#!/usr/bin/env bash
# Which version is the phone actually running? The console stack trace names exact
# line numbers, and the new code shifted them (segment.js gained 5 lines before
# its fetch), so the numbers identify the build.
set -u
cd "$(dirname "$0")/.." || exit 1

OLD=eb42388   # the version pushed before the /stream change
NEW=HEAD

show () {
  local rev="$1" label="$2"
  echo "=== $label ==="
  printf "  segment.js:191   %s\n" "$(git show "$rev:docs/segment.js" 2>/dev/null | sed -n '191p' | cut -c1-72)"
  printf "  player.js:195    %s\n" "$(git show "$rev:docs/player.js" 2>/dev/null | sed -n '195p' | cut -c1-72)"
  printf "  player.js:209    %s\n" "$(git show "$rev:docs/player.js" 2>/dev/null | sed -n '209p' | cut -c1-72)"
  printf "  app.js:431       %s\n" "$(git show "$rev:docs/app.js" 2>/dev/null | sed -n '431p' | cut -c1-72)"
  printf "  app.js:269       %s\n" "$(git show "$rev:docs/app.js" 2>/dev/null | sed -n '269p' | cut -c1-72)"
  echo
  echo "  该版本用哪个路由："
  git show "$rev:docs/config.js" 2>/dev/null | grep -E "AUDIO_MODE" | sed 's/^/    /' || echo "    （无 AUDIO_MODE —— 旧版，只走 /audio 302）"
  echo
}

show "$OLD" "旧版 eb42388（线上推送前的版本）"
show "$NEW" "当前 HEAD（新版，默认 /stream）"
