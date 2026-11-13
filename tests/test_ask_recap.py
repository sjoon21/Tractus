"""여러 노트에서 모아 묻는 질문(결정·할 일·요약)을 저장된 요약으로 답하기, 몰린 인용 거르기. 가상 회의(tests/fixtures/eval)만 쓴다."""

import json
import shutil
from pathlib import Path

import pytest

from tractus import ask as qa
from tractus.index import Index
from test_ask import BUDGET, EVAL, SEARCH, FakeStream, run_ask, cli_env, transcript  # noqa: F401 (fixture)

MOBILE, OKR, DAON = "01M1JFX480KZE86SXAN94C6Y0E", "01M2PZ6MR0KZ0R3C1T2RHWN1E4", "01M3QYXKE0WC2SE1CW214JX464"


@pytest.fixture
def home(tmp_path):
    shutil.copytree(EVAL / "meetings", tmp_path / "meetings")
    return tmp_path


def note_dir(home: Path, mid: str) -> Path:
    return next((home / "meetings").glob(f"*{mid}"))


@pytest.mark.parametrize("q", ["지난주 결정사항 정리해 줘", "내가 해야 할 일을 모아 줘", "이번 달 회의 요약해 줘", "모든 노트의 할 일을 담당자별로",
                               "지난주에 정한 것을 정리해 줘", "우리가 뭘 결정했지?", "What did we decide?", "list my action items",
                               "summarize last week's meetings", "decisions across all notes"])
def test_recap_questions(q):
    assert qa.is_recap(q)


@pytest.mark.parametrize("q", ["GPU 서버 구매 결정은 회의마다 어떻게 바뀌었어?", "모바일 regression test 담당자는 누구야?", "9월 회의에서 정한 OKR은 뭐야?",
                               "7월 회의에서 모바일 앱 출시일은 언제로 정했어?", "아직 정하지 못한 것은?", "회의 할 일정은?", "요약해 줘",
                               "what did Minho say about the budget?"])
def test_find_questions_stay_on_search(q):
    assert not qa.is_recap(q)


def test_dated_filter_counts_as_a_period():
    assert not qa.is_recap("결정사항은?") and qa.is_recap("결정사항은?", dated=True)


def test_summary_items_merge_all_summaries_decisions_and_todos_first(home):
    d = note_dir(home, BUDGET)
    (d / "summaries").mkdir()
    (d / "summaries" / "minutes.json").write_text(json.dumps({"schema_version": 2, "kind": "minutes", "summary": [{"text": "예산 회의", "segment_ids": ["s0001"]}],
        "topics": [{"title": "GPU", "agreed": [{"text": "클라우드 GPU로 간다", "segment_ids": ["s0008"]}], "discussed": []}],
        "actions": [{"text": "backend 채용 공고 게시", "segment_ids": ["s0011"], "owner": "정하은", "team": None, "due": None}]}, ensure_ascii=False), encoding="utf-8")
    items = qa.summary_items(d)
    labels = [i["label"] for i in items]
    assert labels[:labels.count("결정") + labels.count("할 일")] == [x for x in labels if x in ("결정", "할 일")]  # 결정·할 일이 먼저
    assert {"label": "할 일", "text": "개발 클러스터 야간 scale down 적용 (최도윤, 7월 31일)", "segment_ids": ["s0004", "s0005"]} in items
    assert {"label": "결정", "text": "클라우드 GPU로 간다", "segment_ids": ["s0008"]} in items  # 회의록의 합의 칸
    assert sum(i["text"].startswith("backend 채용 공고 게시") for i in items) == 1  # 같은 문장은 한 번
    assert any(i["text"] == "예산 회의" and i["label"] is None for i in items)


def test_recap_sources_use_summaries_in_range_and_fall_back_without_one(home):
    (note_dir(home, DAON) / "summary.json").unlink()  # 요약 없는 노트는 검색 결과로
    s = json.loads((note_dir(home, MOBILE) / "summary.json").read_text(encoding="utf-8"))
    s["decisions"][0]["segment_ids"] = ["s0999"]  # 다시 변환해 사라진 근거 ID
    (note_dir(home, MOBILE) / "summary.json").write_text(json.dumps(s, ensure_ascii=False), encoding="utf-8")
    idx = Index(home)
    idx.sync()
    src = qa.recap_sources(idx, "9월 결정사항 정리해 줘", date_from="2026-09-01", date_to="2026-09-30")
    summ = [x for x in src if x.get("source") == "summary"]
    assert {x["meeting_id"] for x in summ} == {MOBILE, OKR}
    assert not any("s0999" in x["segment_ids"] for x in summ) and not any(x["text"].startswith("v2.4 출시일") for x in summ)
    cited = {(x["meeting_id"], i) for x in summ for i in x["segment_ids"]}
    assert cited <= {(x["meeting_id"], x["segment_id"]) for x in qa.evidence(src)}  # 요약 줄의 근거 줄이 모두 근거에 있다
    assert all(x["date"] >= "2026-09-01" for x in src)
    assert {x["meeting_id"] for x in qa.evidence(src)} - {MOBILE, OKR} <= {DAON}
    idx.close()


