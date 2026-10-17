"""메모 노트(`tractus note`)와 제목 바꾸기. 모델·FFmpeg·네트워크 없이 도는 테스트 (docs/desktop.md §2.10)."""

import csv
import io
import json
import threading
import zipfile
from types import SimpleNamespace

import pytest
from typer.testing import CliRunner

from tractus import ask as qa
from tractus import cli, notes
from tractus.export import render_export
from tractus.index import Index
from tractus.store import edit_transcript, find_meeting_dir, read_transcript, render_markdown, save_transcript, stamp
from tractus.summarize import MeetingSummary, build_prompt, check_segment_ids, render_summary_md, summarize, system_prompt

from test_edit_export import MID, SUMMARY, _transcript


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)  # 저장소의 .env.local(진짜 노트 위치)을 읽지 않게 한다
    monkeypatch.setenv("TRACTUS_HOME", str(tmp_path / "home"))
    return tmp_path / "home"


def run(*args, input=None):
    return CliRunner().invoke(cli.app, [*map(str, args)], input=input)


def new(home, **req):
    r = run("note", "new", input=json.dumps(req) if req else "")
    assert r.exit_code == 0, r.output
    out = json.loads(r.stdout.strip().splitlines()[-1])
    return out["meeting_id"], next((home / "meetings").glob(f"*{out['meeting_id']}"))


def save(ref, body):
    return run("note", "save", ref, input=json.dumps({"body": body}))


def last_line(r) -> str:
    return r.output.strip().splitlines()[-1]


# ── note new ─────────────────────────────────────────────────────────


def test_new_creates_memo_layout_with_default_title(home):
    r = run("note", "new")
    out = json.loads(r.stdout.strip().splitlines()[-1])
    d = home / "meetings" / next((home / "meetings").iterdir()).name
    assert r.exit_code == 0 and out["meeting_dir"] == str(d.resolve()) and out["meeting_id"] in d.name
    t = read_transcript(d)
    assert t["kind"] == "memo" and t["schema_version"] == 2 and t["segments"] == [] and t["body"] == ""
    assert t["audio"] == {"file": None, "duration_sec": 0, "source": "memo", "sha256": None}
    assert t["title"].startswith("메모 ") and len(t["title"]) == len("메모 HH:MM")
    assert (d / "transcript.md").is_file() and not (d / "transcript.vtt").exists() and not (d / "audio.ogg").exists()


def test_new_takes_title_and_body_from_stdin_and_title_option_wins(home):
    _, d = new(home, title="  장보기 \n 목록 ", body="우유\r\n\r\n계란\r빵\x00\x07")
    t = read_transcript(d)
    assert t["title"] == "장보기 목록" and t["body"] == "우유\n\n계란\n빵"
    assert [(s["id"], s["text"], s["line"]) for s in t["segments"]] == [("s0001", "우유", 1), ("s0002", "계란", 3), ("s0003", "빵", 4)]
    assert all(s["start"] == 0 == s["end"] and s["speaker"] is None and s["corrected_text"] is None and s["words"] is None for s in t["segments"])
    r = run("note", "new", "--title", "옵션 제목", input=json.dumps({"title": "stdin 제목"}))
    assert r.exit_code == 0
    assert "옵션 제목" in {read_transcript(p.parent)["title"] for p in (home / "meetings").glob("*/transcript.json")}


@pytest.mark.parametrize("raw", ["not json", "[1]", '{"title": 3}', '{"body": ["x"]}'])
def test_new_rejects_bad_input_and_creates_nothing(home, raw):
    r = run("note", "new", input=raw)
    assert r.exit_code == 2 and "형식이어야 합니다" in last_line(r)
    assert not (home / "meetings").exists() or not list((home / "meetings").iterdir())


def test_new_rejects_long_title_and_long_body(home):
    assert run("note", "new", input=json.dumps({"title": "가" * 121})).exit_code == 2
    r = run("note", "new", input=json.dumps({"body": "가" * (notes.MAX_BODY + 1)}))
    assert r.exit_code == 2 and last_line(r) == notes.BODY_LONG
    assert not (home / "meetings").exists() or not list((home / "meetings").iterdir())


