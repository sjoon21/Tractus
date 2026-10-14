"""글만 있는 노트에 녹음 덧붙이기 `transcribe --append-to` (docs/desktop.md §2.11). 가짜 ASR·화자 분리, 실제 FFmpeg."""

import json
import os
import subprocess
from datetime import datetime
from pathlib import Path

import pytest
from typer.testing import CliRunner

from tractus import attach, cli, notes
from tractus.index import Index
from tractus.store import find_job, find_meeting_dir, memo_lines, read_transcript

from test_cli import FakeTranscriber, env, events, fake_asr, fake_diar, make_recording  # noqa: F401 (fixture)

BODY = "예산은 동결합니다\n\n견적은 김철수 님이 받습니다"  # 줄 1, 3 → s0001, s0002
NOW = datetime.fromisoformat("2026-10-12T09:30:00+09:00")


def make_text_note(home: Path, body: str = BODY, title: str = "장보기") -> tuple[Path, dict]:
    return notes.create_memo(home / "meetings", title, body, NOW)


def append(ref: str, wav: Path, *extra: str):
    return CliRunner().invoke(cli.app, ["transcribe", str(wav), "--append-to", ref, "--progress-json", *extra])


def write_summary(d: Path, mid: str) -> None:
    item = lambda ids: {"segment_ids": ids}  # noqa: E731
    data = {
        "schema_version": 1, "meeting_id": mid, "provider": "upstage", "model": "m", "generated_at": "2026-10-12T10:00:00+09:00",
        "title": "장보기", "summary": "예산과 견적.",
        "topics": [{"title": "예산", **item(["s0001"])}],
        "decisions": [{"text": "예산 동결", **item(["s0001", "s0099"])}],  # s0099: 없는 줄
        "action_items": [{"task": "견적 받기", "owner": None, "due": None, **item(["s0002"])}],
    }
    (d / "summary.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    (d / "summary.md").write_text("# 장보기\n", encoding="utf-8")


def write_chat(d: Path, mid: str) -> None:
    turns = [
        {"question": "견적은?", "answer": "김철수 님이 받습니다. [s0002]", "citations": [{"meeting_id": mid, "segment_id": "s0002", "start": 0.0, "line": 3}],
         "provider": "upstage", "model": "m", "no_evidence": False, "created_at": "g"},
        {"question": "없는 것은?", "answer": "지워진 줄입니다. [s0099]", "citations": [{"meeting_id": mid, "segment_id": "s0099", "start": 0.0, "line": 9}],
         "provider": "upstage", "model": "m", "no_evidence": False, "created_at": "g"},
    ]
    (d / "chat.json").write_text(json.dumps({"schema_version": 1, "meeting_id": mid, "turns": turns}, ensure_ascii=False), encoding="utf-8")


# ── 변환 ──────────────────────────────────────────────────────────────


def test_append_turns_text_note_into_recording_note_and_remaps_references(env, fake_asr):
    home, wav = env
    d, old = make_text_note(home)
    mid = old["meeting_id"]
    write_summary(d, mid)
    write_chat(d, mid)

    r = append(mid, wav)
    assert r.exit_code == 0, r.output
    done = events(r.stdout)[-1]
    assert done == {"event": "done", "meeting_id": mid, "meeting_dir": str(d)}
    assert [p.name for p in (home / "meetings").iterdir()] == [d.name]  # 새 폴더 없음

    t = read_transcript(d)
    assert "kind" not in t and "body" not in t and "seg_seq" not in t
    assert (t["meeting_id"], t["title"], t["created_at"]) == (mid, "장보기", old["created_at"])
    assert t["audio"]["file"] == "audio.ogg" and t["audio"]["duration_sec"] == 8.0 and len(t["audio"]["sha256"]) == 64
    assert (d / "audio.ogg").is_file() and t["audio"]["source"] == wav.name
    assert [s["text"] for s in t["segments"]] == ["청크0", "청크1", "청크2"] and t["asr"]["track"] in ("standard", "lite")
    assert t["memo"] == {"body": BODY, "lines": [{"id": "m0001", "line": 1, "text": "예산은 동결합니다"}, {"id": "m0002", "line": 3, "text": "견적은 김철수 님이 받습니다"}], "seq": 2}
    assert [m["id"] for m in memo_lines(t)] == ["m0001", "m0002"]

    s = json.loads((d / "summary.json").read_text(encoding="utf-8"))  # 같은 줄의 m ID로. 없는 줄 s0099만 빠지고 항목은 남는다
    assert s["topics"][0]["segment_ids"] == ["m0001"] and s["decisions"][0]["segment_ids"] == ["m0001"] and s["action_items"][0]["segment_ids"] == ["m0002"]
    md = (d / "summary.md").read_text(encoding="utf-8")
    assert "# 장보기" in md and "[메모 1번째 줄]" in md and "[메모 3번째 줄]" in md and "[00:00" not in md

    chat = json.loads((d / "chat.json").read_text(encoding="utf-8"))["turns"]
    assert chat[0]["citations"] == [{"meeting_id": mid, "segment_id": "m0002", "start": 0.0, "line": 3, "source": "memo"}]
    assert chat[0]["answer"] == "김철수 님이 받습니다. [m0002]" and chat[0]["no_evidence"] is False
    assert chat[1]["citations"] == [] and chat[1]["answer"] == "지워진 줄입니다." and chat[1]["no_evidence"] is True

    tmd = (d / "transcript.md").read_text(encoding="utf-8")
    assert "duration: 00:00:08" in tmd and "kind: memo" not in tmd and tmd.rstrip().endswith("견적은 김철수 님이 받습니다") and "## 메모" in tmd
    assert (d / "transcript.vtt").read_text(encoding="utf-8").startswith("WEBVTT") and "청크0" in (d / "transcript.vtt").read_text(encoding="utf-8")
    assert not (d / ".job.json").exists() and not (d / ".chunks.jsonl").exists()


def test_search_index_follows_the_converted_note(env, fake_asr):
    home, wav = env
    d, old = make_text_note(home, "예산은 동결합니다\n견적을 받습니다")
    idx = Index(home)
    idx.sync(embed=False)
    assert idx.search("동결").hits[0].segment_ids == ["s0001", "s0002"] and not idx.search("청크").hits  # 글만 있는 노트: 줄이 세그먼트
    idx.close()

    assert append(old["meeting_id"], wav).exit_code == 0
    idx = Index(home)
    idx.sync(embed=False)
    memo, said = idx.search("동결").hits[0], idx.search("청크").hits[0]
    idx.close()
    assert (memo.source, memo.segment_ids) == ("memo", ["m0001", "m0002"]) and said.source == "transcript"


def test_append_keeps_unknown_keys_and_recording_marks(env, fake_asr, tmp_path):
    home, _ = env
    d, old = make_text_note(home)
    t = read_transcript(d)
    (d / "transcript.json").write_text(json.dumps({**t, "tags": ["장보기"], "favorite": True}, ensure_ascii=False), encoding="utf-8")
    rec = make_recording(tmp_path)
    r = CliRunner().invoke(cli.app, ["transcribe", "--recording", str(rec), "--append-to", old["meeting_id"], "--progress-json"])
    assert r.exit_code == 0, r.output
    new = read_transcript(d)
    assert new["tags"] == ["장보기"] and new["favorite"] is True and new["created_at"] == old["created_at"]  # 녹음 시각(2026-10-02)이 아니라 노트의 시각
    assert json.loads((d / "memos.json").read_text(encoding="utf-8"))[0]["text"] == "예산 다시 확인"
    assert "[00:00:03] (메모) 예산 다시 확인" in (d / "transcript.md").read_text(encoding="utf-8")
    assert not rec.exists()


def test_empty_text_note_gets_no_memo_block(env, fake_asr):
    home, wav = env
    d, old = make_text_note(home, "")
    assert append(old["meeting_id"], wav).exit_code == 0
    t = read_transcript(d)
    assert "memo" not in t and len(t["segments"]) == 3


def test_diarization_runs_into_the_note(env, fake_asr, fake_diar):
    home, wav = env
    d, old = make_text_note(home)
    assert append(old["meeting_id"], wav).exit_code == 0
    t = read_transcript(d)
    assert [s["speaker"] for s in t["segments"]] == ["S1", "S2", "S1"] and set(t["speakers"]) == {"S1", "S2"} and t["diarization"]["model"] == "fake"


# ── 오류 ──────────────────────────────────────────────────────────────


def test_recording_note_and_second_append_exit_2_with_sentence(env, fake_asr):
    home, wav = env
    r = CliRunner().invoke(cli.app, ["transcribe", str(wav), "--progress-json"])
    rec_mid = events(r.stdout)[-1]["meeting_id"]
    r = append(rec_mid, wav)
    assert r.exit_code == 2 and events(r.stdout) == [{"event": "error", "message": attach.HAS_AUDIO, "code": "append_has_audio"}]
    assert attach.HAS_AUDIO in r.output

    d, old = make_text_note(home)
    other = home / "other.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=550:duration=8", "-ar", "16000", str(other)], check=True)
    assert append(old["meeting_id"], other).exit_code == 0
    again = append(old["meeting_id"], other)  # 이미 오디오가 있는 노트
    assert again.exit_code == 2 and events(again.stdout)[-1]["code"] == "append_has_audio"


