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


def two_voice_meeting(tmp_path):
    """LINES를 VOICES로 번갈아 읽힌 PCM과 발화별 (시작, 끝) 표본."""
    from tractus.diarize import SR

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
    return pcm, bounds


@pytest.mark.slow
@pytest.mark.parametrize("engine", ["nemotron", "fluid"])
def test_real_diarizer_separates_two_synthetic_voices(tmp_path, engine):
    from tractus.diarize import FLUID_DIR, MODEL_DIR, fluid_hint, load_diarizer, load_fluid, split_chunks

    if engine == "nemotron":
        diarizer = load_diarizer(MODELS)
        assert diarizer is not None, f"{MODELS}/{MODEL_DIR} 필요"
    else:
        diarizer = load_fluid(MODELS)
        if diarizer is None:
            pytest.skip(f"tractus-diar 헬퍼와 {MODELS}/{FLUID_DIR} 필요:\n{fluid_hint(MODELS)}")
    pcm, bounds = two_voice_meeting(tmp_path)
    turns = diarizer.diarize(pcm)
    assert {spk for _, _, spk in turns} == {"S1", "S2"}
    assert diarizer.info["engine"] == engine

    chunks = split_chunks(find_chunks(pcm, MODELS / "silero-vad-v6"), turns)
    assert {c[2] for c in chunks} == {"S1", "S2"}
    for s, e, spk in chunks:  # 청크마다 대부분을 차지하는 음성의 화자가 붙는다 (Yuna=S1, Grandpa=S2)
        overlap = [max(0, min(e, b) - max(s, a)) for a, b in bounds]
        assert spk == ("S1" if overlap.index(max(overlap)) % 2 == 0 else "S2")


@pytest.mark.slow
def test_fluid_helper_killed_mid_run_leaves_no_audio_copy_in_temp(tmp_path):
    """시간 초과(SIGKILL)로 죽어도 회의 오디오 사본이 사용자 임시 폴더에 남지 않는다 (FluidAudio 디스크 소스는 defer로만 지웠다)."""
    from tractus.diarize import FLUID_DIR, _write_wav, fluid_hint, load_fluid

    diarizer = load_fluid(MODELS)
    if diarizer is None:
        pytest.skip(f"tractus-diar 헬퍼와 {MODELS}/{FLUID_DIR} 필요:\n{fluid_hint(MODELS)}")
    pcm, _ = two_voice_meeting(tmp_path)
    wav = tmp_path / "audio.wav"
    _write_wav(wav, pcm)
    # FileManager.temporaryDirectory는 TMPDIR을 무시하고 이 폴더를 쓴다
    temp = Path(subprocess.run(["getconf", "DARWIN_USER_TEMP_DIR"], capture_output=True, text=True, check=True).stdout.strip())
    before = set(temp.glob("fluidaudio-streaming-*"))
    cmd = [str(diarizer.binary), "run", "--audio", str(wav), "--models", str(diarizer.model_dir)]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        progressed = any('"progress"' in line for line in p.stdout)  # 첫 progress 직후 멈춘다
    finally:
        p.kill()
        p.wait()
    leaked = set(temp.glob("fluidaudio-streaming-*")) - before
    for f in leaked:
        f.unlink()
    assert progressed and not leaked


@pytest.mark.slow
def test_real_live_captions_follow_a_growing_recording():
    """bench/live_sim.py로 가상 대화를 녹음처럼(48k, 헤더 0.25초마다 갱신) 2배속으로 쓰면서 `tractus live`를 돌린다."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("live_sim", Path(__file__).resolve().parent.parent / "bench" / "live_sim.py")
    sim_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sim_mod)
    pcm, utts = sim_mod.synth(LINES[:3], (1.0,))
    sim = sim_mod.simulate(pcm, speed=2.0)
    events = [e for _, e in sim["events"]]
    assert sim["exit_code"] == 0 and sim["stop_exit_sec"] < 2.0
    assert [e.get("stage") for e in events[:2]] == ["live_load", "live"] and events[-1]["event"] == "done"
    finals = [e for e in events if e["event"] == "live" and e["kind"] == "final"]
    hyp = " ".join(f["text"] for f in finals)
    assert len(finals) >= 3 and "예산" in hyp and "서버" in hyp
    assert sim_mod.cer(" ".join(u[2] for u in utts), hyp) < 0.35
    assert all(f["speaker"] is None for f in finals)  # 화자는 --speakers일 때만
    assert not [e for e in events if e["event"] == "warning"]


@pytest.mark.slow
def test_real_embedding_8bit_ranks_paraphrase_above_unrelated():
    """8bit 변환본이 올라가고 의미가 맞게 가까운지만 본다 (검색 평가가 아니다: 2026-10-15 소유자가 평가를 면제했다)."""
    from tractus import embed

    path = MODELS / embed.MODEL_DIR
    if not (path / "model.safetensors").exists():
        pytest.skip(f"{path} 없음")
    a, b, c = embed.Embedder(path).embed(["다음 분기 예산안을 금요일까지 제출해야 합니다.", "금요일 전에 다음 분기 예산 계획서를 내야 해요.", "점심 메뉴로 김치찌개와 비빔밥 중에 고민 중입니다."])
    assert a.shape == (1024,) and abs(np.linalg.norm(a) - 1) < 1e-3 and a @ b > a @ c + 0.2
