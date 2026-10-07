"""단어 타임스탬프 (Phase 6.1). 정렬 모델은 가짜로 바꾸고, 실제 모델 테스트는 tests/test_models_slow.py에 있다."""

import json
import subprocess
from types import SimpleNamespace

import numpy as np
import pytest
from typer.testing import CliRunner

from test_cli import env, events, fake_asr  # noqa: F401 — pytest fixture
from tractus import cli
from tractus.align import MAX_SLICE_S, SR, Aligner, align_segments, remap_words, tokenize
from tractus.store import apply_text_edits, save_transcript, seg_text


def _no_soynlp(text):
    raise ImportError("soynlp")  # mlx-audio 기본 한국어 토크나이저 (LGPL-3). 부르면 안 된다


class FakeModel:
    """Qwen3-ForcedAligner 대역. 받은 텍스트를 processor.tokenize_korean으로 나눠 단어마다 0.5초씩 준다."""

    def __init__(self, extra: int = 0, spans=None):
        self.aligner_processor = SimpleNamespace(tokenize_korean=_no_soynlp)
        self.extra, self.spans, self.calls = extra, spans, []

    def generate(self, audio, text, language="English"):
        assert language == "Korean"
        words = self.aligner_processor.tokenize_korean(text) + ["x"] * self.extra
        self.calls.append((len(audio), words))
        spans = self.spans or [(i * 0.5, i * 0.5 + 0.4) for i in range(len(words))]
        return SimpleNamespace(items=[SimpleNamespace(text=w, start_time=s, end_time=e) for w, (s, e) in zip(words, spans)])


def check_words(seg: dict) -> None:
    """불변식: 단어 수·텍스트가 표시 텍스트 공백 토큰과 같고, 시각은 세그먼트 안에서 줄지 않는다."""
    words = seg["words"]
    assert [w["text"] for w in words] == seg_text(seg).split()
    prev = seg["start"]
    for w in words:
        assert seg["start"] <= w["start"] <= w["end"] <= seg["end"] and w["start"] >= prev
        assert round(w["start"], 2) == w["start"] and round(w["end"], 2) == w["end"]
        prev = w["start"]


def seg(i: int, start: float, end: float, text: str, **kw) -> dict:
    return {"id": f"s{i:04d}", "start": start, "end": end, "text": text, "lang": "ko", "speaker": None, "corrected_text": None, "words": None, **kw}


# ── 토큰·정렬 ─────────────────────────────────────────────────────────


def test_tokenize_keeps_one_token_per_word_without_splitting_hanja():
    assert tokenize("안녕하세요, 金哲洙 씨! — it's 3시 ...") == ["안녕하세요", "金哲洙", "씨", "it's", "3시"]


def test_aligner_replaces_soynlp_tokenizer_and_maps_punctuation_tokens():
    model = FakeModel()
    words = Aligner(model).align(np.zeros(4 * SR, np.float32), "자, — 예산 보겠습니다.")
    assert model.calls[0][1] == ["자", "예산", "보겠습니다"]  # 문장부호만 있는 "—"는 모델에 보내지 않는다
    assert [w["text"] for w in words] == ["자,", "—", "예산", "보겠습니다."]
    assert [(w["start"], w["end"]) for w in words] == [(0.0, 0.4), (0.4, 0.4), (0.5, 0.9), (1.0, 1.4)]


def test_leading_punctuation_token_starts_at_zero():
    words = Aligner(FakeModel()).align(np.zeros(2 * SR, np.float32), "— 네")
    assert [(w["start"], w["end"]) for w in words] == [(0.0, 0.0), (0.0, 0.4)]


def test_aligner_clamps_and_keeps_times_monotonic():
    model = FakeModel(spans=[(0.5, 1.2), (0.9, 0.8), (1.5, 9.0)])  # 겹침, 끝 < 시작, 슬라이스(2초) 밖
    words = Aligner(model).align(np.zeros(2 * SR, np.float32), "가 나 다")
    assert [(w["start"], w["end"]) for w in words] == [(0.5, 1.2), (1.2, 1.2), (1.5, 2.0)]


