"""회의 내보내기: txt, md, srt, vtt, csv, docx, bundle(zip). 화자는 표시 이름, 본문은 seg_text(교정본 우선).

참고(MIT, 형식과 레이아웃 수치만 가져와 새로 씀):
- chidiwilliams/buzz `buzz/transcriber/file_transcriber.py` L253-313 @100589fd — txt·srt 작성기
- thewh1teagle/vibe `desktop/src/lib/docx.ts` L1-131 (docx 레이아웃), `transcript-export.ts` L166-187 (CSV, BOM) @53056d6b
"""

import csv
import io
import json
import re
import zipfile
from datetime import datetime
from pathlib import Path

from tractus.i18n import t
from tractus.store import MEMOS_FILE, _hms, _vtt_time, is_memo, is_recorded, load_memos, memo_lines, one_line, render_markdown, render_vtt, seg_text, speaker_display

FORMATS = ("txt", "md", "srt", "vtt", "csv", "docx", "bundle")
BUNDLE_FILES = ("audio.ogg", "audio.opus", "transcript.json", "transcript.md", "transcript.vtt", "summary.md", "summary.json", MEMOS_FILE, "event.json")
MEMO_FORMATS = ("txt", "md", "csv", "docx", "bundle")  # 메모는 시각이 없어 자막(srt·vtt)으로 내보낼 수 없다
NO_SUBTITLES = t("메모는 자막 파일로 내보낼 수 없습니다.")
NO_SUBTITLES_RECORDED = t("아직 텍스트로 변환하지 않아 자막 파일로 내보낼 수 없습니다. 먼저 텍스트로 변환하세요.")  # "변환 전" 노트: 대화 내용이 없다
EAST_ASIA_FONT = "Apple SD Gothic Neo"  # Word·Pages(macOS)에서 한글이 대체 글꼴로 깨지지 않게 w:eastAsia에 지정


class UnsupportedFormat(ValueError):
    """이 노트에는 쓸 수 없는 형식 (CLI가 종료 코드 2와 이 문장으로 알린다)."""


def _when(note: dict) -> str:
    try:
        return datetime.fromisoformat(note["created_at"]).strftime("%Y-%m-%d %H:%M")
    except (KeyError, TypeError, ValueError):
        return str(note.get("created_at") or "")[:16]


def _rows(note: dict) -> list[tuple[dict, str | None, str]]:
    """(세그먼트, 화자 표시 이름 또는 None, 표시 텍스트). 텍스트는 한 줄로(ASR 원문에 줄바꿈이 있으면 SRT 큐가 끊긴다). 빈 세그먼트는 뺀다."""
    return [(s, speaker_display(note, s.get("speaker"), t("참석자 {n}")), one_line(seg_text(s))) for s in note["segments"] if one_line(seg_text(s))]


def _memo_rows(note: dict) -> list[tuple[int, str]]:
    """녹음 노트에 사용자가 적은 메모의 (줄 번호, 한 줄 텍스트). 메모가 없거나 메모 노트면 빈 목록."""
    return [(m["line"], one_line(m["text"])) for m in memo_lines(note) if one_line(m["text"])]


def _txt(note: dict) -> str:
    if is_memo(note):
        body = note["body"].strip("\n") if isinstance(note.get("body"), str) else "\n".join(text for _, _, text in _rows(note))
        return "\n".join([note["title"], _when(note), "", body]) + "\n"
    head = [note["title"], f"{_when(note)} · {_hms(note['audio']['duration_sec'])}", ""]
    memo_rows = _memo_rows(note)
    memo = ["", t("메모"), "", *(text for _, text in memo_rows)] if memo_rows else []
    return "\n".join(head + [f"[{_hms(s['start'])}] {f'{who}: ' if who else ''}{text}" for s, who, text in _rows(note)] + memo) + "\n"


def _srt(note: dict) -> str:
    def ts(sec: float) -> str:
        return _vtt_time(sec).replace(".", ",")

    cues = [f"{i}\n{ts(s['start'])} --> {ts(s['end'])}\n{f'{who}: ' if who else ''}{text.replace('-->', '→')}\n" for i, (s, who, text) in enumerate(_rows(note), 1)]
    return "\n".join(cues)


