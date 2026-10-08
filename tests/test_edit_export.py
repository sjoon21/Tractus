"""Phase 5 CLI: 세그먼트 텍스트 편집, 용어집 추가, 내보내기. 회의 폴더는 save_transcript로 직접 만든다 (모델·FFmpeg 불필요)."""

import csv
import io
import json
import zipfile
from pathlib import Path

import pytest
from typer.testing import CliRunner

from tractus import cli
from tractus.store import load_glossary, render_vtt, save_transcript

MID = "01K6X3TESTMEETING000000000"


def _transcript() -> dict:
    return {
        "schema_version": 2, "meeting_id": MID, "title": "주간회의", "created_at": "2026-10-02T14:00:00+09:00",
        "audio": {"file": "audio.ogg", "duration_sec": 3702.0, "source": "주간회의.m4a", "sha256": "x"},
        "asr": {"model": "m", "track": "lite", "runtime": "mlx-audio", "language": "auto", "hotwords": []},
        "speakers": {"S1": {"name": "김민수"}, "S2": {"name": None}},
        "diarization": None,
        "segments": [
            {"id": "s0001", "start": 0.0, "end": 2.5, "text": "안녕하세요", "lang": "ko", "speaker": "S1", "corrected_text": "안녕하십니까", "words": None},
            {"id": "s0002", "start": 3.0, "end": 65.123, "text": "예산, 보겠습니다", "lang": "ko", "speaker": "S2", "corrected_text": None, "words": None},
            {"id": "s0003", "start": 3700.5, "end": 3702.0, "text": "마무리", "lang": "ko", "speaker": None, "corrected_text": None, "words": None},
        ],
    }


SUMMARY = {
    "schema_version": 1, "meeting_id": MID, "provider": "upstage", "model": "m", "generated_at": "g",
    "title": "주간회의 요약", "summary": "예산을 검토했다.", "topics": [{"title": "예산", "segment_ids": ["s0002"]}],
    "decisions": [{"text": "예산 동결", "segment_ids": ["s0002"]}],
    "action_items": [{"task": "견적 받기", "owner": "김민수", "due": "금요일", "segment_ids": ["s0001"]}],
}


@pytest.fixture
def meeting(tmp_path, monkeypatch):
    home = tmp_path / "home"
    d = home / "meetings" / f"2026-10-02_주간회의_{MID}"
    d.mkdir(parents=True)
    save_transcript(d, _transcript())
    (d / "audio.ogg").write_bytes(b"OggS fake audio")
    (d / "summary.md").write_text("# 주간회의 요약\n\n예산을 검토했다.\n", encoding="utf-8")
    (d / "summary.json").write_text(json.dumps(SUMMARY, ensure_ascii=False), encoding="utf-8")
    (d / "memos.json").write_text('[{"t": 1.0, "kind": "memo", "text": "메모"}]', encoding="utf-8")
    (d / "tracks").mkdir()
    (d / "tracks" / "mic.wav").write_bytes(b"RIFF")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("TRACTUS_HOME", str(home))
    return d


def invoke(*args, input=None):
    return CliRunner().invoke(cli.app, [*map(str, args)], input=input)


def read_t(d: Path) -> dict:
    return json.loads((d / "transcript.json").read_text(encoding="utf-8"))


# ── segments edit ───────────────────────────────────────────────────


def test_segments_edit_writes_renders_and_syncs_without_embedding(meeting, monkeypatch):
    synced = []
    monkeypatch.setattr(cli, "_sync_index_quietly", lambda embed=True: synced.append(embed))
    edits = {"edits": [{"id": "s0002", "text": " 예산을 보겠습니다 "}, {"id": "s0001", "text": "안녕하세요"}]}
    r = invoke("segments", MID[-6:], "edit", input=json.dumps(edits, ensure_ascii=False))
    assert r.exit_code == 0, r.output
    assert json.loads(r.stdout) == {"changed": 2}
    segs = read_t(meeting)["segments"]
    assert [s["corrected_text"] for s in segs] == [None, "예산을 보겠습니다", None]  # s0001은 원문과 같아 교정 해제
    assert [s["text"] for s in segs] == ["안녕하세요", "예산, 보겠습니다", "마무리"] and segs[1]["words"] is None
    assert "**참석자 2**: 예산을 보겠습니다" in (meeting / "transcript.md").read_text(encoding="utf-8")
    assert "<v 참석자 2>예산을 보겠습니다" in (meeting / "transcript.vtt").read_text(encoding="utf-8")
    assert synced == [False] and not list(meeting.glob("*.tmp"))


