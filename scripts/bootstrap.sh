#!/usr/bin/env bash
# Tractus 개발 도구 준비: Xcode 명령줄 도구 확인 → Homebrew 확인 → Brewfile의 빠진 도구 설치 → install.sh --check.
# sudo를 쓰지 않고, 인터넷의 스크립트를 내려받아 실행하지 않습니다. 여러 번 실행해도 안전합니다.
# 사용법은 --help, 안내서는 docs/setup.md.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BREWFILE="$REPO/Brewfile"

CHECK_ONLY=0
ASSUME_YES=0
WITH_INSTALL=0

MIN_MACOS="14.4"
MIN_NODE="22.12"   # scripts/install.sh 와 같은 값

usage() {
  cat <<'USAGE'
사용법: scripts/bootstrap.sh [옵션]

  --check          아무것도 설치하지 않고 상태만 보여 줍니다
  --yes            설치 전 확인을 묻지 않습니다
  --with-install   준비가 끝나면 이어서 scripts/install.sh 를 실행합니다
  -h, --help       이 도움말

끝나는 코드: 0 준비됨, 1 막힌 항목이 있음(Xcode 도구, Homebrew 등), 2 옵션 오류
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --yes) ASSUME_YES=1 ;;
    --with-install) WITH_INSTALL=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "알 수 없는 옵션: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
if [ "$CHECK_ONLY" -eq 1 ] && [ "$WITH_INSTALL" -eq 1 ]; then
  echo "--check 는 아무것도 하지 않으므로 --with-install 과 같이 쓸 수 없습니다" >&2; exit 2
fi

if [ -t 1 ]; then G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; B=$'\033[1m'; N=$'\033[0m'; else G=""; Y=""; R=""; B=""; N=""; fi
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$1"; }
fail() { printf '  %s✗%s %s\n' "$R" "$N" "$1"; }
step() { printf '\n%s== %s%s\n' "$B" "$1" "$N"; }

# 버전 a >= b (점으로 나뉜 숫자). 앞의 두 자리만 비교한다.
ver_ge() {
  local a1 a2 b1 b2
  IFS=. read -r a1 a2 _ <<<"$1"; IFS=. read -r b1 b2 _ <<<"$2"
  a2=${a2:-0}; b2=${b2:-0}
  [ "$a1" -gt "$b1" ] || { [ "$a1" -eq "$b1" ] && [ "$a2" -ge "$b2" ]; }
}

# ── 1. 이 Mac이 지원 대상인가 ─────────────────────────────
step "1/4 시스템 확인"
if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  fail "Apple Silicon(arm64) Mac이 필요합니다 (현재: $(uname -s) $(uname -m))"; exit 1
fi
ok "Apple Silicon Mac"
MACOS="$(sw_vers -productVersion 2>/dev/null || echo 0)"
if ! ver_ge "$MACOS" "$MIN_MACOS"; then
  fail "macOS $MIN_MACOS 이상이 필요합니다 (현재: $MACOS)"; exit 1
fi
ok "macOS $MACOS"

# ── 2. Xcode 명령줄 도구 ─────────────────────────────────
if ! xcode-select -p >/dev/null 2>&1; then
  fail "Xcode 명령줄 도구가 없습니다"
  cat <<'MSG'

  터미널에서 아래 명령을 실행하세요.

      xcode-select --install

  설치 창이 뜨면 '설치'를 누르고 끝날 때까지 기다린 뒤(수 분), 이 스크립트를 다시 실행하세요.
  (Xcode 앱 전체를 설치해도 됩니다. 이 스크립트는 기다리지 않고 여기서 멈춥니다.)
MSG
  exit 1
fi
ok "Xcode 명령줄 도구 ($(xcode-select -p))"

# ── 3. Homebrew ──────────────────────────────────────────
step "2/4 Homebrew 확인"
BREW="$(command -v brew || true)"
[ -n "$BREW" ] || { [ -x /opt/homebrew/bin/brew ] && BREW=/opt/homebrew/bin/brew; } || true
if [ -z "$BREW" ]; then
  fail "Homebrew가 없습니다"
  cat <<'MSG'

  Homebrew는 이 스크립트가 대신 설치하지 않습니다. https://brew.sh 의 공식 명령을 직접 실행하세요.

      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

  설치가 끝나면 마지막에 나오는 'Next steps'(PATH 설정 두 줄)를 따라 한 뒤
  터미널을 새로 열고 이 스크립트를 다시 실행하세요.
MSG
  exit 1
fi
# 이 스크립트와 자식 프로세스(install.sh)가 brew로 설치한 도구를 바로 쓰게 한다. 호출한 터미널의 PATH는 바뀌지 않는다.
# 사용자 PATH를 앞에 둔다(nvm·rustup이 brew보다 먼저 잡히므로 낮은 버전 오탐을 막는다).
USER_PATH="$PATH"
BREW_ON_PATH=0; command -v brew >/dev/null 2>&1 && BREW_ON_PATH=1
eval "$("$BREW" shellenv)"
PATH="$USER_PATH:$PATH"
ok "Homebrew $("$BREW" --version | head -1 | awk '{print $2}') ($BREW)"