def _cell(v: str) -> str:
    """스프레드시트 수식 주입 방지 (OWASP CSV Injection): =+-@ 탭·CR로 시작하면 앞에 '를 붙인다."""
    return "'" + v if v.startswith(("=", "+", "-", "@", "\note", "\r")) else v


def _csv(note: dict) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf)
    if is_memo(note):
        w.writerow([t("줄"), t("내용")])
        w.writerows([s.get("line", ""), _cell(text)] for s, _, text in _rows(note))
    else:
        w.writerow([t("시작"), t("끝"), t("참석자"), t("내용")])
        w.writerows([_hms(s["start"]), _hms(s["end"]), _cell(who or ""), _cell(text)] for s, who, text in _rows(note))
        w.writerows([t("메모 {line}번째 줄", line=line), "", "", _cell(text)] for line, text in _memo_rows(note))  # 사용자 메모: 표 모양은 그대로, 시작 칸에 위치 표시
    return buf.getvalue().encode("utf-8-sig")  # BOM: 한국어 Excel이 UTF-8로 연다


def pick_summary(d: Path, key: str | None) -> str | None:
    """내보낼 요약의 key. key를 주면 그대로(없으면 None이 아니라 호출한 쪽이 먼저 확인한다), 안 주면 기본 요약(meeting),
    기본 요약이 없으면 처음 있는 요약(핵심 요약 같은 다른 유형만 있는 노트). 요약이 없으면 None."""
    from tractus.summaries import DEFAULT_KEY, list_summaries

    if key:
        return key
    have = [x["key"] for x in list_summaries(d)]
    return DEFAULT_KEY if DEFAULT_KEY in have else (have[0] if have else None)


def _md(d: Path, note: dict, key: str | None) -> str:
    from tractus.summaries import read_markdown

    md = render_markdown(note, load_memos(d))
    summary = read_markdown(d, key) if key else None
    if summary is None:
        return md
    body = re.sub(r"\A---\n.*?\n---\n+", "", summary, flags=re.S)  # frontmatter는 문서 맨 앞에서만 frontmatter다
    return md + "\n---\n\n" + body


def _docx_summary(doc, s: dict, key: str) -> None:
    """요약 한 개를 문서에 쓴다. 기본 요약(예전 스키마)은 요약·결정 사항·할 일, 유형별 요약은 개요와 섹션(목록 모양대로)."""
    from tractus.summaries import NO_DETAIL

    if "sections" not in s:
        doc.add_heading(t("요약"), 1)
        doc.add_paragraph(str(s.get("summary") or ""))
        doc.add_heading(t("결정 사항"), 1)
        for x in s.get("decisions") or [{"text": t("없음")}]:
            doc.add_paragraph(str(x.get("text") or ""), style="List Bullet")
        doc.add_heading(t("할 일"), 1)
        for a in s.get("action_items") or [{"task": t("없음")}]:
            who = ", ".join(str(v) for v in (a.get("owner"), a.get("due")) if v)
            doc.add_paragraph(f"{a.get('task') or ''}{' — ' + who if who else ''}", style="List Bullet")
        return
    doc.add_heading(t("요약 · {name}", name=s.get("template_name") or key), 1)
    if str(s.get("overview") or "").strip():
        doc.add_paragraph(str(s["overview"]))
    for sec in s.get("sections") or []:
        items = [i for i in sec.get("items") or [] if isinstance(i, dict)]
        if not items:
            if sec.get("part") == "memo":  # 노트 완성: 세부를 못 찾은 내 메모 줄도 빠뜨리지 않는다
                doc.add_heading(str(sec.get("heading") or ""), 1)
                doc.add_paragraph(NO_DETAIL, style="List Bullet")
            continue
        doc.add_heading(str(sec.get("heading") or ""), 1)
        style = "List Number" if sec.get("style") == "numbered" else "List Bullet"
        for i in items:
            who = ", ".join(str(v) for v in (i.get("owner"), i.get("due")) if v)
            mark = "☐ " if sec.get("style") == "checklist" else ""
            doc.add_paragraph(f"{mark}{i.get('text') or ''}{' — ' + who if who else ''}", style=style)


