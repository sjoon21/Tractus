#!/usr/bin/env bash
# Tractus 설치: 코어(uv) + 녹음 헬퍼(swift) + 데스크톱 앱(pnpm, tauri)을 이 저장소 안에서 빌드한다.
# 여러 번 실행해도 안전하다. 사용법은 --help, 안내서는 docs/setup.md.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE="$REPO/app/src-tauri/target/release/bundle/macos/Tractus.app"

CHECK_ONLY=0
WITH_FLUID=0
COPY_APP=0
MODELS_PRESET=""

# 사전 점검 기준 (docs/setup.md 요구 사항과 같다)
MIN_MACOS="14.4"
MIN_MEM_GB=8
MIN_DISK_GB=15
MIN_NODE="22.12"   # app/ 의 vite 8·vitest 5가 요구하는 하한
MIN_SWIFT="5.10"        # recorder/Package.swift 의 swift-tools-version (Xcode 15.3)
MIN_SWIFT_FLUID="6.2"   # recorder/diar/Package.swift 의 swift-tools-version (Xcode 26, --with-fluid일 때만)

usage() {
  cat <<'USAGE'
사용법: scripts/install.sh [옵션]

  --check             아무것도 설치하지 않고 사전 조건만 확인하고, 할 일을 보여 줍니다
  --with-fluid        9명 이상 참석자 구분용 헬퍼(tractus-diar)도 빌드합니다 (Swift 6.2 이상, Xcode 26)
  --models <구성>     끝에 모델을 받습니다: required | standard | lite | all
  --copy-app          만든 앱을 ~/Applications 에 복사합니다
  -h, --help          이 도움말

도구(Rust, Node.js, pnpm, uv, ffmpeg)가 없으면 먼저 scripts/bootstrap.sh 를 실행하세요.

예: scripts/install.sh --check
    scripts/install.sh --models standard --copy-app
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --with-fluid) WITH_FLUID=1 ;;
    --copy-app) COPY_APP=1 ;;
    --models)
      [ $# -ge 2 ] || { echo "--models 뒤에 구성(required|standard|lite|all)을 적어 주세요" >&2; exit 2; }
      MODELS_PRESET="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "알 수 없는 옵션: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

case "$MODELS_PRESET" in ""|required|standard|lite|all) ;; *)
  echo "--models 는 required, standard, lite, all 중 하나여야 합니다 (받은 값: $MODELS_PRESET)" >&2; exit 2 ;;
esac

if [ -t 1 ]; then G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; B=$'\033[1m'; N=$'\033[0m'; else G=""; Y=""; R=""; B=""; N=""; fi
FAILS=0
WARNS=0
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$1"; WARNS=$((WARNS + 1)); }
fail() { printf '  %s✗%s %s\n' "$R" "$N" "$1"; FAILS=$((FAILS + 1)); }
step() { printf '\n%s== %s%s\n' "$B" "$1" "$N"; }

# 버전 a >= b (점으로 나뉜 숫자). 앞의 두 자리만 비교한다.
ver_ge() {
  local a1 a2 b1 b2
  IFS=. read -r a1 a2 _ <<<"$1"; IFS=. read -r b1 b2 _ <<<"$2"
  a2=${a2:-0}; b2=${b2:-0}
  [ "$a1" -gt "$b1" ] || { [ "$a1" -eq "$b1" ] && [ "$a2" -ge "$b2" ]; }
}

