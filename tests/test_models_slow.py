"""실제 모델로 짧은 한국어 음성을 전사한다. `uv run pytest -m slow` (TRACTUS_MODELS_DIR에 모델 필요)."""

import os
import subprocess
from pathlib import Path

import numpy as np
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


# macOS say 한국어 음성 중 엔진이 다른 둘. 그냥 "Eddy"처럼 쓰면 영어 음성이 골라져 한국어가 거의 빈 오디오가 된다.
VOICES = ("Yuna", "Grandpa (한국어(한국))")
LINES = (
    "안녕하세요. 오늘 회의는 다음 분기 예산 검토입니다. 먼저 인건비부터 보겠습니다.",
    "네, 인건비는 작년보다 오 퍼센트 늘었습니다. 신규 채용 두 명이 반영됐습니다.",
    "좋습니다. 그러면 장비 구매 비용은 어떻게 되나요? 서버 교체 일정도 알려 주세요.",
    "서버는 십일월에 교체합니다. 장비 비용은 지난 분기와 거의 같습니다.",
)


@pytest.mark.slow
def test_real_diarizer_separates_two_synthetic_voices(tmp_path):
    from tractus.diarize import SR, load_diarizer, split_chunks

    parts = []
    for i, line in enumerate(LINES):
        p = tmp_path / f"p{i}.wav"
        subprocess.run(["say", "-v", VOICES[i % 2], "-o", str(p), "--data-format=LEI16@16000", line], check=True)
        parts.append(audio.decode(p))
    gap = np.zeros(SR // 2, np.float32)  # 화자 사이 0.5초 무음
    pcm = np.concatenate([x for p in parts for x in (p, gap)])
    bounds, t = [], 0
    for p in parts:
        bounds.append((t, t + len(p)))
        t += len(p) + len(gap)

    diarizer = load_diarizer(MODELS)
    assert diarizer is not None, f"{MODELS}/nemotron-3-diarization 필요"
    turns = diarizer.diarize(pcm)
    assert {spk for _, _, spk in turns} == {"S1", "S2"}

    chunks = split_chunks(find_chunks(pcm, MODELS / "silero-vad-v6"), turns)
    assert {c[2] for c in chunks} == {"S1", "S2"}
    for s, e, spk in chunks:  # 청크마다 대부분을 차지하는 음성의 화자가 붙는다 (Yuna=S1, Grandpa=S2)
        overlap = [max(0, min(e, b) - max(s, a)) for a, b in bounds]
        assert spk == ("S1" if overlap.index(max(overlap)) % 2 == 0 else "S2")