def _docx(d: Path, note: dict, key: str | None) -> bytes:
    import docx
    from docx.oxml.ns import qn
    from docx.shared import Pt, RGBColor

    from tractus.summaries import read_data

    doc = docx.Document()
    for name in ("Normal", "Title", "Heading 1"):
        rf = doc.styles[name].element.get_or_add_rPr().get_or_add_rFonts()
        rf.attrib.pop(qn("w:eastAsiaTheme"), None)  # 테마 글꼴 지정이 w:eastAsia보다 우선한다. 기본 테마의 동아시아 글꼴은 비어 있다
        rf.set(qn("w:eastAsia"), EAST_ASIA_FONT)
    doc.styles["Normal"].font.size = Pt(10.5)

    doc.add_heading(note["title"], 0)
    memo = is_memo(note)
    doc.add_paragraph(t("일시 {when}", when=_when(note)) + ("" if memo else t(" · 길이 {duration}", duration=_hms(note["audio"]["duration_sec"]))))
    names = [speaker_display(note, label, t("참석자 {n}")) for label in note.get("speakers") or {}]
    if names:
        doc.add_paragraph(t("참석자 {n}명 ({names})", n=len(names), names=", ".join(names)))

    if key and (s := read_data(d, key)):
        _docx_summary(doc, s, key)

    doc.add_heading(t("메모 내용") if memo else t("대화 내용"), 1)
    for seg, who, text in _rows(note):
        p = doc.add_paragraph()
        if memo:
            p.add_run(text)
            continue
        p.add_run(f"{_hms(seg['start'])}  ").font.color.rgb = RGBColor(0x80, 0x80, 0x80)
        if who:
            p.add_run(who).bold = True
            p.add_run("  ")
        p.add_run(text)
    if memo_rows := _memo_rows(note):
        doc.add_heading(t("메모"), 1)
        for _, text in memo_rows:
            doc.add_paragraph(text)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def _bundle(d: Path) -> bytes:
    # ponytail: 메모리에서 묶는다. 보관 오디오는 Opus 32kbps(1시간 약 14MB)라 충분하다. 수 GB가 되면 임시 파일로 바꾼다
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name in BUNDLE_FILES:
            if name == "transcript.json":  # 목소리 제안(suggested)은 이 Mac 밖으로 내보내지 않는다
                note = json.loads((d / name).read_text(encoding="utf-8"))
                note = {**note, "speakers": {k: {"name": (v or {}).get("name")} for k, v in (note.get("speakers") or {}).items()}}
                z.writestr(f"{d.name}/{name}", json.dumps(note, ensure_ascii=False, indent=1))
            elif (d / name).is_file():
                z.write(d / name, f"{d.name}/{name}")
        for p in sorted((d / "summaries").glob("*")):  # 유형별 요약 (summaries/<key>.json·md)
            if p.suffix in (".json", ".md") and p.is_file():
                z.write(p, f"{d.name}/summaries/{p.name}")
    return buf.getvalue()


def render_export(d: Path, fmt: str, summary: str | None = None) -> bytes:
    """회의 폴더 d를 fmt 형식(FORMATS)의 바이트로 만든다. md·docx에는 요약이 들어간다: summary(요약 key)를 주면 그 요약,
    안 주면 기본 요약(없으면 처음 있는 요약). 있는지는 호출한 쪽이 먼저 확인한다 (summaries.read_data)."""
    note = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
    key = pick_summary(d, summary)
    writers = {
        "txt": lambda: _txt(note).encode("utf-8"), "md": lambda: _md(d, note, key).encode("utf-8"), "srt": lambda: _srt(note).encode("utf-8"),
        "vtt": lambda: render_vtt(note).encode("utf-8"), "csv": lambda: _csv(note), "docx": lambda: _docx(d, note, key), "bundle": lambda: _bundle(d),
    }
    if fmt not in writers:
        raise ValueError(t("지원하지 않는 형식입니다: {format} ({formats})", format=fmt, formats=", ".join(FORMATS)))
    if is_memo(note) and fmt not in MEMO_FORMATS:
        raise UnsupportedFormat(NO_SUBTITLES)
    if is_recorded(note) and fmt in ("srt", "vtt"):
        raise UnsupportedFormat(NO_SUBTITLES_RECORDED)
    return writers[fmt]()


def write_bytes_atomic(path: Path, data: bytes) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)
