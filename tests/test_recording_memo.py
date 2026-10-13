"""녹음 노트의 사용자 메모(transcript.json의 "memo", docs/desktop.md §2.10). 모델·FFmpeg·네트워크 없이 도는 테스트."""

import csv
import hashlib
import io
import json
import shutil
import threading
import zipfile
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from typer.testing import CliRunner

from tractus import ask as qa
from tractus import cli, notes
from tractus.export import render_export
from tractus.index import Index
from tractus.store import apply_text_edits, edit_transcript, memo_lines, read_transcript, render_markdown, save_transcript, stamp
from tractus.summarize import MeetingSummary, build_prompt, check_segment_ids, render_summary_md, summarize, system_prompt

from test_edit_export import MID, SUMMARY, _transcript

EVAL = Path(__file__).parent / "fixtures" / "eval"
MEMO_BODY = "예산은 동결합니다\n\n견적은 김철수 님이 받습니다"


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("TRACTUS_HOME", str(tmp_path / "home"))
    return tmp_path / "home"


@pytest.fixture
def rec(home):
    """ASR 세그먼트 3개가 있는 녹음 노트 폴더 (메모 없음)."""
    d = home / "meetings" / f"2026-10-02_주간회의_{MID}"
    d.mkdir(parents=True)
    save_transcript(d, _transcript())
    (d / "audio.ogg").write_bytes(b"OggS fake audio")
    return d


def run(*args, input=None):
    return CliRunner().invoke(cli.app, [*map(str, args)], input=input)


def save(body, ref=MID):
    return run("note", "save", ref, input=json.dumps({"body": body}))


def last_line(r) -> str:
    return r.output.strip().splitlines()[-1]


def with_memo(d, body=MEMO_BODY):
    assert save(body).exit_code == 0
    return read_transcript(d)


# ── 데이터 모델 ──────────────────────────────────────────────────────


def test_save_writes_memo_block_and_leaves_asr_data_untouched(rec):
    before = read_transcript(rec)
    r = save(MEMO_BODY)
    assert r.exit_code == 0 and json.loads(last_line(r)) == {"saved": True, "segments": 2, "changed": True, "kind": "recording"}
    t = read_transcript(rec)
    assert t["memo"] == {"body": MEMO_BODY, "seq": 2, "lines": [{"id": "m0001", "line": 1, "text": "예산은 동결합니다"}, {"id": "m0002", "line": 3, "text": "견적은 김철수 님이 받습니다"}]}
    assert {k: v for k, v in t.items() if k != "memo"} == before and "kind" not in t  # segments·words·speakers·audio 그대로, 녹음 노트로 남는다
    assert not (rec / "summary.json").exists() and (rec / "audio.ogg").read_bytes() == b"OggS fake audio"


def test_save_is_idempotent_and_clearing_removes_memo_key(rec):
    save(MEMO_BODY)
    mtime = (rec / "transcript.json").stat().st_mtime_ns
    assert json.loads(last_line(save(MEMO_BODY)))["changed"] is False and (rec / "transcript.json").stat().st_mtime_ns == mtime
    r = save("  \n\t\n")  # 공백뿐인 본문도 빈 메모다
    assert json.loads(last_line(r)) == {"saved": True, "segments": 0, "changed": True, "kind": "recording"}
    assert "memo" not in read_transcript(rec) and "## 메모" not in (rec / "transcript.md").read_text(encoding="utf-8")
    assert json.loads(last_line(save("")))["changed"] is False  # 이미 비었다


def test_memo_ids_are_separate_from_asr_ids_stable_and_never_reused(rec):
    save("가\n나\n다")
    assert [m["id"] for m in memo_lines(read_transcript(rec))] == ["m0001", "m0002", "m0003"]
    save("가\n다")
    save("가\n새로\n다")  # 지운 m0002를 되살리지 않는다
    t = read_transcript(rec)
    assert [(m["id"], m["text"], m["line"]) for m in memo_lines(t)] == [("m0001", "가", 1), ("m0004", "새로", 2), ("m0003", "다", 3)] and t["memo"]["seq"] == 4
    assert [s["id"] for s in t["segments"]] == ["s0001", "s0002", "s0003"]
    save("가\n새로\n다\n")  # 끝의 줄바꿈만 늘어도 줄은 그대로
    assert [m["id"] for m in memo_lines(read_transcript(rec))] == ["m0001", "m0004", "m0003"]


