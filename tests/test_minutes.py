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


def reply(topics=None, actions=None, agenda="해외 카드, 리포트, 환불", next_meeting=None) -> str:
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
    return json.dumps({"agenda": agenda, "topics": topics, "actions": actions, "next_meeting": next_meeting or []}, ensure_ascii=False)


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


def test_input_adds_the_current_glossary_after_the_transcription_terms():
    text = minutes.build_input(transcript(), ["SYM400", "CSV"])
    assert "용어 표기 기준 (자주 쓰는 단어): PostgreSQL, CSV, SYM400" in text


def test_summarize_minutes_reads_the_glossary(home, fake):
    mid, _ = make_meeting(home)
    run("glossary", "add", "SYM400")
    fake.replies = [reply()]
    run("summarize", mid, "--template", "minutes")
    assert "PostgreSQL, CSV, SYM400" in fake.calls[0]["messages"][1]["content"]


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


def test_due_must_be_said_not_just_any_number_in_the_evidence():
    a = make(reply(actions=[action("문서 정리", "s0006", due="10월 31일"), action("검토", "s0020", due="다음 달 15일"),
                            action("문서 정리", "s0021", due="다음 주 수요일")]))["actions"]
    assert [x["due"] for x in a] == [None, None, "다음 주 수요일"]  # s0006엔 2.0, s0020엔 '오늘'만 있다


def test_partial_name_or_team_matches_do_not_pass():
    a = make(reply(actions=[action("문서 정리", "s0021", owner="박지훈"), action("마감 검토", "s0019", team="정산팀"),
                            action("미팅", "s0025", team="재무팀"), action("문서 정리", "s0021", owner="김지훈")]))["actions"]
    assert a[0]["owner"] is None  # '지훈님'이라 불렀지만 박지훈은 대화 어디에도 없다
    assert a[1]["team"] is None  # 플랫폼팀 사람의 말에 '정산'이 나올 뿐
    assert a[2]["team"] is None  # 재무팀은 언급됐을 뿐 자기 팀이 아니다
    assert a[3]["owner"] == "김지훈"  # '지훈님' + 확인된 이름 '김지훈 (정산팀)'


def test_name_with_team_is_split_before_checking():
    a = make(reply(actions=[action("문서 정리", "s0021", owner="김지훈 (정산팀)"), action("문서 정리", "s0022", team="플랫폼팀", owner="김지훈 (정산팀)")]))["actions"]
    assert (a[0]["owner"], a[0]["team"]) == ("김지훈", None)  # s0021은 기획팀이 말했다: 정산팀은 근거가 없다
    assert (a[1]["owner"], a[1]["team"]) == ("김지훈", "정산팀")  # 틀린 팀은 버리고 이름에 붙은 팀으로


def test_owner_equal_to_team_is_written_once():
    a = make(reply(actions=[action("미팅", "s0025", team="기획팀", owner="기획팀")]))["actions"]
    assert (a[0]["team"], a[0]["owner"]) == ("기획팀", None)


def test_numbers_compare_whole_numbers_and_include_the_note():
    t = transcript()
    assert minutes.unverified_numbers("하루 144번", minutes.evidence(t, ["s0004"])) == ["144"]
    assert minutes.unverified_numbers("하루 1,440번", minutes.evidence(t, ["s0004"])) == []
    a = make(reply(actions=[action("검토", "s0023", note="3일 안에")]))["actions"]
    assert a[0]["unverified"] == ["3"]


def test_unknown_or_missing_evidence_is_rejected():
    import pytest

    for bad in (reply(actions=[action("검토", "s9999")]), reply(actions=[action("검토")]), reply(topics=[])):
        with pytest.raises(ValueError):
            make(bad)


# ── 그리기 ────────────────────────────────────────────────────────────


def data(m: dict) -> dict:
    return {"title": "정산 서비스 2.0 기획 회의", "minutes": m, "attendees": ["기획팀", "김지훈 (정산팀)"]}


