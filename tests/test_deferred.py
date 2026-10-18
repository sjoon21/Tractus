"""녹음과 변환 나누기: `tractus recording finish`(변환 전 노트)와 `tractus transcribe --into` (docs/desktop.md §2.16).
가짜 ASR·화자 분리, 실제 FFmpeg. 마지막 `slow` 테스트만 실제 모델을 쓴다."""

import json
import os
import shutil
import signal
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import anyio
import pytest
from mcp import Client
from typer.testing import CliRunner

from tractus import cli, deferred, notes, organize
from tractus.index import Index
from tractus.mcp_server import build_server
from tractus.store import edit_transcript, find_job, find_meeting_dir, read_transcript

from test_cli import FakeTranscriber, env, events, fake_asr, fake_diar, make_recording  # noqa: F401 (fixture)

REC_NAME = "01RECORDING0000000000000000"


def finish(rec, *extra):
    return CliRunner().invoke(cli.app, ["recording", "finish", str(rec), "--progress-json", *extra])


def convert(ref, *extra):
    return CliRunner().invoke(cli.app, ["transcribe", "--into", ref, "--progress-json", *extra])


def cli_run(*args, input=None):
    return CliRunner().invoke(cli.app, [*map(str, args)], input=input)


def saved(tmp_path, marks=None, *extra):
    """녹음 폴더를 만들어 변환 전 노트로 저장한다 → (노트 폴더, transcript.json)."""
    rec = make_recording(tmp_path, marks=marks)
    r = finish(rec, *extra)
    assert r.exit_code == 0, r.output
    d = Path(events(r.stdout)[-1]["meeting_dir"])
    return d, read_transcript(d)


def saved_from(rec: Path) -> tuple[Path, dict]:
    r = finish(rec)
    assert r.exit_code == 0, r.output
    d = Path(events(r.stdout)[-1]["meeting_dir"])
    return d, read_transcript(d)


def files(d: Path) -> list[str]:
    return sorted(p.name for p in d.iterdir() if p.name != ".lock")  # .lock은 note_lock이 만든다


def notes_in(home: Path) -> list[Path]:
    return sorted(p for p in (home / "meetings").iterdir() if p.is_dir())


# ── recording finish ──────────────────────────────────────────────────


def test_finish_saves_a_recorded_note_without_converting(env, fake_asr, tmp_path):
    home, _ = env
    rec = make_recording(tmp_path)
    r = finish(rec)
    assert r.exit_code == 0, r.output
    ev = events(r.stdout)
    assert [e["stage"] for e in ev if e["event"] == "stage"] == ["decode", "encode"] and ev[-1]["event"] == "done"
    assert fake_asr.calls == [] and not rec.exists()  # 변환하지 않았고 녹음 폴더는 비워졌다

    (d,) = notes_in(home)
    assert Path(ev[-1]["meeting_dir"]) == d and ev[-1]["meeting_id"] == read_transcript(d)["meeting_id"]
    assert files(d) == ["audio.ogg", "memos.json", "tracks", "transcript.json", "transcript.md"]  # vtt·표시 파일 없음
    assert sorted(p.name for p in (d / "tracks").iterdir()) == ["mic.wav", "recording.json", "system.wav"]
    t = read_transcript(d)
    hhmm = datetime.fromisoformat("2026-10-02T14:00:00+09:00").astimezone().strftime("%H:%M")
    assert t["state"] == "recorded" and "kind" not in t and t["segments"] == [] and t["speakers"] == {} and t["diarization"] is None and "asr" not in t
    assert t["title"] == f"녹음 {hhmm}" and t["created_at"].startswith("2026-10-02T14:00:00") and d.name.startswith(f"2026-10-02_녹음_{hhmm.replace(':', '_')}_")
    assert t["audio"]["file"] == "audio.ogg" and t["audio"]["duration_sec"] == 8.0 and t["audio"]["source"] == REC_NAME and len(t["audio"]["sha256"]) == 64
    assert (d / "audio.ogg").stat().st_size > 0
    assert json.loads((d / "memos.json").read_text(encoding="utf-8"))[0] == {"t": 3.5, "kind": "memo", "text": "예산 다시 확인"}
    md = (d / "transcript.md").read_text(encoding="utf-8")
    assert "state: recorded" in md and "asr_model" not in md and "아직 텍스트로 변환하지 않았습니다." in md and "[00:00:03] (메모) 예산 다시 확인" in md and "[00:00:06] (북마크)" in md


def test_finish_keeps_the_pauses_of_recording_json_in_tracks(env, tmp_path):
    rec = make_recording(tmp_path)
    info = json.loads((rec / "recording.json").read_text(encoding="utf-8"))
    pauses = [{"at": 4.0, "wall_start": "2026-10-02T14:00:04+09:00", "wall_end": "2026-10-02T14:20:04+09:00"}]  # 일시정지는 WAV에서 이미 빠져 있다 (오디오 시계)
    (rec / "recording.json").write_text(json.dumps({**info, "pauses": pauses}), encoding="utf-8")
    d, t = saved_from(rec)
    assert json.loads((d / "tracks" / "recording.json").read_text(encoding="utf-8"))["pauses"] == pauses
    assert t["audio"]["duration_sec"] == 8.0 and t["created_at"].startswith("2026-10-02T14:00:00")


