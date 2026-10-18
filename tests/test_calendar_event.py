"""캘린더 일정으로 시작한 녹음 (docs/design/calendar.md): 앱이 녹음 폴더에 쓴 event.json → 제목·음성 인식 힌트·노트 폴더.
가짜 ASR, 실제 FFmpeg."""

import json
from pathlib import Path

from typer.testing import CliRunner

from tractus import cli
from tractus.calendar_event import clean_event, load_event
from tractus.store import read_transcript

from test_cli import env, events, fake_asr, make_recording  # noqa: F401 (fixture)
from test_deferred import convert, finish, notes_in

EVENT = {"title": "주간 개발", "start": "2026-10-02T14:00:00+09:00", "end": "2026-10-02T15:00:00+09:00", "calendar": "회사", "attendees": ["김민수", "이지은"]}


def with_event(tmp_path: Path, ev=EVENT) -> Path:
    rec = make_recording(tmp_path)
    (rec / "event.json").write_text(json.dumps(ev, ensure_ascii=False), encoding="utf-8")
    return rec


def test_clean_event_checks_title_times_and_attendees():
    assert clean_event(EVENT) == EVENT
    assert clean_event({**EVENT, "title": "  "}) is None and clean_event({**EVENT, "start": "내일"}) is None and clean_event([]) is None
    ev = clean_event({**EVENT, "title": "주간\n개발", "calendar": 3, "attendees": ["김민수", "김민수", "", 7, "가" * 81, " 이지은 ", "guest@example.com"]})
    assert ev["title"] == "주간 개발" and ev["calendar"] == "" and ev["attendees"] == ["김민수", "이지은"]
    assert len(clean_event({**EVENT, "attendees": [f"사람{i}" for i in range(60)]})["attendees"]) == 50
    assert len(clean_event({**EVENT, "title": "가" * 300})["title"]) == 200  # 긴 제목은 잘라서 쓴다 (녹음을 막지 않는다)


def test_direct_transcribe_takes_the_event_title_and_attendee_hotwords(env, fake_asr, tmp_path):
    home, _ = env
    r = CliRunner().invoke(cli.app, ["transcribe", "--recording", str(with_event(tmp_path)), "--track", "lite", "--progress-json"])
    assert r.exit_code == 0, r.output
    (d,) = notes_in(home)
    t = read_transcript(d)
    assert t["title"] == "주간 개발" and d.name.startswith("2026-10-02_주간_개발_")
    assert t["asr"]["hotwords"] == ["김민수", "이지은", "WTO"]  # 이 노트만의 참석자가 자주 쓰는 단어(WTO)보다 앞 (asr.HOTWORDS_MAX)
    assert load_event(d) == EVENT
    assert "김민수" not in (home / "glossary.md").read_text(encoding="utf-8")  # 자주 쓰는 단어 목록에는 넣지 않는다


def test_saved_then_converted_note_keeps_the_event_for_hotwords(env, fake_asr, tmp_path):
    r = finish(with_event(tmp_path))
    assert r.exit_code == 0, r.output
    d = Path(events(r.stdout)[-1]["meeting_dir"])
    t = read_transcript(d)
    assert t["title"] == "주간 개발" and load_event(d) == EVENT
    assert convert(t["meeting_id"], "--track", "lite").exit_code == 0
    assert read_transcript(d)["asr"]["hotwords"] == ["김민수", "이지은", "WTO"]


def test_a_broken_event_file_is_ignored(env, fake_asr, tmp_path):
    home, _ = env
    rec = make_recording(tmp_path)
    (rec / "event.json").write_text("{깨진", encoding="utf-8")
    assert CliRunner().invoke(cli.app, ["transcribe", "--recording", str(rec), "--track", "lite"]).exit_code == 0
    (d,) = notes_in(home)
    assert read_transcript(d)["title"].startswith("녹음 ") and not (d / "event.json").exists()


def test_obsidian_lists_the_event_attendees(env, fake_asr, tmp_path):
    home, _ = env
    assert CliRunner().invoke(cli.app, ["transcribe", "--recording", str(with_event(tmp_path)), "--track", "lite"]).exit_code == 0
    (d,) = notes_in(home)
    vault = tmp_path / "vault"
    vault.mkdir()
    r = CliRunner().invoke(cli.app, ["obsidian", read_transcript(d)["meeting_id"], "--vault", str(vault)])
    assert r.exit_code == 0, r.output
    assert "attendees: [김민수, 이지은]" in Path(json.loads(r.stdout.splitlines()[-1])["path"]).read_text(encoding="utf-8")