def test_memo_line_edited_in_place_or_with_insertion_keeps_its_id(rec):
    save("첫째 줄\n둘째 줄 쿠버네티스\n셋째 줄")
    save("첫째 줄\n둘째 줄 쿠버네티스 고침\n셋째 줄")  # 같은 자리
    assert [m["id"] for m in memo_lines(read_transcript(rec))] == ["m0001", "m0002", "m0003"]
    save("첫째 줄\n전혀 다른 새 줄\n둘째 줄 쿠버네티스 수정본\n셋째 줄")  # 줄을 끼워 넣으며 고침: 닮은 줄이 ID를 잇는다
    got = {m["text"]: m["id"] for m in memo_lines(read_transcript(rec))}
    assert got["둘째 줄 쿠버네티스 수정본"] == "m0002" and got["전혀 다른 새 줄"] == "m0004"


def test_memo_normalises_input_and_enforces_limits_without_writing(rec):
    save("가\r\n나\x00\x1b[0m\x85다\r라")
    assert read_transcript(rec)["memo"]["body"] == "가\n나[0m다\n라"
    before = (rec / "transcript.json").read_bytes()
    r = save("가" * (notes.MAX_BODY + 1))
    assert r.exit_code == 2 and last_line(r) == notes.BODY_LONG
    r = save("\n".join("줄" for _ in range(notes.MAX_LINES + 1)))
    assert r.exit_code == 2 and last_line(r) == notes.LINES_LONG
    assert save("\n".join("줄" for _ in range(notes.MAX_LINES))).exit_code == 0  # 한도 안은 된다
    for raw in ("", "not json", '{"body": 1}', '{"text": "x"}'):
        r = run("note", "save", MID, input=raw)
        assert r.exit_code == 2 and "형식이어야 합니다" in last_line(r)
    assert (rec / "transcript.json").read_bytes() != before and len(memo_lines(read_transcript(rec))) == notes.MAX_LINES


def test_memo_id_numbers_wrap_after_9999_without_collisions():
    lines, seq = notes.derive_lines("옛\n새 줄", [{"id": "m9999", "text": "옛"}], 9999, "m")
    assert seq == 1 and [x["id"] for x in lines] == ["m9999", "m0001"]
    lines, seq = notes.derive_lines("가\n나", [{"id": "m0005", "text": "가"}], 0, "m")  # seq가 낡아도 옛 줄의 번호 다음부터
    assert [x["id"] for x in lines] == ["m0005", "m0006"] and seq == 6


def test_note_with_other_edits_keeps_memo(rec):
    with_memo(rec)
    edit_transcript(rec, lambda t: apply_text_edits(t, [{"id": "s0002", "text": "예산 고침"}]))
    assert run("speakers", MID, "rename", "S2", "이영희").exit_code == 0
    assert run("note", "title", MID, input='{"title": "새 제목"}').exit_code == 0
    seg = {**read_transcript(rec)["segments"][0], "words": [{"text": "안녕하십니까", "start": 0.0, "end": 1.0}]}
    assert cli._save_words(rec, [seg], {"s0001"})["aligned"] == 1  # 단어 싱크 병합도 메모를 이어 간다
    t = read_transcript(rec)
    assert t["memo"]["body"] == MEMO_BODY and t["title"] == "새 제목" and t["segments"][1]["corrected_text"] == "예산 고침"