def test_missing_note_exits_2_and_writes_nothing(env, fake_asr):
    home, wav = env
    r = append("01NOSUCHNOTE", wav)
    assert r.exit_code == 2
    ev = events(r.stdout)
    assert ev == [{"event": "error", "message": "‘01NOSUCHNOTE’에 해당하는 노트가 없습니다. 삭제되었거나 옮겨졌을 수 있습니다.", "code": "append_note_missing"}]
    assert not list((home / "meetings").glob("*")) and not FakeTranscriber.calls


def test_duplicate_audio_leaves_the_text_note_alone(env, fake_asr):
    home, wav = env
    first = CliRunner().invoke(cli.app, ["transcribe", str(wav), "--progress-json"])
    other_mid = events(first.stdout)[-1]["meeting_id"]
    d, old = make_text_note(home)
    before = (d / "transcript.json").read_text(encoding="utf-8")
    r = append(old["meeting_id"], wav)
    ev = events(r.stdout)
    assert r.exit_code == 0 and [e["event"] for e in ev] == ["stage", "warning", "done"] and ev[1]["code"] == "duplicate" and ev[-1]["meeting_id"] == other_mid
    assert (d / "transcript.json").read_text(encoding="utf-8") == before and not (d / ".job.json").exists()


def test_note_converted_by_someone_else_meanwhile_is_not_overwritten(env, fake_asr, monkeypatch):
    home, wav = env
    d, old = make_text_note(home)

    class Racing(FakeTranscriber):
        def transcribe(self, audio, language=None, hotwords=None):
            if not FakeTranscriber.calls:  # 첫 청크를 변환하는 사이 다른 실행이 이 노트에 녹음을 붙였다
                t = read_transcript(d)
                (d / "transcript.json").write_text(json.dumps({**{k: v for k, v in t.items() if k != "kind"}, "audio": {"file": "audio.ogg", "duration_sec": 1, "source": "x", "sha256": "other"}}), encoding="utf-8")
            return super().transcribe(audio, language, hotwords)

    monkeypatch.setattr(cli, "Transcriber", Racing)
    r = append(old["meeting_id"], wav)
    assert r.exit_code == 2 and events(r.stdout)[-1] == {"event": "error", "message": attach.HAS_AUDIO, "code": "append_has_audio"}
    assert read_transcript(d)["audio"]["sha256"] == "other" and not memo_lines(read_transcript(d))