def test_new_makes_note_findable_by_ulid_and_searchable(home):
    mid, d = new(home, title="아이디어", body="오로라 관측 여행 계획")
    assert find_meeting_dir(home / "meetings", mid[-8:]) == d
    r = run("search", "오로라")
    assert "아이디어" in r.stdout and "1번째 줄" in r.stdout and "00:00:00" not in r.stdout


# ── note save ────────────────────────────────────────────────────────


def test_save_keeps_ids_of_unchanged_lines_and_never_reuses_ids(home):
    mid, d = new(home, body="가\n나\n다")
    assert json.loads(save(mid, "가\n다").stdout) == {"saved": True, "segments": 2, "changed": True, "kind": "memo"}
    assert [(s["id"], s["text"]) for s in read_transcript(d)["segments"]] == [("s0001", "가"), ("s0003", "다")]
    save(mid, "가\n새로\n다")  # 새 줄은 s0004: 지워진 s0002를 되살리지 않는다
    assert [(s["id"], s["text"], s["line"]) for s in read_transcript(d)["segments"]] == [("s0001", "가", 1), ("s0004", "새로", 2), ("s0003", "다", 3)]
    save(mid, "가\n새로\n다\n")  # 마지막 줄바꿈만 늘어도 세그먼트는 그대로
    assert [s["id"] for s in read_transcript(d)["segments"]] == ["s0001", "s0004", "s0003"]


def test_save_keeps_id_of_line_edited_in_place_and_reports_no_change_for_same_body(home):
    mid, d = new(home, body="가\n나\n다")
    save(mid, "가\n나 고침\n다")
    assert [(s["id"], s["text"]) for s in read_transcript(d)["segments"]] == [("s0001", "가"), ("s0002", "나 고침"), ("s0003", "다")]
    mtime = (d / "transcript.json").stat().st_mtime_ns
    assert json.loads(save(mid, "가\n나 고침\n다").stdout)["changed"] is False
    assert (d / "transcript.json").stat().st_mtime_ns == mtime  # 바뀐 것이 없으면 다시 쓰지 않는다


def test_save_pairs_similar_line_when_a_line_is_inserted_and_edited_at_once(home):
    mid, d = new(home, body="첫째 줄\n둘째 줄 쿠버네티스\n셋째 줄")
    save(mid, "첫째 줄\n전혀 다른 새 줄\n둘째 줄 쿠버네티스 수정\n셋째 줄")
    got = {s["text"]: s["id"] for s in read_transcript(d)["segments"]}
    assert got["둘째 줄 쿠버네티스 수정"] == "s0002"  # 끼워 넣은 줄이 아니라 고친 줄이 옛 ID를 잇는다
    assert got["전혀 다른 새 줄"] == "s0004"


def test_derive_lines_does_not_pair_a_huge_replace_but_stays_fast():
    import time

    old = [{"id": f"m{i:04d}", "text": f"예전 줄 {i} " + "가" * 20} for i in range(1, 3001)]
    body = "\n".join(f"전혀 다른 글 {i} " + "나" * 20 for i in range(2000))  # 크기가 다른 큰 교체: 짝짓는 쌍이 상한을 넘는다
    t0 = time.monotonic()
    lines, seq = notes.derive_lines(body, old, 3000, "m")
    assert time.monotonic() - t0 < 1.0
    assert [l["id"] for l in lines[:2]] == ["m3001", "m3002"] and seq == 5000  # 옛 ID를 잇지 않고 새 번호


def test_save_id_counter_survives_deleting_the_last_line(home):
    mid, d = new(home, body="가\n나")
    save(mid, "가")
    save(mid, "가\n다")
    assert [s["id"] for s in read_transcript(d)["segments"]] == ["s0001", "s0003"]  # s0002는 이미 쓴 번호