@pytest.mark.parametrize("payload", [
    '{"edits": [{"id": "s0001", "text": "x"}, {"id": "s9999", "text": "y"}]}',
    '{"edits": [{"id": "s0001", "text": "   "}]}',
    '{"edits": "s0001"}',
    'not json',
])
def test_segments_edit_rejects_bad_input_and_writes_nothing(meeting, monkeypatch, payload):
    monkeypatch.setattr(cli, "_sync_index_quietly", lambda embed=True: pytest.fail("색인하면 안 됨"))
    before = {p.name: p.read_bytes() for p in meeting.glob("transcript.*")}
    r = invoke("segments", str(meeting), "edit", input=payload)
    assert r.exit_code == 1 and r.stdout == "" and r.stderr.strip()
    assert {p.name: p.read_bytes() for p in meeting.glob("transcript.*")} == before


def test_segments_edit_unknown_id_names_it(meeting):
    r = invoke("segments", MID, "edit", input='{"edits": [{"id": "s9999", "text": "y"}]}')
    assert r.exit_code == 1 and r.stderr.strip().splitlines()[-1] == "해당 대화를 찾지 못했습니다. 노트를 다시 열어 주세요."


# ── glossary add ────────────────────────────────────────────────────


def test_glossary_add_creates_file_and_dedupes(meeting):
    path = meeting.parents[1] / "glossary.md"
    r = invoke("glossary", "add", " 쿠버네티스 ", "WTO", "", "쿠버네티스")
    assert r.exit_code == 0, r.output
    assert json.loads(r.stdout) == {"added": 2} and load_glossary(path) == ["쿠버네티스", "WTO"]
    r = invoke("glossary", "add", "WTO", "Project Atlas")
    assert json.loads(r.stdout) == {"added": 1} and load_glossary(path)[-1] == "Project Atlas"
    r = invoke("glossary", "add", "--", "-x")  # 앱은 용어 앞에 --를 둔다
    assert json.loads(r.stdout) == {"added": 1} and load_glossary(path)[-1] == "-x"


# ── export ──────────────────────────────────────────────────────────


def export(fmt, out, *extra):
    r = invoke("export", MID, "--format", fmt, "--out", out, *extra)
    assert r.exit_code == 0, r.output
    assert json.loads(r.stdout) == {"path": str(Path(out).resolve())}
    return Path(out)


def test_export_txt_uses_display_names_and_corrected_text(meeting, tmp_path):
    lines = export("txt", tmp_path / "o.txt").read_text(encoding="utf-8").splitlines()
    assert lines[0] == "주간회의" and "2026-10-02 14:00" in lines[1] and "01:01:42" in lines[1]
    assert lines[-3:] == ["[00:00:00] 김민수: 안녕하십니까", "[00:00:03] 참석자 2: 예산, 보겠습니다", "[01:01:40] 마무리"]


def test_export_md_appends_summary(meeting, tmp_path):
    text = export("md", tmp_path / "o.md").read_text(encoding="utf-8")
    assert "[00:00:00] **김민수**: 안녕하십니까" in text and "(메모) 메모" in text
    assert text.index("**김민수**") < text.index("# 주간회의 요약")


def test_export_srt_timing_and_vtt(meeting, tmp_path):
    srt = export("srt", tmp_path / "o.srt").read_text(encoding="utf-8")
    assert srt.startswith(
        "1\n00:00:00,000 --> 00:00:02,500\n김민수: 안녕하십니까\n\n"
        "2\n00:00:03,000 --> 00:01:05,123\n참석자 2: 예산, 보겠습니다\n\n"
        "3\n01:01:40,500 --> 01:01:42,000\n마무리\n"
    )
    assert export("vtt", tmp_path / "o.vtt").read_text(encoding="utf-8") == render_vtt(read_t(meeting))


