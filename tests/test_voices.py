"""목소리 프로필(voices.py)과 화자 제안(suggested) 의미. 임베딩 모델 없이 가짜 임베더로 확인한다."""

import json
import math
import os
import stat
import subprocess
from pathlib import Path

import numpy as np
import pytest

from tractus import store, voices
from tractus.store import Job, apply_speaker_edit, apply_suggestions, render_markdown, render_vtt, write_transcript

SR = 16000
DIM = 8


def unit(**cos) -> np.ndarray:
    """축 a0..a6에 주어진 코사인을 갖는 단위 벡터. 나머지는 마지막 축(a7)이 채운다."""
    v = np.zeros(DIM)
    for k, c in cos.items():
        v[int(k[1:])] = c
    v[DIM - 1] = math.sqrt(max(0.0, 1 - float(np.sum(v**2))))
    return v.astype(np.float32)


def person(pid: str, name: str, *vecs) -> dict:
    return {"id": pid, "name": name, "created_at": "2026-10-07T10:00:00+09:00", "consent": True,
            "samples": [{"embedding": [float(x) for x in v], "meeting_id": "m", "added_at": "2026-10-07T10:00:00+09:00"} for v in vecs]}


class FakeEmbedder:
    """화자 구간을 상수 k로 채운 신호 → 축 k 단위 벡터."""

    def __init__(self):
        self.calls: list[int] = []

    def embed(self, pcm):
        self.calls.append(len(pcm))
        v = np.zeros(DIM, np.float32)
        v[int(round(float(np.mean(pcm))))] = 1.0
        return v


# ── 구간 고르기·임베딩 ──────────────────────────────────────────────


def seg(start, end, speaker):
    return {"start": start, "end": end, "speaker": speaker}


def test_clips_take_longest_three_between_bounds():
    segs = [seg(0, 1.0, "S1"), seg(2, 3.5, "S1"), seg(4, 16, "S1"), seg(20, 23, "S1"), seg(30, 35, "S1"), seg(40, 60, "S2")]
    assert voices.clips(segs, "S1") == [(4, 14.0), (30, 35), (20, 23)]  # 12초 → 앞 10초, 1초는 버림, 1.5초는 4번째라 빠짐
    assert voices.clips(segs, "S3") == []


def test_speaker_embedding_is_normalized_mean_or_none():
    pcm = np.zeros(20 * SR, np.float32)
    pcm[0: 2 * SR] = 1
    pcm[5 * SR: 7 * SR] = 2
    segs = [seg(0, 2, "S1"), seg(5, 7, "S1"), seg(10, 11, "S2")]
    emb = FakeEmbedder()
    v = voices.speaker_embedding(emb, pcm, segs, "S1")
    assert np.allclose(v, unit(a1=1 / math.sqrt(2), a2=1 / math.sqrt(2)), atol=1e-6)
    assert emb.calls == [2 * SR, 2 * SR]
    assert voices.speaker_embedding(emb, pcm, segs, "S2") is None  # 1.5초 미만뿐


# ── 프로필 파일 ─────────────────────────────────────────────────────


def mode(p: Path) -> int:
    return stat.S_IMODE(p.stat().st_mode)


def test_profiles_are_written_0600_atomically_and_stay_0600(tmp_path):
    assert voices.load_profiles(tmp_path) == {"version": 1, "model": voices.MODEL_ID, "people": []}
    data, _ = voices.enroll(voices.load_profiles(tmp_path), "홍길동", unit(a0=1), "m1")
    voices.save_profiles(tmp_path, data)
    path = tmp_path / voices.VOICES_FILE
    assert mode(path) == 0o600 and voices.load_profiles(tmp_path) == data
    os.chmod(path, 0o644)
    voices.save_profiles(tmp_path, data)
    assert mode(path) == 0o600 and not list(tmp_path.glob("*.tmp"))


def test_failed_save_keeps_previous_file(tmp_path, monkeypatch):
    data, _ = voices.enroll(voices.load_profiles(tmp_path), "홍길동", unit(a0=1), "m1")
    voices.save_profiles(tmp_path, data)
    before = (tmp_path / voices.VOICES_FILE).read_text(encoding="utf-8")

    def boom(*a):
        raise OSError("disk full")

    monkeypatch.setattr(voices.os, "replace", boom)
    with pytest.raises(OSError):
        voices.save_profiles(tmp_path, {**data, "people": []})
    assert (tmp_path / voices.VOICES_FILE).read_text(encoding="utf-8") == before