def test_finish_prints_json_without_progress_flag_and_takes_a_title(env, tmp_path):
    home, _ = env
    rec = make_recording(tmp_path, marks=[])
    r = cli_run("recording", "finish", rec, "--title", "  주간   점검 ")
    assert r.exit_code == 0, r.output
    out = json.loads(r.stdout.strip().splitlines()[-1])
    (d,) = notes_in(home)
    assert out == {"meeting_id": read_transcript(d)["meeting_id"], "meeting_dir": str(d.resolve())}
    assert read_transcript(d)["title"] == "주간 점검" and not (d / "memos.json").exists()


def test_finish_rejects_bad_input_without_writing(env, tmp_path):
    home, _ = env
    rec = make_recording(tmp_path)
    r = finish(rec, "--title", "가" * 121)
    assert r.exit_code == 2 and events(r.stdout)[-1]["code"] == "bad_input"
    r = finish(tmp_path / "없는 폴더")
    assert r.exit_code == 2 and events(r.stdout)[-1]["code"] == "recording_missing"
    for name in ("mic.wav", "system.wav"):  # 소리 없는 녹음 (헤더만)
        (rec / name).write_bytes((rec / name).read_bytes()[:44])
    r = finish(rec)
    assert r.exit_code == 2 and events(r.stdout)[-1]["code"] == "recording_missing"
    assert notes_in(home) == [] and (rec / "recording.json").is_file()  # 아무것도 만들지 않았고 녹음은 그대로


def test_finish_without_ffmpeg_reports_code(env, tmp_path, monkeypatch):
    monkeypatch.setattr("shutil.which", lambda name: None)
    rec = make_recording(tmp_path)
    r = finish(rec)
    assert r.exit_code == 1 and events(r.stdout)[-1]["code"] == "ffmpeg_missing" and (rec / "mic.wav").is_file()


def test_finish_resumes_after_a_crash_before_the_note_is_complete(env, tmp_path, monkeypatch):
    home, _ = env
    rec = make_recording(tmp_path)
    real = deferred.save_transcript

    def boom(*a, **k):
        raise RuntimeError("kill -9")

    monkeypatch.setattr(deferred, "save_transcript", boom)  # 트랙을 복사한 뒤, transcript.json을 쓰기 직전에 끊김
    assert finish(rec).exit_code == 1
    (d,) = notes_in(home)
    assert not (d / "transcript.json").exists() and organize.list_notes(home) == []  # 아직 노트가 아니다 (목록에 없다)
    assert sorted(p.name for p in rec.iterdir()) == ["mic.wav", "recording.json", "system.wav"]  # 녹음 폴더는 온전하다 (앱의 `변환 대기 중인 녹음`에 그대로 보인다)
    assert (d / "tracks" / "mic.wav").is_file() and (d / "tracks" / "recording.json").is_file()

    monkeypatch.setattr(deferred, "save_transcript", real)
    r = finish(rec)
    assert r.exit_code == 0, r.output
    assert notes_in(home) == [d] and not rec.exists() and not (d / ".finish.json").exists()  # 같은 폴더에서 이어서 끝냈다
    t = read_transcript(d)
    assert t["state"] == "recorded" and len(t["audio"]["sha256"]) == 64 and t["audio"]["duration_sec"] == 8.0
    assert sorted(p.name for p in (d / "tracks").iterdir()) == ["mic.wav", "recording.json", "system.wav"]


def test_finish_resumes_after_an_encode_failure_and_keeps_the_recording(env, tmp_path, monkeypatch):
    home, _ = env
    rec = make_recording(tmp_path)
    real = deferred.audio.encode_opus
    monkeypatch.setattr(deferred.audio, "encode_opus", lambda *a: (_ for _ in ()).throw(cli.audio.FFmpegError("끊김")))
    r = finish(rec)
    assert r.exit_code == 1 and events(r.stdout)[-1]["code"] == "audio_failed"
    assert (rec / "mic.wav").is_file() and (rec / "system.wav").is_file() and (rec / "recording.json").is_file()  # 녹음은 그대로

    monkeypatch.setattr(deferred.audio, "encode_opus", real)
    assert finish(rec).exit_code == 0
    assert len(notes_in(home)) == 1 and read_transcript(notes_in(home)[0])["state"] == "recorded"


