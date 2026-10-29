#!/usr/bin/env bash
# 릴리스 묶음 만들기: 미리 만든 앱(scripts/build_app_bundle.sh) → 업데이트용 Tractus.app.tar.gz + 서명(.sig) → latest.json → .dmg(scripts/make_dmg.sh) → sha256.
# 앱 안의 업데이트 확인(tauri-plugin-updater)은 공개 저장소 정식 릴리스의 latest.json(releases/latest/download/latest.json)만 본다.
# tauri build 가 만드는 tar.gz 는 쓰지 않는다: build_app_bundle.sh 의 마지막 ad-hoc 재서명 전 것이라 쓸모가 없다. 여기서는 최종 서명된 앱을 직접 압축한다.
# 서명 키: 개인 키 ~/.tauri/tractus.key (비밀번호 없음, 저장소 밖), 공개 키는 app/src-tauri/tauri.conf.json 의 plugins.updater.pubkey. 개인 키 내용은 어디에도 찍지 않는다.
# 기본은 --dry-run: gh release create 명령을 출력만 한다. --publish 를 주면 실제로 만든다(리드가 쓴다).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
GH_REPO="sjoon21/Tractus"
KEY="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/tractus.key}"
OUT=""
APP=""
NOTES_FILE=""
CHECK_ONLY=0
PUBLISH=0
WITH_FLUID=""

