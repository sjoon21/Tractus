"""실제 모델로 짧은 한국어 음성을 전사한다. `uv run pytest -m slow` (TRACTUS_MODELS_DIR에 모델 필요)."""

import os
import subprocess
from pathlib import Path

import pytest

from tractus import audio
from tractus.asr import Transcriber
from tractus.vad import find_chunks

MODELS = Path(os.environ.get("TRACTUS_MODELS_DIR", Path(__file__).resolve().parent.parent / "models"))


@pytest.mark.slow
def test_real_models_transcribe_korean_speech(tmp_path):
    wav = tmp_path / "say.wav"
    subprocess.run(["say", "-v", "Yuna", "-o", str(wav), "--data-format=LEI16@16000", "안녕하세요. 오늘 회의는 예산 검토입니다."], check=True)
    pcm = audio.decode(wav)
    chunks = find_chunks(pcm, MODELS / "silero-vad-v6")
    assert len(chunks) >= 1
    seg = Transcriber.load(MODELS / "qwen3-asr-0.6b-8bit").transcribe(pcm, hotwords=["예산"])
    assert seg.lang == "ko" and "예산" in seg.text and "회의" in seg.text