preflight() {
  step "사전 조건 확인"

  if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then ok "Apple Silicon Mac"
  else fail "Apple Silicon(arm64) Mac이 필요합니다 (현재: $(uname -s) $(uname -m))"; fi

  local macos; macos="$(sw_vers -productVersion 2>/dev/null || echo 0)"
  if ver_ge "$macos" "$MIN_MACOS"; then ok "macOS $macos"
  else fail "macOS $MIN_MACOS 이상이 필요합니다 (현재: $macos)"; fi

  local mem_gb; mem_gb=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 ))
  if [ "$mem_gb" -lt "$MIN_MEM_GB" ]; then fail "메모리 ${MIN_MEM_GB}GB 이상이 필요합니다 (현재: ${mem_gb}GB)"
  elif [ "$mem_gb" -lt 16 ]; then warn "메모리 ${mem_gb}GB: 저사양 구성(0.6B 모델)을 권장합니다. 표준 구성은 16GB 이상을 권장합니다"
  else ok "메모리 ${mem_gb}GB"; fi

  local free_gb; free_gb=$(( $(df -k "$REPO" | awk 'NR==2 {print $4}') / 1048576 ))
  if [ "$free_gb" -ge "$MIN_DISK_GB" ]; then ok "디스크 여유 ${free_gb}GB"
  else fail "디스크 여유 ${MIN_DISK_GB}GB 이상이 필요합니다 (현재: ${free_gb}GB). 빌드 산출물과 모델이 들어갑니다"; fi

  if xcode-select -p >/dev/null 2>&1 && command -v swift >/dev/null 2>&1; then
    local sv; sv="$(swift --version 2>&1 | sed -n 's/.*Swift version \([0-9][0-9.]*\).*/\1/p' | head -1)"
    if [ -z "$sv" ] || ! ver_ge "$sv" "$MIN_SWIFT"; then
      fail "Swift $MIN_SWIFT 이상이 필요합니다 (현재: ${sv:-알 수 없음}). Xcode 15.3 이상이 필요합니다. Xcode를 업데이트하세요 (macOS 13.5 이상이면 Xcode 15.3, 14.5 이상이면 Xcode 16을 설치할 수 있습니다)"
    elif [ "$WITH_FLUID" -eq 1 ] && ! ver_ge "$sv" "$MIN_SWIFT_FLUID"; then
      fail "--with-fluid 는 Swift $MIN_SWIFT_FLUID 이상이 필요합니다 (현재: $sv). Xcode 26 이상(macOS 15.6 이상)이 필요합니다. 아니면 --with-fluid 없이 설치하세요 (참석자 구분은 8명까지)"
    elif [ "$WITH_FLUID" -eq 1 ]; then ok "Swift $sv (Xcode 명령줄 도구, 9명 이상 구분 헬퍼까지 빌드 가능)"
    else ok "Swift $sv (Xcode 명령줄 도구)"; fi
  else fail "Xcode 명령줄 도구가 없습니다. 터미널에서 xcode-select --install 을 실행하세요 (scripts/bootstrap.sh 가 안내합니다)"; fi

  if command -v cargo >/dev/null 2>&1; then ok "Rust $(cargo --version | awk '{print $2}')"
  else fail "Rust(cargo)가 없습니다. scripts/bootstrap.sh 를 먼저 실행하세요 (brew install rust)"; fi

  if command -v node >/dev/null 2>&1; then
    local nv; nv="$(node -v | sed 's/^v//')"
    if ver_ge "$nv" "$MIN_NODE"; then ok "Node.js $nv"
    else fail "Node.js $MIN_NODE 이상이 필요합니다 (현재: $nv)"; fi
  else fail "Node.js가 없습니다. scripts/bootstrap.sh 를 먼저 실행하세요 (brew install node)"; fi

  if command -v pnpm >/dev/null 2>&1; then ok "pnpm $(pnpm -v)"
  else fail "pnpm이 없습니다. scripts/bootstrap.sh 를 먼저 실행하세요 (brew install pnpm)"; fi

  if command -v uv >/dev/null 2>&1; then ok "uv $(uv --version | awk '{print $2}')"
  else fail "uv가 없습니다. scripts/bootstrap.sh 를 먼저 실행하세요 (brew install uv)"; fi

  if command -v ffmpeg >/dev/null 2>&1; then ok "ffmpeg ($(command -v ffmpeg))"
  elif command -v brew >/dev/null 2>&1; then
    warn "ffmpeg가 없습니다. 텍스트 변환과 파일 가져오기에 필요합니다: scripts/bootstrap.sh 또는 brew install ffmpeg"
  else
    warn "ffmpeg가 없고 Homebrew도 없습니다. 텍스트 변환과 파일 가져오기에 필요합니다 (https://brew.sh 에서 Homebrew를 설치한 뒤 brew install ffmpeg)"
  fi
}

plan() {
  step "할 일"
  echo "  1. uv sync                                  코어(tractus 명령) 설치 → .venv"
  echo "  2. (recorder) swift build -c release       녹음 프로그램 빌드 → recorder/.build/release/tractus-rec"
  [ "$WITH_FLUID" -eq 1 ] && echo "     (recorder/diar) swift build -c release   9명 이상 구분 헬퍼 빌드 → recorder/diar/.build/release/tractus-diar"
  echo "  3. pnpm install --frozen-lockfile           앱 의존성 설치"
  echo "  4. pnpm tauri build --bundles app           앱 빌드 → ${APP_BUNDLE#"$REPO"/}"
  [ "$COPY_APP" -eq 1 ] && echo "  5. ~/Applications/Tractus.app 으로 복사"
  [ -n "$MODELS_PRESET" ] && echo "  6. tractus models download --preset $MODELS_PRESET   모델 받기"
  return 0
}

preflight
plan

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo
  if [ "$FAILS" -gt 0 ]; then
    echo "${R}막히는 항목이 ${FAILS}개 있습니다.${N} 위 ✗ 항목을 해결한 뒤 다시 실행하세요."; exit 1
  fi
  echo "${G}설치할 수 있습니다.${N} (경고 ${WARNS}개) --check 없이 다시 실행하면 설치합니다."
  exit 0
fi

if [ "$FAILS" -gt 0 ]; then
  echo; echo "${R}막히는 항목이 ${FAILS}개 있어 설치를 멈춥니다.${N} 위 ✗ 항목을 해결한 뒤 다시 실행하세요." >&2
  exit 1
fi

step "1/4 코어 설치 (uv sync)"
(cd "$REPO" && uv sync)

