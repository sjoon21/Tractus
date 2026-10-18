"""예시 노트(첫 사용자 온보딩): `tractus note sample`. 모델·AI 키 없이 돈다."""

import json
import shutil
from pathlib import Path

from tractus import summaries as sums
from tractus.index import Index
from tractus.mcp_server import build_server
from tractus.store import memo_lines, read_transcript

from test_index import FakeEmbedder
from test_mcp import call, structured
from test_templates import home, out, run  # noqa: F401  (pytest fixture 재사용)


def make(home: Path) -> tuple[Path, dict]:
    r = out(run("note", "sample"))
    return Path(r["meeting_dir"]), r


def test_sample_note_has_everything_to_try_without_models_or_keys(home):
    d, r = make(home)
    assert r["created"] is True
    t = read_transcript(d)
    assert t["sample"] is True and t["title"].startswith("예시") and len(t["segments"]) == 10
    assert {v["name"] for v in t["speakers"].values()} == {"이지은", "정하늘", "김민수"}  # 이름을 확정한 참석자
    assert [m["text"] for m in memo_lines(t)] == ["결제 API 느림 - 원인?", "릴리스 날짜", "온보딩 문서 어디로"]
    assert [x["key"] for x in sums.list_summaries(d)] == ["meeting", "enhanced"]  # 회의록 + 완성된 노트
    enhanced = sums.read_data(d, "enhanced")
    assert [s["part"] for s in enhanced["sections"]] == ["memo"] * 5 + ["todos"]  # 내 메모 3줄 + 녹음 중 메모·북마크 2개 + 할 일
    assert (d / "memos.json").is_file() and (d / "transcript.md").is_file()
    assert r["meeting_id"] == t["meeting_id"]


def test_sample_note_is_made_once(home):
    d, _ = make(home)
    again = out(run("note", "sample"))
    assert again["created"] is False and Path(again["meeting_dir"]) == d
    assert len([p for p in (home / "meetings").iterdir() if p.is_dir()]) == 1  # .sample.lock 파일은 빼고
    shutil.rmtree(d)  # 지운 뒤(앱은 휴지통으로 옮긴다)에는 다시 만들 수 있다
    assert out(run("note", "sample"))["created"] is True


def test_sample_note_stays_out_of_search_and_mcp(home):
    make(home)
    run("note", "new", input=json.dumps({"title": "내 메모", "body": "결제 API latency 확인"}))
    idx = Index(home, embedder=FakeEmbedder())
    idx.sync()
    hits = idx.search("latency").hits
    assert hits and all("예시" not in (h.title or "") for h in hits)  # 내 메모만 걸린다
    listed = structured(call(build_server(home, FakeEmbedder()), "list_meetings", {}))["meetings"]
    assert [m["title"] for m in listed] == ["내 메모"]


def test_two_runs_at_once_still_make_one_sample(home):
    # 앱에서 `예시 노트 열기`를 두 번 빨리 누르면 프로세스 둘이 동시에 돈다
    from concurrent.futures import ThreadPoolExecutor

    from tractus import sample_note

    with ThreadPoolExecutor(4) as pool:
        made = list(pool.map(lambda _: sample_note.create(home), range(4)))
    assert len({d for d, _ in made}) == 1 and sum(created for _, created in made) == 1
    assert len([p for p in (home / "meetings").iterdir() if p.is_dir()]) == 1


def test_a_failed_build_leaves_no_half_made_folder(home, monkeypatch):
    import pytest

    from tractus import enhance, sample_note

    def boom(*a):
        raise ValueError("깨진 예시 데이터")

    monkeypatch.setattr(enhance, "check", boom)
    with pytest.raises(ValueError):
        sample_note.create(home)
    assert [p for p in (home / "meetings").iterdir() if p.is_dir()] == []


def test_sample_action_items_are_not_given_to_agents(home):
    d, r = make(home)
    server = build_server(home, FakeEmbedder())
    assert structured(call(server, "list_action_items", {}))["items"] == []
    by_id = structured(call(server, "list_action_items", {"meeting_id": r["meeting_id"]}))["items"]
    assert len(by_id) == 3  # 그 노트를 ID로 직접 물으면 준다


def test_english_ui_gets_the_same_sample_in_english(home, monkeypatch):
    import re

    from tractus import sample_note

    # 문장 상수는 모듈을 불러올 때 언어를 정한다: 앱처럼 TRACTUS_LANG을 정한 새 프로세스로 만든다
    import os
    import subprocess
    import sys

    env = {**os.environ, "TRACTUS_LANG": "en", "TRACTUS_HOME": str(home)}
    r = subprocess.run([sys.executable, "-c", "from tractus.cli import app; app()", "note", "sample"], env=env, capture_output=True, text=True, timeout=60)
    d = Path(json.loads(r.stdout.strip().splitlines()[-1])["meeting_dir"])
    monkeypatch.setenv("TRACTUS_LANG", "en")
    t = read_transcript(d)
    assert t["title"].startswith("Sample") and len(t["segments"]) == 10 and t["segments"][0]["lang"] == "en"
    texts = json.dumps(t, ensure_ascii=False) + "".join(p.read_text(encoding="utf-8") for p in d.rglob("*.md")) + json.dumps(sums.read_data(d, "enhanced"), ensure_ascii=False)
    assert not re.search(r"[가-힣]", texts)  # 대화·메모·요약·완성된 노트·문서 머리말 모두 영어
    ko = json.loads(sample_note.data_path().with_name("sample_note.json").read_text(encoding="utf-8"))
    en = json.loads(sample_note.data_path().read_text(encoding="utf-8"))
    assert [s[:3] for s in ko["segments"]] == [s[:3] for s in en["segments"]] and ko["marks"] == [{**m, "text": m["text"] if m["text"] is None else "pool 50"} for m in en["marks"]]