def test_finish_is_idempotent_when_only_the_cleanup_was_left(env, tmp_path, monkeypatch):
    home, _ = env
    rec = make_recording(tmp_path)
    real = deferred._cleanup
    monkeypatch.setattr(deferred, "_cleanup", lambda *a: (_ for _ in ()).throw(RuntimeError("kill -9")))
    assert finish(rec).exit_code == 1  # transcript.json까지 쓰고 녹음 폴더를 지우기 전에 끊김
    (d,) = notes_in(home)
    mid = read_transcript(d)["meeting_id"]
    monkeypatch.setattr(deferred, "_cleanup", real)
    r = finish(rec)
    assert r.exit_code == 0 and events(r.stdout)[-1]["meeting_id"] == mid and notes_in(home) == [d] and not rec.exists()


# ── transcribe --into ────────────────────────────────────────────────


def test_convert_fills_the_note_in_place(env, fake_asr, tmp_path):
    home, _ = env
    d, before = saved(tmp_path)
    audio_bytes = (d / "audio.ogg").read_bytes()
    r = convert(before["meeting_id"][-6:], "--track", "lite", "-t", "김철수")
    assert r.exit_code == 0, r.output
    ev = events(r.stdout)
    stages = [e["stage"] for e in ev if e["event"] == "stage"]
    assert stages[:3] == ["decode", "vad", "load_model"] and "encode" not in stages and "transcribe" in stages  # 이미 audio.ogg가 있어 다시 만들지 않는다
    assert [e for e in ev if e["event"] == "progress"][-1] == {"event": "progress", "done": 3, "total": 3}
    assert ev[-1] == {"event": "done", "meeting_id": before["meeting_id"], "meeting_dir": str(d)}
    assert notes_in(home) == [d]

    t = read_transcript(d)
    assert "state" not in t and [s["text"] for s in t["segments"]] == ["청크0", "청크1", "청크2"] and t["asr"]["model"] == cli.MODELS[cli.Track.lite] and t["asr"]["hotwords"] == ["김철수", "WTO"]
    assert (t["meeting_id"], t["title"], t["created_at"]) == (before["meeting_id"], before["title"], before["created_at"]) and t["audio"] == before["audio"]
    assert (d / "audio.ogg").read_bytes() == audio_bytes and not (d / "tracks").exists()  # 트랙은 변환이 끝나면 지워진다
    assert files(d) == ["audio.ogg", "memos.json", "transcript.json", "transcript.md", "transcript.vtt"]
    md = (d / "transcript.md").read_text(encoding="utf-8")
    assert "asr_model:" in md and "state:" not in md and "[00:00:03] (메모) 예산 다시 확인" in md and "청크1" in md
    assert fake_asr.calls[0]["samples"] == 2 * 16000


def test_convert_keeps_tracks_on_request(env, fake_asr, tmp_path):
    d, t = saved(tmp_path)
    assert convert(t["meeting_id"], "--keep-tracks").exit_code == 0
    assert sorted(p.name for p in (d / "tracks").iterdir()) == ["mic.wav", "recording.json", "system.wav"] and "state" not in read_transcript(d)


def test_converted_note_equals_the_direct_path_result(env, fake_asr, tmp_path, monkeypatch):
    home, _ = env
    d, saved_t = saved(tmp_path / "a")
    assert convert(saved_t["meeting_id"], "--track", "lite").exit_code == 0
    a = read_transcript(d)

    home2 = tmp_path / "home2"  # 같은 녹음을 바로 변환한 결과 (같은 원본이라 중복으로 걸리지 않게 다른 홈에서)
    shutil.copytree(home / "models", home2 / "models")
    shutil.copy(home / "glossary.md", home2 / "glossary.md")
    monkeypatch.setenv("TRACTUS_HOME", str(home2))
    fake_asr.calls = []
    rec = make_recording(tmp_path / "b")
    assert CliRunner().invoke(cli.app, ["transcribe", "--recording", str(rec), "--track", "lite", "--progress-json"]).exit_code == 0
    (d2,) = notes_in(home2)
    b = read_transcript(d2)
    drop = lambda t: {k: v for k, v in t.items() if k not in ("meeting_id", "updated_at")}  # noqa: E731
    assert drop(a) == drop(b) and a["segments"] == b["segments"]
    assert json.loads((d / "memos.json").read_text(encoding="utf-8")) == json.loads((d2 / "memos.json").read_text(encoding="utf-8"))
    assert files(d) == files(d2)  # 파일 구성도 같다


def test_convert_with_diarization_speakers_and_words(env, fake_asr, fake_diar, tmp_path):
    d, t = saved(tmp_path)
    r = convert(t["meeting_id"], "--max-speakers", "3")
    assert r.exit_code == 0, r.output
    new = read_transcript(d)
    assert [s["speaker"] for s in new["segments"]] == ["S1", "S2", "S1"] and new["speakers"] == {"S1": {"name": None}, "S2": {"name": None}} and new["diarization"]["model"] == "fake"
    assert fake_diar.calls == [3] and "**참석자 2**: 청크1" in (d / "transcript.md").read_text(encoding="utf-8")


