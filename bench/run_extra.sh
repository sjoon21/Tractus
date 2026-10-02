#!/usr/bin/env bash
# 추가 실험: Nemotron은 언어를 ko-KR로 고정하면 영어 발화를 출력하지 않는다(HiKE 빈 출력 150/1121).
# 공정 비교를 위해 대조군·참고 모델도 언어 자동 감지 조건을 잰다.
set -u
cd "$(dirname "$0")"
PY=.venv/bin/python
run() { echo "=== $(date '+%H:%M:%S') $*"; $PY run.py "$@" 2>&1 | grep -v -i warn || echo "FAILED: $*"; }
for d in hike aihub; do
  for m in nemotron-0.6b whisper-turbo; do run "$m" "$d" --lang auto; done
done
echo "=== $(date '+%H:%M:%S') extra done"
