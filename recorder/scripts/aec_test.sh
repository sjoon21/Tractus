#!/usr/bin/env bash
# 에코 제거 실측: 다른 프로세스(afplay)가 스피커로 튼 소리를 --echo-cancel이 마이크 트랙에서 지우는지 본다.
# 실행 중에는 말하지 말고, 헤드폰을 빼고 스피커 음량을 평소 회의 수준으로 둔다.
#   bash recorder/scripts/aec_test.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REC="$ROOT/recorder/.build/release/tractus-rec"
OUT="$(mktemp -d)"
PHRASE="The quarterly budget review is scheduled for Thursday afternoon in the main conference room."

say -v Samantha -o "$OUT/phrase.aiff" "$PHRASE"
for mode in noaec aec; do
  flag=""; [ "$mode" = aec ] && flag="--echo-cancel"
  echo "[$mode] 녹음 중… (스피커에서 영어 문장이 나옵니다)"
  # stdin을 열어 둔 채로 7초 뒤 stop을 보낸다 (stdin이 닫히면 녹음이 끝난다)
  { sleep 7; echo stop; } | "$REC" record --out "$OUT/$mode" --no-system $flag > "$OUT/$mode.events" 2> "$OUT/$mode.log" &
  sleep 1.5
  afplay "$OUT/phrase.aiff"
  wait
  grep -o '"echo_cancel":[a-z]*' "$OUT/$mode.events" | head -1 || true
done

cd "$ROOT"
TRACTUS_MODELS_DIR="$ROOT/models" .venv/bin/python - "$OUT" "$PHRASE" <<'EOF'
import sys
from pathlib import Path
from tractus import audio
from tractus.asr import Transcriber
out, phrase = Path(sys.argv[1]), sys.argv[2].lower()
asr = Transcriber.load(Path("models/qwen3-asr-0.6b-8bit"))
words = set(w.strip(".,") for w in phrase.split())
for mode in ("noaec", "aec"):
    text = asr.transcribe(audio.decode(out / mode / "mic.wav")).text
    hit = len(words & set(w.strip(".,").lower() for w in text.split())) / len(words)
    print(f"{mode:6} 문장 단어 검출률 {hit:4.0%} | 전사: {text[:120]!r}")
print("판정: aec 검출률이 noaec보다 크게 낮으면 다른 앱 소리도 지워진다 (화상 모드 설계 유효)")
EOF
echo "녹음 파일: $OUT"
