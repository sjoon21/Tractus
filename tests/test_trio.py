"""세 기능이 함께 도는 경로: 글 노트(태그·즐겨찾기·폴더) → 녹음 덧붙이기(A) → 요약 유형별 요약(C) → 폴더 이름 바꾸기(B). 가짜 ASR, 실제 FFmpeg."""

import json

from tractus import cli, organize, summaries
from tractus.store import read_transcript
from typer.testing import CliRunner

from test_attach import BODY, append, make_text_note
from test_cli import env, events, fake_asr, fake_diar  # noqa: F401 (fixture)


def _generic(mid: str, ids: list[str]) -> dict:
    sec = {"heading": "할 일", "style": "checklist", "items": [{"text": "견적 받기", "segment_ids": ids, "owner": None, "due": None}]}
    return {"schema_version": 2, "meeting_id": mid, "template": "todo", "template_name": "할 일 중심", "prompt_hash": "x", "provider": "p", "model": "m",
            "generated_at": "2026-10-12T10:00:00+09:00", "title": "장보기", "overview": "요약", "sections": [sec]}


def test_append_keeps_organisation_remaps_template_summaries_and_folder_rename_follows(env, fake_asr, monkeypatch):
    home, wav = env
    monkeypatch.setenv("TRACTUS_HOME", str(home))
    d, old = make_text_note(home)
    mid = old["meeting_id"]
    f = organize.create_folder(home, "집안일")
    run = lambda *a, **k: CliRunner().invoke(cli.app, [*map(str, a)], **k)  # noqa: E731
    assert run("note", "meta", mid, input=json.dumps({"favorite": True, "tags": ["장보기", "급함"], "folder": f["id"]})).exit_code == 0
    (d / "summaries").mkdir()
    (d / "summaries" / "todo.json").write_text(json.dumps(_generic(mid, ["s0002", "s0099"]), ensure_ascii=False), encoding="utf-8")
    (d / "summaries" / "todo.md").write_text("x", encoding="utf-8")
    before = read_transcript(d)

    r = append(mid, wav)
    assert r.exit_code == 0, r.output
    assert not [e for e in events(r.stdout) if e["event"] == "warning" and e["code"] == "append_remap_failed"]
    t = read_transcript(d)
    assert (t["favorite"], t["tags"], t["folder"]) == (True, ["장보기", "급함"], f["id"])  # A가 B의 정리 정보를 지우지 않는다
    assert t["updated_at"] != before.get("updated_at") and t["updated_at"] > before["created_at"]  # 녹음이 붙으면 수정 시각이 올라간다
    md = (d / "transcript.md").read_text(encoding="utf-8")
    assert "tags: [장보기, 급함]" in md and "favorite: true" in md and "folder: 집안일" in md and "## 메모" in md

    s = json.loads((d / "summaries" / "todo.json").read_text(encoding="utf-8"))  # C의 요약 근거도 같은 줄의 m ID로 (없는 줄은 빠진다)
    assert s["sections"][0]["items"][0]["segment_ids"] == ["m0002"]
    assert "[메모 3번째 줄]" in (d / "summaries" / "todo.md").read_text(encoding="utf-8")
    assert [x["key"] for x in summaries.list_summaries(d)] == ["todo"]

    assert run("folders", "rename", f["id"], "--name", "살림").exit_code == 0
    assert "folder: 살림" in (d / "transcript.md").read_text(encoding="utf-8")
    rows = json.loads(run("notes", "list", "--json", "--folder", "살림").stdout.strip().splitlines()[-1])["notes"]
    assert [(x["meeting_id"], x["favorite"], x["tags"]) for x in rows] == [(mid, True, ["장보기", "급함"])] and rows[0]["kind"] != "memo"