def test_concurrent_memo_saves_and_asr_edits_do_not_lose_each_other(rec):
    save("시작")
    errors = []

    def memo_worker(i):
        try:
            for k in range(5):
                body = f"시작\n작업{i}-{k}"
                edit_transcript(rec, lambda t: (notes.apply_body(t, body)[0], None))
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    def edit_worker():
        try:
            for k in range(5):
                edit_transcript(rec, lambda t: apply_text_edits(t, [{"id": "s0003", "text": f"마무리 {k}"}])[:1] + (None,))
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=memo_worker, args=(i,)) for i in range(3)] + [threading.Thread(target=edit_worker)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    t = read_transcript(rec)
    ids = [m["id"] for m in memo_lines(t)]
    assert not errors and len(ids) == len(set(ids)) == 2 and t["segments"][2]["corrected_text"] == "마무리 4"
    assert (rec / "transcript.md").read_text(encoding="utf-8").count("작업") == 1


def test_old_notes_and_malformed_memo_blocks_are_tolerated_everywhere(rec):
    t = read_transcript(rec)
    assert memo_lines(t) == [] and "## 메모" not in render_markdown(t)
    for bad in (5, "x", [], {"lines": 3}, {"lines": [None, 1, {"id": "s0001", "line": 1, "text": "x"}, {"id": "m0001", "line": 0, "text": "x"}, {"id": "m0002", "line": 1, "text": "  "}]}):
        t2 = {**t, "memo": bad}
        assert memo_lines(t2) == [] and "## 메모" not in render_markdown(t2)
        qa.transcript_sources(t2)
        build_prompt(t2)
        assert "직접 쓴 메모" not in system_prompt(t2)
        (rec / "transcript.json").write_text(json.dumps(t2, ensure_ascii=False), encoding="utf-8")
        for fmt in ("txt", "md", "csv", "docx", "bundle", "srt", "vtt"):
            render_export(rec, fmt)
        assert run("note", "save", MID, input='{"body": "정상 메모"}').exit_code == 0  # 깨진 블록 위에도 저장된다
        assert read_transcript(rec)["memo"]["lines"] == [{"id": "m0001", "line": 1, "text": "정상 메모"}]
        (rec / "transcript.json").write_text(json.dumps(t, ensure_ascii=False), encoding="utf-8")


def test_stamp_labels_memo_lines():
    assert stamp({"source": "memo", "line": 3, "start": 0.0}) == "메모 3번째 줄"
    assert stamp({"line": 3, "start": 0.0}) == "3번째 줄" and stamp({"start": 65}) == "00:01:05"


# ── 문서·내보내기 ────────────────────────────────────────────────────


def test_markdown_gets_memo_section_after_transcript_and_vtt_is_captions_only(rec):
    t = with_memo(rec)
    md = (rec / "transcript.md").read_text(encoding="utf-8")
    assert md.endswith("[01:01:40] 마무리\n\n## 메모\n\n예산은 동결합니다\n\n견적은 김철수 님이 받습니다\n")
    assert md.index("마무리") < md.index("## 메모") and render_markdown(t) == md
    assert "메모" not in (rec / "transcript.vtt").read_text(encoding="utf-8") and "예산은 동결" not in (rec / "transcript.vtt").read_text(encoding="utf-8")


def test_export_formats_include_memo_section_but_subtitles_do_not(rec):
    with_memo(rec)
    (rec / "summary.json").write_text(json.dumps(SUMMARY, ensure_ascii=False), encoding="utf-8")
    txt = render_export(rec, "txt").decode()
    assert txt.endswith("[01:01:40] 마무리\n\n메모\n\n예산은 동결합니다\n견적은 김철수 님이 받습니다\n")
    assert "## 메모\n\n예산은 동결합니다\n\n견적은" in render_export(rec, "md").decode()
    raw = render_export(rec, "csv")
    assert raw.startswith(b"\xef\xbb\xbf")
    rows = list(csv.reader(io.StringIO(raw.decode("utf-8-sig"))))
    assert rows[0] == ["시작", "끝", "참석자", "내용"] and rows[-2:] == [["메모 1번째 줄", "", "", "예산은 동결합니다"], ["메모 3번째 줄", "", "", "견적은 김철수 님이 받습니다"]]
    assert len(rows) == 1 + 3 + 2 and {len(r) for r in rows} == {4}
    import docx

    paras = [(p.style.name, p.text) for p in docx.Document(io.BytesIO(render_export(rec, "docx"))).paragraphs]
    i = paras.index(("Heading 1", "메모"))
    assert paras[i - 1][1].endswith("마무리")
    assert [p[1] for p in paras[i + 1:]] == ["예산은 동결합니다", "견적은 김철수 님이 받습니다"]
    for fmt in ("srt", "vtt"):
        assert "예산은 동결합니다" not in render_export(rec, fmt).decode()
    with zipfile.ZipFile(io.BytesIO(render_export(rec, "bundle"))) as z:
        prefix = z.namelist()[0].split("/")[0]
        assert json.loads(z.read(f"{prefix}/transcript.json"))["memo"]["body"] == MEMO_BODY and "## 메모" in z.read(f"{prefix}/transcript.md").decode()


def test_export_without_memo_is_unchanged(rec):
    txt = render_export(rec, "txt").decode()
    assert "메모" not in txt and "메모" not in render_export(rec, "md").decode()
    rows = list(csv.reader(io.StringIO(render_export(rec, "csv").decode("utf-8-sig"))))
    assert len(rows) == 4


# ── 색인·검색 ────────────────────────────────────────────────────────


class Emb:
    model_id, dim = "fake", 8

    def embed(self, texts, is_query=False):
        return np.array([[b / 255 for b in hashlib.md5(t.encode()).digest()[:8]] for t in texts], np.float32)


def test_memo_lines_are_their_own_chunks_and_hits_carry_source_and_line(rec, home):
    with_memo(rec, "첫 줄\n\n희귀단어 포함 줄")
    idx = Index(home)
    idx.sync(embed=False)
    chunks = idx.db.execute("SELECT segments FROM chunks ORDER BY ord").fetchall()
    kinds = [{s.get("source") for s in json.loads(c[0])} for c in chunks]
    assert kinds == [{None}, {"memo"}]  # ASR 청크와 메모 청크는 섞이지 않는다
    hit = idx.search("희귀단어").hits[0]
    assert hit.source == "memo" and [(s["id"], s["line"], s["source"], s["start"]) for s in hit.segments] == [("m0001", 1, "memo", 0.0), ("m0002", 3, "memo", 0.0)]
    assert [stamp(s) for s in hit.segments] == ["메모 1번째 줄", "메모 3번째 줄"]
    asr = idx.search("안녕하십니까").hits[0]
    assert asr.source == "transcript" and all("source" not in s and "line" not in s for s in asr.segments)
    idx.close()


def test_index_resyncs_when_memo_changes_and_keeps_vectors_of_unchanged_chunks(rec, home):
    save("가나다라 " * 100)  # 300자 이상: 청크 하나로 닫힌다
    idx = Index(home, embedder=Emb())
    idx.sync()
    n = idx.stats()["chunks"]
    assert n == 2 and idx.stats()["pending"] == 0
    save("가나다라 " * 100 + "\n새로 쓴 문단 " * 70)
    idx.sync(embed=False)  # (CLI가 저장하면서 이미 키워드 색인을 갱신했다)
    assert idx.stats()["pending"] >= 1 and idx.stats()["vectors"] >= 2  # ASR 청크와 안 바뀐 메모 청크는 벡터를 그대로
    idx.sync()
    assert idx.stats()["pending"] == 0
    save("")  # 메모를 지우면 메모 청크도 사라진다
    idx.sync(embed=False)
    assert idx.stats()["chunks"] == 1 and not [h for h in idx.search("가나다라").hits if "keyword" in h.matched]
    idx.close()


def test_cli_search_prints_memo_label(rec):
    with_memo(rec, "오로라 관측 여행 계획")
    r = run("search", "오로라")
    memo_line = next(x for x in r.stdout.splitlines() if "오로라 관측 여행 계획" in x)
    assert "#m0001 메모 1번째 줄]" in memo_line and "00:00:00" not in memo_line  # (벡터 검색이 켜지면 다른 ASR 줄도 따라 나오므로 메모 줄만 본다)


# ── MCP ──────────────────────────────────────────────────────────────


def _mcp(home, calls):
    import anyio
    from mcp import Client

    from test_index import FakeEmbedder
    from tractus.mcp_server import build_server

    async def go():
        async with Client(build_server(home, FakeEmbedder())) as c:
            return [await c.call_tool(name, args) for name, args in calls]

    return anyio.run(go)


def test_mcp_search_and_get_transcript_label_memo_lines(rec, home):
    with_memo(rec, "오로라 관측 여행\n\n둘째 메모")
    sr, tr, tr2, lst = _mcp(home, [("search_meetings", {"query": "오로라"}), ("get_transcript", {"meeting_id": MID}),
                                   ("get_transcript", {"meeting_id": MID, "max_segments": 2}), ("list_meetings", {})])
    seg = sr.structured_content["hits"][0]["segments"][0]
    assert (seg["id"], seg["source"], seg["time"], seg["line"]) == ("m0001", "memo", "메모 1번째 줄", 1) and seg["cite"].endswith("#m0001 메모 1번째 줄]")
    lines = tr.content[0].text.splitlines()
    assert lines[-3:] == ["memo (사용자가 직접 적은 메모, 음성 인식 아님, 2줄):", "[m0001 메모 1번째 줄] 오로라 관측 여행", "[m0002 메모 3번째 줄] 둘째 메모"]
    assert lines.index("(끝)") < next(i for i, x in enumerate(lines) if x.startswith("memo ("))  # 전사 끝 뒤에 memo 구간
    assert "next_offset: 2" in tr2.content[0].text and "memo (" not in tr2.content[0].text  # 중간 쪽에는 붙지 않는다
    assert lst.structured_content["meetings"][0]["segments"] == 3  # 목록은 ASR 세그먼트 수 그대로


def test_mcp_save_summary_accepts_memo_ids_and_action_items_cite_memo_lines(rec, home):
    with_memo(rec)
    s = {"title": "예산", "summary": "동결.", "topics": [{"title": "예산", "segment_ids": ["s0002", "m0001"]}], "decisions": [{"text": "동결", "segment_ids": ["m0001"]}],
         "action_items": [{"task": "견적", "owner": "김철수", "due": None, "segment_ids": ["m0002"]}]}
    bad = {**s, "decisions": [{"text": "x", "segment_ids": ["m0099"]}]}
    ok, refused, items = _mcp(home, [("save_summary", {"meeting_id": MID, "summary": s, "author": "t"}), ("save_summary", {"meeting_id": MID, "summary": bad, "author": "t"}),
                                     ("list_action_items", {"meeting_id": MID})])
    assert not ok.is_error and refused.is_error and "m0099" in refused.content[0].text
    assert items.structured_content["items"][0]["cite"].endswith("#m0002 메모 3번째 줄]")
    md = (rec / "summary.md").read_text(encoding="utf-8")
    assert "- 동결 [메모 1번째 줄]\n" in md and "- [ ] 견적 — 김철수 [메모 3번째 줄]\n" in md and "### 예산 [00:00:03–00:01:05, 메모 1번째 줄]\n" in md


# ── 질문 ─────────────────────────────────────────────────────────────


def test_ask_evidence_has_separate_memo_block_and_citations_carry_source_and_line(rec):
    t = with_memo(rec)
    src = qa.transcript_sources(t)
    assert [s["segment_id"] for s in src] == ["s0001", "s0002", "s0003", "m0001", "m0002"]
    memo = [s for s in src if s.get("source") == "memo"]
    assert [(s["line"], s["start"], s["speaker"]) for s in memo] == [(1, 0.0, None), (3, 0.0, None)] and all("source" not in s for s in src[:3])
    msgs = qa.build_messages("예산은?", [], src, "meeting")
    user = msgs[-1]["content"]
    assert user.index("[내가 적은 메모]") < user.index("[m0001] 예산은 동결합니다") < user.index("[대화 기록]") < user.index("[s0001 00:00:00") and "[m0002] 견적은" in user
    assert "내가 적은 메모" in msgs[0]["content"]  # 시스템 프롬프트에도 메모 규칙이 붙는다
    answer, cites = qa.finalize("동결합니다 [m0001] 자세한 건 [s0002]. [m0099] 없는 건 지운다", src, "meeting")
    assert answer == "동결합니다 [m0001] 자세한 건 [s0002]. 없는 건 지운다"
    assert cites == [{"meeting_id": MID, "segment_id": "m0001", "start": 0.0, "line": 1, "source": "memo"}, {"meeting_id": MID, "segment_id": "s0002", "start": 3.0}]
    assert [stamp(c) for c in cites] == ["메모 1번째 줄", "00:00:03"]
    answer, cites = qa.finalize(f"동결 [{MID}#m0002]", src, "global")
    assert answer == f"동결 [{MID}#m0002]" and cites[0]["segment_id"] == "m0002"


def test_ask_prompt_is_unchanged_for_notes_without_memo(rec):
    src = qa.transcript_sources(read_transcript(rec))
    msgs = qa.build_messages("예산은?", [], src, "meeting")
    assert "내가 적은 메모" not in msgs[0]["content"] + msgs[-1]["content"] and qa.MEMO_PROMPT not in msgs[0]["content"]


def test_global_ask_retrieval_includes_memo_chunks_with_neighbours(rec, home):
    with_memo(rec, "인사\n\n희귀단어 견적 마감 금요일\n\n끝 메모\n마지막")
    idx = Index(home)
    idx.sync(embed=False)
    src = qa.search_sources(idx, "희귀단어 마감")
    idx.close()
    memo = [(s["segment_id"], s["line"]) for s in src if s.get("source") == "memo"]
    assert memo[:2] == [("m0001", 1), ("m0002", 3)] and all(s["meeting_id"] == MID for s in src)
    msgs = qa.build_messages("마감?", [], src, "global")
    assert f"[{MID}#m0002] 희귀단어 견적 마감 금요일" in msgs[-1]["content"] and "[내가 적은 메모]" in msgs[-1]["content"]


def test_ask_prompt_with_memo_lines_only_has_no_transcript_label(rec):
    src = [s for s in qa.transcript_sources(with_memo(rec)) if s.get("source") == "memo"]
    user = qa.build_messages("예산은?", [], src, "meeting")[-1]["content"]
    assert "[내가 적은 메모]" in user and "[대화 기록]" not in user


def test_ask_cli_prints_memo_label_for_memo_citations(rec, monkeypatch):
    with_memo(rec)
    chunk = lambda x: SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=x))])  # noqa: E731
    seen = []

    def create(**kw):
        seen.append(kw["messages"])
        return iter([chunk("동결 [m0001]")])

    monkeypatch.setattr(cli, "make_client", lambda p: SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create))))
    monkeypatch.setattr(cli, "resolve_provider", lambda p, m: (SimpleNamespace(name="fake"), "m"))
    r = run("ask", "--meeting", MID, input="예산은?")
    assert r.exit_code == 0 and "[m0001 메모 1번째 줄]" in r.stdout and "[내가 적은 메모]" in seen[0][-1]["content"]