def test_convert_resumes_after_an_interruption(env, fake_asr, tmp_path):
    home, wav = env
    d, t = saved(tmp_path)
    fake_asr.fail_at = 2
    r = convert(t["meeting_id"])
    assert r.exit_code == 130 and events(r.stdout)[-1]["code"] == "interrupted"
    assert (d / ".job.json").is_file() and json.loads((d / ".job.json").read_text(encoding="utf-8"))["convert"] is True
    assert read_transcript(d)["state"] == "recorded" and (d / "tracks" / "mic.wav").is_file()  # 노트는 그대로 변환 전
    sha = t["audio"]["sha256"]
    assert find_job(home / "meetings", sha, into=t["meeting_id"]) is not None
    assert find_job(home / "meetings", sha) is None and find_job(home / "meetings", sha, t["meeting_id"]) is None  # 새 노트·덧붙이기 작업과 섞이지 않는다
    find_meeting_dir(home / "meetings", t["meeting_id"])  # 노트를 여는 일이 진행 중인 작업 파일을 지우지 않는다
    assert (d / ".job.json").is_file()

    fake_asr.fail_at = None
    fake_asr.calls = []
    r = convert(t["meeting_id"])
    assert r.exit_code == 0, r.output
    assert len(fake_asr.calls) == 1  # 끝나지 않은 청크만
    assert "vad" not in [e.get("stage") for e in events(r.stdout)]  # VAD·화자 분리는 다시 하지 않는다
    new = read_transcript(d)
    assert "state" not in new and [s["text"] for s in new["segments"]] == ["청크0", "청크1", "청크0"]  # 청크0, 청크1은 처음 실행에서, 마지막은 다시 시작한 호출
    assert not (d / ".job.json").exists() and not (d / ".chunks.jsonl").exists() and not (d / "tracks").exists()


def test_a_second_direct_transcribe_of_the_same_audio_is_not_taken_over_by_a_pending_convert(env, fake_asr, tmp_path):
    home, _ = env
    d, t = saved(tmp_path)
    fake_asr.fail_at = 1
    assert convert(t["meeting_id"]).exit_code == 130
    fake_asr.fail_at = None
    rec = make_recording(tmp_path / "again")  # 같은 소리의 새 녹음 폴더를 바로 변환
    r = CliRunner().invoke(cli.app, ["transcribe", "--recording", str(rec), "--progress-json"])
    assert r.exit_code == 0, r.output
    assert events(r.stdout)[-1]["meeting_dir"] != str(d) and read_transcript(d)["state"] == "recorded"  # 변환 전 노트는 그대로


class EditingTranscriber(FakeTranscriber):
    hook = None

    def transcribe(self, audio, language=None, hotwords=None):
        if EditingTranscriber.hook and len(FakeTranscriber.calls) == 1:
            EditingTranscriber.hook()
        return super().transcribe(audio, language, hotwords)


def test_edits_made_while_converting_survive(env, fake_asr, tmp_path, monkeypatch):
    home, _ = env
    d, t = saved(tmp_path)
    cli_run("note", "save", t["meeting_id"], input=json.dumps({"body": "예산\n\n견적"}))
    monkeypatch.setattr(cli, "Transcriber", EditingTranscriber)

    def edit():  # 변환 중에 앱이 메모·제목·태그를 고친다
        edit_transcript(d, lambda cur: (notes.apply_title(notes.apply_body(cur, "예산\n\n견적\n\n새 줄")[0], "바뀐 제목"), None))
        organize.set_note_meta(home, d, {"favorite": True, "tags": ["회의"]})

    EditingTranscriber.hook = edit
    try:
        r = convert(t["meeting_id"])
    finally:
        EditingTranscriber.hook = None
    assert r.exit_code == 0, r.output
    new = read_transcript(d)
    assert "state" not in new and [s["text"] for s in new["segments"]] == ["청크0", "청크1", "청크2"]
    assert new["title"] == "바뀐 제목" and new["favorite"] is True and new["tags"] == ["회의"]
    assert new["memo"]["body"] == "예산\n\n견적\n\n새 줄" and [m["text"] for m in new["memo"]["lines"]] == ["예산", "견적", "새 줄"]
    md = (d / "transcript.md").read_text(encoding="utf-8")
    assert "# 바뀐 제목" in md and "## 메모" in md and "새 줄" in md
    assert [m["id"] for m in new["memo"]["lines"]] == ["m0001", "m0002", "m0003"]


def test_convert_falls_back_to_audio_ogg_when_tracks_are_gone(env, fake_asr, tmp_path):
    d, t = saved(tmp_path)
    shutil.rmtree(d / "tracks")
    audio_bytes = (d / "audio.ogg").read_bytes()
    r = convert(t["meeting_id"])
    assert r.exit_code == 0, r.output
    warn = [e for e in events(r.stdout) if e["event"] == "warning"]
    assert warn[0]["code"] == "tracks_missing" and "audio.ogg" in warn[0]["message"]
    new = read_transcript(d)
    assert "state" not in new and len(new["segments"]) == 3 and new["audio"]["sha256"] == t["audio"]["sha256"]  # 저장할 때 잰 원본 해시를 그대로 둔다
    assert (d / "audio.ogg").read_bytes() == audio_bytes  # audio.ogg를 자기 자신으로 다시 만들지 않는다


