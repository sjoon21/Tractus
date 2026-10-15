#!/usr/bin/env bash
# Tractus 업데이트: 최신 코드를 받아(git pull --ff-only) 바뀐 커밋을 보여 주고, scripts/install.sh 로 다시 설치합니다.
# 여러 번 실행해도 안전합니다. 안내서는 docs/setup.md.
set -euo pipefail

usage() {
  cat <<'USAGE'
사용법: scripts/update.sh [--check] [install.sh 옵션]

  --check     받을 커밋만 보여 줍니다 (git fetch 와 git log 만 실행하고 아무것도 바꾸지 않습니다)
  그 밖의 옵션은 scripts/install.sh 로 그대로 넘깁니다 (예: --with-fluid --models standard --copy-app)

멈추는 경우: 작업 폴더에 고치지 않은 변경이 있을 때(새 파일은 세지 않습니다), 브랜치가 origin 을 따라가지 않을 때,
내 커밋이 있어 빠르게 합칠 수 없을 때. 설치(install.sh)가 끝에 doctor 점검을 보여 줍니다.
USAGE
}

# 스크립트 전체를 함수 안에 둔다: pull 로 이 파일이 바뀌어도 bash 가 이미 다 읽어 둔 것을 실행한다
main() {
  local repo check=0 args=() arg
  repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  for arg in "$@"; do
    case "$arg" in
      --check) check=1 ;;
      -h|--help) usage; return 0 ;;
      *) args+=("$arg") ;;
    esac
  done
  cd "$repo"

  local branch remote upstream old new
  branch="$(git symbolic-ref --short -q HEAD)" || { echo "브랜치가 아닌 상태(detached HEAD)라 업데이트하지 않습니다. 브랜치로 돌아가세요: git switch main" >&2; return 1; }
  remote="$(git config "branch.$branch.remote" || true)"
  upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  if [ "$remote" != "origin" ] || [ -z "$upstream" ]; then
    echo "브랜치 $branch 가 origin 을 따라가지 않습니다. 업데이트하지 않습니다. (git branch -u origin/main 으로 정하세요)" >&2
    return 1
  fi
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "고치지 않은 변경이 있어 업데이트하지 않습니다. 커밋하거나 되돌린 뒤 다시 실행하세요:" >&2
    git status --short --untracked-files=no | head -10 >&2
    return 1
  fi

  git fetch --quiet origin
  old="$(git rev-parse HEAD)"
  new="$(git rev-parse '@{u}')"
  if [ "$old" = "$new" ] || git merge-base --is-ancestor "$new" "$old"; then
    echo "이미 최신입니다 ($(git rev-parse --short HEAD)). 다시 설치하려면 scripts/install.sh"
    return 0
  fi
  git merge-base --is-ancestor "$old" "$new" || {
    echo "내 커밋이 $upstream 과 갈라져 있어 빠르게 합칠 수 없습니다. 직접 정리한 뒤 다시 실행하세요 (git log $upstream..HEAD)" >&2
    return 1
  }

  echo "받을 커밋 $(git rev-list --count "$old..$new")개 ($(git rev-parse --short "$old") → $(git rev-parse --short "$new")):"
  git log --oneline "$old..$new"
  [ "$check" -eq 1 ] && return 0

  git pull --ff-only --quiet
  echo "받았습니다. 설치를 시작합니다: scripts/install.sh ${args[*]:-}"
  "$repo/scripts/install.sh" ${args[@]+"${args[@]}"} || {
    echo "설치 단계가 끝나지 않았습니다. 코드는 이미 최신이니 문제를 고친 뒤 scripts/install.sh ${args[*]:-} 를 다시 실행하세요." >&2
    return 1
  }
}

main "$@"
exit $?
