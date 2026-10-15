#!/usr/bin/env bash
# 빌드 산출물 지우기: 크기를 보여 주고, 확인을 받고, 다시 만들 수 있는 것만 지웁니다. 안내서는 docs/setup.md.
# 절대 지우지 않는 것: .venv, models/, data/, 노트(TRACTUS_HOME), 소스. 다음 scripts/install.sh 가 지운 것을 다시 만듭니다.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

# 기본: 컴파일 산출물. --all: 의존성 폴더까지 (다시 받아야 하므로 인터넷이 필요합니다)
TARGETS=(app/src-tauri/target recorder/.build recorder/diar/.build)
ALL_EXTRA=(app/node_modules bench/.venv)
YES=0
FORCE=0

usage() {
  cat <<'USAGE'
사용법: scripts/clean.sh [옵션]

  (없음)    다시 만들 수 있는 빌드 산출물을 지웁니다:
            app/src-tauri/target, recorder/.build, recorder/diar/.build
  --all     위에 더해 app/node_modules, bench/.venv 도 지웁니다 (다시 받아야 합니다)
  --yes     확인 없이 지웁니다
  --force   이 저장소의 Tractus 앱·녹음 프로그램이 실행 중이어도 지웁니다
  -h, --help

지우지 않는 것: .venv, models/, data/, 노트 폴더, 소스.
지운 뒤에는 scripts/install.sh 를 다시 실행하면 앱과 녹음 프로그램이 다시 만들어집니다.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --all) TARGETS+=("${ALL_EXTRA[@]}") ;;
    --yes|-y) YES=1 ;;
    --force) FORCE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "알 수 없는 옵션: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# 이 저장소의 실행 파일이 돌고 있으면 멈춘다 (앱 번들·개발 빌드·녹음 프로그램은 target/.build 안에서 실행된다)
if [ "$FORCE" -eq 0 ]; then
  for rel in app/src-tauri/target recorder/.build recorder/diar/.build; do
    pat="$(printf '%s' "$REPO/$rel/" | sed 's/[][\.*^$+?(){}|]/\\&/g')"
    if pgrep -f -- "$pat" >/dev/null 2>&1; then
      echo "이 저장소의 Tractus 프로그램이 실행 중입니다 ($rel). 앱을 끝낸 뒤 다시 실행하세요. (실행 중이어도 지우려면 --force)" >&2
      exit 1
    fi
  done
fi

# 지울 것만 추린다. 저장소 밖을 가리키는 링크(심볼릭 링크)는 건드리지 않는다.
FOUND=()
for rel in "${TARGETS[@]}"; do
  path="$REPO/$rel"
  [ -e "$path" ] || [ -L "$path" ] || continue
  if [ -L "$path" ] || [ ! -d "$path" ] || [ "$(cd "$path" && pwd -P)" != "$path" ]; then
    echo "건너뜁니다 (폴더가 아니거나 링크입니다): $rel" >&2
    continue
  fi
  FOUND+=("$rel")
done

if [ "${#FOUND[@]}" -eq 0 ]; then
  echo "지울 빌드 산출물이 없습니다."
  exit 0
fi

echo "지울 폴더 ($REPO):"
TOTAL_KB=0
for rel in "${FOUND[@]}"; do
  kb="$(du -sk "$REPO/$rel" | awk '{print $1}')"
  TOTAL_KB=$((TOTAL_KB + kb))
  printf '  %8s  %s\n' "$(du -sh "$REPO/$rel" | awk '{print $1}')" "$rel"
done
echo "남기는 것: .venv, models/, data/, 노트, 소스"

if [ "$YES" -eq 0 ]; then
  [ -t 0 ] || { echo "확인할 수 없습니다 (터미널이 아닙니다). 지우려면 --yes 를 붙이세요." >&2; exit 1; }
  read -r -p "위 폴더를 지울까요? [y/N] " answer
  case "$answer" in y|Y|yes) ;; *) echo "지우지 않았습니다."; exit 1 ;; esac
fi

for rel in "${FOUND[@]}"; do
  rm -rf -- "${REPO:?}/$rel"
  echo "지웠습니다: $rel"
done
echo "약 $(( TOTAL_KB / 1024 )) MB 확보했습니다. 앱을 다시 만들려면 scripts/install.sh"
