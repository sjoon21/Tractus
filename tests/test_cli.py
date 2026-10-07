"""CLI 흐름 테스트. FFmpeg는 실제로 돌리고, VAD·ASR 모델만 가짜로 바꾼다."""

import json
import re
import subprocess
from pathlib import Path

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
    assert sorted(p.name for p in d.iterdir()) == ["audio.ogg", "transcript.json", "transcript.md", "transcript.vtt"]
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
    result = CliRunner().invoke(cli.app, ["summarize", meeting_id[-6:], "--provider", "upstage", "--progress-json"])
    assert result.exit_code == 0, result.output
    ev = events(result.stdout)
    assert ev[0] == {"event": "stage", "stage": "summarize"} and ev[-1]["event"] == "done" and ev[-1]["meeting_id"].endswith(meeting_id[-6:])
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


def make_recording(tmp_path, marks=None):
    rec = tmp_path / "recordings" / "01RECORDING0000000000000000"
    rec.mkdir(parents=True)
    for name, freq in (("mic", 440), ("system", 660)):
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", f"sine=frequency={freq}:duration=8", "-ar", "48000", "-ac", "1", str(rec / f"{name}.wav")], check=True)
    (rec / "recording.json").write_text(json.dumps({
        "schema_version": 1, "started_at": "2026-10-02T14:00:00+09:00", "duration": 8.0,
        "tracks": {"mic": "mic.wav", "system": "system.wav"},
        "marks": marks if marks is not None else [{"t": 3.5, "kind": "memo", "text": "예산 다시 확인"}, {"t": 6.0, "kind": "bookmark", "text": None}],
    }, ensure_ascii=False), encoding="utf-8")
    return rec


def events(output: str) -> list[dict]:
    return [json.loads(line) for line in output.splitlines() if line.startswith("{")]


def test_transcribe_recording_with_progress_json(env, fake_asr, tmp_path):
    home, _ = env
    rec = make_recording(tmp_path)
    result = CliRunner().invoke(cli.app, ["transcribe", "--recording", str(rec), "--progress-json"])
    assert result.exit_code == 0, result.output
    ev = events(result.stdout)
    stages = [e["stage"] for e in ev if e["event"] == "stage"]
    assert stages[:3] == ["decode", "vad", "encode"] and "transcribe" in stages
    assert [e for e in ev if e["event"] == "progress"][-1] == {"event": "progress", "done": 3, "total": 3}
    done = ev[-1]
    assert done["event"] == "done" and Path(done["meeting_dir"]).is_dir()
    d = Path(done["meeting_dir"])
    assert d.name.startswith("2026-10-02_") and (d / "audio.ogg").exists() and not rec.exists()
    t = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
    assert t["audio"]["file"] == "audio.ogg" and t["created_at"].startswith("2026-10-02T14:00:00")
    assert json.loads((d / "memos.json").read_text(encoding="utf-8"))[0] == {"t": 3.5, "kind": "memo", "text": "예산 다시 확인"}
    md = (d / "transcript.md").read_text(encoding="utf-8")
    assert "[00:00:03] (메모) 예산 다시 확인" in md and "[00:00:06] (북마크)" in md
    vtt = (d / "transcript.vtt").read_text(encoding="utf-8")
    assert vtt.startswith("WEBVTT") and "s0001\n00:00:00.000 --> 00:00:02.000\n청크0" in vtt


def test_recording_keep_tracks_moves_wavs(env, fake_asr, tmp_path):
    rec = make_recording(tmp_path, marks=[])
    result = CliRunner().invoke(cli.app, ["transcribe", "--recording", str(rec), "--keep-tracks", "--progress-json"])
    assert result.exit_code == 0, result.output
    d = Path(events(result.stdout)[-1]["meeting_dir"])
    assert sorted(p.name for p in (d / "tracks").iterdir()) == ["mic.wav", "recording.json", "system.wav"] and not rec.exists()
    assert not (d / "memos.json").exists()


def test_progress_json_reports_errors(env, fake_asr, tmp_path):
    bad = tmp_path / "bad.m4a"
    bad.write_bytes(b"not audio")
    result = CliRunner().invoke(cli.app, ["transcribe", str(bad), "--progress-json"])
    assert result.exit_code == 1 and events(result.stdout)[-1]["event"] == "error"