def test_save_wraps_ids_after_s9999_without_collisions():
    segs, seq = notes.derive_segments("옛\n새 줄", [{"id": "s9999", "text": "옛"}], 9999)
    assert seq == 1 and [s["id"] for s in segs] == ["s9999", "s0001"]
    segs, _ = notes.derive_segments("가\n나", [{"id": "s0001", "text": "가"}], 9999)
    assert [s["id"] for s in segs] == ["s0001", "s0002"]


def test_save_rewrites_md_and_search_index_and_skips_vtt(home):
    mid, d = new(home, title="계획", body="첫째 줄")
    r = save(mid, "첫째 줄\n\n둘째 줄\t탭")
    assert r.exit_code == 0
    md = (d / "transcript.md").read_text(encoding="utf-8")
    assert md.endswith("# 계획\n\n첫째 줄\n\n둘째 줄\t탭\n") and "duration" not in md and "asr_model" not in md and "kind: memo" in md
    assert not (d / "transcript.vtt").exists()
    assert "둘째" in run("search", "둘째").stdout


def test_save_strips_control_characters_and_normalises_newlines(home):
    mid, d = new(home)
    save(mid, "가\r\n나\x00\x1b[0m\x85다\r라")
    assert read_transcript(d)["body"] == "가\n나[0m다\n라"


def test_save_rejects_bad_input_without_writing(home):
    mid, md = new(home, body="가")
    for raw in ("", "not json", '{"body": 1}', '{"text": "x"}'):
        r = run("note", "save", mid, input=raw)
        assert r.exit_code == 2 and "형식이어야 합니다" in last_line(r)
    assert read_transcript(md)["body"] == "가"
    r = save(mid, "가" * (notes.MAX_BODY + 1))
    assert r.exit_code == 2 and last_line(r) == notes.BODY_LONG
    r = save(mid, "\n".join("줄" * 1 for _ in range(notes.MAX_LINES + 1)))
    assert r.exit_code == 2 and last_line(r) == notes.LINES_LONG
    assert read_transcript(md)["body"] == "가"
    assert run("note", "save", "없는노트", input='{"body": ""}').exit_code == 2


def test_concurrent_saves_serialise_under_note_lock(home):
    mid, d = new(home, body="시작")
    errors = []

    def worker(i):
        try:
            for k in range(5):
                body = f"시작\n작업{i}-{k}"
                edit_transcript(d, lambda t: (notes.apply_body(t, body)[0], None))  # 읽기→쓰기를 잠금 안에서 하지 않으면 ID 번호가 겹친다
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(4)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    t = read_transcript(d)
    ids = [s["id"] for s in t["segments"]]
    assert not errors and len(ids) == len(set(ids)) == 2 and t["body"].startswith("시작\n작업")
    assert (d / "transcript.md").read_text(encoding="utf-8").count("작업") == 1


# ── note title ───────────────────────────────────────────────────────


def title(ref, value):
    return run("note", "title", ref, input=json.dumps({"title": value}))


def test_title_rename_keeps_folder_and_updates_json_md_index_and_summary_files(home):
    d = home / "meetings" / f"2026-10-02_주간회의_{MID}"
    d.mkdir(parents=True)
    save_transcript(d, _transcript())
    (d / "summary.md").write_text("---\nmeeting_id: x\n---\n\n# 옛 요약 제목\n\n본문\n# 다른 제목\n", encoding="utf-8")
    (d / "summary.json").write_text(json.dumps(SUMMARY, ensure_ascii=False), encoding="utf-8")
    idx = Index(home)
    idx.sync(embed=False)
    r = title(MID, "  새 제목 😀\n둘째줄 ")
    assert r.exit_code == 0 and json.loads(r.stdout.strip().splitlines()[-1]) == {"title": "새 제목 😀 둘째줄"}
    assert d.exists() and list((home / "meetings").iterdir()) == [d]  # 폴더 이름은 그대로
    t = read_transcript(d)
    assert t["title"] == "새 제목 😀 둘째줄" and t["audio"]["file"] == "audio.ogg" and "kind" not in t
    assert "title: 새 제목 😀 둘째줄" in (d / "transcript.md").read_text(encoding="utf-8") and (d / "transcript.vtt").is_file()
    assert json.loads((d / "summary.json").read_text(encoding="utf-8"))["title"] == "새 제목 😀 둘째줄"
    assert (d / "summary.md").read_text(encoding="utf-8").count("# 새 제목 😀 둘째줄") == 1 and "# 다른 제목" in (d / "summary.md").read_text(encoding="utf-8")
    assert idx.sync(embed=False).updated == 0  # CLI가 이미 색인을 갱신했다
    assert idx.search("안녕하십니까").hits[0].title == "새 제목 😀 둘째줄"
    idx.close()