def test_corrupt_profiles_raise_instead_of_being_overwritten(tmp_path):
    (tmp_path / voices.VOICES_FILE).write_text("{not json", encoding="utf-8")
    with pytest.raises(ValueError):
        voices.load_profiles(tmp_path)


def test_enroll_appends_to_same_name_keeps_five_newest_and_is_pure():
    data = voices.load_profiles(Path("/nonexistent"))
    data, p = voices.enroll(data, "홍길동", unit(a0=1), "m0")
    first = json.loads(json.dumps(data))
    data2, p2 = voices.enroll(data, "홍길동", unit(a1=1), "m1")
    assert data == first  # 원본은 그대로
    assert p2["id"] == p["id"] and len(p2["samples"]) == 2
    for i in range(2, 7):
        data2, p2 = voices.enroll(data2, "홍길동", unit(a0=1), f"m{i}")
    assert [s["meeting_id"] for s in p2["samples"]] == ["m2", "m3", "m4", "m5", "m6"]  # 가장 오래된 m0, m1을 버린다
    data3, p3 = voices.enroll(data2, "김영희", unit(a2=1), "m7")
    assert p3["id"] != p["id"] and [x["name"] for x in data3["people"]] == ["홍길동", "김영희"]
    assert p3["consent"] is True and len(p3["samples"][0]["embedding"]) == DIM


def test_model_mismatch_ignores_profiles_and_reenroll_replaces_old_vectors():
    old = {"version": 1, "model": "other-model", "people": [person("P1", "홍길동", unit(a0=1))]}
    assert voices.usable_people(old) == [] and voices.needs_reenroll(old)
    new, p = voices.enroll(old, "김영희", unit(a1=1), "m1")
    assert new["model"] == voices.MODEL_ID and [x["name"] for x in new["people"]] == ["김영희"]  # 쓸 수 없는 옛 벡터는 지운다
    assert voices.usable_people(new) == new["people"] and not voices.needs_reenroll(new)


def test_forget_by_name_or_id():
    data = {"version": 1, "model": voices.MODEL_ID, "people": [person("P1", "홍길동", unit(a0=1)), person("P2", "김영희", unit(a1=1))]}
    left, gone = voices.forget(data, "홍길동")
    assert gone == ["P1"] and [p["id"] for p in left["people"]] == ["P2"] and len(data["people"]) == 2
    left, gone = voices.forget(data, "P2")
    assert gone == ["P2"]
    assert voices.forget(data, "없는사람")[1] == []


# ── 매칭 ──────────────────────────────────────────────────────────


@pytest.fixture
def thr(monkeypatch):
    monkeypatch.setattr(voices, "THRESHOLD", 0.5)  # 벤치가 정한 값과 무관하게 경계를 시험한다


def test_match_accepts_above_threshold_and_rejects_below(thr):
    people = [person("P1", "홍길동", unit(a0=1))]
    got = voices.match({"S1": unit(a0=0.55), "S2": unit(a1=1)}, people)
    assert got == {"S1": {"person_id": "P1", "name": "홍길동", "score": 0.55}}
    assert voices.match({"S1": unit(a0=0.45)}, people) == {}


def test_match_requires_margin_over_second_best_person(thr):
    people = [person("P1", "홍길동", unit(a0=1)), person("P2", "김영희", unit(a1=1))]
    assert voices.match({"S1": unit(a0=0.65, a1=0.60)}, people) == {}  # 차이 0.05 < 0.08
    assert voices.match({"S1": unit(a0=0.65, a1=0.55)}, people)["S1"]["person_id"] == "P1"


def test_match_is_one_to_one(thr):
    people = [person("P1", "홍길동", unit(a0=1))]
    got = voices.match({"S1": unit(a0=0.7), "S2": unit(a0=0.8)}, people)
    assert list(got) == ["S2"]  # 같은 사람을 두 화자에 붙이지 않는다: 더 비슷한 쪽만


def test_match_uses_normalized_centroid_of_samples():
    people = [person("P1", "홍길동", unit(a0=1), unit(a1=1))]
    got = voices.match({"S1": unit(a0=1 / math.sqrt(2), a1=1 / math.sqrt(2))}, people)
    assert got["S1"]["score"] == 1.0
    assert voices.match({}, people) == {} and voices.match({"S1": unit(a0=1)}, []) == {}


