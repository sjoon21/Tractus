"""녹음 중 남긴 메모·북마크를 노트에서 고치고 지운다 (`tractus marks <노트> save`, memos.json)."""

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from tractus import cli
from tractus.store import MEMOS_FILE, load_memos, save_memos, save_transcript

SAMPLE = Path(__file__).parent / "fixtures" / "sample_meeting.json"
MARKS = [{"t": 30.5, "kind": "memo", "text": "pool size 50"}, {"t": 95.0, "kind": "bookmark", "text": None}, {"t": 120.0, "kind": "memo", "text": "릴리스 날짜"}]


@pytest.fixture
def note(tmp_path, monkeypatch):
    monkeypatch.setenv("TRACTUS_HOME", str(tmp_path / "home"))
    t = json.loads(SAMPLE.read_text(encoding="utf-8"))
    d = tmp_path / "home" / "meetings" / f"2026-10-02_x_{t['meeting_id']}"
    d.mkdir(parents=True)
    save_transcript(d, t)
    (d / MEMOS_FILE).write_text(json.dumps(MARKS, ensure_ascii=False), encoding="utf-8")
    return t["meeting_id"], d


def test_edit_and_delete_keep_time_and_kind(note):
    _, d = note
    out = save_memos(d, [{"t": 30.5, "kind": "memo", "text": " pool size\n 60 "}, {"t": 120.0, "kind": "memo", "text": "릴리스 날짜"}])
    assert out == [{"t": 30.5, "kind": "memo", "text": "pool size 60"}, {"t": 120.0, "kind": "memo", "text": "릴리스 날짜"}]  # 북마크는 빠졌다
    assert load_memos(d) == out
    assert "pool size 60" in (d / "transcript.md").read_text(encoding="utf-8")  # 대화 내용 md에도 반영


def test_emptied_memo_is_deleted_and_bookmark_text_is_ignored(note):
    _, d = note
    out = save_memos(d, [{"t": 30.5, "kind": "memo", "text": "  "}, {"t": 95.0, "kind": "bookmark", "text": "몰래 글"}])
    assert out == [{"t": 95.0, "kind": "bookmark", "text": None}]


def test_deleting_everything_leaves_an_empty_file(note):
    _, d = note
    assert save_memos(d, []) == [] and (d / MEMOS_FILE).read_text(encoding="utf-8").strip() == "[]"  # 변환 전 노트가 원본 메모를 다시 읽지 않게


@pytest.mark.parametrize("bad", [
    [{"t": 31.0, "kind": "memo", "text": "새 메모"}],  # 없는 시각: 끼워 넣기
    [{"t": 30.5, "kind": "bookmark", "text": None}],  # 종류 바꾸기
    [{"t": 30.5, "kind": "memo", "text": "a"}, {"t": 30.5, "kind": "memo", "text": "b"}],  # 같은 메모 두 번
    [{"t": "30", "kind": "memo"}],
    "not a list",
])
def test_inserting_or_changing_time_or_kind_is_refused(note, bad):
    _, d = note
    with pytest.raises(ValueError):
        save_memos(d, bad)
    assert load_memos(d) == sorted(MARKS, key=lambda m: m["t"])  # 그대로


def test_marks_save_cli(note):
    mid, d = note
    r = CliRunner().invoke(cli.app, ["marks", mid, "save"], input=json.dumps({"marks": [{"t": 95.0, "kind": "bookmark", "text": None}]}))
    assert r.exit_code == 0, r.output
    assert json.loads(r.stdout.strip().splitlines()[-1]) == {"marks": [{"t": 95.0, "kind": "bookmark", "text": None}]}
    bad = CliRunner().invoke(cli.app, ["marks", mid, "save"], input=json.dumps({"marks": [{"t": 1.0, "kind": "memo", "text": "x"}]}))
    assert bad.exit_code == 2