# ── 4. 빠진 도구 찾기 ────────────────────────────────────
# Brewfile의 formula 이름 → PATH에서 찾을 명령. 이미 PATH에 있으면(rustup, nvm 등) 중복 설치하지 않는다.
tool_cmd() { case "$1" in rust) echo cargo ;; *) echo "$1" ;; esac; }
tool_ok() {
  command -v "$(tool_cmd "$1")" >/dev/null 2>&1 || return 1
  [ "$1" = node ] || return 0
  ver_ge "$(node -v | sed 's/^v//')" "$MIN_NODE"
}
tool_version() {
  case "$1" in
    rust) cargo --version | awk '{print $2}' ;;
    node) node -v | sed 's/^v//' ;;
    *) "$1" --version 2>/dev/null | head -1 | grep -oE '[0-9]+(\.[0-9]+)+' | head -1 ;;
  esac
}

step "3/4 도구 확인 (Brewfile)"
[ -f "$BREWFILE" ] || { fail "Brewfile을 찾을 수 없습니다: $BREWFILE"; exit 1; }
WANTED=()
while IFS= read -r line; do
  case "$line" in 'brew "'*) line="${line#brew \"}"; WANTED+=("${line%%\"*}") ;; esac
done <"$BREWFILE"

MISSING=()
for t in "${WANTED[@]}"; do
  if tool_ok "$t"; then ok "$t $(tool_version "$t")"
  elif [ "$t" = node ] && command -v node >/dev/null 2>&1; then
    fail "node $(tool_version node): $MIN_NODE 이상이 필요합니다. brew로 최신 버전을 설치합니다"; MISSING+=("$t")
  else fail "$t 없음"; MISSING+=("$t"); fi
done

if [ "${#MISSING[@]}" -eq 0 ]; then
  ok "빠진 도구가 없습니다"
elif [ "$CHECK_ONLY" -eq 1 ]; then
  echo
  echo "  brew bundle check 결과 (PATH에 이미 있는 도구도 brew 기준으로는 빠진 것으로 나옵니다):"
  HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ENV_HINTS=1 "$BREW" bundle check --file "$BREWFILE" --verbose 2>&1 | sed 's/^/    /' || true
  echo
  echo "${R}빠진 도구가 ${#MISSING[@]}개 있습니다: ${MISSING[*]}${N}"
  echo "--check 없이 scripts/bootstrap.sh 를 실행하면 설치합니다."
  exit 1
else
  # 빠진 것만 담은 임시 Brewfile로 설치한다(Brewfile 전체를 설치·업그레이드하지 않는다).
  TMP_BREWFILE="$(mktemp "${TMPDIR:-/tmp}/tractus-brewfile.XXXXXX")"
  trap 'rm -f "$TMP_BREWFILE"' EXIT
  for t in "${MISSING[@]}"; do printf 'brew "%s"\n' "$t" >>"$TMP_BREWFILE"; done
  echo
  echo "  설치할 도구: ${MISSING[*]}  (brew bundle, sudo 없음. rust와 ffmpeg는 몇 분 걸릴 수 있습니다)"
  if [ "$ASSUME_YES" -ne 1 ]; then
    if [ ! -t 0 ]; then
      echo "${R}확인을 물을 수 없는 환경입니다.${N} 설치하려면 --yes 를 붙여 다시 실행하세요." >&2; exit 1
    fi
    read -r -p "  설치할까요? [y/N] " answer
    case "$answer" in y|Y|yes|YES) ;; *) echo "  설치하지 않고 멈춥니다."; exit 1 ;; esac
  fi
  if ! "$BREW" bundle --file "$TMP_BREWFILE"; then
    echo; echo "${R}일부 설치에 실패했습니다.${N} 같은 명령을 다시 실행하면 빠진 것만 설치합니다." >&2
    exit 1
  fi

  step "설치 결과 확인"
  STILL=()
  for t in "${MISSING[@]}"; do
    if tool_ok "$t"; then ok "$t $(tool_version "$t")"; else fail "$t: 설치했지만 요구 사항을 채우지 못했습니다"; STILL+=("$t"); fi
  done
  if [ "${#STILL[@]}" -gt 0 ]; then
    echo "  PATH에서 이전 버전이 먼저 잡혔을 수 있습니다: which -a $(tool_cmd "${STILL[0]}")"
    exit 1
  fi
fi

# ── 5. install.sh 사전 점검 ──────────────────────────────
step "4/4 설치 사전 점검 (scripts/install.sh --check)"
if "$REPO/scripts/install.sh" --check; then
  RESULT=0
else
  RESULT=1
fi
[ "$RESULT" -eq 0 ] || { echo; echo "${R}위 ✗ 항목을 해결한 뒤 다시 실행하세요.${N}"; exit 1; }

if [ "$WITH_INSTALL" -eq 1 ]; then
  step "scripts/install.sh 실행"
  rm -f "${TMP_BREWFILE:-}"
  exec "$REPO/scripts/install.sh"
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo; echo "${G}도구가 모두 준비돼 있습니다.${N}"; exit 0
fi
step "다음 순서"
cat <<'NEXT'
  scripts/install.sh                                코어·녹음 프로그램·앱 빌드 (처음에는 15~30분)
  scripts/install.sh --models standard --copy-app   모델까지 받고 ~/Applications 에 복사

  터미널을 새로 열 필요는 없습니다. 다만 Xcode 명령줄 도구나 Homebrew를 이번에 처음 설치했다면
  터미널을 새로 연 뒤 실행하세요.
NEXT
# brew가 PATH에 없어 대체 경로로 찾았다면, 이 터미널에는 brew로 설치한 도구가 보이지 않는다.
if [ "$BREW_ON_PATH" -eq 0 ]; then
  echo
  echo "  이 터미널에서 바로 install.sh를 쓰려면 먼저 실행하세요:  eval \"\$($BREW shellenv)\""
fi