def test_convert_without_tracks_or_audio_reports_recording_missing(env, fake_asr, tmp_path):
    d, t = saved(tmp_path)
    shutil.rmtree(d / "tracks")
    (d / "audio.ogg").unlink()
    r = convert(t["meeting_id"])
    assert r.exit_code == 2 and events(r.stdout)[-1]["code"] == "note_audio_missing" and read_transcript(d)["state"] == "recorded"  # 마이크 안내(recording_missing)가 아니다


def test_finish_reports_a_disk_error_and_keeps_the_recording_visible(env, tmp_path, monkeypatch):
    home, _ = env
    rec = make_recording(tmp_path)
    real = deferred.save_transcript
    monkeypatch.setattr(deferred, "save_transcript", lambda *a, **k: (_ for _ in ()).throw(OSError(28, "No space left on device")))
    r = finish(rec)
    assert r.exit_code == 1 and not isinstance(r.exception, OSError)  # 트레이스백이 아니라 오류 이벤트
    ev = events(r.stdout)[-1]
    assert ev["event"] == "error" and "No space left" in ev["message"]
    assert (rec / "recording.json").is_file()  # 앱의 남은 녹음 목록(recording.json이 있는 폴더)에서 사라지지 않는다
    monkeypatch.setattr(deferred, "save_transcript", real)
    assert finish(rec).exit_code == 0 and not rec.exists() and len(notes_in(home)) == 1


def test_convert_refuses_notes_that_are_not_recorded(env, fake_asr, tmp_path):
    home, wav = env
    memo_dir, memo = notes.create_memo(home / "meetings", "장보기", "우유")
    r = convert(memo["meeting_id"])
    assert r.exit_code == 2 and events(r.stdout)[-1] == {"event": "error", "message": deferred.NOT_RECORDED_MEMO, "code": "not_recorded"}
    assert CliRunner().invoke(cli.app, ["transcribe", str(wav), "--progress-json"]).exit_code == 0
    done = next(p for p in notes_in(home) if p != memo_dir)
    r = convert(read_transcript(done)["meeting_id"])
    assert r.exit_code == 2 and events(r.stdout)[-1]["code"] == "not_recorded" and events(r.stdout)[-1]["message"] == deferred.NOT_RECORDED_CONVERTED
    assert len(read_transcript(done)["segments"]) == 3  # 변환 전이 아니면 아무것도 바꾸지 않는다
    r = convert("01NOPE")
    assert r.exit_code == 2 and events(r.stdout)[-1]["event"] == "error" and "code" not in events(r.stdout)[-1]


def test_convert_rejects_conflicting_options(env, fake_asr, tmp_path):
    home, wav = env
    d, t = saved(tmp_path)
    assert CliRunner().invoke(cli.app, ["transcribe", str(wav), "--into", t["meeting_id"]]).exit_code == 2
    assert CliRunner().invoke(cli.app, ["transcribe", "--into", t["meeting_id"], "--append-to", t["meeting_id"]]).exit_code == 2
    assert read_transcript(d)["state"] == "recorded"


def test_a_recorded_note_cannot_be_the_target_of_append(env, fake_asr, tmp_path):
    home, wav = env
    d, t = saved(tmp_path)
    r = CliRunner().invoke(cli.app, ["transcribe", str(wav), "--append-to", t["meeting_id"], "--progress-json"])
    assert r.exit_code == 2 and events(r.stdout)[-1]["code"] == "append_has_audio"


def test_convert_does_not_overwrite_a_note_converted_by_another_run(env, fake_asr, tmp_path, monkeypatch):
    d, t = saved(tmp_path)
    monkeypatch.setattr(cli, "Transcriber", EditingTranscriber)
    EditingTranscriber.hook = lambda: edit_transcript(d, lambda cur: ({k: v for k, v in cur.items() if k != "state"}, None))  # 다른 실행이 먼저 끝냈다
    try:
        r = convert(t["meeting_id"])
    finally:
        EditingTranscriber.hook = None
    assert r.exit_code == 2 and events(r.stdout)[-1]["code"] == "not_recorded" and read_transcript(d)["segments"] == []


# ── 소비자: 변환 전 노트 (대화 0개, 오디오 있음) ──────────────────────────


@pytest.fixture
def recorded(env, tmp_path, monkeypatch):
    """메모가 있는 변환 전 노트 하나. 검색 색인 갱신은 테스트가 직접 한다."""
    home, _ = env
    d, t = saved(tmp_path)
    assert cli_run("note", "save", t["meeting_id"], input=json.dumps({"body": "예산은 동결합니다\n견적은 김철수 님이"})).exit_code == 0
    return SimpleNamespace(home=home, d=d, id=t["meeting_id"], t=read_transcript(d))