usage() {
  cat <<'USAGE'
사용법: scripts/release.sh [옵션]
        scripts/release.sh --check

  --skip-build <Tractus.app>  앱을 새로 만들지 않고 이미 만든 앱으로 압축·서명·latest.json·dmg 만 만듭니다
  --notes-file <파일>         릴리스 노트 (기본: docs/releases/v<버전>.md. 앞머리의 summary·summary_en + 웹 페이지 주소가
                              latest.json 의 notes(앱 업데이트 칸), 본문이 GitHub 릴리스 본문이 된다. 웹 페이지는 main에 합치면 Pages가 만든다)
  --with-fluid                build_app_bundle.sh 에 넘깁니다 (9명 이상 참석자 구분 도우미 포함)
  --out <폴더>                결과를 둘 폴더 (기본: dist/release/<버전>)
  --publish                   gh release create 를 실제로 실행합니다 (기본은 명령만 출력합니다)
  --check                     도구·서명 키가 있는지만 확인합니다 (아무것도 만들지 않습니다)
  -h, --help

버전은 app/src-tauri/tauri.conf.json 의 version 입니다. 결과(<폴더>/):
  Tractus.app.tar.gz        업데이트용 (앱 폴더가 아카이브 루트, COPYFILE_DISABLE=1)
  Tractus.app.tar.gz.sig    tauri signer 서명
  latest.json               {version, notes, pub_date, platforms.darwin-aarch64{signature, url}}
  Tractus-<버전>-arm64.dmg  처음 설치하는 사람용 (v0.1.0 에는 업데이트 확인이 없어 한 번은 이것으로 설치합니다)
  Tractus-<버전>-arm64.dmg.sha256
서명 키: $TAURI_SIGNING_PRIVATE_KEY (키 문자열) 또는 $TAURI_SIGNING_PRIVATE_KEY_PATH, 기본 ~/.tauri/tractus.key.
키가 없으면: cd app && pnpm tauri signer generate -w ~/.tauri/tractus.key --ci  (공개 키를 tauri.conf.json 에 넣어야 앱이 받아들입니다)
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --publish) PUBLISH=1 ;;
    --with-fluid) WITH_FLUID="--with-fluid" ;;
    --skip-build) [ $# -ge 2 ] || { echo "--skip-build 뒤에 Tractus.app 경로를 적어 주세요" >&2; exit 2; }; APP="$2"; shift ;;
    --notes-file) [ $# -ge 2 ] || { echo "--notes-file 뒤에 파일을 적어 주세요" >&2; exit 2; }; NOTES_FILE="$2"; shift ;;
    --out) [ $# -ge 2 ] || { echo "--out 뒤에 폴더를 적어 주세요" >&2; exit 2; }; OUT="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "알 수 없는 옵션: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [ -t 1 ]; then G=$'\033[32m'; R=$'\033[31m'; B=$'\033[1m'; N=$'\033[0m'; else G=""; R=""; B=""; N=""; fi
FAILS=0
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
fail() { printf '  %s✗%s %s\n' "$R" "$N" "$1"; FAILS=$((FAILS + 1)); }
step() { printf '\n%s== %s%s\n' "$B" "$1" "$N"; }

VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$REPO/app/src-tauri/tauri.conf.json" | head -1)"
[ -n "$OUT" ] || OUT="$REPO/dist/release/$VERSION"
TAG="v$VERSION"
[ -n "$NOTES_FILE" ] || NOTES_FILE="$REPO/docs/releases/v$VERSION.md"
URL="https://github.com/$GH_REPO/releases/download/$TAG/Tractus.app.tar.gz"

step "사전 조건 확인 (버전 $VERSION)"
for t in tar shasum python3 pnpm codesign; do
  if command -v "$t" >/dev/null 2>&1; then ok "$t"; else fail "$t 이(가) 없습니다"; fi
done
# 서명 키: 환경변수(키 문자열)가 있으면 그것, 아니면 파일. 내용은 읽지도 찍지도 않는다
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then ok "서명 키: TAURI_SIGNING_PRIVATE_KEY"
elif [ -f "$KEY" ]; then ok "서명 키: $KEY"
else fail "서명 키가 없습니다: $KEY  (cd app && pnpm tauri signer generate -w ~/.tauri/tractus.key --ci)"; fi
grep -q '"pubkey": *"[^"]\+"' "$REPO/app/src-tauri/tauri.conf.json" && ok "tauri.conf.json plugins.updater.pubkey" || fail "tauri.conf.json 에 plugins.updater.pubkey 가 없습니다"
if command -v gh >/dev/null 2>&1; then ok "gh"; elif [ "$PUBLISH" -eq 1 ]; then fail "gh 가 없습니다 (--publish 에 필요)"; else ok "gh 없음 (--publish 때만 필요)"; fi
if [ ! -f "$NOTES_FILE" ]; then fail "릴리스 노트 파일이 없습니다: $NOTES_FILE (docs/releases/v<버전>.md, 앞머리 version·date·summary·summary_en)"
elif CHECK_DIR="$(mktemp -d)" && python3 "$REPO/scripts/releases_page.py" --release-texts "$NOTES_FILE" "$CHECK_DIR"; then ok "릴리스 노트: $NOTES_FILE"; rm -rf "$CHECK_DIR"
else fail "릴리스 노트를 읽지 못했습니다: $NOTES_FILE"; fi
if [ -n "$APP" ]; then
  [ -f "$APP/Contents/Info.plist" ] && ok "앱: $APP" || fail "Tractus.app 이 아닙니다: $APP"
else
  "$REPO/scripts/build_app_bundle.sh" --check >/dev/null 2>&1 && ok "build_app_bundle.sh --check" || fail "build_app_bundle.sh --check 실패 (scripts/build_app_bundle.sh --check 로 확인하세요)"
fi
if [ "$FAILS" -gt 0 ]; then echo; echo "부족한 것이 $FAILS 개 있습니다."; exit 1; fi
[ "$CHECK_ONLY" -eq 0 ] || { echo; echo "사전 조건이 갖춰졌습니다. 만들려면 --check 없이 실행하세요."; exit 0; }

START=$SECONDS
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd -P)"

if [ -z "$APP" ]; then
  step "1. 앱 만들기 (scripts/build_app_bundle.sh)"
  "$REPO/scripts/build_app_bundle.sh" --out "$OUT/app.noindex" $WITH_FLUID   # .noindex: Spotlight가 사본을 앱으로 띄우지 않게
  APP="$OUT/app.noindex/Tractus.app"
fi
APP="$(cd "$APP" && pwd -P)"
BUILT="$(sed -n '/CFBundleShortVersionString/{n;s/.*<string>\(.*\)<\/string>.*/\1/p;}' "$APP/Contents/Info.plist")"
[ "$BUILT" = "$VERSION" ] || { echo "앱의 버전($BUILT)이 tauri.conf.json($VERSION)과 다릅니다. 앱을 다시 만드세요" >&2; exit 1; }
codesign --verify --deep --strict "$APP" || { echo "앱 서명 검증에 실패했습니다. scripts/build_app_bundle.sh 로 다시 만드세요" >&2; exit 1; }

