import json
import random
import sys
from pathlib import Path

import numpy as np
import pytest

from tractus import diarize
from tractus.diarize import FLUID_DIR, MAX_CHUNK_S, MIN_PIECE_S, SR, FluidDiarizer, load_diarizer, load_fluid, smooth, split_chunks

STRIDE = 0.01  # Nemotron 3 Diarization 프레임 간격 (hop 160 / 16 kHz)


def probs(*runs, k=8):
    """runs: (프레임 수, 채널 또는 None=무음) → [T, k] 확률."""
    rows = []
    for n, ch in runs:
        r = np.full((n, k), 0.05, np.float32)
        if ch is not None:
            r[:, ch] = 0.9
        rows.append(r)
    return np.concatenate(rows)


def test_smooth_labels_by_first_appearance():
    assert smooth(probs((300, 3), (300, 0)), STRIDE) == [(0.0, 3.0, "S1"), (3.0, 6.0, "S2")]


def test_smooth_removes_flicker_and_short_turns():
    flicker = probs((300, 0), (4, 1), (300, 0))  # 40ms 깜빡임은 다수결 필터가 지운다
    assert smooth(flicker, STRIDE) == [(0.0, 6.04, "S1")]
    short = probs((300, 0), (50, 1), (300, 0))  # 0.5초 turn은 버리고 같은 화자 양쪽을 잇는다
    assert smooth(short, STRIDE) == [(0.0, 6.5, "S1")]


def test_smooth_fills_short_gaps_only():
    assert smooth(probs((300, 0), (50, None), (300, 0)), STRIDE) == [(0.0, 6.5, "S1")]
    assert smooth(probs((300, 0), (200, None), (300, 0)), STRIDE) == [(0.0, 3.0, "S1"), (5.0, 8.0, "S1")]


def test_smooth_below_threshold_or_empty_gives_no_turns():
    assert smooth(probs((500, None)), STRIDE) == []
    assert smooth(np.zeros((0, 8), np.float32), STRIDE) == []


def test_smooth_max_speakers_reassigns_least_talkative_to_nearest_kept():
    p = probs((400, 0), (200, 2), (400, 1))
    p[400:600, 1] = 0.3  # 버려지는 화자(2) 구간에서 남는 화자 중 1이 더 가깝다
    assert [t[2] for t in smooth(p, STRIDE)] == ["S1", "S2", "S3"]
    assert smooth(p, STRIDE, max_speakers=2) == [(0.0, 4.0, "S1"), (4.0, 10.0, "S2")]


def test_split_without_turns_keeps_chunks_with_null_speaker():
    chunks = [(0, 5 * SR), (6 * SR, 9 * SR)]
    assert split_chunks(chunks, []) == [(0, 5 * SR, None), (6 * SR, 9 * SR, None)]


def test_split_cuts_at_speaker_change_midpoint():
    chunks = [(0, 20 * SR)]
    turns = [(0.0, 8.0, "S1"), (9.0, 20.0, "S2")]
    assert split_chunks(chunks, turns) == [(0, int(8.5 * SR), "S1"), (int(8.5 * SR), 20 * SR, "S2")]