def test_index_and_search_cover_only_the_memo(recorded):
    idx = Index(recorded.home)
    assert not idx.sync(embed=False).errors and idx.stats()["meetings"] == 1
    assert idx.search("동결").hits[0].source == "memo" and not idx.search("청크").hits
    idx.close()


def test_search_cli_does_not_crash_on_a_recorded_note(recorded, monkeypatch):
    monkeypatch.setenv("TRACTUS_MODELS_DIR", str(recorded.home / "no-models"))
    r = cli_run("search", "동결")
    assert r.exit_code == 0, r.output
    assert "메모 1번째 줄" in r.stdout


def test_summarize_refuses_a_recorded_note(recorded):
    r = CliRunner().invoke(cli.app, ["summarize", recorded.id, "--progress-json"])
    assert r.exit_code == 2
    assert events(r.stdout)[-1] == {"event": "error", "message": "먼저 텍스트로 변환하세요.", "code": "not_converted"}
    assert not (recorded.d / "summary.json").exists()


def test_ask_on_a_recorded_note_without_a_memo_does_not_call_the_llm(env, tmp_path, monkeypatch):
    home, _ = env
    d, t = saved(tmp_path)
    monkeypatch.setenv("UPSTAGE_API_KEY", "k")
    monkeypatch.setattr(cli, "_sync_index_quietly", lambda embed=True: None)
    class NoLLM:
        @property
        def chat(self):
            raise AssertionError("LLM을 부르면 안 된다")

    monkeypatch.setattr(cli, "make_client", lambda p: NoLLM())
    r = CliRunner().invoke(cli.app, ["ask", "--meeting", t["meeting_id"], "--provider", "upstage", "--progress-json"], input="예산은?")
    assert r.exit_code == 0, r.output
    ev = events(r.stdout)
    assert {"event": "warning", "code": "not_converted", "message": "먼저 텍스트로 변환하세요."} in ev
    assert ev[-1]["event"] == "done" and ev[-1]["no_evidence"] is True and ev[-1]["provider"] is None and ev[-1]["citations"] == []


def test_ask_on_a_recorded_note_uses_the_memo_as_evidence(recorded, monkeypatch):
    monkeypatch.setenv("UPSTAGE_API_KEY", "k")
    monkeypatch.setattr(cli, "_sync_index_quietly", lambda embed=True: None)
    stream = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kw: iter([
        SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content="동결합니다 [m0001]."))]),
    ]))))
    monkeypatch.setattr(cli, "make_client", lambda p: stream)
    r = CliRunner().invoke(cli.app, ["ask", "--meeting", recorded.id, "--provider", "upstage", "--progress-json"], input="예산은?")
    assert r.exit_code == 0, r.output
    ev = events(r.stdout)
    assert ev[-1]["citations"][0]["segment_id"] == "m0001" and not [e for e in ev if e["event"] == "warning"]


@pytest.mark.parametrize("fmt", ["txt", "md", "csv", "docx", "bundle"])
def test_exports_work_with_an_empty_transcript_and_the_memo(recorded, tmp_path, fmt):
    out = tmp_path / f"out.{fmt}"
    r = cli_run("export", recorded.id, "--format", fmt, "--out", out)
    assert r.exit_code == 0, r.output
    assert out.stat().st_size > 0
    if fmt == "txt":
        text = out.read_text(encoding="utf-8")
        assert recorded.t["title"] in text and "메모" in text and "예산은 동결합니다" in text and "[00:" not in text
    if fmt == "csv":
        assert "메모 1번째 줄" in out.read_text(encoding="utf-8-sig") and "[00:" not in out.read_text(encoding="utf-8-sig")
    if fmt == "md":
        assert "state: recorded" in out.read_text(encoding="utf-8")
    if fmt == "bundle":
        import zipfile

        names = zipfile.ZipFile(out).namelist()
        assert any(n.endswith("/audio.ogg") for n in names) and any(n.endswith("/transcript.json") for n in names) and not any("tracks" in n for n in names)
    if fmt == "docx":
        import docx

        paras = [p.text for p in docx.Document(str(out)).paragraphs]
        assert "대화 내용" in paras and "예산은 동결합니다" in paras


@pytest.mark.parametrize("fmt", ["srt", "vtt"])
def test_subtitle_exports_are_refused(recorded, tmp_path, fmt):
    out = tmp_path / f"out.{fmt}"
    r = cli_run("export", recorded.id, "--format", fmt, "--out", out)
    assert r.exit_code == 2 and "아직 텍스트로 변환하지 않아 자막 파일로 내보낼 수 없습니다." in r.output and not out.exists()


