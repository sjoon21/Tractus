"""노트 완성: 내 메모(메모 탭 줄 + 녹음 중 메모·북마크)를 뼈대로 대화 내용의 세부를 붙인다 (docs/design/enhanced-notes.md).
모델·네트워크 없이 가짜 응답으로 돈다."""

import json
import shutil
from pathlib import Path

import pytest

from tractus import enhance, summaries as sums
from tractus.store import save_transcript
from test_templates import events, fake, home, make_note, run  # noqa: F401  (pytest fixture 재사용)

SAMPLE = Path(__file__).parent / "fixtures" / "sample_meeting.json"


def make_recording(home: Path, memo: str | None = "예산 다시 확인\n\n담당자 정하기\n", rec: list | None = None) -> tuple[str, Path]:
    t = json.loads(SAMPLE.read_text(encoding="utf-8"))
    d = home / "meetings" / f"2026-10-02_주간_개발_{t['meeting_id']}"
    d.mkdir(parents=True)
    if memo is not None:
        lines = [{"id": f"m{n:04d}", "line": i, "text": x} for n, (i, x) in enumerate(((i, x) for i, x in enumerate(memo.splitlines(), 1) if x.strip()), 1)]
        t["memo"] = {"body": memo, "lines": lines, "seq": len(lines)}
    save_transcript(d, t)
    if rec is not None:
        (d / "memos.json").write_text(json.dumps(rec, ensure_ascii=False), encoding="utf-8")
    return t["meeting_id"], d


REC = [{"t": 95.0, "kind": "bookmark", "text": None}, {"t": 30.5, "kind": "memo", "text": "pool size 50"}]


def item(text: str, *ids: str, owner=None, due=None) -> dict:
    return {"text": text, "segment_ids": list(ids), "owner": owner, "due": due}


def reply(blocks=None, todos=None, title="주간 개발") -> str:
    blocks = blocks if blocks is not None else [
        {"source": "m0001", "heading": "", "items": [item("p95가 800ms까지 올랐다", "s0002")]},
        {"source": "m0002", "heading": "", "items": [item("slow query 분석은 김민수", "s0003", "s0004")]},
        {"source": "r0001", "heading": "", "items": [item("pool size를 20에서 50으로", "s0003")]},
        {"source": "r0002", "heading": "", "items": [item("수요일까지 공유하기로 했다", "s0004")]},
        {"source": None, "heading": "릴리스 일정", "items": [item("다음 릴리스 일정 논의", "s0005")]},
    ]
    todos = todos if todos is not None else [item("slow query 분석 공유", "s0004", owner="김민수", due="수요일")]
    return json.dumps({"title": title, "blocks": blocks, "todos": todos}, ensure_ascii=False)


# ── 입력 ─────────────────────────────────────────────────────────────


def test_sources_put_memo_tab_lines_first_then_recording_marks_by_time(home):
    _, d = make_recording(home, rec=REC)
    t = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
    src = enhance.sources(t, d)
    assert [(s.id, s.kind, s.text, s.at) for s in src] == [
        ("m0001", "memo", "예산 다시 확인", None),
        ("m0002", "memo", "담당자 정하기", None),
        ("r0001", "recording_memo", "pool size 50", 30.5),  # 시각 순: 30.5초가 95초보다 먼저
        ("r0002", "bookmark", "", 95.0),
    ]
    assert enhance.sources(t, d) == src  # 같은 노트면 언제나 같은 ID (저장하지 않고 매번 만든다)


def test_prompt_lists_transcript_and_my_notes_with_times_but_not_the_summary_memo_block(home):
    _, d = make_recording(home, rec=REC)
    t = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
    p = enhance.build_input(t, enhance.sources(t, d))
    assert "[s0001 00:00:00] 네 그럼 주간 개발 회의 시작하겠습니다." in p
    assert "내가 적은 메모 (적은 순서):\n[m0001] 예산 다시 확인\n[m0002] 담당자 정하기\n[r0001 00:00:30 녹음 중 메모] pool size 50\n[r0002 00:01:35 북마크]" in p
    assert "사용자가 적은 메모:" not in p  # 요약용 메모 블록과 겹치지 않는다