step "2/4 녹음 프로그램 빌드 (swift)"
(cd "$REPO/recorder" && swift build -c release)
if [ "$WITH_FLUID" -eq 1 ]; then
  echo "9명 이상 구분 헬퍼 빌드 (FluidAudio를 받아 처음에는 2~3분 걸립니다)"
  (cd "$REPO/recorder/diar" && swift build -c release) \
    || warn "tractus-diar 빌드에 실패했습니다. 8명까지 구분하는 기본 기능에는 영향이 없습니다. 나중에 cd recorder/diar && swift build -c release 로 다시 시도하세요"
fi

step "3/4 앱 의존성 설치 (pnpm)"
(cd "$REPO/app" && pnpm install --frozen-lockfile)

step "4/4 앱 빌드 (처음에는 Rust 컴파일로 10~20분 걸립니다)"
(cd "$REPO/app" && pnpm tauri build --bundles app)
[ -d "$APP_BUNDLE" ] || { echo "${R}앱을 찾을 수 없습니다: $APP_BUNDLE${N}" >&2; exit 1; }

if [ "$COPY_APP" -eq 1 ]; then
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/Tractus.app"
  ditto "$APP_BUNDLE" "$HOME/Applications/Tractus.app"
  rm -rf "$APP_BUNDLE"   # 빌드 사본을 남기면 Spotlight에 Tractus가 둘 뜬다
  ok "복사했습니다: ~/Applications/Tractus.app"
fi

if [ -n "$MODELS_PRESET" ]; then
  step "모델 받기 ($MODELS_PRESET)"
  if (cd "$REPO" && uv run tractus models --help >/dev/null 2>&1); then
    (cd "$REPO" && uv run tractus models download --preset "$MODELS_PRESET") \
      || warn "모델을 다 받지 못했습니다. 같은 명령을 다시 실행하면 이어 받습니다: uv run tractus models download --preset $MODELS_PRESET"
  else
    warn "이 버전의 tractus에는 models 명령이 없어 건너뜁니다. 앱 왼쪽 아래 ‘모델’에서 받으세요"
  fi
fi

# 설치 점검 (읽기만 한다): tractus doctor 요약과, 앱 설정에 직접 지정해 둔 경로가 방금 만든 것과 맞는지 본다
# (TRACTUS_APP_SETTINGS는 시험용으로 settings.json 위치를 바꾼다)
saved_paths_check() {
  local f="${TRACTUS_APP_SETTINGS:-$HOME/Library/Application Support/dev.tractus.app/settings.json}" out key why val
  [ -f "$f" ] || return 0
  out="$("$REPO/.venv/bin/python" - "$f" "$REPO/.venv/bin/tractus" "$REPO/recorder/.build/release/tractus-rec" <<'PY' || true
import json, os, sys

f, *built = sys.argv[1:]
try:
    saved = json.load(open(f, encoding="utf-8"))
except (OSError, ValueError):
    sys.exit(0)
for key, now in zip(("tractus_bin", "rec_bin"), built):
    val = saved.get(key) or ""
    path = os.path.expanduser(val)
    if val and not os.path.exists(path):
        print(key, "없는 파일입니다", val, sep="\t")
    elif val and os.path.realpath(path) != os.path.realpath(now):
        print(key, "방금 만든 것과 다릅니다", val, sep="\t")
PY
)"
  while IFS=$'\t' read -r key why val; do
    [ -n "$key" ] || continue
    warn "앱 설정에 저장된 $key 경로가 $why: $val  → 설정에서 경로를 '자동'으로 되돌리세요"
  done <<<"$out"
}

step "설치 점검"
doctor_out=$("$REPO/.venv/bin/tractus" doctor 2>&1) || warn "tractus doctor를 실행하지 못했습니다"  # 파이프 앞의 종료 코드를 봐야 한다 (sed의 것이 아니라)
printf '%s\n' "$doctor_out" | sed 's/^/  /'
saved_paths_check

APP_SHOWN="$APP_BUNDLE"
[ "$COPY_APP" -eq 1 ] && APP_SHOWN="$HOME/Applications/Tractus.app"
step "설치를 마쳤습니다"
cat <<NEXT
  앱:        $APP_SHOWN
  다음 순서:
    1. 앱을 엽니다: open "$APP_SHOWN"
       처음 열 때 "확인되지 않은 개발자" 경고가 나오면 Finder에서 우클릭 > 열기를 고릅니다
    2. 처음 실행하면 나오는 "시작 점검"에서 모델을 받습니다 (왼쪽 아래 ‘모델’에서도 받을 수 있습니다)
    3. 설정 > AI 요약·질문에서 API 키를 넣으면 요약과 질문을 쓸 수 있습니다

  이 저장소 폴더($REPO)를 옮기거나 지우지 마세요.
  앱이 이 폴더 안의 tractus와 tractus-rec 을 실행합니다.
NEXT
[ "$WARNS" -gt 0 ] && echo && echo "${Y}경고 ${WARNS}개가 있었습니다. 위 ! 항목을 확인하세요.${N}"
exit 0