# ── 요약 ─────────────────────────────────────────────────────────────


def test_summary_prompt_has_separate_memo_block_and_validates_memo_ids(rec):
    t = with_memo(rec)
    prompt = build_prompt(t)
    assert prompt.endswith("\n\n사용자가 적은 메모:\n[m0001] 예산은 동결합니다\n[m0002] 견적은 김철수 님이 받습니다") and "[s0001 00:00:00 김민수]" in prompt
    assert "사용자가 적은 메모" in system_prompt(t) and "m0001" in system_prompt(t) and "직접 쓴 메모" not in system_prompt(t).replace("사용자가 직접 쓴 글", "")
    mk = lambda ids: MeetingSummary.model_validate({"title": "t", "summary": "s", "topics": [{"title": "a", "segment_ids": ids}], "decisions": [], "action_items": []})  # noqa: E731
    check_segment_ids(mk(["s0001", "m0002"]), t)
    with pytest.raises(ValueError, match="m0003"):
        check_segment_ids(mk(["m0003"]), t)
    with pytest.raises(ValueError):
        check_segment_ids(mk(["m0001"]), _transcript())  # 메모가 없는 노트에서 m ID는 모르는 ID


def test_summary_markdown_renders_memo_citations_without_timestamps(rec):
    t = with_memo(rec)
    s = MeetingSummary.model_validate({
        "title": "예산", "summary": "동결.",
        "topics": [{"title": "메모만", "segment_ids": ["m0001", "m0002"]}, {"title": "섞임", "segment_ids": ["s0002", "m0002"]}, {"title": "전사만", "segment_ids": ["s0002"]}],
        "decisions": [{"text": "동결", "segment_ids": ["m0001"]}], "action_items": [{"task": "견적", "owner": None, "due": None, "segment_ids": ["s0001", "m0002"]}]})
    md = render_summary_md(s, t, "p", "m", "g")
    assert "### 메모만 [메모 1–3번째 줄]\n" in md and "### 섞임 [00:00:03–00:01:05, 메모 3번째 줄]\n" in md and "### 전사만 [00:00:03–00:01:05]\n" in md
    assert "- 동결 [메모 1번째 줄]\n" in md and "- [ ] 견적 [00:00:00, 메모 3번째 줄]\n" in md
    assert render_summary_md(s, _transcript(), "p", "m", "g").count("[메모") == 0  # 메모 없는 노트: 모르는 ID는 위치를 비운다


