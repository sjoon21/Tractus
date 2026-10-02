#!/usr/bin/env bash
# Phase 0 벤치마크 환경 재현: 의존성, 모델(models/), 데이터셋(data/), HiKE 평가 코드.
# 사용: ./setup.sh (확정 모델만) | ./setup.sh --phase0 (비교 모델 포함, run_all.sh 재현 시)
# AI Hub 데이터는 승인 후 수동으로 받아 data/aihub-meeting/ 아래에 둔다
# (라벨링데이터/…/*.json, 원천데이터/…/*.wav 구조 그대로).
set -euo pipefail
cd "$(dirname "$0")"
ROOT=..
uv sync
HF=.venv/bin/hf

# 확정 모델 (기본·저사양 트랙)
for r in mlx-community/Qwen3-ASR-1.7B-8bit mlx-community/Qwen3-ASR-0.6B-8bit; do
  $HF download "$r" --local-dir "$ROOT/models/$(basename "$r" | tr 'A-Z' 'a-z')"
done

# Phase 0 비교 재현용 (대조군 Whisper, 참고 Nemotron). `./setup.sh --phase0`일 때만 받는다.
if [ "${1:-}" = "--phase0" ]; then
  for r in mlx-community/whisper-large-v3-turbo mlx-community/nemotron-3.5-asr-streaming-0.6b; do
    $HF download "$r" --local-dir "$ROOT/models/$(basename "$r" | tr 'A-Z' 'a-z')"
  done
  # mlx-community Whisper 변환본에는 토크나이저가 없어 원본 리포에서 가져온다
  $HF download openai/whisper-large-v3-turbo added_tokens.json generation_config.json merges.txt \
    preprocessor_config.json special_tokens_map.json tokenizer.json \
    tokenizer_config.json vocab.json --local-dir "$ROOT/models/whisper-large-v3-turbo"
fi

$HF download google/fleurs parquet-data/ko_kr/test-00000-of-00001.parquet --repo-type dataset --local-dir "$ROOT/data/fleurs"
$HF download thetaone-ai/HiKE --repo-type dataset --local-dir "$ROOT/data/hike"
$HF download edinburghcstr/ami --include "ihm/test-*" --repo-type dataset --local-dir "$ROOT/data/ami"

[ -d third_party/HiKE ] || git clone --depth 1 --recurse-submodules --shallow-submodules \
  https://github.com/ThetaOne-AI/HiKE.git third_party/HiKE

.venv/bin/python vad.py aihub 15 30 60