def test_title_works_for_memo_without_summary_and_leaves_index_vectors_pending(home):
    mid, d = new(home, title="옛", body="벡터 확인 문장")
    r = title(mid, "새")
    assert r.exit_code == 0 and read_transcript(d)["title"] == "새"
    assert "# 새\n" in (d / "transcript.md").read_text(encoding="utf-8") and not (d / "summary.md").exists()
    idx = Index(home)
    assert idx.search("벡터").hits[0].title == "새"
    idx.close()


@pytest.mark.parametrize("raw, message", [("", notes.TITLE_EMPTY), (" \n\t ", notes.TITLE_EMPTY), ("\x00\x07", notes.TITLE_EMPTY), ("가" * 121, notes.TITLE_LONG)])
def test_title_rejects_empty_and_too_long(home, raw, message):
    mid, d = new(home, title="그대로")
    r = title(mid, raw)
    assert r.exit_code == 2 and last_line(r) == message and read_transcript(d)["title"] == "그대로"


def test_title_accepts_exactly_120_characters_and_korean_emoji(home):
    mid, d = new(home)
    assert title(mid, "한" * 120).exit_code == 0 and len(read_transcript(d)["title"]) == 120
    assert title(mid, "🎉" * 120).exit_code == 0 and read_transcript(d)["title"] == "🎉" * 120
    assert run("note", "title", mid, input="{}").exit_code == 2 and run("note", "title", "없는노트", input='{"title": "x"}').exit_code == 2


def test_old_note_without_kind_is_untouched_by_rendering_and_checks(home):
    d = home / "meetings" / f"2026-10-02_주간회의_{MID}"
    d.mkdir(parents=True)
    t = _transcript()
    assert "kind" not in t
    save_transcript(d, t)
    assert "duration: 01:01:42" in (d / "transcript.md").read_text(encoding="utf-8")
    assert run("segments", MID, "edit", input='{"edits": [{"id": "s0001", "text": "새 문장"}]}').exit_code == 0
    assert run("speakers", MID, "rename", "S2", "이영희").exit_code == 0


# ── 다른 기능과의 호환 ───────────────────────────────────────────────


def memo_with(home, body="예산은 동결합니다\n견적은 김철수 님이 받습니다"):
    mid, d = new(home, title="예산 메모", body=body)
    return mid, d, read_transcript(d)


def test_export_formats_for_memo(home):
    _, d, t = memo_with(home)
    (d / "summary.json").write_text(json.dumps({**SUMMARY, "topics": [], "decisions": [{"text": "동결", "segment_ids": ["s0001"]}], "action_items": []}), encoding="utf-8")
    txt = render_export(d, "txt").decode()
    assert txt.startswith("예산 메모\n") and txt.endswith("\n\n예산은 동결합니다\n견적은 김철수 님이 받습니다\n") and ":" not in txt.splitlines()[2]
    assert "[00" not in txt
    md = render_export(d, "md").decode()
    assert "# 예산 메모\n\n예산은 동결합니다\n\n견적은" in md and "00:00:00" not in md
    rows = list(csv.reader(io.StringIO(render_export(d, "csv").decode("utf-8-sig"))))
    assert rows == [["줄", "내용"], ["1", "예산은 동결합니다"], ["2", "견적은 김철수 님이 받습니다"]]
    import docx

    doc = docx.Document(io.BytesIO(render_export(d, "docx")))
    body = [p.text for p in doc.paragraphs]
    assert "예산 메모" in body and "메모 내용" in body and "예산은 동결합니다" in body and not any("길이" in x or "00:00:00" in x for x in body)
    with zipfile.ZipFile(io.BytesIO(render_export(d, "bundle"))) as z:
        names = {n.split("/", 1)[1] for n in z.namelist()}
        assert {"transcript.json", "transcript.md", "summary.json"} <= names and not any(n.startswith("audio") or n.endswith(".vtt") for n in names)


