"""CLI 흐름 테스트. FFmpeg는 실제로 돌리고, VAD·ASR 모델만 가짜로 바꾼다."""

import json
import re
import subprocess
from datetime import datetime
from pathlib import Path

import numpy as np
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
    monkeypatch.setenv("TRACTUS_DIAR_BIN", str(tmp_path / "no-tractus-diar"))  # 저장소에 빌드된 헬퍼를 쓰지 않게
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
    assert result.exit_code == 1 and "음성 파일을 읽지 못했습니다" in result.output


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


def test_summarize_invalid_llm_reply_emits_code_and_keeps_detail_on_stderr(env, fake_asr, monkeypatch):
    home, wav = env
    assert run(wav).exit_code == 0
    (d,) = (home / "meetings").iterdir()

    def boom(*a, **k):
        raise cli.LLMError("upstage/m 응답이 2회 연속 검증에 실패했습니다: 전사에 없는 segment_ids: ['s0099']", code="llm_invalid")

    monkeypatch.setattr(cli.summ, "summarize", boom)
    monkeypatch.setattr(cli, "make_client", lambda p: None)
    monkeypatch.setenv("UPSTAGE_API_KEY", "k")
    result = CliRunner().invoke(cli.app, ["summarize", str(d), "--provider", "upstage", "--progress-json"])
    assert result.exit_code == 1 and "s0099" in result.stderr
    assert events(result.stdout)[-1] == {"event": "error", "message": "AI 응답이 형식에 맞지 않아 요약하지 못했습니다", "code": "llm_invalid"}


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
    hhmm = datetime.fromisoformat("2026-10-02T14:00:00+09:00").astimezone().strftime("%H:%M")
    assert t["title"] == f"녹음 {hhmm}" and d.name.startswith(f"2026-10-02_녹음_{hhmm.replace(':', '_')}_")
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
    assert "**참석자 2**: 청크1" in (d / "transcript.md").read_text(encoding="utf-8")


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
    assert run(wav, "--max-speakers", "0").exit_code != 0
    assert run(wav, "--diarizer", "pyannote").exit_code != 0
    assert run(wav, "--max-speakers", "12").exit_code == 0  # 9명 이상은 fluid가 받는다
    assert fake_diar.calls == [12]


# ── 두 번째 엔진 (fluid, v3.15) ─────────────────────────────────────


EIGHT = [(float(i), i + 0.9, f"S{i + 1}") for i in range(8)]  # Nemotron 8채널을 모두 씀


class FakeFluid:
    calls: list = []
    fail = False
    info = {"engine": "fluid", "model": "fluid-fake", "revision": "r", "params": {}}

    def diarize(self, pcm, max_speakers=None):
        FakeFluid.calls.append(max_speakers)
        if FakeFluid.fail:
            raise RuntimeError("helper boom")
        return [(0.0, 2.5, "S1"), (2.5, 5.5, "S2"), (5.5, 8.0, "S3")]


@pytest.fixture
def fake_fluid(monkeypatch):
    FakeFluid.calls, FakeFluid.fail = [], False
    monkeypatch.setattr(cli, "load_fluid", lambda models: FakeFluid())
    return FakeFluid


def nemotron_turns(monkeypatch, turns):
    monkeypatch.setattr(FakeDiarizer, "diarize", lambda self, pcm, max_speakers=None: FakeDiarizer.calls.append(max_speakers) or turns)


def transcribe_json(*args):
    result = CliRunner().invoke(cli.app, ["transcribe", *map(str, args), "--progress-json"])
    assert result.exit_code == 0, result.output
    evs = events(result.stdout)
    return evs, [e for e in evs if e["event"] == "stage" and e["stage"] == "diarize"], [e["code"] for e in evs if e["event"] == "warning"]


def diarization(home):
    (d,) = (home / "meetings").iterdir()
    return json.loads((d / "transcript.json").read_text(encoding="utf-8"))


def test_auto_reruns_with_fluid_when_all_eight_channels_used(env, fake_asr, fake_diar, fake_fluid, monkeypatch):
    home, wav = env
    nemotron_turns(monkeypatch, EIGHT)
    _, diar, warns = transcribe_json(wav)
    assert [e["engine"] for e in diar] == ["nemotron", "fluid"] and fake_fluid.calls == [None]
    t = diarization(home)
    assert t["diarization"]["engine"] == "fluid" and [s["speaker"] for s in t["segments"]] == ["S1", "S2", "S3"]
    assert "diarizer_cap" not in warns