step "2. 업데이트용 압축 (앱 폴더가 아카이브 루트)"
TGZ="$OUT/Tractus.app.tar.gz"
DMG="$OUT/Tractus-$VERSION-arm64.dmg"
# 지난 실행의 산출물을 먼저 모두 지운다: 중간에 실패해도 새 tar.gz 와 옛 latest.json·dmg 가 한 폴더에 섞여 올라가지 않게
rm -f "$TGZ" "$TGZ.sig" "$OUT/latest.json" "$DMG" "$DMG.sha256"
# COPYFILE_DISABLE=1: macOS tar 가 넣는 ._* (리소스 포크·xattr) 를 뺀다. 서명은 ditto 처럼 그대로 보존된다
(cd "$(dirname "$APP")" && COPYFILE_DISABLE=1 tar czf "$TGZ" "$(basename "$APP")")
ok "$TGZ ($(du -h "$TGZ" | awk '{print $1}'))"

step "3. 서명 (tauri signer)"
# 개인 키는 파일 경로(-f) 또는 TAURI_SIGNING_PRIVATE_KEY 로만 넘긴다. 비밀번호 없는 키라 -p "" 로 물어보지 않게 한다
SIGN_KEY=(); [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] || SIGN_KEY=(-f "$KEY")
(cd "$REPO/app" && pnpm --silent tauri signer sign "${SIGN_KEY[@]}" -p "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" --app-version "$VERSION" "$TGZ" >/dev/null)
[ -s "$TGZ.sig" ] || { echo "서명 파일이 만들어지지 않았습니다: $TGZ.sig" >&2; exit 1; }
ok "$TGZ.sig"

step "4. latest.json"
TEXTS="$OUT/notes"; mkdir -p "$TEXTS"
python3 "$REPO/scripts/releases_page.py" --release-texts "$NOTES_FILE" "$TEXTS"
NOTES="$(cat "$TEXTS/notes.txt")"
PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
python3 - "$OUT/latest.json" "$VERSION" "$PUB_DATE" "$URL" "$TGZ.sig" "$NOTES" <<'PY'
import json, sys
out, version, pub_date, url, sig, notes = sys.argv[1:]
with open(sig, encoding="utf-8") as f:
    signature = f.read().strip()
doc = {"version": version, "notes": notes, "pub_date": pub_date, "platforms": {"darwin-aarch64": {"signature": signature, "url": url}}}
with open(out, "w", encoding="utf-8") as f:
    json.dump(doc, f, ensure_ascii=False, indent=2)
    f.write("\n")
PY
ok "$OUT/latest.json ($URL)"

step "5. 디스크 이미지 (scripts/make_dmg.sh)"
"$REPO/scripts/make_dmg.sh" "$APP" --version "$VERSION" --out "$OUT"

step "6. sha256 (디스크 이미지. tar.gz 는 .sig 가 보증한다)"
(cd "$OUT" && shasum -a 256 "$(basename "$DMG")" > "$DMG.sha256" && cat "$DMG.sha256")

step "끝"
echo "결과:   $OUT"
echo "걸린 시간: $((SECONDS - START))초"
echo "서명 검증(앱과 같은 방식, app/src-tauri/tests/update_signature.rs):"
echo "  TRACTUS_UPDATE_ARTIFACT=$TGZ TRACTUS_UPDATE_SIG=$TGZ.sig cargo test --manifest-path $REPO/app/src-tauri/Cargo.toml --test update_signature"
NOTES_ARG=(--notes-file "$TEXTS/body.md")
GH_CMD=(gh release create "$TAG" -R "$GH_REPO" --title "Tractus $VERSION" "${NOTES_ARG[@]}" "$DMG" "$DMG.sha256" "$TGZ" "$TGZ.sig" "$OUT/latest.json")
echo
echo "GitHub 릴리스 (정식 릴리스여야 앱이 찾습니다. pre-release 가 아니고, 저장소가 공개여야 합니다):"
printf '  %q' "${GH_CMD[@]}"; echo
if [ "$PUBLISH" -eq 1 ]; then
  step "7. gh release create"
  "${GH_CMD[@]}"
else
  echo "  (--publish 를 주면 실행합니다)"
fi