def test_export_srt_and_vtt_are_refused_for_memo(home):
    mid, d, _ = memo_with(home)
    for fmt in ("srt", "vtt"):
        out = home.parent / f"x.{fmt}"
        r = run("export", mid, "--format", fmt, "--out", out)
        assert r.exit_code == 2 and last_line(r) == "메모는 자막 파일로 내보낼 수 없습니다." and not out.exists()
    assert run("export", mid, "--format", "txt", "--out", home.parent / "x.txt").exit_code == 0


def test_summary_prompt_and_markdown_have_no_times_for_memo(home):
    _, _, t = memo_with(home)
    prompt = build_prompt(t)
    assert prompt.startswith("메모 제목: 예산 메모\n\n메모:\n[s0001] 예산은 동결합니다\n[s0002] 견적은") and "00:00" not in prompt
    assert "직접 쓴 메모" in system_prompt(t) and "직접 쓴 메모" not in system_prompt({"segments": []})
    s = MeetingSummary.model_validate({"title": "예산", "summary": "동결.", "topics": [{"title": "예산", "segment_ids": ["s0001"]}],
                                       "decisions": [{"text": "동결", "segment_ids": ["s0001"]}],
                                       "action_items": [{"task": "견적", "owner": "김철수", "due": None, "segment_ids": ["s0002"]}]})
    check_segment_ids(s, t)
    md = render_summary_md(s, t, "p", "m", "g")
    assert "### 예산\n" in md and "- 동결\n" in md and "- [ ] 견적 — 김철수\n" in md and "00:00" not in md


def test_summarize_memo_with_fake_provider(home):
    _, _, t = memo_with(home)
    reply = json.dumps({"title": "예산", "summary": "동결.", "topics": [], "decisions": [{"text": "동결", "segment_ids": ["s0001"]}], "action_items": []})
    calls = []

    def create(**kw):
        calls.append(kw)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=reply))])

    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    from tractus.llm import PROVIDERS

    out = summarize(client, PROVIDERS["upstage"], "m", t)
    assert out.decisions[0].segment_ids == ["s0001"]
    assert "직접 쓴 메모" in calls[0]["messages"][0]["content"] and "[s0002]" in calls[0]["messages"][1]["content"]


def test_summarize_cli_refuses_empty_memo_with_memo_sentence(home):
    mid, _ = new(home)
    r = run("summarize", mid)
    assert r.exit_code == 1 and last_line(r) == "메모가 비어 있어 요약할 수 없습니다"


def test_ask_sources_prompt_and_citations_use_line_numbers_for_memo(home):
    _, _, t = memo_with(home, "첫 줄\n\n예산은 동결합니다")
    sources = qa.transcript_sources(t)
    assert [s["line"] for s in sources] == [1, 3] and all(s["start"] == 0.0 for s in sources)
    msgs = qa.build_messages("예산은?", [], sources, "meeting")
    assert "[s0002] 예산은 동결합니다" in msgs[-1]["content"] and "00:00" not in msgs[-1]["content"]
    answer, cites = qa.finalize("동결입니다 [s0002]", sources, "meeting")
    assert answer == "동결입니다 [s0002]" and cites == [{"meeting_id": t["meeting_id"], "segment_id": "s0002", "start": 0.0, "line": 3}]
    assert stamp(cites[0]) == "3번째 줄" and stamp({"start": 65}) == "00:01:05"
    rec = qa.transcript_sources(_transcript())
    assert "line" not in rec[0]