def test_aligner_returns_none_on_mismatch_long_slice_empty_or_garbage():
    pcm = np.zeros(2 * SR, np.float32)
    assert Aligner(FakeModel(extra=1)).align(pcm, "가 나") is None
    assert Aligner(FakeModel()).align(np.zeros(int(MAX_SLICE_S * SR) + 1, np.float32), "가") is None
    assert Aligner(FakeModel()).align(pcm, "  ") is None
    assert Aligner(FakeModel()).align(pcm, "… —") is None  # 보낼 단어가 없다
    assert Aligner(FakeModel(spans=[(0.0, 0.0), (0.0, 0.0)])).align(pcm, "가 나") is None  # 모두 길이 0


def test_align_segments_uses_display_text_absolute_times_and_does_not_mutate():
    pcm = np.zeros(10 * SR, np.float32)
    segs = [seg(1, 1.0, 3.0, "원문", corrected_text="고친 문장"), seg(2, 4.0, 4.6, "가 나 다"), seg(3, 5.0, 6.0, "짧음")]
    before = json.dumps(segs)
    progress = []
    out, aligned, failed = align_segments(Aligner(FakeModel()), pcm, segs, on_progress=lambda n, total: progress.append((n, total)))
    assert json.dumps(segs) == before and out is not segs
    assert (aligned, failed) == (3, 0) and progress == [(1, 3), (2, 3), (3, 3)]
    assert out[0]["words"] == [{"text": "고친", "start": 1.0, "end": 1.4}, {"text": "문장", "start": 1.5, "end": 1.9}]
    assert out[1]["words"][-1] == {"text": "다", "start": 4.6, "end": 4.6}  # 세그먼트 끝에서 자른다
    for s in out:
        check_words(s)


def test_align_segments_marks_failures_and_respects_only():
    pcm = np.zeros(4 * SR, np.float32)
    done = [{"text": "그대로", "start": 0.0, "end": 0.5}]
    segs = [seg(1, 0.0, 1.0, "그대로", words=done), seg(2, 1.0, 2.0, "가 나")]
    out, aligned, failed = align_segments(Aligner(FakeModel(extra=1)), pcm, segs, only={"s0002"})
    assert out[0]["words"] == done and out[1]["words"] is None and (aligned, failed) == (0, 1)


# ── 편집 뒤 시각 옮기기 ───────────────────────────────────────────────


W = [{"text": "예산은", "start": 1.0, "end": 1.5}, {"text": "삼억", "start": 1.6, "end": 2.0}, {"text": "입니다", "start": 2.2, "end": 2.8}]


def test_remap_keeps_equal_words_and_spreads_replacements():
    out = remap_words(W, "예산은 삼억 오천만 원입니다", 0.5, 3.0)
    assert out[:2] == W[:2]
    assert out[2:] == [{"text": "오천만", "start": 2.0, "end": 2.5, "approx": True}, {"text": "원입니다", "start": 2.5, "end": 3.0, "approx": True}]


def test_remap_uses_segment_bounds_at_edges_and_handles_deletion():
    assert remap_words(W, "올해 예산은", 0.5, 3.0) == [{"text": "올해", "start": 0.5, "end": 1.0, "approx": True}, W[0]]
    assert remap_words(W, "예산은 입니다", 0.5, 3.0) == [W[0], W[2]]
    assert remap_words(None, "무엇이든", 0.0, 1.0) is None
    assert remap_words([{**W[0], "approx": True}], "예산은", 0.0, 3.0) == [{**W[0], "approx": True}]


def test_apply_text_edits_keeps_words_invariant_including_revert():
    t = {"segments": [seg(1, 0.5, 3.0, "예산은 삼억 입니다", words=W), seg(2, 3.0, 4.0, "단어 없음")]}
    t2, _ = apply_text_edits(t, [{"id": "s0001", "text": "예산은 사억 입니다"}, {"id": "s0002", "text": "고침"}])
    assert t["segments"][0]["words"] == W  # 원본은 그대로
    check_words(t2["segments"][0])
    assert t2["segments"][0]["words"][1]["approx"] is True and t2["segments"][1]["words"] is None
    t3, _ = apply_text_edits(t2, [{"id": "s0001", "text": "예산은 삼억 입니다"}])
    assert t3["segments"][0]["corrected_text"] is None
    check_words(t3["segments"][0])


# ── CLI ────────────────────────────────────────────────────────────────


