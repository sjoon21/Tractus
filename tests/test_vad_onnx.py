"""Silero VAD ONNX 어댑터 (docs/design/asr-onnx.md 5·7절). 기본 시험은 onnxruntime 없이 가짜 세션으로 돈다.
실제 그래프: `uv run --with onnxruntime==1.32.0 pytest -m slow tests/test_vad_onnx.py` (models/silero-vad-v6-onnx)."""

import os
import subprocess
import sys
import types
from pathlib import Path

import numpy as np
import pytest

from conftest import NO_MLX, mac_only
from tractus import vad, vad_onnx
from tractus.vad_onnx import CHUNK, CONTEXT, probabilities, timestamps

MS = 16  # 1ms = 16표본


def probs_for(spans: list[tuple[int, int, float]], n: int) -> list[float]:
    """창 번호 [시작, 끝)에 확률 p를 둔 길이 n 확률열 (나머지 0)."""
    out = [0.0] * n
    for a, b, p in spans:
        out[a:b] = [p] * (b - a)
    return out


def test_speech_needs_threshold_and_ends_after_min_silence_with_padding():
    # 창 10–29가 발화(20창 = 640ms), 그 뒤 무음
    got = timestamps(probs_for([(10, 30, 0.9)], 60), 60 * CHUNK)
    assert got == [(10 * CHUNK - 30 * MS, 30 * CHUNK + 30 * MS)]
    assert timestamps(probs_for([(10, 30, 0.49)], 60), 60 * CHUNK) == []  # 0.5 미만은 시작하지 않는다


def test_short_speech_is_dropped_and_short_gaps_are_bridged():
    assert timestamps(probs_for([(10, 17, 0.9)], 60), 60 * CHUNK) == []  # 7창 = 224ms < 250ms
    # 두 발화 사이 3창(96ms) 무음 < 100ms: 하나로 이어진다
    assert timestamps(probs_for([(10, 20, 0.9), (23, 35, 0.9)], 80), 80 * CHUNK) == [(10 * CHUNK - 480, 35 * CHUNK + 480)]
    # 0.35–0.5 사이는 끝내지도 시작하지도 않는다 (neg_threshold)
    assert timestamps(probs_for([(10, 20, 0.9), (20, 40, 0.4)], 80), 80 * CHUNK) == [(10 * CHUNK - 480, 40 * CHUNK + 480)]


def test_speech_until_the_end_is_cut_at_the_audio_length():
    n, audio_len = 30, 30 * CHUNK - 100  # 마지막 창은 0으로 채운 창
    assert timestamps(probs_for([(5, 30, 0.9)], n), audio_len) == [(5 * CHUNK - 480, audio_len)]
    assert timestamps(probs_for([(0, 30, 0.9)], n), audio_len) == [(0, audio_len)]  # 앞 덧붙임도 0에서 자른다


@mac_only(NO_MLX)
def test_timestamps_still_match_the_installed_mlx_audio():
    """mlx-audio를 올려 구간 규칙이 바뀌면 여기서 먼저 깨진다 (모델 없이, 같은 확률열·길이를 두 함수에 넣는다)."""
    from mlx_audio.vad.models.silero_vad.silero_vad import Model

    rng = np.random.default_rng(0)
    blocky = np.repeat(rng.choice([0.0, 0.2, 0.4, 0.6, 0.95], size=120), rng.integers(1, 12, size=120))
    for probs in (rng.random(700), blocky, probs_for([(0, 40, 0.9)], 40), np.zeros(5)):
        probs = np.asarray(probs, np.float32)
        for audio_len in (len(probs) * CHUNK, len(probs) * CHUNK - 300):
            want = Model._probs_to_timestamps(probs, audio_len, 16000, 0.5, 250, 100, 30, False)
            assert timestamps(probs, audio_len) == [(t["start"], t["end"]) for t in want]


class FakeSession:
    """받은 입력 모양·문맥을 기록하고 stateN = state + 1을 돌려준다. 확률은 창의 마지막 표본 값."""

    def __init__(self):
        self.calls = []

    def run(self, names, feeds):
        assert names == ["output", "stateN"]
        x, state, sr = feeds["input"], feeds["state"], feeds["sr"]
        self.calls.append((x.copy(), state.copy()))
        assert x.dtype == np.float32 and state.shape == (2, 1, 128) and sr.dtype == np.int64 and int(sr) == 16000
        return np.array([[x[0, -1]]], np.float32), state + 1


