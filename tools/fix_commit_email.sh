#!/usr/bin/env bash
#
# Rewrite every commit that used the wrong author email, then prove nothing else
# changed.
#
#   bash tools/fix_commit_email.sh [--push]
#
# Why: GitHub credits a commit to an account only when the commit's email is verified
# there. This repo's commits carried losidk@gmail.com -- one "l" short of the address
# actually verified on the account -- so all 17 of them counted toward no one's
# contribution graph. The tree contents were fine; only the identity was wrong.
#
# Rewriting changes every commit SHA, so this verifies the two things that must NOT
# change (the commit count and every tree hash) and leaves a tag pointing at the old
# tip so the previous state is recoverable.
set -eu
cd "$(dirname "$0")/.." || exit 1

OLD_EMAIL="losidk@gmail.com"
NEW_EMAIL="losidkl@gmail.com"
NAME="losidk"
BACKUP_TAG="pre-email-rewrite"
BRANCH="main"
PUSH="${1:-}"

hr () { printf '%s\n' "------------------------------------------------------------"; }

hr
echo "改写前"
BEFORE_COUNT=$(git rev-list --count HEAD)
BEFORE_TREES=$(git log --format='%T' | sort | shasum -a 256 | awk '{print $1}')
BEFORE_HEAD=$(git rev-parse --short HEAD)
echo "  提交数        : $BEFORE_COUNT"
echo "  全部 tree 指纹: $BEFORE_TREES"
echo "  HEAD          : $BEFORE_HEAD $(git log -1 --format=%s)"
echo "  需要改写的提交: $(git log --format='%ae' | grep -c "$OLD_EMAIL" || true)"

git fetch origin --quiet 2>/dev/null || true

# Safety net: the old tip stays reachable under a tag, so this is undoable with
# `git reset --hard pre-email-rewrite` (or by force-pushing that tag back).
git tag -f "$BACKUP_TAG" HEAD >/dev/null
echo "  回退点        : tag $BACKUP_TAG -> $(git rev-parse --short "$BACKUP_TAG")"

hr
echo "改写 author + committer（两者都要，贡献归属看 author，但提交记录里 committer 也会显示）"
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --env-filter "
if [ \"\$GIT_AUTHOR_EMAIL\" = \"$OLD_EMAIL\" ]; then
  export GIT_AUTHOR_EMAIL=\"$NEW_EMAIL\"
  export GIT_AUTHOR_NAME=\"$NAME\"
fi
if [ \"\$GIT_COMMITTER_EMAIL\" = \"$OLD_EMAIL\" ]; then
  export GIT_COMMITTER_EMAIL=\"$NEW_EMAIL\"
  export GIT_COMMITTER_NAME=\"$NAME\"
fi
" --tag-name-filter cat -- "$BRANCH" >/dev/null 2>&1

# filter-branch leaves the original refs under refs/original; drop them so the rewrite
# is what a plain `git log` shows and so refs do not linger.
git for-each-ref --format='%(refname)' refs/original/ | while read -r r; do
  git update-ref -d "$r"
done

hr
echo "改写后"
AFTER_COUNT=$(git rev-list --count HEAD)
AFTER_TREES=$(git log --format='%T' | sort | shasum -a 256 | awk '{print $1}')
AFTER_HEAD=$(git rev-parse --short HEAD)
echo "  提交数        : $AFTER_COUNT"
echo "  全部 tree 指纹: $AFTER_TREES"
echo "  HEAD          : $AFTER_HEAD $(git log -1 --format=%s)"

hr
echo "校验"
FAILED=0
check () { # label, expected, actual
  if [ "$2" = "$3" ]; then echo "  ok    $1"; else echo "  FAIL  $1 (期望 $2，实际 $3)"; FAILED=1; fi
}
check "提交数不变" "$BEFORE_COUNT" "$AFTER_COUNT"
check "所有 tree 内容不变（只有身份被改写）" "$BEFORE_TREES" "$AFTER_TREES"
left=$(git log --format='%ae %ce' | grep -c "$OLD_EMAIL" || true)
check "旧邮箱已无残留" "0" "$left"
now=$(git log --format='%ae' | grep -c "$NEW_EMAIL" || true)
echo "  已改为 $NEW_EMAIL 的提交: $now"
echo
echo "  署名一览（author 邮箱 -> 提交数）:"
git log --format='%ae' | sort | uniq -c | sort -rn | sed 's/^/    /'

if [ "$FAILED" -ne 0 ]; then
  echo
  echo "校验未通过，不做任何推送。用 'git reset --hard $BACKUP_TAG' 可完整回退。"
  exit 1
fi

hr
echo "本地身份一并更正（只影响本仓库）"
git config user.email "$NEW_EMAIL"
git config user.name "$NAME"
echo "  user.name  : $(git config --get user.name)"
echo "  user.email : $(git config --get user.email)"

if [ "$PUSH" = "--push" ]; then
  hr
  echo "强推（--force-with-lease：远端若被每日同步动过就安全失败，不会覆盖别人的提交）"
  git push --force-with-lease origin main
  echo "  已推送。"
else
  hr
  echo "尚未推送。检查无误后执行："
  echo "  git push --force-with-lease origin main"
  echo "回退：git reset --hard $BACKUP_TAG"
fi
