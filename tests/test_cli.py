"""CLI 흐름 테스트. FFmpeg는 실제로 돌리고, VAD·ASR 모델만 가짜로 바꾼다."""

import json
import re
import subprocess

import pytest
from typer.testing import CliRunner

from tractus import cli
from tractus.asr import Segment

SR = 16000
CHUNKS = [(0, 2 * SR), (3 * SR, 5 * SR), (6 * SR, 8 * SR)]


@pytest.fixture
def env(tmp_path, monkeypatch):
    home = tmp_path / "home"
    for repo in (cli.VAD_MODEL, *cli.MODELS.values()):
        d = home / "models" / repo.split("/")[1].lower()
        d.mkdir(parents=True)
        (d / "config.json").write_text("{}")
    (home / "glossary.md").write_text("- WTO\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)  # 저장소 루트의 .env / .env.local을 읽지 않게 한다
    monkeypatch.setenv("TRACTUS_HOME", str(home))
    monkeypatch.delenv("TRACTUS_MODELS_DIR", raising=False)
    monkeypatch.setattr(cli, "find_chunks", lambda pcm, vad_dir: CHUNKS)

    wav = tmp_path / "주간회의.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-ar", "16000", str(wav)], check=True)
    return home, wav


class FakeTranscriber:
    calls: list = []
    fail_at: int | None = None

    @classmethod
    def load(cls, model_dir):
        return cls()

    def transcribe(self, audio, language=None, hotwords=None):
        n = len(FakeTranscriber.calls)
        if FakeTranscriber.fail_at == n:
            raise KeyboardInterrupt
        FakeTranscriber.calls.append({"samples": len(audio), "language": language, "hotwords": hotwords})
        return Segment(text=f"청크{n}", lang="ko")


@pytest.fixture
def fake_asr(monkeypatch):
    FakeTranscriber.calls, FakeTranscriber.fail_at = [], None
    monkeypatch.setattr(cli, "Transcriber", FakeTranscriber)
    return FakeTranscriber


def run(*args):
    return CliRunner().invoke(cli.app, ["transcribe", *map(str, args)])


def test_transcribe_creates_meeting_layout(env, fake_asr):
    home, wav = env
    result = run(wav, "--track", "lite", "-t", "김철수")
    assert result.exit_code == 0, result.output
    (d,) = (home / "meetings").iterdir()
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}_주간회의_[0-9A-Z]{26}", d.name)
    assert sorted(p.name for p in d.iterdir()) == ["audio.opus", "transcript.json", "transcript.md"]
    t = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
    assert t["asr"]["model"] == cli.MODELS[cli.Track.lite] and t["asr"]["hotwords"] == ["WTO", "김철수"]
    assert [s["text"] for s in t["segments"]] == ["청크0", "청크1", "청크2"]
    assert fake_asr.calls[0] == {"samples": 2 * SR, "language": None, "hotwords": ["WTO", "김철수"]}


def test_interrupted_run_resumes_remaining_chunks(env, fake_asr):
    home, wav = env
    fake_asr.fail_at = 2
    assert run(wav).exit_code == 130
    (d,) = (home / "meetings").iterdir()
    assert (d / ".job.json").exists() and not (d / "transcript.json").exists()

    fake_asr.fail_at = None
    result = run(wav)
    assert result.exit_code == 0, result.output
    assert len(fake_asr.calls) == 3  # 첫 실행 2개 + 이어하기 1개
    t = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
    assert [s["text"] for s in t["segments"]] == ["청크0", "청크1", "청크2"]


def test_already_transcribed_file_is_skipped(env, fake_asr):
    _, wav = env
    assert run(wav).exit_code == 0
    result = run(wav)
    assert result.exit_code == 0 and "이미 전사된 파일" in result.output
    assert len(fake_asr.calls) == 3


def test_missing_model_shows_download_command(env, fake_asr, monkeypatch, tmp_path):
    _, wav = env
    monkeypatch.setenv("TRACTUS_MODELS_DIR", str(tmp_path / "empty"))
    result = run(wav)
    assert result.exit_code != 0 and "hf download" in result.output


def test_unreadable_audio_exits_with_message(env, fake_asr, tmp_path):
    bad = tmp_path / "bad.m4a"
    bad.write_bytes(b"not audio")
    result = run(bad)
    assert result.exit_code == 1 and "오디오 처리 실패" in result.output


def test_summarize_writes_summary_files(env, fake_asr, monkeypatch):
    home, wav = env
    assert run(wav).exit_code == 0
    (d,) = (home / "meetings").iterdir()
    meeting_id = d.name.rsplit("_", 1)[1]

    from tractus import summarize as summ

    reply = {
        "title": "주간회의", "summary": "요약", "topics": [{"title": "t", "segment_ids": ["s0001"]}],
        "decisions": [], "action_items": [{"task": "견적", "owner": None, "due": None, "segment_ids": ["s0002"]}],
    }
    calls = []

    def fake_summarize(client, provider, model, transcript):
        calls.append((provider.name, model, len(transcript["segments"])))
        return summ.MeetingSummary.model_validate(reply)

    monkeypatch.setattr(cli.summ, "summarize", fake_summarize)
    monkeypatch.setattr(cli, "make_client", lambda p: None)
    monkeypatch.setenv("UPSTAGE_API_KEY", "k")
    result = CliRunner().invoke(cli.app, ["summarize", meeting_id[-6:], "--provider", "upstage"])
    assert result.exit_code == 0, result.output
    assert calls == [("upstage", "solar-pro4", 3)]
    data = json.loads((d / "summary.json").read_text(encoding="utf-8"))
    assert data["provider"] == "upstage" and data["action_items"][0]["segment_ids"] == ["s0002"]
    assert "- [ ] 견적 [00:00:03]" in (d / "summary.md").read_text(encoding="utf-8")


def test_summarize_without_key_explains(env, fake_asr, monkeypatch):
    home, wav = env
    assert run(wav).exit_code == 0
    (d,) = (home / "meetings").iterdir()
    monkeypatch.delenv("UPSTAGE_API_KEY", raising=False)
    result = CliRunner().invoke(cli.app, ["summarize", str(d), "--provider", "upstage"])
    assert result.exit_code == 1 and "UPSTAGE_API_KEY" in result.output


def test_error_text_with_brackets_is_printed_verbatim(env, fake_asr, monkeypatch):
    home, wav = env
    assert run(wav).exit_code == 0
    (d,) = (home / "meetings").iterdir()

    def boom(*a, **k):
        raise cli.LLMError("검증 실패 [type=missing, input_value={}] [/x]")

    monkeypatch.setattr(cli.summ, "summarize", boom)
    monkeypatch.setattr(cli, "make_client", lambda p: None)
    monkeypatch.setenv("UPSTAGE_API_KEY", "k")
    result = CliRunner().invoke(cli.app, ["summarize", str(d), "--provider", "upstage"])
    assert result.exit_code == 1 and "[type=missing" in result.output