def test_windows_carry_64_samples_of_context_and_the_state():
    audio = np.arange(1, 1201, dtype=np.float32)  # 512의 배수가 아니다: 3창, 마지막 창은 0으로 채운다
    s = FakeSession()
    p = probabilities(audio, s)
    assert [c[0].shape for c in s.calls] == [(1, CONTEXT + CHUNK)] * 3
    first, second, third = (c[0][0] for c in s.calls)
    assert first[:CONTEXT].tolist() == [0.0] * CONTEXT and first[CONTEXT:].tolist() == audio[:512].tolist()
    assert second[:CONTEXT].tolist() == audio[512 - CONTEXT : 512].tolist()  # 앞 창의 마지막 64표본
    assert third[CONTEXT : CONTEXT + 1200 - 1024].tolist() == audio[1024:].tolist() and third[CONTEXT + 176 :].sum() == 0
    assert [float(c[1].max()) for c in s.calls] == [0.0, 1.0, 2.0]  # state를 이어 받는다
    assert p.tolist() == [512.0, 1024.0, 0.0] and p.dtype == np.float32


def test_empty_audio_has_no_windows():
    s = FakeSession()
    assert probabilities(np.zeros(0, np.float32), s).shape == (0,) and s.calls == []


def test_find_chunks_picks_onnx_by_the_marker_file(tmp_path, monkeypatch):
    onnx_dir, mlx_dir = tmp_path / "onnx", tmp_path / "mlx"
    onnx_dir.mkdir()
    mlx_dir.mkdir()
    (onnx_dir / vad_onnx.MARKER).write_bytes(b"")
    monkeypatch.setattr(vad_onnx, "load", lambda d: "session")
    monkeypatch.setattr(vad_onnx, "speech_timestamps", lambda audio, session: [(0, 16000), (20000, 30000)] if session == "session" else None)
    speech = types.SimpleNamespace(get_speech_timestamps=lambda audio, sample_rate: [{"start": 5, "end": 9}])
    monkeypatch.setitem(sys.modules, "mlx_audio.vad.utils", types.SimpleNamespace(load=lambda d: speech))
    assert vad.find_chunks(np.zeros(40000, np.float32), onnx_dir) == [(0, 30000)]  # 30초 묶기는 같다
    assert vad.find_chunks(np.zeros(40000, np.float32), mlx_dir) == [(5, 9)]


# ── 실제 그래프 ──

MODELS = Path(os.environ.get("TRACTUS_MODELS_DIR", Path(__file__).resolve().parent.parent / "models"))


@pytest.mark.slow
def test_real_onnx_vad_is_close_to_the_mlx_vad(tmp_path):
    pytest.importorskip("onnxruntime")
    from mlx_audio.vad.utils import load

    from tractus import audio

    parts = []
    for i, line in enumerate(("안녕하세요. 오늘 회의는 다음 분기 예산 검토입니다.", "네, 인건비는 작년보다 조금 늘었습니다.")):
        wav = tmp_path / f"p{i}.wav"
        subprocess.run(["say", "-v", "Yuna", "-o", str(wav), "--data-format=LEI16@16000", line], check=True)
        parts += [audio.decode(wav), np.zeros(16000, np.float32)]  # 문장 사이 1초 무음
    pcm = np.concatenate(parts)[:-7]  # 512의 배수가 아닌 길이
    mlx = load(str(MODELS / "silero-vad-v6"))
    want = np.array(mlx.predict_proba(pcm, sample_rate=16000))
    session = vad_onnx.load(MODELS / "silero-vad-v6-onnx")
    got = probabilities(pcm, session)
    assert got.shape == want.shape and np.abs(got - want).max() < 1e-4  # 실측 2.6e-6 (가상 음성 12초)
    assert vad_onnx.speech_timestamps(pcm, session) == [(t["start"], t["end"]) for t in mlx.get_speech_timestamps(pcm, sample_rate=16000)]
    assert vad.find_chunks(pcm, MODELS / "silero-vad-v6-onnx") == vad.find_chunks(pcm, MODELS / "silero-vad-v6")