def test_export_csv_is_utf8_sig_with_korean_headers(meeting, tmp_path):
    raw = export("csv", tmp_path / "o.csv").read_bytes()
    assert raw.startswith(b"\xef\xbb\xbf")  # 한국어 Excel이 UTF-8로 연다
    rows = list(csv.reader(io.StringIO(raw.decode("utf-8-sig"))))
    assert rows[0] == ["시작", "끝", "참석자", "내용"]
    assert rows[1:] == [["00:00:00", "00:00:02", "김민수", "안녕하십니까"], ["00:00:03", "00:01:05", "참석자 2", "예산, 보겠습니다"], ["01:01:40", "01:01:42", "", "마무리"]]


def test_export_docx_roundtrip(meeting, tmp_path):
    import docx
    from docx.oxml.ns import qn

    doc = docx.Document(str(export("docx", tmp_path / "o.docx")))
    texts = [p.text for p in doc.paragraphs]
    assert texts[0] == "주간회의"
    body = "\n".join(texts)
    assert "2026-10-02 14:00" in body and "01:01:42" in body and "참석자 2명 (김민수, 참석자 2)" in body and "대화 내용" in texts
    assert "예산을 검토했다." in body and "예산 동결" in body and "견적 받기 — 김민수, 금요일" in body
    line = next(p for p in doc.paragraphs if "안녕하십니까" in p.text)
    assert line.text == "00:00:00  김민수  안녕하십니까"
    assert [r.text for r in line.runs if r.bold] == ["김민수"]
    assert doc.styles["Normal"].element.rPr.rFonts.get(qn("w:eastAsia")) == "Apple SD Gothic Neo"


def test_export_docx_without_summary(meeting, tmp_path):
    import docx

    (meeting / "summary.json").unlink()
    body = "\n".join(p.text for p in docx.Document(str(export("docx", tmp_path / "o.docx"))).paragraphs)
    assert "결정 사항" not in body and "마무리" in body


def test_export_bundle_zips_meeting_files_only(meeting, tmp_path):
    with zipfile.ZipFile(export("bundle", tmp_path / "o.zip")) as z:
        names = sorted(z.namelist())
        assert z.read(f"{meeting.name}/audio.ogg") == b"OggS fake audio"
    assert names == sorted(f"{meeting.name}/{n}" for n in (
        "audio.ogg", "transcript.json", "transcript.md", "transcript.vtt", "summary.md", "summary.json", "memos.json"))


def test_export_refuses_to_overwrite_without_force(meeting, tmp_path):
    out = tmp_path / "o.txt"
    out.write_text("keep", encoding="utf-8")
    r = invoke("export", MID, "--format", "txt", "--out", out)
    assert r.exit_code == 1 and out.read_text(encoding="utf-8") == "keep" and "--force" in r.stderr
    assert "김민수" in export("txt", out, "--force").read_text(encoding="utf-8")
    assert invoke("export", MID, "--format", "pdf", "--out", tmp_path / "o.pdf").exit_code != 0


# ── 통합 점검·리뷰 반영 ─────────────────────────────────────────────


def test_long_error_stays_on_one_line_and_names_out(meeting, tmp_path):
    out = tmp_path / ("긴경로" * 20) / "없는폴더" / "x.txt"  # 앱은 stderr 마지막 줄만 보여 준다
    r = invoke("export", MID, "--format", "txt", "--out", out, "--force")
    assert r.exit_code == 1
    last = r.stderr.strip().splitlines()[-1]
    assert last.startswith(str(out)) and last.endswith(")") and "에 저장할 수 없습니다" in last and ".tmp" not in last


def test_control_chars_are_dropped_from_edits_and_names(meeting, monkeypatch):
    monkeypatch.setattr(cli, "_sync_index_quietly", lambda embed=True: None)
    r = invoke("segments", MID, "edit", input=json.dumps({"edits": [{"id": "s0002", "text": "abc\u0001def\u0085g"}]}))
    assert r.exit_code == 0, r.output
    assert invoke("speakers", MID, "rename", "S2", "이\x02영희").exit_code == 0
    t = read_t(meeting)
    assert t["segments"][1]["corrected_text"] == "abcdef g" and t["speakers"]["S2"]["name"] == "이영희"


def test_docx_export_error_is_one_line_not_traceback(meeting, tmp_path):
    t = read_t(meeting)
    save_transcript(meeting, {**t, "title": "제목\x01"})
    r = invoke("export", MID, "--format", "docx", "--out", tmp_path / "o.docx")
    lines = r.stderr.strip().splitlines()
    assert r.exit_code == 1 and "Traceback" not in r.output and lines[-1] == "제목이나 대화 내용에 쓸 수 없는 글자가 있습니다."
    assert any(line.startswith("All strings must be XML compatible") for line in lines[:-1])  # 원인은 앞 줄 (CLI용)