def test_auto_keeps_nemotron_below_cap(env, fake_asr, fake_diar, fake_fluid, monkeypatch):
    home, wav = env
    nemotron_turns(monkeypatch, EIGHT[:7])
    _, diar, _ = transcribe_json(wav)
    assert [e["engine"] for e in diar] == ["nemotron"] and fake_fluid.calls == []
    assert diarization(home)["diarization"]["model"] == "fake"


def test_auto_respects_user_cap_of_eight_or_less(env, fake_asr, fake_diar, fake_fluid, monkeypatch):
    _, wav = env
    nemotron_turns(monkeypatch, EIGHT)
    transcribe_json(wav, "--max-speakers", "8")
    assert fake_fluid.calls == []


def test_auto_passes_large_cap_to_fluid(env, fake_asr, fake_diar, fake_fluid, monkeypatch):
    _, wav = env
    nemotron_turns(monkeypatch, EIGHT)
    transcribe_json(wav, "--max-speakers", "12")
    assert fake_diar.calls == [12] and fake_fluid.calls == [12]


def test_auto_cap_without_fluid_warns_and_keeps_nemotron(env, fake_asr, fake_diar, monkeypatch):
    home, wav = env
    nemotron_turns(monkeypatch, EIGHT)
    monkeypatch.setattr(cli, "load_fluid", lambda models: None)
    evs, diar, warns = transcribe_json(wav)
    assert [e["engine"] for e in diar] == ["nemotron"] and warns[0] == "diarizer_cap"
    msg = next(e["message"] for e in evs if e["event"] == "warning")
    assert "swift build" in msg and "download" in msg
    assert diarization(home)["diarization"]["model"] == "fake"


def test_auto_fluid_failure_keeps_nemotron(env, fake_asr, fake_diar, fake_fluid, monkeypatch):
    home, wav = env
    nemotron_turns(monkeypatch, EIGHT)
    fake_fluid.fail = True
    _, _, warns = transcribe_json(wav)
    assert warns[0] == "diarizer_cap_failed"  # 9명 이상 재시도만 실패: 8명 결과는 남는다
    t = diarization(home)
    assert t["diarization"]["model"] == "fake" and len(t["speakers"]) == 3  # 청크 3개에 Nemotron 라벨


def test_explicit_fluid_skips_nemotron(env, fake_asr, fake_diar, fake_fluid):
    home, wav = env
    _, diar, _ = transcribe_json(wav, "--diarizer", "fluid", "--max-speakers", "3")
    assert [e["engine"] for e in diar] == ["fluid"] and fake_diar.calls == [] and fake_fluid.calls == [3]
    assert diarization(home)["diarization"]["engine"] == "fluid"


def test_explicit_fluid_missing_falls_back_to_nemotron(env, fake_asr, fake_diar, monkeypatch):
    home, wav = env
    monkeypatch.setattr(cli, "load_fluid", lambda models: None)
    _, diar, warns = transcribe_json(wav, "--diarizer", "fluid")
    assert warns[:2] == ["fluid_short_clip", "fluid_missing"] and [e["engine"] for e in diar] == ["nemotron"]
    assert diarization(home)["diarization"]["model"] == "fake"


def test_explicit_fluid_failure_falls_back_to_nemotron(env, fake_asr, fake_diar, fake_fluid):
    home, wav = env
    fake_fluid.fail = True
    _, diar, warns = transcribe_json(wav, "--diarizer", "fluid")
    assert warns[:2] == ["fluid_short_clip", "diarizer_failed"] and [e["engine"] for e in diar] == ["fluid", "nemotron"]
    assert diarization(home)["diarization"]["model"] == "fake"


def test_explicit_fluid_warns_on_clips_under_a_minute_but_still_runs_fluid(env, fake_asr, fake_diar, fake_fluid):
    _, wav = env  # 8초
    _, diar, warns = transcribe_json(wav, "--diarizer", "fluid")
    assert warns[0] == "fluid_short_clip" and "diarizer_failed" not in warns and [e["engine"] for e in diar] == ["fluid"] and fake_fluid.calls == [None]  # 경고만, 엔진은 그대로


def test_fluid_short_clip_warning_not_for_long_clips(env, fake_asr, fake_diar, fake_fluid, monkeypatch):
    _, wav = env
    monkeypatch.setattr(cli, "FLUID_MIN_CLIP_S", 5.0)  # 8초 클립이 문턱을 넘는다
    assert "fluid_short_clip" not in transcribe_json(wav, "--diarizer", "fluid")[2]