def test_one_format_draws_every_part_that_has_content():
    md = minutes.markdown(data(make(reply())), transcript())
    assert md.startswith("# [26.10.20] 정산 서비스 2.0 기획 회의\n\n일시: 2026-10-20 14:00 · 4분  \n참석: 기획팀, 김지훈 (정산팀)\n\n**주요 안건:** 해외 카드, 리포트, 환불\n")
    assert "| **해외 카드 정산** | • 환율을 하루 한 번만 받아 실시간 정산이 안 됨<br>• 플랫폼팀은" in md
    assert "| **[추가 논의 필요] 환불 정책** | • 부분 환불 허용 여부 | • 추가 논의 필요 |" in md
    assert "### 1) 해외 카드 정산" in md and "### 2) [추가 논의 필요] 환불 정책" in md
    assert "- **기술적 이슈**\n    - 환율 공급사 계약이 아직임\n        - 하루 1회 수신" in md
    assert "| 원화 결제 범위 문서 정리 | 정산팀 · 김지훈 | 기한 다음 주 수요일 |" in md
    assert "| 새벽 배치 분할 방식 검토 | 담당 미정 |  |" in md


def test_parts_without_content_are_not_drawn():
    one = json.loads(reply())
    one["topics"], one["actions"], one["agenda"] = one["topics"][:1], [], ""
    t = {**transcript(), "created_at": None, "audio": None}
    md = minutes.markdown({**data(make(json.dumps(one, ensure_ascii=False))), "attendees": []}, t)
    for part in ("일시", "참석", "주요 안건", "논의 사항 요약", "향후 예정 작업", "다음에 볼 날"):  # 안건이 하나면 요약 표도 없다
        assert part not in md
    assert "### 1) 해외 카드 정산" in md


def test_next_meeting_is_kept_only_when_said_as_written():
    said = make(reply(next_meeting=[line("다음 주 수요일", "s0021")]))
    assert said["next_meeting"] == [line("다음 주 수요일", "s0021")]
    assert "**다음에 볼 날:** 다음 주 수요일" in minutes.markdown(data(said), transcript())
    assert make(reply(next_meeting=[line("10월 27일", "s0021")]))["next_meeting"] == []  # 말하지 않은 날짜


def test_short_version_has_decisions_todos_with_missing_owner_due_and_open_items():
    text = minutes.short(data(make(reply(next_meeting=[line("다음 주 수요일", "s0021")]))), transcript())
    assert text.startswith("[회의록] 정산 서비스 2.0 기획 회의 (10.20)\n짧게 정리했습니다. 틀린 부분은 알려 주세요.\n")
    assert "정한 것\n- 해외 카드는 2.0 범위에서 빼고 2.1에서 다시 봄\n" in text
    assert "- 원화 결제 범위 문서 정리 — 정산팀 · 김지훈, 다음 주 수요일\n" in text
    assert "- 새벽 배치 분할 방식 검토 — 담당 미정, 기한 미정\n" in text
    assert "아직 안 정한 것\n- 환불 정책\n" in text and text.endswith("다음에 볼 날: 다음 주 수요일\n")


def test_pipes_and_newlines_in_text_do_not_break_tables():
    r = json.loads(reply(actions=[action("A|B 비교\n둘째 줄", "s0023")]))
    r["topics"][0]["title"] = "가|나 안건"
    r["topics"][0]["discussed"][0]["text"] = "첫 줄\n둘째 줄"
    md = minutes.markdown(data(make(json.dumps(r, ensure_ascii=False))), transcript())
    assert "| A\\|B 비교 둘째 줄 | 담당 미정 |  |" in md
    assert "| **가\\|나 안건** | • 첫 줄 둘째 줄<br>" in md


def test_retitle_keeps_the_date(home, fake):
    from tractus import notes

    mid, d = make_meeting(home)
    fake.replies = [reply()]
    run("summarize", mid, "--template", "minutes")
    notes.retitle_summary(d, "새 제목")
    md = (d / "summaries" / "minutes.md").read_text(encoding="utf-8")
    assert "# [26.10.20] 새 제목" in md
    assert md == sums.render_md(json.loads((d / "summaries" / "minutes.json").read_text(encoding="utf-8")), transcript())  # 디스크의 md = 다시 그린 글


# ── CLI ───────────────────────────────────────────────────────────────


