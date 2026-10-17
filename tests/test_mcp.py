"""MCP 서버 테스트. 대부분 in-process Client, 마지막 하나는 실제 stdio 하위 프로세스(stdout 오염 검사)."""

import json
import os
import re
import shutil
import sys
from pathlib import Path

import anyio
import pytest
from mcp import Client, StdioServerParameters

from tractus.mcp_server import build_server

from test_index import EVAL, FakeEmbedder

BUDGET = "01KWZKT9M0T5YFCND21XGZFT8G"  # 3분기 예산 계획 회의 (2026-07-08)
RELEASE = "01M1JFX480KZE86SXAN94C6Y0E"  # 모바일 앱 v2.4 릴리스 회의


@pytest.fixture
def home(tmp_path):
    shutil.copytree(EVAL / "meetings", tmp_path / "meetings")
    return tmp_path


def call(server, tool, args=None):
    async def go():
        async with Client(server) as c:
            return await c.call_tool(tool, args or {})

    return anyio.run(go)


def structured(result):
    assert not result.is_error, result.content
    return result.structured_content


def text(result):
    assert not result.is_error, result.content
    return "".join(c.text for c in result.content)


def test_tools_are_listed_with_read_only_hints(home):
    async def go():
        async with Client(build_server(home, FakeEmbedder())) as c:
            return {t.name: t for t in (await c.list_tools()).tools}

    tools = anyio.run(go)
    assert set(tools) == {"status", "search_meetings", "list_meetings", "get_transcript", "get_summary", "list_action_items", "save_summary"}
    assert all(tools[n].annotations.read_only_hint for n in tools if n != "save_summary")
    assert tools["save_summary"].annotations.read_only_hint is False


def test_search_syncs_index_and_returns_citations(home):
    from tractus.index import Index

    emb = FakeEmbedder()
    Index(home, embedder=emb).sync()  # 벡터는 CLI 쪽 동기화가 만든다
    r = structured(call(build_server(home, emb), "search_meetings", {"query": "latency", "limit": 3}))
    assert r["vector_used"] and r["hits"]
    h = r["hits"][0]
    s = h["segments"][0]
    assert s["cite"] == f"[{h['title']} {s['time']}]" and h["meeting_id"] not in s["cite"]  # 사람이 읽는 인용 (ID는 다른 칸)
    assert any("latency" in x["text"].lower() for x in h["segments"])


def test_search_date_filter(home):
    r = structured(call(build_server(home, FakeEmbedder()), "search_meetings", {"query": "예산", "date_from": "2026-07-01", "date_to": "2026-07-31"}))
    assert r["hits"] and {h["meeting_id"] for h in r["hits"]} == {BUDGET}


def test_list_meetings_sorted_with_summary_flag(home):
    r = structured(call(build_server(home, None), "list_meetings", {"date_from": "2026-09-01"}))
    dates = [m["date"] for m in r["meetings"]]
    assert dates == sorted(dates) and dates[0] >= "2026-09-01" and all(m["has_summary"] for m in r["meetings"])


def test_get_transcript_paginates_with_segment_lines(home):
    srv = build_server(home, None)
    page = text(call(srv, "get_transcript", {"meeting_id": RELEASE[-8:], "offset": 0, "max_segments": 5}))
    assert "[s0001 00:00:00]" in page and "[s0006" not in page and "next_offset: 5" in page
    last = text(call(srv, "get_transcript", {"meeting_id": RELEASE, "offset": 10, "max_segments": 50}))
    assert "[s0011" in last and "next_offset" not in last


def test_unknown_meeting_is_tool_error(home):
    r = call(build_server(home, None), "get_transcript", {"meeting_id": "nope"})
    assert r.is_error and "nope" in "".join(c.text for c in r.content)


def test_get_summary_and_action_items(home):
    srv = build_server(home, None)
    assert "## 할 일" in text(call(srv, "get_summary", {"meeting_id": RELEASE}))
    items = structured(call(srv, "list_action_items", {"date_from": "2026-09-03", "date_to": "2026-09-03"}))["items"]
    assert items and all(i["meeting_id"] == RELEASE and i["cite"].startswith("[") and RELEASE not in i["cite"] for i in items)


def test_save_summary_validates_segment_ids_and_writes_files(home):
    srv = build_server(home, None)
    (d,) = [p for p in (home / "meetings").iterdir() if RELEASE in p.name]
    (d / "summary.json").unlink()
    (d / "summary.md").unlink()
    good = {"title": "릴리스", "summary": "요약", "topics": [{"title": "출시", "segment_ids": ["s0003"]}],
            "decisions": [], "action_items": [{"task": "QA", "owner": None, "due": None, "segment_ids": ["s0004"]}]}
    bad = {**good, "decisions": [{"text": "x", "segment_ids": ["s9999"]}]}
    r = call(srv, "save_summary", {"meeting_id": RELEASE, "summary": bad, "author": "claude-code"})
    assert r.is_error and "s9999" in "".join(c.text for c in r.content) and not (d / "summary.json").exists()
    ok = structured(call(srv, "save_summary", {"meeting_id": RELEASE, "summary": good, "author": "claude-code"}))
    assert ok["saved"].endswith("summary.md")
    data = json.loads((d / "summary.json").read_text(encoding="utf-8"))
    assert data["provider"] == "mcp" and data["model"] == "claude-code"


def test_status_reports_home_and_vector_availability(home):
    r = structured(call(build_server(home, None), "status"))
    assert r["home"] == str(home) and r["meetings"] == 5 and r["vector_search"] is False and r["hint"]