def test_auto_never_warns_about_short_clips(env, fake_asr, fake_diar, fake_fluid):
    _, wav = env
    assert "fluid_short_clip" not in transcribe_json(wav)[2]  # auto는 그대로 (8명을 다 써야 fluid로 간다)


def test_explicit_nemotron_never_runs_fluid(env, fake_asr, fake_diar, fake_fluid, monkeypatch):
    _, wav = env
    nemotron_turns(monkeypatch, EIGHT)
    _, diar, _ = transcribe_json(wav, "--diarizer", "nemotron")
    assert [e["engine"] for e in diar] == ["nemotron"] and fake_fluid.calls == []


def test_resume_keeps_fluid_engine(env, fake_asr, fake_diar, fake_fluid):
    home, wav = env
    fake_asr.fail_at = 1
    assert run(wav, "--diarizer", "fluid").exit_code == 130
    fake_asr.fail_at = None
    _, diar, _ = transcribe_json(wav)  # 이어하기: 기본값(auto)이어도 화자 분리를 다시 돌리지 않는다
    assert diar == [] and fake_fluid.calls == [None] and fake_diar.calls == []
    assert diarization(home)["diarization"]["engine"] == "fluid"


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
        {"label": "S1", "name": None, "display": "S1", "suggested": None, "segments": 2, "talk_sec": 4.0},
        {"label": "S2", "name": None, "display": "S2", "suggested": None, "segments": 1, "talk_sec": 2.0},
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
    assert bad.exit_code == 1 and "참석자를 찾지 못했습니다" in bad.output
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
    assert err["event"] == "error" and err["code"] == "audio_failed" and "소리가 없는 파일입니다" in err["message"]


def test_missing_ffmpeg_has_its_own_code(env, fake_asr, tmp_path, monkeypatch):
    wav = tmp_path / "a.wav"
    wav.write_bytes(b"RIFF")
    monkeypatch.setattr(cli.audio.shutil, "which", lambda _: None)
    result = CliRunner().invoke(cli.app, ["transcribe", str(wav), "--progress-json"])
    assert result.exit_code == 1
    err = events(result.stdout)[-1]
    assert err["code"] == "ffmpeg_missing" and err["message"].startswith("음성 파일을 읽는 데 필요한 ffmpeg가 없습니다")


# ── 목소리 프로필 (Phase 7.1) ─────────────────────────────────────────


class FakeVoiceEmbedder:
    """모든 구간에 같은 단위 벡터: 등록한 사람과 점수 1.0. 매칭 세부는 test_voices에서 본다."""

    calls = 0

    def embed(self, pcm):
        FakeVoiceEmbedder.calls += 1
        return np.full(4, 0.5, np.float32)


@pytest.fixture
def fake_voice(monkeypatch):
    FakeVoiceEmbedder.calls = 0
    monkeypatch.setattr(cli.voices, "load_embedder", lambda models: FakeVoiceEmbedder())
    return FakeVoiceEmbedder


def voices_cmd(*args):
    return CliRunner().invoke(cli.app, ["voices", *map(str, args)])


def another_wav(tmp_path, name="두번째회의.wav", freq=880):
    wav = tmp_path / name  # 주파수가 다르면 sha256이 달라 중복 전사로 건너뛰지 않는다
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", f"sine=frequency={freq}:duration=8", "-ar", "16000", str(wav)], check=True)
    return wav


def _enrolled(env, monkeypatch):
    """첫 회의를 전사하고 S1을 홍길동으로 등록한다 → (회의 폴더, enroll 결과)."""
    home, wav = env
    assert run(wav).exit_code == 0
    (d,) = (home / "meetings").iterdir()
    monkeypatch.setattr(cli, "_sync_index_quietly", lambda embed=True: None)
    r = voices_cmd("enroll", d.name[-6:], "S1", "--name", "홍길동", "--consent")
    assert r.exit_code == 0, r.output
    return d, json.loads(r.stdout)


def test_enroll_requires_consent(env, fake_asr, fake_diar, fake_voice):
    home, wav = env
    assert run(wav).exit_code == 0
    (d,) = (home / "meetings").iterdir()
    r = voices_cmd("enroll", d.name[-6:], "S1", "--name", "홍길동")
    assert r.exit_code == 2 and "동의" in r.stderr and "제23조" in r.stderr
    assert not (home / "voices.json").exists() and fake_voice.calls == 0