def test_mcp_lists_state_and_explains_the_missing_transcript(recorded):
    srv = build_server(recorded.home, None)

    async def go(tool, args=None):
        async with Client(srv) as c:
            return await c.call_tool(tool, args or {})

    listed = anyio.run(go, "list_meetings").structured_content["meetings"]
    assert listed[0]["state"] == "recorded" and listed[0]["segments"] == 0 and listed[0]["kind"] == "recording" and listed[0]["duration_sec"] == 8.0
    text = "".join(c.text for c in anyio.run(go, "get_transcript", {"meeting_id": recorded.id}).content)
    assert "변환 전" in text and "아직 텍스트로 변환하지 않은 노트" in text and "[m0001 메모 1번째 줄] 예산은 동결합니다" in text
    r = anyio.run(go, "save_summary", {"meeting_id": recorded.id, "author": "t", "summary": {"title": "t", "summary": "s", "topics": [], "decisions": [], "action_items": []}})
    assert r.is_error and "텍스트로 변환" in r.content[0].text


def test_notes_list_includes_state(recorded, env):
    rows = json.loads(cli_run("notes", "list", "--json").stdout)["notes"]
    assert [(r["meeting_id"], r["kind"], r["state"], r["duration_sec"]) for r in rows] == [(recorded.id, "recording", "recorded", 8.0)]


def test_notes_list_state_is_null_after_conversion(recorded, fake_asr):
    assert convert(recorded.id).exit_code == 0
    assert json.loads(cli_run("notes", "list", "--json").stdout)["notes"][0]["state"] is None


def test_commands_that_need_a_transcript_refuse_clearly(recorded):
    sentence = "먼저 텍스트로 변환하세요."
    for args in (["align", recorded.id], ["speakers", recorded.id, "rename", "S1", "김"], ["speakers", recorded.id, "set", "s0001", "S1"],
                 ["voices", "enroll", recorded.id, "S1", "--name", "김", "--consent"], ["voices", "match", recorded.id]):
        r = cli_run(*args)
        assert r.exit_code == 2 and sentence in r.output, args
    r = cli_run("segments", recorded.id, "edit", input=json.dumps({"edits": [{"id": "s0001", "text": "x"}]}))
    assert r.exit_code == 2 and sentence in r.output
    assert json.loads(cli_run("speakers", recorded.id, "list", "--json").stdout)["speakers"] == []  # 목록은 그냥 빈 것
    assert read_transcript(recorded.d)["state"] == "recorded"


def test_memo_title_and_meta_work_on_a_recorded_note(recorded):
    assert json.loads(cli_run("note", "save", recorded.id, input=json.dumps({"body": "한 줄"})).stdout) == {"saved": True, "segments": 1, "changed": True, "kind": "recording"}
    assert json.loads(cli_run("note", "title", recorded.id, input=json.dumps({"title": "새 이름"})).stdout) == {"title": "새 이름"}
    assert json.loads(cli_run("note", "meta", recorded.id, input=json.dumps({"favorite": True, "tags": ["a"]})).stdout)["favorite"] is True
    t = read_transcript(recorded.d)
    assert t["state"] == "recorded" and t["title"] == "새 이름" and t["memo"]["lines"][0]["text"] == "한 줄"
    md = (recorded.d / "transcript.md").read_text(encoding="utf-8")
    assert "# 새 이름" in md and "tags: [a]" in md and "state: recorded" in md and "## 메모" in md and "한 줄" in md


def test_render_all_is_idempotent_and_skips_vtt_for_recorded_notes(recorded):
    r1 = cli_run("render", "--all")
    before = (recorded.d / "transcript.md").read_text(encoding="utf-8")
    r2 = cli_run("render", "--all")
    assert json.loads(r1.stdout) == json.loads(r2.stdout) == {"rendered": 1}
    assert (recorded.d / "transcript.md").read_text(encoding="utf-8") == before and not (recorded.d / "transcript.vtt").exists()


def test_recorded_note_folder_holds_everything_for_trash(recorded):
    # 삭제는 폴더째 휴지통으로 가므로 tracks/도 함께 간다 (앱 전용, 코어에 삭제 명령은 없다)
    assert (recorded.d / "tracks" / "mic.wav").is_file() and (recorded.d / "audio.ogg").is_file()


def test_render_markdown_tolerates_missing_asr_block():
    from tractus.store import render_markdown

    t = {"meeting_id": "01X", "title": "t", "created_at": "2026-10-02T14:00:00+09:00", "audio": {"duration_sec": 3}, "segments": [], "speakers": {}}
    assert "asr_model" not in render_markdown(t)  # state가 없어도 asr 블록이 없으면 죽지 않는다


# ── 실제 모델 ─────────────────────────────────────────────────────────