def test_ask_cli_prints_line_label_for_memo_citations(home, monkeypatch):
    mid, d, t = memo_with(home, "가\n예산은 동결합니다")
    chunk = lambda x: SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=x))])  # noqa: E731
    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kw: iter([chunk("동결 [s0002]")]))))
    monkeypatch.setattr(cli, "make_client", lambda p: client)
    monkeypatch.setattr(cli, "resolve_provider", lambda p, m: (SimpleNamespace(name="fake", temperature=0.2, base_url="http://x"), "m"))
    r = run("ask", "--meeting", mid, input="예산은?")
    assert r.exit_code == 0 and "[s0002 2번째 줄]" in r.stdout and "00:00:00" not in r.stdout


def test_search_hits_carry_line_and_new_title(home):
    mid, d, _ = memo_with(home, "가\n\n희귀단어 포함 줄")
    title(mid, "바뀐 제목")
    idx = Index(home)
    hit = idx.search("희귀단어").hits[0]
    idx.close()
    assert hit.title == "바뀐 제목" and [(s["id"], s["line"], s["start"]) for s in hit.segments] == [("s0001", 1, 0.0), ("s0002", 3, 0.0)]


def test_index_picks_up_memo_edits_and_keeps_vectors_of_unchanged_chunks(home):
    import hashlib

    import numpy as np

    class Emb:
        model_id, dim = "fake", 8

        def embed(self, texts, is_query=False):
            return np.array([[b / 255 for b in hashlib.md5(t.encode()).digest()[:8]] for t in texts], np.float32)

    mid, d = new(home, body="가나다라 " * 100)  # 300자 이상: 청크 하나로 닫힌다
    idx = Index(home, embedder=Emb())
    idx.sync()
    assert idx.stats()["pending"] == 0
    save(mid, "가나다라 " * 100 + "\n새로 쓴 문단 " * 70)
    idx.sync(embed=False)
    assert idx.stats()["pending"] > 0  # 새 청크는 벡터 대기 (앱의 조용한 색인이 채운다)
    idx.sync()
    assert idx.stats()["pending"] == 0
    idx.close()


def test_mcp_tools_tolerate_memo_notes(home):
    import anyio
    from mcp import Client

    from tractus.mcp_server import build_server
    from test_index import FakeEmbedder

    mid, d, _ = memo_with(home)

    async def go():
        async with Client(build_server(home, FakeEmbedder())) as c:
            lst = (await c.call_tool("list_meetings", {})).structured_content
            tr = (await c.call_tool("get_transcript", {"meeting_id": mid})).content[0].text
            sr = (await c.call_tool("search_meetings", {"query": "예산은"})).structured_content
            return lst, tr, sr

    lst, tr, sr = anyio.run(go)
    assert lst["meetings"][0]["kind"] == "memo" and lst["meetings"][0]["duration_sec"] == 0
    assert "[s0001 1번째 줄] 예산은 동결합니다" in tr
    seg = sr["hits"][0]["segments"][0]
    assert seg["time"] == "1번째 줄" and seg["cite"].endswith(" 1번째 줄]") and "#" not in seg["cite"]


def test_audio_only_commands_refuse_memo(home):
    mid, d, _ = memo_with(home)
    r = run("align", mid)
    assert r.exit_code == 2 and last_line(r) == notes.NO_AUDIO_ALIGN
    for args in (("speakers", mid, "set", "s0001", "new"), ("segments", mid, "edit"), ("voices", "enroll", mid, "S1", "--name", "가", "--consent")):
        r = run(*args, input='{"edits": []}')
        assert r.exit_code == 2, args
    assert read_transcript(d)["speakers"] == {} and run("render", mid).exit_code == 0 and not (d / "transcript.vtt").exists()


def test_memo_folder_is_deletable_like_any_note(home):
    import shutil

    mid, d = new(home, body="지울 메모")
    idx = Index(home)
    idx.sync(embed=False)
    shutil.rmtree(d)
    assert idx.sync(embed=False).removed == 1 and idx.search("지울").hits == []
    idx.close()


def test_render_markdown_memo_handles_missing_asr_and_empty_body():
    t = notes.new_memo("빈 메모", "", __import__("datetime").datetime(2026, 10, 13, 9, 5).astimezone(), "01TESTMEMO")
    assert "asr" not in t and render_markdown(t).endswith("# 빈 메모\n\n")