def test_enroll_renames_and_stores_0600_profile_without_leaking_vectors(env, fake_asr, fake_diar, fake_voice, monkeypatch):
    home, _ = env
    d, out = _enrolled(env, monkeypatch)
    assert out["name"] == "홍길동" and out["samples"] == 1 and len(out["person_id"]) == 26
    assert (home / "voices.json").stat().st_mode & 0o777 == 0o600
    t = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
    assert t["speakers"]["S1"] == {"name": "홍길동"}
    assert fake_voice.calls == 2  # S1 구간 2개 (0–2초, 6–8초)
    assert not any("embedding" in p.read_text(encoding="utf-8", errors="replace") for p in d.iterdir() if p.is_file())

    again = voices_cmd("enroll", d.name[-6:], "S1", "--name", "홍길동", "--consent")
    assert json.loads(again.stdout)["samples"] == 2 and json.loads(again.stdout)["person_id"] == out["person_id"]
    listed = json.loads(voices_cmd("list", "--json").stdout)
    assert listed["reenroll"] is False
    assert listed["people"] == [{"id": out["person_id"], "name": "홍길동", "samples": 2, "created_at": listed["people"][0]["created_at"]}]
    human = voices_cmd("list")
    assert human.exit_code == 0 and "홍길동" in human.stdout and "embedding" not in human.output


def test_enroll_rejects_unknown_label_and_speaker_without_clips(env, fake_asr, fake_diar, fake_voice, monkeypatch):
    home, wav = env
    assert run(wav).exit_code == 0
    (d,) = (home / "meetings").iterdir()
    assert voices_cmd("enroll", d.name[-6:], "S9", "--name", "홍길동", "--consent").exit_code == 1
    monkeypatch.setattr(cli.voices, "MIN_CLIP_S", 5.0)
    r = voices_cmd("enroll", d.name[-6:], "S1", "--name", "홍길동", "--consent")
    assert r.exit_code == 1 and "초 이상" in r.stderr and not (home / "voices.json").exists()
    assert json.loads((d / "transcript.json").read_text(encoding="utf-8"))["speakers"]["S1"]["name"] is None  # 실패하면 이름도 그대로


def test_transcribe_suggests_enrolled_voice_without_displaying_it(env, fake_asr, fake_diar, fake_voice, monkeypatch, tmp_path):
    home, _ = env
    d1, out = _enrolled(env, monkeypatch)
    result = CliRunner().invoke(cli.app, ["transcribe", str(another_wav(tmp_path)), "--progress-json"])
    assert result.exit_code == 0, result.output
    stages = [e["stage"] for e in events(result.stdout) if e["event"] == "stage"]
    assert stages[:6] == ["decode", "vad", "diarize", "voices", "encode", "load_model"]
    (d2,) = [p for p in (home / "meetings").iterdir() if p != d1]
    t = json.loads((d2 / "transcript.json").read_text(encoding="utf-8"))
    sugg = {k: v["suggested"] for k, v in t["speakers"].items() if "suggested" in v}
    assert list(sugg.values()) == [{"person_id": out["person_id"], "name": "홍길동", "score": 1.0}]  # 1:1이라 한 화자만
    assert all(v["name"] is None for v in t["speakers"].values())
    assert "홍길동" not in (d2 / "transcript.md").read_text(encoding="utf-8") + (d2 / "transcript.vtt").read_text(encoding="utf-8")
    (label,) = sugg
    listed = json.loads(speakers(d2.name[-6:], "list", "--json").stdout)
    assert next(r for r in listed["speakers"] if r["label"] == label)["suggested"]["name"] == "홍길동"
    assert next(r for r in listed["speakers"] if r["label"] == label)["display"] == label

    assert speakers(d2.name[-6:], "dismiss", label).exit_code == 0
    sp = json.loads((d2 / "transcript.json").read_text(encoding="utf-8"))["speakers"]
    assert "suggested" not in sp[label] and sp[label]["dismissed"] == [out["person_id"]]
    m = voices_cmd("match", d2.name[-6:])  # 거절한 사람은 같은 참석자에 다시 제안하지 않는다 (다른 참석자에는 제안할 수 있다)
    assert m.exit_code == 0, m.output
    sp = json.loads((d2 / "transcript.json").read_text(encoding="utf-8"))["speakers"]
    assert "suggested" not in sp[label] and sp[label]["dismissed"] == [out["person_id"]]
    assert json.loads(m.stdout) == {"suggested": 1} and sum("suggested" in v for v in sp.values()) == 1
    assert speakers(d2.name[-6:], "rename", label, "홍길동").exit_code == 0  # 앱의 '확정'
    assert json.loads((d2 / "transcript.json").read_text(encoding="utf-8"))["speakers"][label] == {"name": "홍길동", "dismissed": [out["person_id"]]}
    assert json.loads(voices_cmd("match", d2.name[-6:]).stdout) == {"suggested": 0}  # 확정된 화자·이미 쓰인 이름은 다시 제안하지 않는다


