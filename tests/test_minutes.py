"""회의록: AI는 근거가 달린 구조만 내고, 표·참석·형식은 코어가 그린다 (docs/design/meeting-minutes.md).
모델·네트워크 없이 가짜 응답으로 돈다. fixture는 가상 회의(tests/fixtures/minutes_meeting.json)다."""

import json
from pathlib import Path

from tractus import minutes, summaries as sums
from tractus.store import save_transcript
from test_templates import events, fake, home, run  # noqa: F401  (pytest fixture 재사용)

SAMPLE = Path(__file__).parent / "fixtures" / "minutes_meeting.json"


def transcript() -> dict:
    return json.loads(SAMPLE.read_text(encoding="utf-8"))


def make_meeting(home: Path) -> tuple[str, Path]:
    t = transcript()
    d = home / "meetings" / f"2026-10-20_정산_{t['meeting_id']}"
    d.mkdir(parents=True)
    save_transcript(d, t)
    return t["meeting_id"], d


def line(text: str, *ids: str) -> dict:
    return {"text": text, "segment_ids": list(ids)}


def action(text: str, *ids: str, team=None, owner=None, due=None, note=None) -> dict:
    return {**line(text, *ids), "team": team, "owner": owner, "due": due, "note": note}


def reply(topics=None, actions=None, agenda="해외 카드, 리포트, 환불") -> str:
    topics = topics if topics is not None else [
        {"title": "해외 카드 정산", "open": False,
         "discussed": [line("환율을 하루 한 번만 받아 실시간 정산이 안 됨", "s0003"), line("플랫폼팀은 하루 1440번 호출 비용을 걱정함", "s0004")],
         "agreed": [line("해외 카드는 2.0 범위에서 빼고 2.1에서 다시 봄", "s0005")],
         "points": [{"label": "기술적 이슈", "details": [{**line("환율 공급사 계약이 아직임", "s0003"), "children": [line("하루 1회 수신", "s0003")]}]}],
         "approach": []},
        {"title": "환불 정책", "open": True, "discussed": [line("부분 환불 허용 여부", "s0016")], "agreed": [], "points": [], "approach": []},
    ]
    actions = actions if actions is not None else [
        action("원화 결제 범위 문서 정리", "s0021", "s0022", owner="김지훈 (정산팀)", due="다음 주 수요일"),
        action("새벽 배치 분할 방식 검토", "s0023", team="플랫폼팀"),  # s0023은 "저희는"뿐: 팀을 말하지 않았다
        action("재무팀 미팅 잡기", "s0025", team="기획팀", due="금요일"),  # 화자 이름이 기획팀, 기한은 말하지 않았다
    ]
    return json.dumps({"agenda": agenda, "topics": topics, "actions": actions}, ensure_ascii=False)


def make(reply_text: str) -> dict:
    t = transcript()
    m = minutes.Minutes.model_validate_json(reply_text)
    minutes.check(m, t)
    return minutes.clean(m, t)


# ── 입력 ─────────────────────────────────────────────────────────────


def test_input_adds_confirmed_names_and_terms_but_not_auto_labels():
    text = minutes.build_input(transcript())
    assert "참석자 (사용자가 확인한 이름): 기획팀, 김지훈 (정산팀)" in text
    assert "용어 표기 기준 (자주 쓰는 단어): PostgreSQL, CSV" in text
    assert "[s0004 " in text and "참석자 3" in text  # 이름 없는 사람은 대화 줄에만 자동 이름으로


# ── 근거 대조 ─────────────────────────────────────────────────────────


def test_team_owner_due_survive_only_when_the_evidence_says_so():
    a = make(reply())["actions"]
    assert (a[0]["owner"], a[0]["team"], a[0]["due"]) == ("김지훈", "정산팀", "다음 주 수요일")  # 이름의 팀을 나눈다
    assert a[1]["team"] is None  # 근거 줄에 팀이 없다
    assert (a[2]["team"], a[2]["due"]) == ("기획팀", None)  # 팀은 확인한 화자 이름, 기한은 근거에 없다


def test_team_said_in_the_evidence_text_is_kept():
    a = make(reply(actions=[action("배치 검토", "s0004", "s0023", team="플랫폼팀")]))["actions"]
    assert a[0]["team"] == "플랫폼팀"  # s0004: "저희 플랫폼팀에서는"


def test_auto_label_and_suggested_names_never_become_owner():
    a = make(reply(actions=[action("검토", "s0023", owner="참석자 3"), action("검토", "s0023", team="S3")]))["actions"]
    assert a[0]["owner"] is None and a[1]["team"] is None


