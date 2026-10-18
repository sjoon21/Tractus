#!/usr/bin/env bash
# README 스크린샷 다시 만들기: 앱 미리보기(가짜 데이터)를 라이트·다크로 찍는다.
#   scripts/screenshots/make_shots.sh            → docs/images/{note,home,ask,record,memo,settings}-{light,dark}.png
#   scripts/screenshots/make_shots.sh --lang en  → docs/images/en/…  (영어 화면 + 영어 가짜 데이터, preview.html?lang=en)
# 필요: Google Chrome, Node. 미리보기 서버가 떠 있어야 한다: (cd app && pnpm dev) → http://localhost:1420/preview.html
# playwright-core는 저장소 의존성에 넣지 않고 임시 폴더에 받는다(make_demo.sh와 같다).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd -P)"
LANG_ARG=ko
[[ "${1:-}" == "--lang" ]] && LANG_ARG="${2:?--lang ko|en}"
case "$LANG_ARG" in ko) OUT="$REPO/docs/images" ;; en) OUT="$REPO/docs/images/en" ;; *) echo "--lang은 ko 또는 en" >&2; exit 2 ;; esac
curl -sf -o /dev/null http://localhost:1420/preview.html || { echo "미리보기 서버가 없습니다: (cd app && pnpm dev)" >&2; exit 1; }
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
cp "$REPO/scripts/screenshots/readme-shots.mjs" "$T/"
(cd "$T" && npm init -y >/dev/null && npm i --silent --no-audit --no-fund playwright-core@1.56.1)
mkdir -p "$OUT"
node "$T/readme-shots.mjs" "$OUT" "$LANG_ARG"
echo "$OUT"