def test_suggest_embeds_only_requested_labels():
    pcm = np.zeros(10 * SR, np.float32)
    pcm[: 3 * SR] = 0
    pcm[4 * SR: 7 * SR] = 1
    segs = [seg(0, 3, "S1"), seg(4, 7, "S2")]
    people = [person("P1", "홍길동", unit(a1=1))]
    emb = FakeEmbedder()
    assert voices.suggest(emb, pcm, segs, people, ["S2"]) == {"S2": {"person_id": "P1", "name": "홍길동", "score": 1.0}}
    assert emb.calls == [3 * SR]


# ── transcript.json의 suggested ─────────────────────────────────────

SUGG = {"person_id": "P1", "name": "홍길동", "score": 0.82}


def _t() -> dict:
    return {
        "schema_version": 2, "meeting_id": "M", "title": "회의", "created_at": "2026-10-07T10:00:00+09:00",
        "audio": {"file": "audio.ogg", "duration_sec": 9.0, "source": "x", "sha256": "x"},
        "asr": {"model": "m", "track": "lite", "runtime": "mlx-audio", "language": "auto", "hotwords": []},
        "speakers": {"S1": {"name": None, "suggested": SUGG}, "S2": {"name": None, "suggested": {**SUGG, "person_id": "P2", "name": "김영희"}},
                     "S3": {"name": "박민수"}},
        "diarization": None,
        "segments": [
            {"id": "s0001", "start": 0.0, "end": 2.0, "text": "가", "lang": "ko", "speaker": "S1", "corrected_text": None, "words": None},
            {"id": "s0002", "start": 2.0, "end": 4.0, "text": "나", "lang": "ko", "speaker": "S2", "corrected_text": None, "words": None},
            {"id": "s0003", "start": 4.0, "end": 6.0, "text": "다", "lang": "ko", "speaker": "S3", "corrected_text": None, "words": None},
        ],
    }


def test_suggested_name_is_never_the_display_name():
    t = _t()
    assert store.speaker_name(t, "S1") == "S1"
    assert "홍길동" not in render_markdown(t) and "홍길동" not in render_vtt(t)
    assert "**참석자 1**: 가" in render_markdown(t) and "**박민수**: 다" in render_markdown(t)


def test_rename_and_dismiss_clear_suggestion_and_merge_drops_source_suggestion():
    t = _t()
    renamed = apply_speaker_edit(t, "rename", "S1", "홍길동")
    assert renamed["speakers"]["S1"] == {"name": "홍길동"} and t["speakers"]["S1"]["suggested"] == SUGG  # 원본은 그대로
    assert apply_speaker_edit(t, "dismiss", "S1")["speakers"]["S1"] == {"name": None}
    merged = apply_speaker_edit(t, "merge", "S2", "S1")
    assert merged["speakers"] == {"S1": {"name": None, "suggested": SUGG}, "S3": {"name": "박민수"}}
    merged = apply_speaker_edit(t, "merge", "S3", "S1")  # 이름 있는 화자를 합치면 이름을 받고 제안은 지운다
    assert merged["speakers"]["S1"] == {"name": "박민수"}
    with pytest.raises(ValueError):
        apply_speaker_edit(t, "dismiss", "S9")


def test_apply_suggestions_skips_confirmed_and_clears_stale():
    t = _t()
    out = apply_suggestions(t, {"S2": SUGG, "S3": SUGG})
    assert out["speakers"] == {"S1": {"name": None}, "S2": {"name": None, "suggested": SUGG}, "S3": {"name": "박민수"}}
    assert t["speakers"]["S1"]["suggested"] == SUGG


def test_job_keeps_suggestions_for_resume_and_writes_them(tmp_path):
    job = Job(dir=tmp_path, meeting_id="M", sha256="x", source="a.wav", title="회의", created_at="2026-10-07T10:00:00+09:00",
              duration_sec=4.0, model="m", track="lite", language="auto", chunks=[(0, 2 * SR, "S1"), (2 * SR, 4 * SR, "S2")],
              suggestions={"S1": SUGG})
    job.save()
    assert Job.load(tmp_path).suggestions == {"S1": SUGG}
    raw = json.loads((tmp_path / store.JOB_FILE).read_text(encoding="utf-8"))
    del raw["suggestions"]  # 예전 .job.json
    (tmp_path / store.JOB_FILE).write_text(json.dumps(raw), encoding="utf-8")
    assert Job.load(tmp_path).suggestions == {}
    job.save()
    from tractus.asr import Segment

    job.append(0, Segment(text="가", lang="ko"))
    job.append(1, Segment(text="나", lang="ko"))
    t = write_transcript(job)
    assert t["speakers"] == {"S1": {"name": None, "suggested": SUGG}, "S2": {"name": None}}