def test_csv_neutralizes_formula_cells(meeting, tmp_path):
    t = read_t(meeting)
    t["segments"][1]["corrected_text"] = "=1+2"
    t["speakers"]["S1"]["name"] = "@이름"
    save_transcript(meeting, t)
    rows = list(csv.reader(io.StringIO(export("csv", tmp_path / "o.csv").read_bytes().decode("utf-8-sig"))))
    assert rows[1][2] == "'@이름" and rows[2][3] == "'=1+2" and rows[3][3] == "마무리"


def test_docx_headings_use_east_asian_font(meeting, tmp_path):
    import docx
    from docx.oxml.ns import qn

    doc = docx.Document(str(export("docx", tmp_path / "o.docx")))
    for name in ("Title", "Heading 1"):
        rf = doc.styles[name].element.rPr.rFonts
        assert rf.get(qn("w:eastAsia")) == "Apple SD Gothic Neo" and rf.get(qn("w:eastAsiaTheme")) is None


def test_md_export_drops_summary_front_matter(meeting, tmp_path):
    (meeting / "summary.md").write_text("---\nmeeting_id: x\nprovider: upstage\n---\n\n# 주간회의 요약\n", encoding="utf-8")
    text = export("md", tmp_path / "o.md").read_text(encoding="utf-8")
    assert "provider: upstage" not in text and "# 주간회의 요약" in text


def test_srt_and_txt_keep_one_line_per_cue(meeting, tmp_path):
    t = read_t(meeting)
    t["segments"][2]["text"] = "a --> b\n\n줄  바꿈"
    save_transcript(meeting, t)
    assert export("srt", tmp_path / "o.srt").read_text(encoding="utf-8").endswith("01:01:40,500 --> 01:01:42,000\na → b 줄 바꿈\n")
    assert export("txt", tmp_path / "o.txt").read_text(encoding="utf-8").endswith("[01:01:40] a --> b 줄 바꿈\n")


# ── 목소리 제안은 내보내지 않는다 (Phase 7.1) ───────────────────────


def test_voice_suggestion_never_leaks_into_exports(meeting, tmp_path):
    import docx

    t = read_t(meeting)
    t["speakers"]["S2"] = {"name": None, "suggested": {"person_id": "P1", "name": "홍길동", "score": 0.82}}
    save_transcript(meeting, t)
    for fmt in ("txt", "md", "srt", "vtt"):
        assert "홍길동" not in export(fmt, tmp_path / f"o.{fmt}").read_text(encoding="utf-8"), fmt
    assert "홍길동" not in export("csv", tmp_path / "o.csv").read_bytes().decode("utf-8-sig")
    assert "홍길동" not in "\n".join(p.text for p in docx.Document(str(export("docx", tmp_path / "o.docx"))).paragraphs)
    with zipfile.ZipFile(export("bundle", tmp_path / "o.zip")) as z:
        raw = {n: z.read(n).decode("utf-8", "replace") for n in z.namelist()}
    assert not any("홍길동" in v or "suggested" in v for v in raw.values())
    assert json.loads(raw[f"{meeting.name}/transcript.json"])["speakers"] == {"S1": {"name": "김민수"}, "S2": {"name": None}}
    assert "suggested" in (meeting / "transcript.json").read_text(encoding="utf-8")  # 원본은 그대로


def test_summary_prompt_and_owners_never_use_suggested_name():
    from tractus.summarize import ActionItem, MeetingSummary, build_prompt, clean_owners

    t = _transcript()
    t["speakers"]["S2"] = {"name": None, "suggested": {"person_id": "P1", "name": "홍길동", "score": 0.82}}
    assert "홍길동" not in build_prompt(t) and " 참석자 2] " in build_prompt(t)
    s = MeetingSummary(title="t", summary="s", topics=[], decisions=[], action_items=[
        ActionItem(task="a", owner="홍길동", due=None, segment_ids=["s0002"]), ActionItem(task="b", owner="김민수", due=None, segment_ids=["s0001"])])
    assert [a.owner for a in clean_owners(s, t).action_items] == [None, "김민수"]