def test_mcp_sync_does_not_embed_but_reports_missing_vectors(home):
    from tractus.index import Index

    emb = FakeEmbedder()
    Index(home, embedder=emb).sync()  # CLI가 벡터까지 만든 상태
    calls = emb.calls
    new = home / "meetings" / "2026-10-01_추가_01NEWMEETING00000000000000"
    new.mkdir()
    (new / "transcript.json").write_text(json.dumps({"meeting_id": "01NEWMEETING00000000000000", "title": "추가", "created_at": "2026-10-01",
        "segments": [{"id": "s0001", "start": 0, "end": 10, "text": "새로 추가된 회의의 예산 이야기"}]}, ensure_ascii=False), encoding="utf-8")
    r = structured(call(build_server(home, emb), "status"))
    assert emb.calls == calls  # MCP 동기화는 임베딩하지 않는다
    assert r["vectors"] < r["indexed_chunks"] and "tractus index" in r["hint"]


def test_corrupt_files_do_not_break_listing_tools(home):
    (d,) = [p for p in (home / "meetings").iterdir() if RELEASE in p.name]
    (d / "summary.json").write_text("{", encoding="utf-8")
    bad = home / "meetings" / "2026-01-01_broken_01BROKEN000000000000000000"
    bad.mkdir()
    (bad / "transcript.json").write_text("[]", encoding="utf-8")
    srv = build_server(home, None)
    assert len(structured(call(srv, "list_meetings"))["meetings"]) == 5
    assert structured(call(srv, "list_action_items"))["items"]
    assert structured(call(srv, "search_meetings", {"query": "예산"}))["hits"]


def test_stdio_server_keeps_stdout_clean(home, tmp_path):
    """실제 `python -m tractus.mcp_server`를 띄워 JSON-RPC 이외 출력이 stdout에 섞이지 않는지 본다."""
    env = {**os.environ, "TRACTUS_HOME": str(home), "TRACTUS_MODELS_DIR": str(tmp_path / "no-models")}
    params = StdioServerParameters(command=sys.executable, args=["-m", "tractus.mcp_server"], env=env, cwd=str(tmp_path))
    errors = []

    async def go():
        async with Client(params, message_handler=lambda m: errors.append(m) if isinstance(m, Exception) else None) as c:
            return await c.call_tool("search_meetings", {"query": "Redis"})

    r = anyio.run(go)
    assert not r.is_error and r.structured_content["hits"] and not errors


def _with_speakers(home):
    """가상 회의 하나에 화자 정보를 붙인다 (schema_version 2)."""
    (d,) = [p for p in (home / "meetings").iterdir() if RELEASE in p.name]
    t = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
    for i, s in enumerate(t["segments"]):
        s["speaker"] = ["S1", "S2", None][i % 3]
    t.update(schema_version=2, speakers={"S1": {"name": "김민수"}, "S2": {"name": None}}, diarization={"model": "m", "revision": "r", "params": {}})
    (d / "transcript.json").write_text(json.dumps(t, ensure_ascii=False), encoding="utf-8")
    return t


def test_get_transcript_shows_speaker_names_or_labels(home):
    _with_speakers(home)
    page = text(call(build_server(home, None), "get_transcript", {"meeting_id": RELEASE, "max_segments": 3}))
    assert "[s0001 00:00:00 김민수] " in page and "[s0002 " in page and " S2] " in page
    assert re.search(r"\[s0003 \d\d:\d\d:\d\d\] ", page)  # 화자를 모르면 생략


def test_search_hits_include_speaker(home):
    t = _with_speakers(home)
    word = t["segments"][0]["text"].split()[0]
    r = structured(call(build_server(home, None), "search_meetings", {"query": word, "meeting_id": RELEASE}))
    segs = [s for h in r["hits"] for s in h["segments"]]
    assert {s["speaker"] for s in segs} <= {"김민수", "S2", None} and any(s["speaker"] == "김민수" for s in segs)


def test_voice_suggestion_never_reaches_mcp(home):
    t = _with_speakers(home)
    t["speakers"]["S2"] = {"name": None, "suggested": {"person_id": "P1", "name": "홍길동", "score": 0.82}}
    (d,) = [p for p in (home / "meetings").iterdir() if RELEASE in p.name]
    (d / "transcript.json").write_text(json.dumps(t, ensure_ascii=False), encoding="utf-8")
    server = build_server(home, None)
    page = text(call(server, "get_transcript", {"meeting_id": RELEASE, "max_segments": 500}))
    assert "홍길동" not in page and " S2] " in page
    word = t["segments"][1]["text"].split()[0]
    hits = call(server, "search_meetings", {"query": word, "meeting_id": RELEASE})
    assert "홍길동" not in json.dumps(structured(hits), ensure_ascii=False)


def test_instructions_mention_estimated_speakers():
    from tractus.mcp_server import INSTRUCTIONS

    assert "자동 추정" in INSTRUCTIONS


def test_save_summary_drops_speaker_label_owners(home):
    (d,) = [p for p in (home / "meetings").iterdir() if RELEASE in p.name]
    s = {"title": "릴리스", "summary": "요약", "topics": [], "decisions": [],
         "action_items": [{"task": "QA", "owner": "S2", "due": None, "segment_ids": ["s0004"]}]}
    assert not call(build_server(home, None), "save_summary", {"meeting_id": RELEASE, "summary": s, "author": "claude-code"}).is_error
    assert json.loads((d / "summary.json").read_text(encoding="utf-8"))["action_items"][0]["owner"] is None