def test_broken_summary_warns_but_still_converts(env, fake_asr):
    home, wav = env
    d, old = make_text_note(home)
    (d / "summary.json").write_text("{not json", encoding="utf-8")
    r = append(old["meeting_id"], wav)
    assert r.exit_code == 0
    ev = events(r.stdout)
    assert {"event": "warning", "code": "append_remap_failed", "message": attach.REMAP_FAILED} in ev
    assert "kind" not in read_transcript(d) and len(read_transcript(d)["segments"]) == 3


# ── 이어하기 ──────────────────────────────────────────────────────────


def test_interrupted_append_resumes_in_the_note_with_the_latest_text(env, fake_asr):
    home, wav = env
    d, old = make_text_note(home)
    mid = old["meeting_id"]
    FakeTranscriber.fail_at = 1
    r = append(mid, wav)
    assert r.exit_code == 130
    assert (d / ".job.json").is_file() and json.loads((d / ".job.json").read_text(encoding="utf-8"))["attach"] is True
    assert read_transcript(d)["kind"] == "memo"  # 실패해도 글만 있는 노트 그대로

    find_meeting_dir(home / "meetings", mid)  # 노트를 여는 어떤 명령도 진행 중인 작업 파일을 지우지 않는다
    assert (d / ".job.json").is_file()
    assert find_job(home / "meetings", json.loads((d / ".job.json").read_text(encoding="utf-8"))["sha256"]) is None  # 새 노트를 만드는 작업이 아니다
    save = CliRunner().invoke(cli.app, ["note", "save", mid], input=json.dumps({"body": "처음 쓴 글\n\n뒤에 고친 글"}))
    assert save.exit_code == 0

    FakeTranscriber.fail_at = None
    r = append(mid, wav)
    assert r.exit_code == 0, r.output
    assert len(FakeTranscriber.calls) == 3 and [c["samples"] for c in FakeTranscriber.calls[1:]] == [2 * 16000, 2 * 16000]  # 첫 청크는 이어받음 (1 + 남은 2)
    t = read_transcript(d)
    assert "kind" not in t and [x["text"] for x in memo_lines(t)] == ["처음 쓴 글", "뒤에 고친 글"] and len(t["segments"]) == 3
    assert not (d / ".job.json").exists()