def test_transcribe_requires_exactly_one_source(env, fake_asr, tmp_path):
    _, wav = env
    assert CliRunner().invoke(cli.app, ["transcribe"]).exit_code != 0
    rec = make_recording(tmp_path)
    assert CliRunner().invoke(cli.app, ["transcribe", str(wav), "--recording", str(rec)]).exit_code != 0


# ── 화자 분리 ─────────────────────────────────────────────────────────


class FakeDiarizer:
    """CHUNKS(0–2, 3–5, 6–8초) 중 가운데 청크만 다른 화자."""

    calls: list = []
    info = {"model": "fake", "revision": "r", "params": {}}

    def diarize(self, pcm, max_speakers=None):
        FakeDiarizer.calls.append(max_speakers)
        return [(0.0, 2.5, "S1"), (2.5, 5.5, "S2"), (5.5, 8.0, "S1")]


@pytest.fixture
def fake_diar(monkeypatch):
    FakeDiarizer.calls = []
    monkeypatch.setattr(cli, "load_diarizer", lambda models: FakeDiarizer())
    return FakeDiarizer


def test_transcribe_diarizes_before_asr(env, fake_asr, fake_diar):
    home, wav = env
    result = CliRunner().invoke(cli.app, ["transcribe", str(wav), "--progress-json", "--max-speakers", "3"])
    assert result.exit_code == 0, result.output
    stages = [e["stage"] for e in events(result.stdout) if e["event"] == "stage"]
    assert stages[:5] == ["decode", "vad", "diarize", "encode", "load_model"]
    assert fake_diar.calls == [3]
    (d,) = (home / "meetings").iterdir()
    t = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
    assert [s["speaker"] for s in t["segments"]] == ["S1", "S2", "S1"]
    assert t["speakers"] == {"S1": {"name": None}, "S2": {"name": None}} and t["diarization"]["model"] == "fake"
    assert "**S2**: 청크1" in (d / "transcript.md").read_text(encoding="utf-8")


def test_resume_does_not_rerun_diarization(env, fake_asr, fake_diar):
    home, wav = env
    fake_asr.fail_at = 1
    assert run(wav).exit_code == 130
    fake_asr.fail_at = None
    result = CliRunner().invoke(cli.app, ["transcribe", str(wav), "--progress-json"])
    assert result.exit_code == 0, result.output
    assert fake_diar.calls == [None]  # 첫 실행 한 번뿐
    assert "diarize" not in [e.get("stage") for e in events(result.stdout)]
    (d,) = (home / "meetings").iterdir()
    assert [s["speaker"] for s in json.loads((d / "transcript.json").read_text(encoding="utf-8"))["segments"]] == ["S1", "S2", "S1"]


def test_no_diarize_flag_skips_diarization(env, fake_asr, fake_diar):
    home, wav = env
    assert run(wav, "--no-diarize").exit_code == 0
    assert fake_diar.calls == []
    (d,) = (home / "meetings").iterdir()
    t = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
    assert t["diarization"] is None and t["speakers"] == {} and {s["speaker"] for s in t["segments"]} == {None}


def test_missing_diarization_model_warns_and_continues(env, fake_asr):
    home, wav = env
    result = CliRunner().invoke(cli.app, ["transcribe", str(wav), "--progress-json"])
    assert result.exit_code == 0, result.output
    warn = [e for e in events(result.stdout) if e["event"] == "warning"]
    assert warn and warn[0]["code"] == "diarizer_missing" and "nemotron-3-diarization" in warn[0]["message"]
    assert "화자 분리 없이" in result.stderr
    (d,) = (home / "meetings").iterdir()
    assert json.loads((d / "transcript.json").read_text(encoding="utf-8"))["diarization"] is None


def test_diarization_failure_warns_and_continues(env, fake_asr, monkeypatch):
    _, wav = env

    class Broken:
        info = {}

        def diarize(self, pcm, max_speakers=None):
            raise RuntimeError("boom")

    monkeypatch.setattr(cli, "load_diarizer", lambda models: Broken())
    result = CliRunner().invoke(cli.app, ["transcribe", str(wav), "--progress-json"])
    assert result.exit_code == 0, result.output
    assert [e["code"] for e in events(result.stdout) if e["event"] == "warning"] == ["diarizer_failed", "aligner_missing"]