@pytest.fixture
def fake_aligner(monkeypatch):
    model = FakeModel()
    monkeypatch.setattr(cli, "load_aligner", lambda models: Aligner(model))
    return model


def _meeting(env) -> tuple:
    home, wav = env
    (d,) = (home / "meetings").iterdir()
    return d, json.loads((d / "transcript.json").read_text(encoding="utf-8"))


def test_transcribe_aligns_after_asr(env, fake_asr, fake_aligner):  # noqa: F811
    _, wav = env
    result = CliRunner().invoke(cli.app, ["transcribe", str(wav), "--progress-json"])
    assert result.exit_code == 0, result.output
    ev = events(result.stdout)
    stages = [e["stage"] for e in ev if e["event"] == "stage"]
    assert stages[-3:] == ["transcribe", "align", "index"]
    assert [e for e in ev if e["event"] == "progress"][-1] == {"event": "progress", "done": 3, "total": 3}
    _, t = _meeting(env)
    assert [s["words"][0]["text"] for s in t["segments"]] == ["청크0", "청크1", "청크2"]
    for s in t["segments"]:
        check_words(s)


def test_transcribe_no_align_and_missing_model(env, fake_asr):  # noqa: F811
    _, wav = env
    result = CliRunner().invoke(cli.app, ["transcribe", str(wav), "--progress-json"])
    assert result.exit_code == 0, result.output
    warn = [e for e in events(result.stdout) if e["event"] == "warning" and e["code"] == "aligner_missing"]
    assert warn and "hf download mlx-community/Qwen3-ForcedAligner-0.6B-8bit --revision" in warn[0]["message"]
    assert "align" not in [e.get("stage") for e in events(result.stdout)]
    _, t = _meeting(env)
    assert {s["words"] is None for s in t["segments"]} == {True}


def test_transcribe_no_align_flag(env, fake_asr, fake_aligner):  # noqa: F811
    _, wav = env
    result = CliRunner().invoke(cli.app, ["transcribe", str(wav), "--no-align", "--progress-json"])
    assert result.exit_code == 0 and not fake_aligner.calls
    assert not [e for e in events(result.stdout) if e["event"] == "warning" and e["code"].startswith("aligner")]


def test_alignment_failure_keeps_transcript(env, fake_asr, monkeypatch):  # noqa: F811
    _, wav = env

    class Broken:
        def align(self, pcm, text):
            raise RuntimeError("boom")

    monkeypatch.setattr(cli, "load_aligner", lambda models: Broken())
    result = CliRunner().invoke(cli.app, ["transcribe", str(wav), "--progress-json"])
    assert result.exit_code == 0, result.output
    assert [e["code"] for e in events(result.stdout) if e["event"] == "warning" and e["code"].startswith("aligner")] == ["aligner_failed"]
    _, t = _meeting(env)
    assert len(t["segments"]) == 3 and {s["words"] is None for s in t["segments"]} == {True}


def test_ctrl_c_during_align_keeps_transcript(env, fake_asr, monkeypatch):  # noqa: F811
    _, wav = env

    class Interrupted:
        def align(self, pcm, text):
            raise KeyboardInterrupt

    monkeypatch.setattr(cli, "load_aligner", lambda models: Interrupted())
    result = CliRunner().invoke(cli.app, ["transcribe", str(wav), "--progress-json"])
    assert result.exit_code == 130
    assert "tractus align" in events(result.stdout)[-1]["message"]
    d, t = _meeting(env)
    assert len(t["segments"]) == 3 and not (d / ".job.json").exists()


def test_transcribe_align_stage_keeps_edits_made_during_alignment(env, fake_asr, monkeypatch):  # noqa: F811
    home, wav = env

    class EditingAligner(Aligner):
        def align(self, pcm, text):
            if text == "청크1":  # transcript.json이 이미 있어 앱이 정렬 중인 회의를 고칠 수 있다
                (d,) = (home / "meetings").iterdir()
                cur = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
                save_transcript(d, apply_text_edits(cur, [{"id": "s0002", "text": "앱에서 고침"}])[0])
            return super().align(pcm, text)

    monkeypatch.setattr(cli, "load_aligner", lambda models: EditingAligner(FakeModel()))
    r = CliRunner().invoke(cli.app, ["transcribe", str(wav)])
    assert r.exit_code == 0, r.output
    _, t = _meeting(env)
    assert t["segments"][1]["corrected_text"] == "앱에서 고침" and t["segments"][1]["words"] is None
    check_words(t["segments"][0])
    check_words(t["segments"][2])


