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

from tractus.store import MEMOS_FILE, _hms, _vtt_time, is_memo, load_memos, memo_lines, one_line, render_markdown, render_vtt, seg_text, speaker_display

FORMATS = ("txt", "md", "srt", "vtt", "csv", "docx", "bundle")
BUNDLE_FILES = ("audio.ogg", "audio.opus", "transcript.json", "transcript.md", "transcript.vtt", "summary.md", "summary.json", MEMOS_FILE)
MEMO_FORMATS = ("txt", "md", "csv", "docx", "bundle")  # 메모는 시각이 없어 자막(srt·vtt)으로 내보낼 수 없다
NO_SUBTITLES = "메모는 자막 파일로 내보낼 수 없습니다."
EAST_ASIA_FONT = "Apple SD Gothic Neo"  # Word·Pages(macOS)에서 한글이 대체 글꼴로 깨지지 않게 w:eastAsia에 지정


class UnsupportedFormat(ValueError):
    """이 노트에는 쓸 수 없는 형식 (CLI가 종료 코드 2와 이 문장으로 알린다)."""


def _when(t: dict) -> str:
    try:
        return datetime.fromisoformat(t["created_at"]).strftime("%Y-%m-%d %H:%M")
    except (KeyError, TypeError, ValueError):
        return str(t.get("created_at") or "")[:16]


def _rows(t: dict) -> list[tuple[dict, str | None, str]]:
    """(세그먼트, 화자 표시 이름 또는 None, 표시 텍스트). 텍스트는 한 줄로(ASR 원문에 줄바꿈이 있으면 SRT 큐가 끊긴다). 빈 세그먼트는 뺀다."""
    return [(s, speaker_display(t, s.get("speaker")), one_line(seg_text(s))) for s in t["segments"] if one_line(seg_text(s))]


def _memo_rows(t: dict) -> list[tuple[int, str]]:
    """녹음 노트에 사용자가 적은 메모의 (줄 번호, 한 줄 텍스트). 메모가 없거나 메모 노트면 빈 목록."""
    return [(m["line"], one_line(m["text"])) for m in memo_lines(t) if one_line(m["text"])]


def _txt(t: dict) -> str:
    if is_memo(t):
        body = t["body"].strip("\n") if isinstance(t.get("body"), str) else "\n".join(text for _, _, text in _rows(t))
        return "\n".join([t["title"], _when(t), "", body]) + "\n"
    head = [t["title"], f"{_when(t)} · {_hms(t['audio']['duration_sec'])}", ""]
    memo_rows = _memo_rows(t)
    memo = ["", "메모", "", *(text for _, text in memo_rows)] if memo_rows else []
    return "\n".join(head + [f"[{_hms(s['start'])}] {f'{who}: ' if who else ''}{text}" for s, who, text in _rows(t)] + memo) + "\n"


def _srt(t: dict) -> str:
    def ts(sec: float) -> str:
        return _vtt_time(sec).replace(".", ",")

    cues = [f"{i}\n{ts(s['start'])} --> {ts(s['end'])}\n{f'{who}: ' if who else ''}{text.replace('-->', '→')}\n" for i, (s, who, text) in enumerate(_rows(t), 1)]
    return "\n".join(cues)


def _cell(v: str) -> str:
    """스프레드시트 수식 주입 방지 (OWASP CSV Injection): =+-@ 탭·CR로 시작하면 앞에 '를 붙인다."""
    return "'" + v if v.startswith(("=", "+", "-", "@", "\t", "\r")) else v


def _csv(t: dict) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf)
    if is_memo(t):
        w.writerow(["줄", "내용"])
        w.writerows([s.get("line", ""), _cell(text)] for s, _, text in _rows(t))
    else:
        w.writerow(["시작", "끝", "참석자", "내용"])
        w.writerows([_hms(s["start"]), _hms(s["end"]), _cell(who or ""), _cell(text)] for s, who, text in _rows(t))
        w.writerows([f"메모 {line}번째 줄", "", "", _cell(text)] for line, text in _memo_rows(t))  # 사용자 메모: 표 모양은 그대로, 시작 칸에 위치 표시
    return buf.getvalue().encode("utf-8-sig")  # BOM: 한국어 Excel이 UTF-8로 연다


