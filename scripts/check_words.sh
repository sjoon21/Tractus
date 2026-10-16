#!/usr/bin/env bash
# WORDS.md §5 금지어 검사를 그대로 돌린다 (검사 내용의 원본은 WORDS.md 하나다). 출력이 없으면 통과(종료 코드 0), 있으면 1.
# 저장소 루트에서 실행한다. rg(PCRE2)가 필요하다 (Homebrew ripgrep).
set -euo pipefail
cd "$(dirname "$0")/.."
check=$(awk '/^## 5\. 금지어 검사/{f=1} f&&/^```bash/{g=1;next} g&&/^```/{exit} g' WORDS.md)
[ -n "$check" ] || { echo "WORDS.md §5에서 검사를 찾지 못했습니다" >&2; exit 2; }
out=$(bash -c "$check" || true)
if [ -n "$out" ]; then
  echo "$out"
  echo "금지어가 있습니다 (WORDS.md §5). 의도한 예외는 줄 끝에 words-ok와 이유를 적습니다." >&2
  exit 1
fi