def test_split_merges_short_pieces_into_neighbor():
    chunks = [(0, 10 * SR)]
    assert split_chunks(chunks, [(0.0, 0.5, "S1"), (0.5, 10.0, "S2")]) == [(0, 10 * SR, "S2")]  # 앞 조각이 짧음
    assert split_chunks(chunks, [(0.0, 9.6, "S1"), (9.6, 12.0, "S2")]) == [(0, 10 * SR, "S1")]  # 뒤 조각이 짧음
    assert split_chunks([(0, SR // 2)], [(0.0, 3.0, "S1")]) == [(0, SR // 2, "S1")]  # 청크 자체가 짧으면 그대로


def test_split_chunk_outside_any_turn_is_unknown():
    assert split_chunks([(0, 2 * SR), (30 * SR, 32 * SR)], [(0.0, 3.0, "S1")]) == [(0, 2 * SR, "S1"), (30 * SR, 32 * SR, None)]


def test_split_properties_on_random_inputs():
    rng = random.Random(7)
    for _ in range(300):
        chunks, t = [], 0
        for _ in range(rng.randint(1, 8)):
            t += rng.randint(1, 3 * SR)  # 청크 사이에는 무음이 있다
            n = rng.randint(SR // 4, int(MAX_CHUNK_S * SR))
            chunks.append((t, t + n))
            t += n
        turns, x = [], 0.0
        while x < t / SR:
            d = rng.uniform(1.0, 15.0)
            turns.append((round(x, 2), round(x + d, 2), f"S{rng.randint(1, 3)}"))
            x += d + rng.choice([0.0, 0.0, rng.uniform(0, 2)])
        out = split_chunks(chunks, turns)
        # 길이·범위 보존: 원래 청크마다 조각들이 빈틈없이 이어진다
        i = 0
        for s, e in chunks:
            pos = s
            while i < len(out) and out[i][0] < e:
                assert out[i][0] == pos and out[i][1] > out[i][0]
                pos = out[i][1]
                i += 1
            assert pos == e
        assert i == len(out)
        assert all(e - s <= MAX_CHUNK_S * SR for s, e, _ in out)
        # 1초 미만 조각은 청크 자체가 1초 미만일 때만
        short_chunks = {(s, e) for s, e in chunks if e - s < MIN_PIECE_S * SR}
        assert all(e - s >= MIN_PIECE_S * SR or (s, e) in short_chunks for s, e, _ in out)
        # 조각마다 화자 하나, 같은 청크 안의 이웃 조각은 화자가 다르다
        assert all(isinstance(spk, str) or spk is None for _, _, spk in out)
        assert all(a[2] != b[2] for a, b in zip(out, out[1:]) if a[1] == b[0])


def test_load_diarizer_returns_none_without_model(tmp_path):
    assert load_diarizer(tmp_path) is None


# ── FluidAudio 헬퍼 (tractus-diar) — 가짜 바이너리로 ─────────────────────


FLUID_OK = [
    {"event": "progress", "done": 1, "total": 2},
    {"event": "result", "turns": [[5.0, 9.0, "S1"], [0.0, 4.6, "S3"], [4.6, 5.0, "S2"], [9.5, 12.0, "S1"]],
     "speakers": 3, "engine": "fluid", "model": "FluidInference/speaker-diarization-coreml@abc123"},
]


def fake_bin(tmp_path, events=(), code=0, sleep=0.0, stderr="", raw=""):
    """argv와 받은 WAV 형식을 tmp_path/seen.json에 적고, events를 JSON Lines로 출력하는 가짜 tractus-diar."""
    p = tmp_path / "tractus-diar"
    out = raw + "".join(json.dumps(e) + "\n" for e in events)
    p.write_text(
        f"#!{sys.executable}\n"
        "import json, sys, time, wave\n"
        "a = sys.argv[1:]\n"
        "w = wave.open(a[a.index('--audio') + 1])\n"
        f"json.dump({{'argv': a, 'wav': [w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()]}}, open({str(tmp_path / 'seen.json')!r}, 'w'))\n"
        f"time.sleep({sleep})\n"
        f"sys.stdout.write({out!r}); sys.stderr.write({stderr!r})\n"
        f"sys.exit({code})\n"
    )
    p.chmod(0o755)
    return p


def fluid_models(tmp_path):
    d = tmp_path / "models" / FLUID_DIR
    for f in diarize.FLUID_FILES:
        (d / f).mkdir(parents=True)
    return d


def test_fluid_parses_result_tidies_turns_and_relabels(tmp_path):
    binary, models = fake_bin(tmp_path, FLUID_OK), fluid_models(tmp_path)
    pcm = np.zeros(13 * SR, np.float32)
    turns = FluidDiarizer(binary, models).diarize(pcm, max_speakers=12)
    # 0.4초 turn은 버리고, 같은 화자 사이 0.5초 무음은 메운다. 라벨은 처음 말한 순서대로 다시 붙인다
    assert turns == [(0.0, 4.6, "S1"), (5.0, 12.0, "S2")]
    seen = json.loads((tmp_path / "seen.json").read_text())
    a = seen["argv"]
    assert a[0] == "run" and a[a.index("--models") + 1] == str(models) and a[a.index("--max-speakers") + 1] == "12"
    assert seen["wav"] == [SR, 1, 2, 13 * SR]
    assert not Path(a[a.index("--audio") + 1]).exists()  # 임시 WAV는 지운다


def test_fluid_info_names_engine_model_and_revision(tmp_path):
    d = FluidDiarizer(fake_bin(tmp_path, FLUID_OK), fluid_models(tmp_path))
    d.diarize(np.zeros(SR, np.float32))
    assert d.info["engine"] == "fluid"
    assert (d.info["model"], d.info["revision"]) == ("FluidInference/speaker-diarization-coreml", "abc123")
    assert d.info["params"]["max_speakers"] is None and d.info["params"]["min_turn_s"] == diarize.MIN_TURN_S
    assert "--max-speakers" not in json.loads((tmp_path / "seen.json").read_text())["argv"]


def test_fluid_error_event_raises_with_message(tmp_path):
    binary = fake_bin(tmp_path, [{"event": "error", "message": "모델이 없습니다"}], code=2)
    with pytest.raises(RuntimeError, match="모델이 없습니다"):
        FluidDiarizer(binary, fluid_models(tmp_path)).diarize(np.zeros(SR, np.float32))


def test_fluid_crash_without_json_reports_stderr(tmp_path):
    binary = fake_bin(tmp_path, code=1, stderr="Fatal error: boom", raw="not json\n")
    with pytest.raises(RuntimeError, match="boom"):
        FluidDiarizer(binary, fluid_models(tmp_path)).diarize(np.zeros(SR, np.float32))
    # 종료 코드가 0이어도 result가 없으면 실패다
    with pytest.raises(RuntimeError):
        FluidDiarizer(fake_bin(tmp_path, FLUID_OK[:1]), tmp_path / "models" / FLUID_DIR).diarize(np.zeros(SR, np.float32))


def test_fluid_malformed_turns_raise(tmp_path):
    bad = [{"event": "result", "turns": [[0.0, "x", "S1"]], "speakers": 1}]
    with pytest.raises(RuntimeError, match="형식"):
        FluidDiarizer(fake_bin(tmp_path, bad), fluid_models(tmp_path)).diarize(np.zeros(SR, np.float32))


def test_fluid_timeout_scales_with_duration(tmp_path, monkeypatch):
    monkeypatch.setattr(diarize, "FLUID_TIMEOUT_BASE_S", 0.3)
    monkeypatch.setattr(diarize, "FLUID_TIMEOUT_RTF", 0.0)
    with pytest.raises(RuntimeError, match="시간 초과"):
        FluidDiarizer(fake_bin(tmp_path, FLUID_OK, sleep=5), fluid_models(tmp_path)).diarize(np.zeros(SR, np.float32))
    assert diarize.fluid_timeout(3600) == pytest.approx(0.3)
    monkeypatch.setattr(diarize, "FLUID_TIMEOUT_RTF", 0.2)
    assert diarize.fluid_timeout(3600) == pytest.approx(0.3 + 720)


def test_load_fluid_needs_binary_and_models(tmp_path, monkeypatch):
    monkeypatch.setenv("TRACTUS_DIAR_BIN", str(tmp_path / "nope"))
    fluid_models(tmp_path)
    assert load_fluid(tmp_path / "models") is None  # 바이너리 없음
    binary = fake_bin(tmp_path, FLUID_OK)
    monkeypatch.setenv("TRACTUS_DIAR_BIN", str(binary))
    d = load_fluid(tmp_path / "models")
    assert isinstance(d, FluidDiarizer) and d.binary == binary
    assert load_fluid(tmp_path / "other-models") is None  # 모델 없음
    assert "download" in diarize.fluid_hint(tmp_path / "other-models")


def test_fluid_bin_defaults_to_recorder_release_build(monkeypatch):
    monkeypatch.setenv("TRACTUS_DIAR_BIN", "")
    assert diarize.fluid_bin() == diarize.REPO_ROOT / "recorder/.build/release/tractus-diar"


REAL_BIN = diarize.REPO_ROOT / "recorder/.build/release/tractus-diar"


@pytest.mark.skipif(not REAL_BIN.exists(), reason="recorder/에서 swift build -c release 필요")
def test_real_helper_contract_on_broken_models(tmp_path):
    """실제 헬퍼와의 계약 (모델 불필요): 인수를 받아들이고, 모델이 깨졌으면 받지 않고(offline) error 이벤트 + 종료 코드 1."""
    models = fluid_models(tmp_path)
    before = sorted(p.relative_to(models) for p in models.rglob("*"))
    with pytest.raises(RuntimeError, match=r"종료 코드 1\).*download"):
        FluidDiarizer(REAL_BIN, models).diarize(np.zeros(SR, np.float32), max_speakers=12)
    assert sorted(p.relative_to(models) for p in models.rglob("*")) == before  # 아무것도 받지 않았다