def test_max_speakers_is_validated(env, fake_asr, fake_diar):
    _, wav = env
    assert run(wav, "--max-speakers", "9").exit_code != 0
    assert run(wav, "--max-speakers", "0").exit_code != 0


def speakers(*args):
    return CliRunner().invoke(cli.app, ["speakers", *map(str, args)])


def test_speakers_commands_rewrite_transcript_and_renders(env, fake_asr, fake_diar, monkeypatch):
    home, wav = env
    assert run(wav).exit_code == 0
    (d,) = (home / "meetings").iterdir()
    ref = d.name.rsplit("_", 1)[1][-6:]
    synced = []
    monkeypatch.setattr(cli, "_sync_index_quietly", lambda embed=True: synced.append(embed))
    audio_before = (d / "audio.ogg").read_bytes()

    r = speakers(ref, "list", "--json")
    assert r.exit_code == 0, r.output
    listed = json.loads(r.stdout)
    assert listed["meeting_id"].endswith(ref) and listed["diarization"]["model"] == "fake"
    assert listed["speakers"] == [
        {"label": "S1", "name": None, "display": "S1", "segments": 2, "talk_sec": 4.0},
        {"label": "S2", "name": None, "display": "S2", "segments": 1, "talk_sec": 2.0},
    ]

    assert speakers(ref, "rename", "S1", "김민수").exit_code == 0
    assert speakers(ref, "set", "s0003", "new").exit_code == 0
    assert speakers(ref, "merge", "S3", "S2").exit_code == 0
    t = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
    assert [s["speaker"] for s in t["segments"]] == ["S1", "S2", "S2"] and t["speakers"]["S1"]["name"] == "김민수"
    assert "**김민수**: 청크0" in (d / "transcript.md").read_text(encoding="utf-8")
    assert "<v 김민수>청크0" in (d / "transcript.vtt").read_text(encoding="utf-8")
    assert synced == [False, False, False] and (d / "audio.ogg").read_bytes() == audio_before
    assert not list(d.glob("*.tmp"))

    bad = speakers(ref, "merge", "S9", "S1")
    assert bad.exit_code == 1 and "S9" in bad.output
    human = speakers(ref, "list")
    assert human.exit_code == 0 and "김민수" in human.output


# ── 파일 가져오기 (Phase 5) ───────────────────────────────────────────


def test_duplicate_import_emits_decode_then_warning_then_done(env, fake_asr):
    _, wav = env
    first = CliRunner().invoke(cli.app, ["transcribe", str(wav), "--progress-json"])
    assert first.exit_code == 0, first.output
    assert events(first.stdout)[0] == {"event": "stage", "stage": "decode"}  # 해시 계산 전에 바로 알린다
    assert [e.get("stage") for e in events(first.stdout)].count("decode") == 1
    again = CliRunner().invoke(cli.app, ["transcribe", str(wav), "--progress-json"])
    assert again.exit_code == 0, again.output
    ev = events(again.stdout)
    assert [e["event"] for e in ev] == ["stage", "warning", "done"] and ev[1]["code"] == "duplicate" and ev[1]["message"]
    assert ev[2]["meeting_id"] == events(first.stdout)[-1]["meeting_id"] and ev[2]["meeting_dir"] == events(first.stdout)[-1]["meeting_dir"]
    assert len(fake_asr.calls) == 3


def test_video_file_is_transcribed_from_its_audio_track(env, fake_asr, tmp_path):
    home, _ = env
    mp4 = tmp_path / "화면녹화.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=8:size=64x48:rate=5", "-f", "lavfi", "-i", "sine=duration=8",
                    "-shortest", "-c:v", "mpeg4", "-c:a", "aac", str(mp4)], check=True)
    result = run(mp4)
    assert result.exit_code == 0, result.output
    (d,) = (home / "meetings").iterdir()
    assert "화면녹화" in d.name and (d / "audio.ogg").stat().st_size > 0
    assert fake_asr.calls[0]["samples"] == 2 * SR


def test_video_without_audio_reports_korean_error(env, fake_asr, tmp_path):
    mp4 = tmp_path / "무음.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=64x48:rate=5", "-c:v", "mpeg4", str(mp4)], check=True)
    result = CliRunner().invoke(cli.app, ["transcribe", str(mp4), "--progress-json"])
    assert result.exit_code == 1
    err = events(result.stdout)[-1]
    assert err["event"] == "error" and "오디오 트랙이 없습니다" in err["message"]
