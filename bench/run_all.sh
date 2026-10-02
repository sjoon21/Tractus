#!/usr/bin/env bash
# Phase 0 전체 매트릭스. 판정에 직접 쓰는 실험부터 돌린다.
# 실패한 실행은 건너뛰고 계속 진행한다. 로그: results/run_all.log
# Whisper·Nemotron이 필요하므로 먼저 `./setup.sh --phase0`을 실행한다.
set -u
cd "$(dirname "$0")"
PY=.venv/bin/python
MODELS="qwen3-1.7b qwen3-0.6b whisper-turbo nemotron-0.6b"

run() { echo "=== $(date '+%H:%M:%S') $*"; $PY run.py "$@" 2>&1 | grep -v -i warn || echo "FAILED: $*"; }

# E1 + E2: 기본 비교 (언어 고정). aihub 4개 세션(66–90분)이 장시간 완주 테스트를 겸한다.
for d in hike aihub fleurs ami; do
  for m in $MODELS; do run "$m" "$d" --lang fixed; done
done

# E1 언어 자동 감지: 트랙 후보(Qwen3-ASR)만. Phase 1 기본값을 정하는 용도.
for d in hike aihub; do
  for m in qwen3-1.7b qwen3-0.6b; do run "$m" "$d" --lang auto; done
done

# E3 용어집: AI Hub 세션별 영문 용어(hangeulToEnglish)를 용어집으로 사용
for m in qwen3-1.7b whisper-turbo; do run "$m" aihub --glossary; done

# E4 청크 길이
for c in 15 60; do run qwen3-1.7b aihub --chunk "$c"; done

echo "=== $(date '+%H:%M:%S') done"