def _say_recording(tmp_path: Path, name: str, text: str, copy_of: Path | None = None) -> Path:
    """macOS say 음성으로 만든 녹음 폴더 (마이크 트랙 하나). copy_of가 있으면 그 녹음을 그대로 복사한다 (두 번 합성하면 바이트가 같지 않을 수 있다)."""
    rec = tmp_path / name / "recordings" / REC_NAME
    if copy_of:
        shutil.copytree(copy_of, rec)
        return rec
    rec.mkdir(parents=True)
    wav = tmp_path / name / "say.wav"
    subprocess.run(["say", "-v", "Yuna", "-o", str(wav), "--data-format=LEI16@16000", text], check=True)
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(wav), "-ar", "48000", "-ac", "1", str(rec / "mic.wav")], check=True)
    (rec / "recording.json").write_text(json.dumps({"schema_version": 1, "started_at": "2026-10-02T14:00:00+09:00", "duration": None, "tracks": {"mic": "mic.wav"}, "marks": []}), encoding="utf-8")
    return rec


def _cli_proc(home: Path, models: Path, *args: str) -> subprocess.Popen:
    e = {**os.environ, "TRACTUS_HOME": str(home), "TRACTUS_MODELS_DIR": str(models)}
    return subprocess.Popen([sys.executable, "-m", "tractus.cli", *args], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=e, cwd=home.parent)


def _kill_after(proc: subprocess.Popen, stage_or_event: str) -> None:
    """stdout 이벤트에서 stage_or_event(stage 이름 또는 event 이름)가 나오면 SIGKILL을 보낸다."""
    for line in proc.stdout:
        e = json.loads(line) if line.startswith("{") else {}
        if e.get("stage") == stage_or_event or e.get("event") == stage_or_event:
            proc.send_signal(signal.SIGKILL)
            break
    proc.wait()


@pytest.mark.slow
def test_real_models_finish_then_convert_equals_the_direct_path(tmp_path, monkeypatch):
    models = Path(os.environ.get("TRACTUS_MODELS_DIR", Path(__file__).resolve().parent.parent / "models")).resolve()  # chdir 뒤에 깨지지 않게 먼저 절대 경로로
    text = "안녕하세요. 오늘은 예산 검토를 합니다. 다음 주 화요일까지 견적서를 제출해 주세요."
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("TRACTUS_MODELS_DIR", str(models))
    monkeypatch.setattr(cli, "_sync_index_quietly", lambda embed=True: None)

    # 바로 변환 (기준)
    home_a = tmp_path / "a" / "home"
    monkeypatch.setenv("TRACTUS_HOME", str(home_a))
    rec_a = _say_recording(tmp_path, "a", text)
    rec_a_copy = tmp_path / "a_copy"
    shutil.copytree(rec_a, rec_a_copy)  # 변환이 녹음 폴더를 지우기 전에 같은 녹음을 따로 둔다
    r = CliRunner().invoke(cli.app, ["transcribe", "--recording", str(rec_a), "--track", "lite", "--progress-json"])
    assert r.exit_code == 0, r.output
    (da,) = notes_in(home_a)
    direct = read_transcript(da)
    assert "예산" in " ".join(s["text"] for s in direct["segments"])

    # 저장만 하고 (SIGKILL로 한 번 끊은 뒤 이어서 끝내고), 나중에 변환 (SIGKILL로 한 번 끊은 뒤 이어서 끝낸다)
    home_b = tmp_path / "b" / "home"
    monkeypatch.setenv("TRACTUS_HOME", str(home_b))
    rec_b = _say_recording(tmp_path, "b", text, copy_of=rec_a_copy)
    p = _cli_proc(home_b, models, "recording", "finish", str(rec_b), "--progress-json")
    _kill_after(p, "encode")
    if rec_b.exists():  # 끊기 전에 끝나 버렸으면 다시 할 일이 없다
        r = finish(rec_b)
        assert r.exit_code == 0, r.output
    (db,) = notes_in(home_b)
    assert read_transcript(db)["state"] == "recorded" and (db / "audio.ogg").stat().st_size > 0 and not rec_b.exists()
    cli_run("note", "save", read_transcript(db)["meeting_id"], input=json.dumps({"body": "내가 적은 메모"}))

    mid = read_transcript(db)["meeting_id"]
    p = _cli_proc(home_b, models, "transcribe", "--into", mid, "--track", "lite", "--progress-json")
    _kill_after(p, "progress")  # 첫 진행 표시 = 청크 변환을 시작한 직후
    if read_transcript(db).get("state") == "recorded":  # 끊기 전에 끝나 버렸으면 다시 할 일이 없다
        assert (db / ".job.json").is_file()
        r = convert(mid, "--track", "lite")
        assert r.exit_code == 0, r.output

    conv = read_transcript(db)
    assert "state" not in conv and not (db / "tracks").exists() and conv["memo"]["body"] == "내가 적은 메모"
    assert [(s["text"], s["start"], s["end"], s["speaker"]) for s in conv["segments"]] == [(s["text"], s["start"], s["end"], s["speaker"]) for s in direct["segments"]]
    assert conv["audio"] == direct["audio"] and conv["asr"] == direct["asr"] and conv["speakers"] == direct["speakers"]