# ── 실제 모델 ──────────────────────────────────────────────────────

# ── 런타임 의존성 ────────────────────────────────────────────────

ROOT = Path(__file__).resolve().parent.parent
# copyleft 런타임: sherpa-onnx 휠은 espeak-ng(GPL-3)를 정적 링크한다. mlx-embeddings(GPL-3), Kiwi(LGPL-3), soynlp(LGPL)
COPYLEFT = {"sherpa-onnx", "sherpa-onnx-core", "mlx-embeddings", "kiwipiepy", "soynlp"}


def test_lock_has_no_known_copyleft_runtime():
    import tomllib

    names = {p["name"] for p in tomllib.loads((ROOT / "uv.lock").read_text(encoding="utf-8"))["package"]}
    assert not names & COPYLEFT, names & COPYLEFT


def test_onnxruntime_pools_partial_window_like_pytorch():
    """1.28까지는 AveragePool(ceil_mode)의 마지막 짧은 창을 창 크기로 나눠 CAM++ 임베딩이 PyTorch 원본과 달랐다."""
    import onnxruntime

    assert tuple(int(x) for x in onnxruntime.__version__.split(".")[:2]) >= (1, 29)


def test_fbank_is_80_dim_kaldi_frames_with_global_mean_removed():
    pcm = np.random.default_rng(0).standard_normal(SR).astype(np.float32) * 0.1
    x = voices.fbank(pcm)
    assert x.shape == (100, 80)  # snip_edges=False: 10ms마다 한 프레임
    assert np.abs(x.mean(axis=0)).max() < 1e-4
    assert voices.fbank(np.zeros(0, np.float32)).shape == (0, 80)


def test_threshold_is_the_bench_recommendation_with_label_alias_and_cross_session_rows():
    """THRESHOLD는 벤치 권고값과 같아야 하고, 권고 근거에는 AI Hub 라벨 행·ALIASES 민감도 행·세션 간 시험이 모두 있어야 한다."""
    d = json.loads((ROOT / "bench/results/voice_summary.json").read_text(encoding="utf-8"))
    assert voices.THRESHOLD == d["recommended"]["threshold"]
    m = d["models"][d["recommended"]["model"]]
    assert {"production", "production_alias", "cross_session"} <= set(m)
    assert m["production"]["people"] == m["production_alias"]["people"] + 1  # 기본 행은 ALIASES를 묶지 않는다
    assert m["cross_session"]["cross_session_probes"]["n"] > 0


MODELS = Path(os.environ.get("TRACTUS_MODELS_DIR", Path(__file__).resolve().parent.parent / "models"))
LINES = ("안녕하세요. 오늘 회의는 다음 분기 예산 검토입니다. 먼저 인건비부터 보겠습니다.",
         "서버는 십일월에 교체합니다. 장비 비용은 지난 분기와 거의 같습니다.")


@pytest.mark.slow
def test_real_embedder_scores_same_voice_above_different_voice(tmp_path):
    from tractus import audio

    emb = voices.load_embedder(MODELS)
    assert emb is not None, f"{MODELS / voices.MODEL_DIR} 필요"
    vec = {}
    for voice in ("Yuna", "Grandpa (한국어(한국))"):
        for i, line in enumerate(LINES):
            p = tmp_path / f"{len(vec)}.wav"
            subprocess.run(["say", "-v", voice, "-o", str(p), "--data-format=LEI16@16000", line], check=True)
            vec[(voice, i)] = emb.embed(audio.decode(p))
    (a0, a1), (b0, b1) = [(vec[(v, 0)], vec[(v, 1)]) for v in ("Yuna", "Grandpa (한국어(한국))")]
    same = min(float(a0 @ a1), float(b0 @ b1))
    diff = max(float(a0 @ b0), float(a0 @ b1), float(a1 @ b0), float(a1 @ b1))
    assert all(abs(float(np.linalg.norm(v)) - 1) < 1e-4 for v in vec.values())
    assert same > diff, (same, diff)