def test_summarize_sends_memo_block_with_fake_provider(rec):
    t = with_memo(rec)
    reply = json.dumps({"title": "예산", "summary": "동결.", "topics": [], "decisions": [{"text": "동결", "segment_ids": ["m0001"]}], "action_items": []})
    calls = []

    def create(**kw):
        calls.append(kw)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=reply))])

    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    from tractus.llm import PROVIDERS

    assert summarize(client, PROVIDERS["upstage"], "m", t).decisions[0].segment_ids == ["m0001"]
    assert "[m0002]" in calls[0]["messages"][1]["content"]


# ── 가상 평가 노트 ───────────────────────────────────────────────────


def test_eval_memo_fixtures_are_consistent_with_derive_lines():
    for p in (EVAL / "memo_meetings").glob("*/transcript.json"):
        t = json.loads(p.read_text(encoding="utf-8"))
        again, _ = notes.apply_body(t, t["memo"]["body"])
        assert again == t and "## 메모" in (p.parent / "transcript.md").read_text(encoding="utf-8")
    qs = [json.loads(x) for x in (EVAL / "ask_memo_questions.jsonl").read_text(encoding="utf-8").splitlines() if x.strip()]
    ids = {t["meeting_id"]: {m["id"] for m in memo_lines(t)} for t in (json.loads(p.read_text(encoding="utf-8")) for p in (EVAL / "memo_meetings").glob("*/transcript.json"))}
    assert len(qs) == 6 and all(sid in ids[mid] for q in qs for mid, sids in q["gold"].items() for sid in sids)


def test_memo_questions_retrieve_their_memo_line_by_keyword_search(tmp_path):
    shutil.copytree(EVAL / "meetings", tmp_path / "meetings")
    shutil.copytree(EVAL / "memo_meetings", tmp_path / "meetings", dirs_exist_ok=True)
    idx = Index(tmp_path)
    idx.sync(embed=False)
    qs = [json.loads(x) for x in (EVAL / "ask_memo_questions.jsonl").read_text(encoding="utf-8").splitlines() if x.strip()]
    for q in qs:
        if q["type"] == "meeting":
            continue  # 노트 범위 질문은 전사 전체를 보낸다
        got = {(s["meeting_id"], s["segment_id"]) for s in qa.search_sources(idx, q["question"], date_from=q.get("from"), date_to=q.get("to"))}
        assert {(m, s) for m, ids in q["gold"].items() for s in ids} <= got, q["qid"]
    idx.close()