def test_prompt_says_there_are_no_notes_when_there_are_none(home):
    _, d = make_recording(home, memo=None)
    t = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
    assert enhance.sources(t, d) == []
    assert "내가 적은 메모: 없음" in enhance.build_input(t, [])


# ── 만들기와 저장 ──────────────────────────────────────────────────────


def test_enhance_saves_a_v2_summary_with_my_notes_as_headings_in_order(home, fake):
    mid, d = make_recording(home, rec=REC)
    fake.replies = [reply()]
    r = run("summarize", mid, "--template", "enhanced", "--progress-json")
    assert r.exit_code == 0, r.output
    assert events(r)[-1]["summary_key"] == "enhanced"
    data = json.loads((d / "summaries" / "enhanced.json").read_text(encoding="utf-8"))
    assert data["schema_version"] == 2 and data["kind"] == "enhanced" and data["template"] == "enhanced" and data["template_name"] == "노트 완성"
    assert data["overview"] == "" and "prompt" not in data
    secs = data["sections"]
    assert [(s["part"], s["source"], s["heading"]) for s in secs] == [
        ("memo", "m0001", "예산 다시 확인"),
        ("memo", "m0002", "담당자 정하기"),
        ("memo", "r0001", "pool size 50"),
        ("memo", "r0002", "북마크 1:35"),
        ("extra", None, "릴리스 일정"),
        ("todos", None, "할 일"),
    ]
    assert secs[2]["at"] == 30.5 and secs[3]["at"] == 95.0 and "at" not in secs[0]
    assert secs[5]["style"] == "checklist" and secs[5]["items"][0]["owner"] == "김민수"
    md = (d / "summaries" / "enhanced.md").read_text(encoding="utf-8")
    assert "## 예산 다시 확인\n\n- p95가 800ms까지 올랐다" in md and "## 할 일\n\n- [ ] slow query 분석 공유 — 김민수, 수요일" in md
    assert [x["key"] for x in sums.list_summaries(d)] == ["enhanced"]
    assert next(x for x in sums.list_summaries(d))["name"] == "노트 완성"
    assert "pool size 50" in fake.calls[0]["messages"][1]["content"]


def test_my_note_text_is_kept_verbatim_even_if_the_model_rewrites_the_heading(home, fake):
    mid, d = make_recording(home)
    blocks = [{"source": "m0002", "heading": "담당자를 정해야 함 (AI가 고친 말)", "items": []}, {"source": "m0001", "heading": "예산 재확인", "items": [item("p95", "s0002")]}]
    fake.replies = [reply(blocks=blocks, todos=[])]
    assert run("summarize", mid, "--template", "enhanced").exit_code == 0
    secs = json.loads((d / "summaries" / "enhanced.json").read_text(encoding="utf-8"))["sections"]
    assert [(s["source"], s["heading"], len(s["items"])) for s in secs] == [("m0001", "예산 다시 확인", 1), ("m0002", "담당자 정하기", 0)]  # 순서도 입력 순서로
    assert len(fake.calls) == 1  # 순서만 다르면 다시 묻지 않는다


@pytest.mark.parametrize(
    "bad",
    [
        [{"source": "m0001", "heading": "", "items": []}],  # m0002가 빠짐
        [{"source": "m0001", "heading": "", "items": []}, {"source": "m0002", "heading": "", "items": []}, {"source": "m0009", "heading": "", "items": []}],  # 없는 메모
        [{"source": "m0001", "heading": "", "items": []}, {"source": "m0001", "heading": "", "items": []}, {"source": "m0002", "heading": "", "items": []}],  # 두 번
        [{"source": "m0001", "heading": "", "items": [item("메모를 근거로", "m0001")]}, {"source": "m0002", "heading": "", "items": []}],  # 메모 ID는 근거가 아니다
        [{"source": "m0001", "heading": "", "items": [item("근거 없음")]}, {"source": "m0002", "heading": "", "items": []}],
    ],
)
def test_invalid_structure_is_retried_once(home, fake, bad):
    mid, d = make_recording(home)
    good = [{"source": "m0001", "heading": "", "items": [item("p95", "s0002")]}, {"source": "m0002", "heading": "", "items": []}]
    fake.replies = [reply(blocks=bad, todos=[]), reply(blocks=good, todos=[])]
    r = run("summarize", mid, "--template", "enhanced")
    assert r.exit_code == 0, r.output
    assert len(fake.calls) == 2
    assert [s["source"] for s in json.loads((d / "summaries" / "enhanced.json").read_text(encoding="utf-8"))["sections"]] == ["m0001", "m0002"]