def test_summarize_minutes_saves_v2_with_sections_for_other_readers(home, fake):
    mid, d = make_meeting(home)
    fake.replies = [reply()]
    r = run("summarize", mid, "--template", "minutes", "--progress-json")
    assert r.exit_code == 0, r.output
    assert events(r)[-1]["summary_key"] == "minutes"
    saved = json.loads((d / "summaries" / "minutes.json").read_text(encoding="utf-8"))
    assert (saved["kind"], saved["edited_at"], saved["attendees"]) == ("minutes", None, ["기획팀", "김지훈 (정산팀)"])
    assert [s["heading"] for s in saved["sections"]] == ["해외 카드 정산", "[추가 논의 필요] 환불 정책", "할 일"]
    assert "## 논의 사항 요약" in (d / "summaries" / "minutes.md").read_text(encoding="utf-8")
    assert sums.read_markdown(d, "minutes").count("향후 예정 작업") == 1
    assert "용어 표기 기준" in fake.calls[0]["messages"][1]["content"]


def test_memo_notes_have_no_minutes(home, fake):
    r = run("note", "new", input=json.dumps({"title": "메모", "body": "한 줄\n"}))
    mid = json.loads(r.stdout.strip().splitlines()[-1])["meeting_id"]
    r = run("summarize", mid, "--template", "minutes")
    assert r.exit_code == 2 and not fake.calls


def made(home, fake) -> tuple[str, Path, dict]:
    mid, d = make_meeting(home)
    fake.replies = [reply()]
    run("summarize", mid, "--template", "minutes")
    r = run("minutes", mid, "show")
    assert r.exit_code == 0, r.output
    return mid, d, json.loads(r.stdout)


def test_show_returns_fields_markdown_and_short(home, fake):
    _, _, shown = made(home, fake)
    assert set(shown) == {"minutes", "attendees", "title", "generated_at", "edited_at", "markdown", "short"}
    assert shown["markdown"].startswith("# [26.10.20]") and shown["short"].startswith("[회의록]")


def test_show_without_minutes_is_null(home):
    mid, _ = make_meeting(home)
    assert json.loads(run("minutes", mid, "show").stdout) == {"minutes": None}


def test_save_edits_fields_drops_emptied_lines_and_marks_edited(home, fake):
    mid, d, shown = made(home, fake)
    m = shown["minutes"]
    m["actions"][1] = {**m["actions"][1], "owner": "박서연", "due": "금요일"}  # 사람이 정한 값은 근거와 대조하지 않는다
    m["topics"][0]["discussed"][0]["text"] = "  "  # 비우면 지운다
    m["topics"][0]["agreed"][0]["text"] = "해외 카드는 2.1에서 12개 통화로"
    r = run("minutes", mid, "save", input=json.dumps({"minutes": m}, ensure_ascii=False))
    assert r.exit_code == 0, r.output
    out = json.loads(r.stdout)
    assert out["edited_at"] and (out["minutes"]["actions"][1]["owner"], out["minutes"]["actions"][1]["due"]) == ("박서연", "금요일")
    assert len(out["minutes"]["topics"][0]["discussed"]) == 1
    assert out["minutes"]["topics"][0]["agreed"][0]["unverified"] == ["12"]  # 고친 문장으로 다시 잰다
    assert "박서연" in (d / "summaries" / "minutes.md").read_text(encoding="utf-8")
    saved = json.loads((d / "summaries" / "minutes.json").read_text(encoding="utf-8"))
    assert saved["sections"][-1]["items"][1]["owner"] == "박서연"  # 내보내기·MCP도 고친 값


def test_save_rejects_bad_shape_and_unknown_evidence(home, fake):
    mid, _, shown = made(home, fake)
    bad = json.loads(json.dumps(shown["minutes"]))
    bad["actions"][0]["segment_ids"] = ["s9999"]
    for body in ("not json", json.dumps({"minutes": {"agenda": "x"}}), json.dumps({"minutes": bad})):
        r = run("minutes", mid, "save", input=body)
        assert r.exit_code == 2, body


def test_regenerating_clears_edited_at(home, fake):
    mid, d, shown = made(home, fake)
    run("minutes", mid, "save", input=json.dumps({"minutes": shown["minutes"]}, ensure_ascii=False))
    run("summarize", mid, "--template", "minutes")
    assert json.loads((d / "summaries" / "minutes.json").read_text(encoding="utf-8"))["edited_at"] is None