def test_other_file_after_interrupted_append_transcribes_every_chunk(env, fake_asr, tmp_path):
    home, wav = env
    d, old = make_text_note(home)
    FakeTranscriber.fail_at = 1
    assert append(old["meeting_id"], wav).exit_code == 130
    assert (d / ".chunks.jsonl").is_file()
    wav2 = tmp_path / "other.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=880:duration=8", "-ar", "16000", str(wav2)], check=True)
    FakeTranscriber.fail_at = None
    before = len(FakeTranscriber.calls)
    r = append(old["meeting_id"], wav2)
    assert r.exit_code == 0, r.output
    assert len(FakeTranscriber.calls) - before == 3  # 첫 파일의 청크를 이어받지 않고 모두 새로 전사
    assert len(read_transcript(d)["segments"]) == 3


def test_append_job_is_only_found_for_its_own_note(env, fake_asr):
    home, wav = env
    d, old = make_text_note(home)
    FakeTranscriber.fail_at = 1
    assert append(old["meeting_id"], wav).exit_code == 130
    sha = json.loads((d / ".job.json").read_text(encoding="utf-8"))["sha256"]
    meetings = home / "meetings"
    assert find_job(meetings, sha, old["meeting_id"]) is not None
    assert find_job(meetings, sha, "01OTHER") is None and find_job(meetings, sha) is None


# ── 녹음 폴더의 attach.json ───────────────────────────────────────────


def test_read_attach_target(tmp_path):
    rec = tmp_path / "rec"
    rec.mkdir()
    assert attach.read_attach_target(rec) is None
    for bad in ("{oops", "[]", '{"meeting_id": 5}', '{"meeting_id": "../x"}', '{"meeting_id": "short"}'):
        (rec / "attach.json").write_text(bad, encoding="utf-8")
        assert attach.read_attach_target(rec) is None
    (rec / "attach.json").write_text('{"meeting_id": "01K6X3TESTMEETING000000000"}', encoding="utf-8")
    assert attach.read_attach_target(rec) == "01K6X3TESTMEETING000000000"