def align_cmd(*args):
    return CliRunner().invoke(cli.app, ["align", *map(str, args)])


def test_align_command_fills_missing_words_then_skips(env, fake_asr, fake_aligner):  # noqa: F811
    _, wav = env
    assert CliRunner().invoke(cli.app, ["transcribe", str(wav), "--no-align"]).exit_code == 0
    d, t = _meeting(env)
    ref = t["meeting_id"][-6:]
    r = align_cmd(ref)
    assert r.exit_code == 0, r.output
    assert json.loads(r.stdout) == {"aligned": 3, "failed": 0, "skipped": 0}
    _, t = _meeting(env)
    for s in t["segments"]:
        check_words(s)
    assert json.loads(align_cmd(ref).stdout) == {"aligned": 0, "failed": 0, "skipped": 3}
    assert len(fake_aligner.calls) == 3
    forced = align_cmd(ref, "--force", "--progress-json")
    ev = events(forced.stdout)
    assert [e["stage"] for e in ev if e["event"] == "stage"] == ["decode", "align"]
    assert ev[-1] == {"event": "done", "meeting_id": t["meeting_id"], "meeting_dir": str(d), "aligned": 3, "failed": 0, "skipped": 0}


def test_align_command_keeps_edits_made_during_alignment(env, fake_asr, monkeypatch):  # noqa: F811
    _, wav = env
    assert CliRunner().invoke(cli.app, ["transcribe", str(wav), "--no-align"]).exit_code == 0
    d, t = _meeting(env)

    class EditingAligner(Aligner):
        def align(self, pcm, text):
            if text == "청크1":  # 정렬 중에 앱이 s0002를 고쳤다
                cur = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
                save_transcript(d, apply_text_edits(cur, [{"id": "s0002", "text": "앱에서 고침"}])[0])
            return super().align(pcm, text)

    monkeypatch.setattr(cli, "load_aligner", lambda models: EditingAligner(FakeModel()))
    r = align_cmd(t["meeting_id"])
    assert r.exit_code == 0, r.output
    assert json.loads(r.stdout) == {"aligned": 2, "failed": 0, "skipped": 1}
    _, t = _meeting(env)
    assert t["segments"][1]["corrected_text"] == "앱에서 고침" and t["segments"][1]["words"] is None
    check_words(t["segments"][0])
    check_words(t["segments"][2])


def test_align_command_without_model_explains_download(env, fake_asr):  # noqa: F811
    _, wav = env
    assert CliRunner().invoke(cli.app, ["transcribe", str(wav), "--no-align"]).exit_code == 0
    _, t = _meeting(env)
    r = align_cmd(t["meeting_id"], "--progress-json")
    assert r.exit_code == 1 and "hf download mlx-community/Qwen3-ForcedAligner-0.6B-8bit" in events(r.stdout)[-1]["message"]


def test_align_command_unknown_meeting(env):
    r = align_cmd("없는회의", "--progress-json")
    assert r.exit_code != 0 and events(r.stdout)[-1]["event"] == "error"


# ── 실제 모델 ──────────────────────────────────────────────────────────


@pytest.mark.slow
def test_real_aligner_on_synthetic_korean(tmp_path):
    from test_models_slow import MODELS

    from tractus import audio
    from tractus.align import load_aligner

    wav = tmp_path / "say.wav"
    text = "안녕하세요. 오늘 회의는 다음 분기 예산 검토입니다, 金 팀장님!"
    subprocess.run(["say", "-v", "Yuna", "-o", str(wav), "--data-format=LEI16@16000", text], check=True)
    pcm = audio.decode(wav)
    aligner = load_aligner(MODELS)
    assert aligner is not None, f"{MODELS}/qwen3-forcedaligner-0.6b-8bit 필요"
    segs = [seg(1, 0.0, round(len(pcm) / SR, 2), text)]
    out, aligned, failed = align_segments(aligner, pcm, segs)
    assert (aligned, failed) == (1, 0)
    check_words(out[0])
    words = out[0]["words"]
    assert words[-1]["end"] > words[0]["start"] and sum(w["end"] > w["start"] for w in words) >= len(words) // 2