def _md(d: Path, t: dict) -> str:
    md = render_markdown(t, load_memos(d))
    summary = d / "summary.md"
    if not summary.is_file():
        return md
    body = re.sub(r"\A---\n.*?\n---\n+", "", summary.read_text(encoding="utf-8"), flags=re.S)  # frontmatter는 문서 맨 앞에서만 frontmatter다
    return md + "\n---\n\n" + body


def _load_summary(d: Path) -> dict | None:
    try:
        return json.loads((d / "summary.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _docx(d: Path, t: dict) -> bytes:
    import docx
    from docx.oxml.ns import qn
    from docx.shared import Pt, RGBColor

    doc = docx.Document()
    for name in ("Normal", "Title", "Heading 1"):
        rf = doc.styles[name].element.get_or_add_rPr().get_or_add_rFonts()
        rf.attrib.pop(qn("w:eastAsiaTheme"), None)  # 테마 글꼴 지정이 w:eastAsia보다 우선한다. 기본 테마의 동아시아 글꼴은 비어 있다
        rf.set(qn("w:eastAsia"), EAST_ASIA_FONT)
    doc.styles["Normal"].font.size = Pt(10.5)

    doc.add_heading(t["title"], 0)
    memo = is_memo(t)
    doc.add_paragraph(f"일시 {_when(t)}" + ("" if memo else f" · 길이 {_hms(t['audio']['duration_sec'])}"))
    names = [speaker_display(t, label) for label in t.get("speakers") or {}]
    if names:
        doc.add_paragraph(f"참석자 {len(names)}명 ({', '.join(names)})")

    if s := _load_summary(d):
        doc.add_heading("요약", 1)
        doc.add_paragraph(str(s.get("summary") or ""))
        doc.add_heading("결정 사항", 1)
        for x in s.get("decisions") or [{"text": "없음"}]:
            doc.add_paragraph(str(x.get("text") or ""), style="List Bullet")
        doc.add_heading("할 일", 1)
        for a in s.get("action_items") or [{"task": "없음"}]:
            who = ", ".join(str(v) for v in (a.get("owner"), a.get("due")) if v)
            doc.add_paragraph(f"{a.get('task') or ''}{' — ' + who if who else ''}", style="List Bullet")

    doc.add_heading("메모 내용" if memo else "대화 내용", 1)
    for seg, who, text in _rows(t):
        p = doc.add_paragraph()
        if memo:
            p.add_run(text)
            continue
        p.add_run(f"{_hms(seg['start'])}  ").font.color.rgb = RGBColor(0x80, 0x80, 0x80)
        if who:
            p.add_run(who).bold = True
            p.add_run("  ")
        p.add_run(text)
    if memo_rows := _memo_rows(t):
        doc.add_heading("메모", 1)
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
                t = json.loads((d / name).read_text(encoding="utf-8"))
                t = {**t, "speakers": {k: {"name": (v or {}).get("name")} for k, v in (t.get("speakers") or {}).items()}}
                z.writestr(f"{d.name}/{name}", json.dumps(t, ensure_ascii=False, indent=1))
            elif (d / name).is_file():
                z.write(d / name, f"{d.name}/{name}")
    return buf.getvalue()


def render_export(d: Path, fmt: str) -> bytes:
    """회의 폴더 d를 fmt 형식(FORMATS)의 바이트로 만든다."""
    t = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
    writers = {
        "txt": lambda: _txt(t).encode("utf-8"), "md": lambda: _md(d, t).encode("utf-8"), "srt": lambda: _srt(t).encode("utf-8"),
        "vtt": lambda: render_vtt(t).encode("utf-8"), "csv": lambda: _csv(t), "docx": lambda: _docx(d, t), "bundle": lambda: _bundle(d),
    }
    if fmt not in writers:
        raise ValueError(f"지원하지 않는 형식입니다: {fmt} ({', '.join(FORMATS)})")
    if is_memo(t) and fmt not in MEMO_FORMATS:
        raise UnsupportedFormat(NO_SUBTITLES)
    return writers[fmt]()


def write_bytes_atomic(path: Path, data: bytes) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)