def test_without_any_notes_the_ai_builds_the_structure(home, fake):
    mid, d = make_recording(home, memo=None)
    fake.replies = [reply(blocks=[{"source": None, "heading": "성능 문제", "items": [item("p95 800ms", "s0002")]}], todos=[])]
    assert run("summarize", mid, "--template", "enhanced").exit_code == 0
    secs = json.loads((d / "summaries" / "enhanced.json").read_text(encoding="utf-8"))["sections"]
    assert [(s["part"], s["heading"]) for s in secs] == [("extra", "성능 문제")]


def test_memo_note_and_unknown_template_flags_are_refused_without_calling_the_model(home, fake):
    mid, _ = make_note(home)
    r = run("summarize", mid, "--template", "enhanced", "--progress-json")
    assert r.exit_code == 2 and events(r)[-1]["code"] == "no_recording"
    r = run("summarize", mid, "--template", "enhanced", "--custom", input='{"prompt": "x"}')
    assert r.exit_code == 2
    assert fake.calls == []


def test_enhanced_is_not_a_template_in_the_menu(home):
    r = run("templates", "list", "--json")
    assert r.exit_code == 0 and "enhanced" not in [t["id"] for t in json.loads(r.stdout)["templates"]]


def test_regular_summary_prompt_does_not_change_with_recording_marks(home, fake):
    # 녹음 중 메모는 노트 완성에만 쓴다: 기존 요약의 입력은 그대로다
    mid, d = make_recording(home, rec=REC)
    assert run("summarize", mid, "--template", "brief").exit_code == 0
    assert "pool size 50" not in fake.calls[0]["messages"][1]["content"]


def test_enhanced_summary_can_be_deleted_like_any_summary(home, fake):
    mid, d = make_recording(home)
    fake.replies = [reply(blocks=[{"source": "m0001", "heading": "", "items": []}, {"source": "m0002", "heading": "", "items": []}], todos=[])]
    assert run("summarize", mid, "--template", "enhanced").exit_code == 0
    assert run("summaries", mid, "delete", "enhanced").exit_code == 0
    assert not (d / "summaries" / "enhanced.json").exists()
    shutil.rmtree(d)


def test_a_note_without_details_still_appears_in_markdown_and_docx(home, fake):
    # 화면은 `대화에서 관련 내용을 찾지 못했습니다`로 그 줄을 보인다. 내보낸 문서에서도 빠지면 안 된다 (메모를 하나도 빠뜨리지 않는다)
    import zipfile
    from io import BytesIO

    from tractus.export import render_export

    mid, d = make_recording(home)
    fake.replies = [reply(blocks=[{"source": "m0001", "heading": "", "items": [item("p95", "s0002")]}, {"source": "m0002", "heading": "", "items": []}], todos=[])]
    assert run("summarize", mid, "--template", "enhanced").exit_code == 0
    md = (d / "summaries" / "enhanced.md").read_text(encoding="utf-8")
    assert "## 담당자 정하기\n\n- 대화에서 관련 내용을 찾지 못했습니다" in md
    docx = render_export(d, "docx", "enhanced")
    xml = zipfile.ZipFile(BytesIO(docx)).read("word/document.xml").decode()
    assert "담당자 정하기" in xml and "대화에서 관련 내용을 찾지 못했습니다" in xml