def test_numbers_missing_from_the_evidence_are_marked_not_dropped():
    m = make(reply(topics=[{"title": "해외", "open": False, "discussed": [line("12개 통화 지원 안", "s0002"), line("하루 1440번 호출", "s0004")],
                            "agreed": [], "points": [], "approach": []}]))
    d = m["topics"][0]["discussed"]
    assert d[0]["unverified"] == ["12"] and d[0]["text"] == "12개 통화 지원 안"  # 대화는 "열두 개"
    assert "unverified" not in d[1]


def test_unknown_or_missing_evidence_is_rejected():
    import pytest

    for bad in (reply(actions=[action("검토", "s9999")]), reply(actions=[action("검토")]), reply(topics=[])):
        with pytest.raises(ValueError):
            make(bad)


# ── 그리기 ────────────────────────────────────────────────────────────


def data(m: dict, fmt="table", edited=None) -> dict:
    return {"title": "정산 서비스 2.0 기획 회의", "minutes": m, "attendees": ["기획팀", "김지훈 (정산팀)"], "format": fmt, "edited": edited}


def test_table_format_has_summary_table_body_and_actions_by_team():
    md = minutes.markdown(data(make(reply())), transcript())
    assert md.startswith("# [26.10.20] 정산 서비스 2.0 기획 회의\n\n참석: 기획팀, 김지훈 (정산팀)\n")
    assert "| **해외 카드 정산** | • 환율을 하루 한 번만 받아 실시간 정산이 안 됨<br>• 플랫폼팀은" in md
    assert "| **[추가 논의 필요] 환불 정책** | • 부분 환불 허용 여부 | • 추가 논의 필요 |" in md
    assert "- **기술적 이슈**\n    - 환율 공급사 계약이 아직임\n        - 하루 1회 수신" in md
    assert "| **정산팀** | • 원화 결제 범위 문서 정리 (김지훈, 기한 다음 주 수요일) |" in md
    assert "| **담당 미정** | • 새벽 배치 분할 방식 검토 |" in md


def test_list_format_numbers_topics_and_puts_teams_in_the_task_cell():
    md = minutes.markdown(data(make(reply()), fmt="list"), transcript())
    assert "**주요 안건:** 해외 카드, 리포트, 환불" in md
    assert "### 1) 해외 카드 정산" in md and "### 2) [추가 논의 필요] 환불 정책" in md
    assert "| 원화 결제 범위 문서 정리 (정산팀 · 김지훈) | 기한 다음 주 수요일 |" in md
    assert "논의 사항 요약" not in md


def test_edited_markdown_is_the_minutes_until_a_format_is_asked_for():
    d = data(make(reply()), edited={"markdown": "# 내가 고친 회의록\n"})
    assert minutes.markdown(d, transcript()) == "# 내가 고친 회의록\n"
    assert minutes.markdown(d, transcript(), "list").startswith("# [26.10.20]")


def test_pipes_in_text_do_not_break_tables():
    md = minutes.markdown(data(make(reply(actions=[action("A|B 비교", "s0023")]))), transcript())
    assert "A\\|B 비교" in md


# ── CLI ───────────────────────────────────────────────────────────────


def test_summarize_minutes_saves_v2_with_sections_for_other_readers(home, fake):
    mid, d = make_meeting(home)
    fake.replies = [reply()]
    r = run("summarize", mid, "--template", "minutes", "--progress-json")
    assert r.exit_code == 0, r.output
    assert events(r)[-1]["summary_key"] == "minutes"
    saved = json.loads((d / "summaries" / "minutes.json").read_text(encoding="utf-8"))
    assert (saved["kind"], saved["format"], saved["edited"], saved["attendees"]) == ("minutes", "table", None, ["기획팀", "김지훈 (정산팀)"])
    assert [s["heading"] for s in saved["sections"]] == ["해외 카드 정산", "[추가 논의 필요] 환불 정책", "할 일"]
    assert "## 논의 사항 요약" in (d / "summaries" / "minutes.md").read_text(encoding="utf-8")
    assert sums.read_markdown(d, "minutes").count("향후 예정 작업") == 1
    assert "용어 표기 기준" in fake.calls[0]["messages"][1]["content"]


def test_summarize_minutes_keeps_the_chosen_format(home, fake):
    mid, d = make_meeting(home)
    fake.replies = [reply()]
    run("summarize", mid, "--template", "minutes")
    p = d / "summaries" / "minutes.json"
    p.write_text(json.dumps({**json.loads(p.read_text(encoding="utf-8")), "format": "list"}, ensure_ascii=False), encoding="utf-8")
    run("summarize", mid, "--template", "minutes")
    assert json.loads(p.read_text(encoding="utf-8"))["format"] == "list"


def test_memo_notes_have_no_minutes(home, fake):
    r = run("note", "new", input=json.dumps({"title": "메모", "body": "한 줄\n"}))
    mid = json.loads(r.stdout.strip().splitlines()[-1])["meeting_id"]
    r = run("summarize", mid, "--template", "minutes")
    assert r.exit_code == 2 and not fake.calls