def test_forget_deletes_person_and_their_suggestions(env, fake_asr, fake_diar, fake_voice, monkeypatch, tmp_path):
    home, _ = env
    d1, out = _enrolled(env, monkeypatch)
    assert run(another_wav(tmp_path)).exit_code == 0
    (d2,) = [p for p in (home / "meetings").iterdir() if p != d1]
    assert "suggested" in (d2 / "transcript.json").read_text(encoding="utf-8")
    r = voices_cmd("forget", "홍길동")
    assert r.exit_code == 0 and json.loads(r.stdout) == {"forgotten": 1}
    assert json.loads((home / "voices.json").read_text(encoding="utf-8"))["people"] == []
    assert "suggested" not in (d2 / "transcript.json").read_text(encoding="utf-8")
    assert json.loads((d1 / "transcript.json").read_text(encoding="utf-8"))["speakers"]["S1"] == {"name": "홍길동"}  # 확정한 이름은 남는다
    assert json.loads(voices_cmd("forget", out["person_id"]).stdout) == {"forgotten": 0}


def test_resume_keeps_suggestions_without_re_embedding(env, fake_asr, fake_diar, fake_voice, monkeypatch, tmp_path):
    home, _ = env
    d1, _ = _enrolled(env, monkeypatch)
    calls = fake_voice.calls
    wav = another_wav(tmp_path)
    fake_asr.fail_at = len(fake_asr.calls) + 1
    assert run(wav).exit_code == 130
    after_first = fake_voice.calls
    assert after_first > calls
    fake_asr.fail_at = None
    assert run(wav).exit_code == 0
    assert fake_voice.calls == after_first
    (d2,) = [p for p in (home / "meetings").iterdir() if p != d1]
    assert "suggested" in (d2 / "transcript.json").read_text(encoding="utf-8")


def test_no_profiles_means_no_voices_stage_or_warning(env, fake_asr, fake_diar, fake_voice):
    _, wav = env
    result = CliRunner().invoke(cli.app, ["transcribe", str(wav), "--progress-json"])
    assert result.exit_code == 0
    ev = events(result.stdout)
    assert "voices" not in [e.get("stage") for e in ev] and not [e for e in ev if e.get("code", "").startswith("voices")]
    assert fake_voice.calls == 0


def test_voices_model_missing_or_failing_warns_and_transcription_continues(env, fake_asr, fake_diar, fake_voice, monkeypatch, tmp_path):
    home, _ = env
    _enrolled(env, monkeypatch)
    monkeypatch.setattr(cli.voices, "load_embedder", lambda models: None)
    r = CliRunner().invoke(cli.app, ["transcribe", str(another_wav(tmp_path)), "--progress-json"])
    assert r.exit_code == 0, r.output
    (w,) = [e for e in events(r.stdout) if e.get("code", "").startswith("voices")]
    assert w["code"] == "voices_model_missing" and "curl" in w["message"] and cli.voices.MODEL_DIR in w["message"]

    class Broken:
        def embed(self, pcm):
            raise RuntimeError("boom")

    monkeypatch.setattr(cli.voices, "load_embedder", lambda models: Broken())
    r = CliRunner().invoke(cli.app, ["transcribe", str(another_wav(tmp_path, "세번째.wav", 990)), "--progress-json"])
    assert r.exit_code == 0, r.output
    assert [e["code"] for e in events(r.stdout) if e.get("code", "").startswith("voices")] == ["voices_failed"]
    assert len(list((home / "meetings").glob("*/transcript.json"))) == 3


def test_voices_list_flags_profiles_from_another_model(env):
    home, _ = env
    (home / "voices.json").write_text(json.dumps({"version": 1, "model": "old", "people": [
        {"id": "P1", "name": "홍길동", "created_at": "2026-10-01T10:00:00+09:00", "consent": True, "samples": [{"embedding": [1.0], "meeting_id": "m", "added_at": "x"}]}]}))
    listed = json.loads(voices_cmd("list", "--json").stdout)
    assert listed["reenroll"] is True and listed["people"][0]["samples"] == 1
    assert "다시 등록" in voices_cmd("list").stderr