def test_recap_without_any_summary_is_plain_search(home):
    for p in (home / "meetings").glob("*/summary.json"):
        p.unlink()
    idx = Index(home)
    idx.sync()
    assert qa.global_sources(idx, "모든 노트의 할 일") == qa.search_sources(idx, "모든 노트의 할 일")
    idx.close()


def test_recap_prompt_lists_summary_lines_with_their_citations(home):
    idx = Index(home)
    idx.sync()
    src = qa.global_sources(idx, "7월에 결정한 것은?", date_from="2026-07-01", date_to="2026-07-31")
    idx.close()
    system, user = (m["content"] for m in qa.build_messages("7월에 결정한 것은?", [], src, "global", today="2026-11-13"))
    assert system.endswith(qa.RECAP_PROMPT)
    assert f"[노트 요약]\n- 결정: 개발 EKS 클러스터를 야간에 scale down한다 [{BUDGET}#s0003][{BUDGET}#s0004]" in user
    assert "\n[대화 기록]\n" in user and f"[{BUDGET}#s0003 " in user


def test_ask_sends_summary_lines_but_reports_only_citable_sources(home):
    src = [{"meeting_id": BUDGET, "title": "t", "date": "2026-07-08", "source": "summary", "label": "결정", "text": "GPU 보류", "segment_ids": ["s0008"]},
           *qa.transcript_sources(transcript(home, BUDGET), [s for s in transcript(home, BUDGET)["segments"] if s["id"] == "s0008"])]
    ev = list(qa.ask(FakeStream([f"GPU는 보류 [{BUDGET}#s0008]."]), "upstage", "m", "결정사항?", [], "global", lambda: src))
    assert [s["segment_id"] for s in ev[1]["sources"]] == ["s0008"]
    assert ev[-1]["citations"][0]["segment_id"] == "s0008"


# ── 몰린 인용 ─────────────────────────────────────────────────────────


def all_notes(home: Path) -> list[dict]:
    return [s for p in sorted((home / "meetings").glob("*/transcript.json")) for s in qa.transcript_sources(json.loads(p.read_text(encoding="utf-8")))]


def test_finalize_drops_a_pile_citing_most_notes(home):
    src = all_notes(home)  # 노트 5개
    pile = "".join(f"[{m}#s0002]" for m in (BUDGET, SEARCH, MOBILE))
    answer, cites = qa.finalize(f"모두 일정이 밀렸다 {pile}. GPU는 보류 [{BUDGET}#s0008][{OKR}#s0009].", src, "global")
    assert answer == f"모두 일정이 밀렸다. GPU는 보류 [{BUDGET}#s0008][{OKR}#s0009]."  # 5개 중 3개 = 몰림, 2개는 그대로
    assert [c["segment_id"] for c in cites] == ["s0008", "s0009"]


def test_finalize_keeps_a_spread_when_notes_are_few(home):
    src = qa.transcript_sources(transcript(home, BUDGET)) + qa.transcript_sources(transcript(home, SEARCH)) + qa.transcript_sources(transcript(home, OKR))
    pile = "".join(f"[{m}#s0002]" for m in (BUDGET, SEARCH, OKR))
    assert qa.finalize(f"A {pile}.", src, "global")[0] == f"A {pile}."  # 노트 3개면 거르지 않는다


def test_finalize_caps_citations_per_note_in_one_run(home):
    src = qa.transcript_sources(transcript(home, BUDGET))
    answer, cites = qa.finalize("A [s0001][s0002] [s0003][s0004][s0002]. B [s0005].", src, "meeting")
    assert answer == "A [s0001][s0002][s0003]. B [s0005]."
    assert [c["segment_id"] for c in cites] == ["s0001", "s0002", "s0003", "s0005"]


# ── CLI ───────────────────────────────────────────────────────────────


def test_cli_ask_recap_question_answers_from_summaries(cli_env, monkeypatch):
    r, ev, client = run_ask(monkeypatch, [f"backend 채용 공고는 정하은 [{BUDGET}#s0011]."], '{"question": "7월에 나온 할 일을 모아 줘"}',
                            "--from", "2026-07-01", "--to", "2026-07-31")
    assert r.exit_code == 0, r.output
    assert "[노트 요약]" in client.calls[0]["messages"][-1]["content"]
    assert all("segment_id" in s for s in ev[1]["sources"])
    assert ev[-1]["citations"][0]["segment_id"] == "s0011"