def test_recording_with_attach_json_is_not_appended_unless_asked(env, fake_asr, tmp_path):
    home, _ = env
    d, old = make_text_note(home)
    rec = make_recording(tmp_path)
    (rec / "attach.json").write_text(json.dumps({"meeting_id": old["meeting_id"]}), encoding="utf-8")
    r = CliRunner().invoke(cli.app, ["transcribe", "--recording", str(rec), "--progress-json"])
    assert r.exit_code == 0, r.output
    new_mid = events(r.stdout)[-1]["meeting_id"]
    assert new_mid != old["meeting_id"] and read_transcript(d)["kind"] == "memo" and not rec.exists()


# ── 단위 ──────────────────────────────────────────────────────────────


def test_id_map_pairs_by_line_number_then_by_position():
    lines = [{"id": "m0001", "line": 1, "text": "a"}, {"id": "m0002", "line": 3, "text": "b"}]
    old = {"segments": [{"id": "s0007", "line": 3}, {"id": "s0002", "line": 1}, {"id": "s0009", "line": 8}]}
    assert attach.id_map(old, lines) == {"s0007": "m0002", "s0002": "m0001"}
    legacy = {"segments": [{"id": "s0001"}, {"id": "s0002"}, {"id": "s0003"}]}  # line이 없는 옛 세그먼트는 순서로
    assert attach.id_map(legacy, lines) == {"s0001": "m0001", "s0002": "m0002"}


def test_remapping_twice_is_the_same_as_once():
    assert attach._remap_ids(["s0001", "m0002", "s0099"], {"s0001": "m0001"}) == ["m0001", "m0002"]


def test_check_target_accepts_only_text_notes():
    attach.check_target({"kind": "memo", "audio": {"file": None}})
    for t in ({"audio": {"file": "audio.ogg"}}, {"kind": "memo", "audio": {"file": "audio.ogg"}}):
        with pytest.raises(ValueError, match="이미 녹음이 있는"):
            attach.check_target(t)


# ── 실제 모델 ─────────────────────────────────────────────────────────


@pytest.mark.slow
def test_real_models_append_say_audio_to_a_text_note(tmp_path, monkeypatch):
    models = Path(os.environ.get("TRACTUS_MODELS_DIR", Path(__file__).resolve().parent.parent / "models")).resolve()  # .env의 상대 경로가 chdir 뒤에 깨지지 않게 먼저 절대 경로로
    home = tmp_path / "home"
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("TRACTUS_HOME", str(home))
    monkeypatch.setenv("TRACTUS_MODELS_DIR", str(models))
    monkeypatch.setattr(cli, "_sync_index_quietly", lambda embed=True: None)
    wav = tmp_path / "say.wav"
    subprocess.run(["say", "-v", "Yuna", "-o", str(wav), "--data-format=LEI16@16000", "안녕하세요. 오늘 회의는 예산 검토입니다."], check=True)
    d, old = notes.create_memo(home / "meetings", "예산 메모", BODY, NOW)
    write_summary(d, old["meeting_id"])
    r = CliRunner().invoke(cli.app, ["transcribe", str(wav), "--append-to", old["meeting_id"], "--track", "lite", "--progress-json"])
    assert r.exit_code == 0, r.output
    t = read_transcript(d)
    assert "kind" not in t and "예산" in " ".join(s["text"] for s in t["segments"]) and len(memo_lines(t)) == 2
    assert t["audio"]["duration_sec"] > 1 and (d / "audio.ogg").stat().st_size > 0 and (d / "transcript.vtt").is_file()
    assert json.loads((d / "summary.json").read_text(encoding="utf-8"))["action_items"][0]["segment_ids"] == ["m0002"]
