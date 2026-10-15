#!/usr/bin/env bash
# Tractus.app 을 끌어다 놓는 설치 디스크 이미지(.dmg)로 포장한다: hdiutil(macOS 기본 도구)만 쓴다. 관리자 암호가 필요 없는 가장 단순한 배포 형태다.
# 앱 만들기는 scripts/build_app_bundle.sh, 안내서는 docs/setup.md "미리 만든 앱 받기".
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
APP=""
OUT="$REPO/dist"
VERSION=""
CHECK_ONLY=0

usage() {
  cat <<'USAGE'
사용법: scripts/make_dmg.sh <Tractus.app 경로> [--version X] [--out <폴더>]
        scripts/make_dmg.sh --check

  --version X   파일 이름에 넣을 버전 (기본: app/src-tauri/tauri.conf.json 의 version 에 만든 날짜를 붙입니다. 버전은 0.1.0 그대로라 날짜가 없으면 빌드마다 이름이 같습니다)
  --out <폴더>  결과를 둘 폴더 (기본: dist). 결과: <폴더>/Tractus-<버전>-arm64.dmg
  --check       hdiutil·ditto 가 있는지, 앱이 있으면 서명이 맞는지만 확인합니다 (아무것도 만들지 않습니다)

디스크 이미지 안: Tractus.app, Applications 바로가기, 설치 안내.txt (처음 열 때 Gatekeeper 경고를 넘기는 법, 데이터 위치).
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --version) [ $# -ge 2 ] || { echo "--version 뒤에 버전을 적어 주세요" >&2; exit 2; }; VERSION="$2"; shift ;;
    --out) [ $# -ge 2 ] || { echo "--out 뒤에 폴더를 적어 주세요" >&2; exit 2; }; OUT="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "알 수 없는 옵션: $1" >&2; usage >&2; exit 2 ;;
    *) [ -z "$APP" ] || { echo "앱 경로는 하나만 줄 수 있습니다" >&2; exit 2; }; APP="$1" ;;
  esac
  shift
done

for t in hdiutil ditto codesign; do command -v "$t" >/dev/null 2>&1 || { echo "$t 이(가) 없습니다 (macOS 기본 도구입니다)" >&2; exit 1; }; done
if [ -n "$APP" ]; then
  [ -f "$APP/Contents/Info.plist" ] || { echo "Tractus.app 이 아닙니다: $APP" >&2; exit 1; }
  codesign --verify --deep --strict "$APP" 2>&1 || { echo "앱 서명 검증에 실패했습니다. scripts/build_app_bundle.sh 로 다시 만드세요" >&2; exit 1; }
fi
if [ "$CHECK_ONLY" -eq 1 ]; then echo "확인했습니다${APP:+ (앱 서명 통과)}."; exit 0; fi
[ -n "$APP" ] || { echo "Tractus.app 경로를 적어 주세요" >&2; usage >&2; exit 2; }

[ -n "$VERSION" ] || VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$REPO/app/src-tauri/tauri.conf.json" | head -1)-$(date +%Y%m%d)"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd -P)"
DMG="$OUT/Tractus-$VERSION-arm64.dmg"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tractus-dmg.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "== 디스크 이미지 준비"
ditto "$APP" "$WORK/Tractus.app"   # ditto: 서명·실행 권한·링크를 그대로 복사한다
ln -s /Applications "$WORK/Applications"
cat > "$WORK/설치 안내.txt" <<'TXT'
Tractus 설치 안내
=================

필요한 것: Apple Silicon(M1 이상) Mac, macOS 14.4 이상.
(만든 Mac에서는 macOS 26에서 확인했습니다. macOS 14·15 단계와 아래 경고 해제 방법은 직접 확인하지 못했습니다.)

1. 설치
   Tractus 아이콘을 Applications 바로가기로 끌어다 놓습니다. 관리자 암호는 필요 없습니다.
   (내 폴더의 Applications 폴더에 넣어도 됩니다.)

2. 처음 열 때 (경고가 나옵니다)
   이 앱은 Apple에 등록한 개발자 서명이 없어서 처음 열 때 "확인되지 않은 개발자" 경고가 나옵니다.
   - macOS 15 이상: 앱을 한 번 열어 경고를 닫습니다. 시스템 설정 > 개인정보 보호 및 보안을 열고
     아래쪽의 "그래도 열기"를 눌러 암호를 입력합니다.
   - macOS 14: 앱을 control 키를 누른 채 클릭하고 "열기"를 고릅니다.
   - 터미널을 쓸 수 있다면 한 줄로 끝납니다 (경로는 설치한 곳에 맞춥니다):
       xattr -dr com.apple.quarantine /Applications/Tractus.app
   "손상되었기 때문에 열 수 없습니다"라고 나오면 위 xattr 명령을 실행한 뒤 다시 엽니다.

3. 처음 실행한 뒤
   - 시작 점검이 열립니다. 빠진 것을 확인하세요.
   - 모델: 사이드바의 "모델"에서 변환 엔진을 받습니다 (수 GB, 인터넷이 필요합니다).
   - AI 요약·질문을 쓰려면 설정에서 AI 키를 등록합니다. 키가 없어도 녹음과 텍스트 변환은 됩니다.
   - ffmpeg는 앱에 들어 있지 않습니다. 터미널에서 설치합니다:  brew install ffmpeg
   - 마이크 권한은 처음 녹음할 때 macOS가 묻습니다.

내 데이터가 있는 곳 (앱 밖이라 앱을 지우거나 새 버전으로 바꿔도 남습니다)
   노트·녹음   ~/Tractus
   모델        ~/Library/Application Support/dev.tractus.app/models
               (예전에 ~/Tractus/models 에 받아 둔 모델이 있으면 그 폴더를 씁니다)
   앱 설정·AI 키  ~/Library/Application Support/dev.tractus.app/

업데이트
   새 Tractus.app 으로 바꿔 넣으면 됩니다. 노트·모델·설정은 그대로입니다.
   앱을 새로 만들 때마다 서명이 달라져서 위 2번의 경고와 마이크·시스템 오디오 권한 확인이 다시 나올 수 있습니다
   (그럴 것으로 예상하지만 직접 확인하지는 못했습니다).

삭제
   Tractus.app 을 휴지통에 넣습니다. 위 데이터 폴더는 남으니, 필요 없으면 직접 지웁니다.
TXT

echo "== hdiutil create (UDZO, 압축)"
rm -f "$DMG"
hdiutil create -quiet -volname "Tractus" -srcfolder "$WORK" -fs HFS+ -format UDZO -ov "$DMG"
echo "만들었습니다: $DMG ($(du -h "$DMG" | awk '{print $1}'))"
