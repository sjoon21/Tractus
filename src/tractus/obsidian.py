"""Obsidian으로 보내기: 노트 하나 → 볼트/Tractus/<폴더…>/<날짜 제목>.md (docs/design/obsidian-export.md).

다시 보내면 같은 파일을 고쳐 쓴다. 보낸 파일과 sha256은 볼트/Tractus/.tractus.json에 적고,
그 뒤 볼트에서 고친 파일은 force 없이 덮어쓰지 않는다 (status "edited").
"""

import hashlib
import json
import os
import re
import shutil
from pathlib import Path

from tractus.export import _rows, pick_summary
from tractus.organize import load_folders, meta_of
from tractus.store import NOT_CONVERTED_NOTE, _hms, _meta_lines, _write_atomic, _yaml_scalar, is_memo, is_recorded, memo_lines, seg_text
from tractus.summaries import list_summaries, read_markdown
from tractus.calendar_event import load_event
from tractus.enhance import KEY as ENHANCED

ROOT = "Tractus"
MANIFEST = ".tractus.json"
ATTACHMENTS = "attachments"
INSIDE_HOME = "데이터 폴더 안에는 보낼 수 없습니다. 다른 볼트를 고르세요."
NO_VAULT = "볼트 폴더를 찾지 못했습니다. 설정에서 다시 고르세요."
_BAD_NAME = re.compile(r'[/\\:*?"<>|\x00-\x1f\x7f]')


def safe_name(s: str, limit: int = 80) -> str:
    """파일·폴더 이름: 못 쓰는 글자는 공백으로, 앞의 점은 뺀다 (숨김 파일이 되지 않게)."""
    s = " ".join(_BAD_NAME.sub(" ", s).split()).lstrip(". ")[:limit].strip()
    return s or "제목 없음"


def folder_parts(home: Path, t: dict) -> list[str]:
    """노트 폴더의 이름 경로 (최상위부터, 원래 이름). 폴더가 없거나 folders.json에 없으면 빈 목록."""
    by_id = {f["id"]: f for f in load_folders(home)}
    parts, fid = [], meta_of(t)["folder"]
    while fid in by_id and len(parts) < 8:  # ponytail: 깊이 3 제한이지만 깨진 parent 고리에 대비한 상한
        parts.insert(0, by_id[fid]["name"])
        fid = by_id[fid]["parent"]
    return parts


def _body_of(md: str | None) -> list[str]:
    """저장된 요약 md → frontmatter·`# 제목` 줄을 빼고 제목 단계를 하나 내린 줄들."""
    if not md:
        return []
    md = re.sub(r"\A---\n.*?\n---\n+", "", md, flags=re.S)
    md = re.sub(r"\A# [^\n]*\n+", "", md)
    return [("#" + x) if re.match(r"#{1,5} ", x) else x for x in md.rstrip("\n").split("\n")]


def render(d: Path, t: dict, home: Path, summary: str | None = None, audio: str | None = None) -> str:
    """볼트에 쓸 Markdown. summary: 넣을 요약 key (None이나 노트 완성이면 기본 요약). audio: 붙일 첨부 파일 이름."""
    names = [v["name"].strip() for v in (t.get("speakers") or {}).values() if isinstance(v, dict) and isinstance(v.get("name"), str) and v["name"].strip()]
    parts = folder_parts(home, t)
    recording = not is_memo(t)
    head = [
        "---",
        f"tractus_id: {t['meeting_id']}",
        f"title: {_yaml_scalar(t['title'])}",
        f"created: {t['created_at']}",
        *([f"duration: {_hms(t['audio']['duration_sec'])}"] if recording and isinstance(t.get("audio"), dict) else []),
        *([f"participants: [{', '.join(_yaml_scalar(x) for x in names)}]"] if names else []),
        *([f"attendees: [{', '.join(_yaml_scalar(x) for x in ev['attendees'])}]"] if (ev := load_event(d)) and ev["attendees"] else []),  # 캘린더 일정의 참석자
        *_meta_lines(t, parts[-1] if parts else None),
        "---",
        "",
        f"# {t['title']}",
        "",
    ]
    out = head + ([f"![[{audio}]]", ""] if audio else [])
    if not recording:  # 메모 노트: 본문이 곧 노트다
        out += [x for p in (seg_text(s) for s in t["segments"]) if p for x in (p, "")]
    elif enhanced := _body_of(read_markdown(d, ENHANCED)):
        out += ["## 완성된 노트", "", *enhanced, ""]
    elif memo := memo_lines(t):
        out += ["## 내 메모", "", *(m["text"] for m in memo), ""]
    key = pick_summary(d, None if summary in (None, ENHANCED) else summary)
    if key == ENHANCED:  # 요약이 노트 완성 하나뿐이다
        key = None
    if key and (body := _body_of(read_markdown(d, key))):
        name = next((x["name"] for x in list_summaries(d) if x["key"] == key), key)
        out += [f"## 요약 · {name}", "", *body, ""]
    if recording and is_recorded(t):
        out += [NOT_CONVERTED_NOTE, ""]
    elif recording and (rows := _rows(t)):
        out += ["> [!note]- 대화 내용", *(f"> [{_hms(s['start'])}] {f'**{who}**: ' if who else ''}{text}" for s, who, text in rows), ""]
    return "\n".join(out).rstrip("\n") + "\n"


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _load_manifest(root: Path) -> dict:
    try:
        notes = json.loads((root / MANIFEST).read_text(encoding="utf-8")).get("notes")
        return {k: v for k, v in notes.items() if isinstance(v, dict) and isinstance(v.get("path"), str) and isinstance(v.get("sha256"), str)}
    except (OSError, ValueError, AttributeError):
        return {}


def _inside(p: Path, root: Path) -> bool:
    return p == root or root in p.parents


def _same(a: Path, b: Path | None) -> bool:
    """같은 파일인가. APFS는 대소문자·한글 정규화(NFC/NFD)를 가리지 않아 경로 글자가 달라도 같은 파일일 수 있다."""
    return b is not None and (a == b or (a.exists() and b.exists() and os.path.samefile(a, b)))


def _claims(p: Path, mid: str) -> bool:
    """frontmatter에 tractus_id: mid가 있는가 (앞 40줄만 본다)."""
    try:
        with p.open(encoding="utf-8") as f:
            head = [next(f, "") for _ in range(40)]
    except (OSError, UnicodeDecodeError):
        return False
    return head[0].strip() == "---" and any(x.strip() == f"tractus_id: {mid}" for x in head[1:])


def _find(root: Path, mid: str, rec: dict | None) -> Path | None:
    """이 노트를 보낸 파일: 기록된 위치, 없으면 Tractus/ 아래에서 tractus_id로 찾는다 (Obsidian에서 옮긴 경우)."""
    if rec and (p := root / rec["path"]).is_file() and _inside(p.resolve(), root.resolve()) and _claims(p, mid):  # 그 자리에 다른 노트 파일이 들어왔을 수 있다
        return p
    return next((p for p in sorted(root.rglob("*.md")) if not any(x.startswith(".") for x in p.relative_to(root).parts) and _claims(p, mid)), None)


def _free(root: Path, parts: list[str], stem: str, mid: str, mine: Path | None) -> Path:
    """쓸 위치. 같은 이름의 남의 파일이 있으면 ` (2)`부터 붙인다."""
    folder = root.joinpath(*(safe_name(x, 40) for x in parts))
    for n in range(1, 1000):
        p = folder / (f"{stem}.md" if n == 1 else f"{stem} ({n}).md")
        if not p.exists() or _same(p, mine) or _claims(p, mid):
            return p
    raise ValueError("같은 이름의 파일이 너무 많습니다")


def send(d: Path, t: dict, home: Path, vault: Path, summary: str | None = None, with_audio: bool = False, force: bool = False) -> dict:
    """노트를 볼트에 쓴다 → {"status": created|updated|unchanged|edited, "path": 절대 경로, "audio": 첨부 경로|None}.
    edited면 아무것도 쓰지 않는다 (볼트에서 고친 파일, force로 덮어쓴다)."""
    if not vault.is_dir():
        raise ValueError(NO_VAULT)
    root = (vault.resolve() / ROOT).resolve()  # Tractus가 링크여도 실제 위치로 데이터 폴더와 겹치는지 본다
    h = home.expanduser().resolve()
    if _inside(root, h) or _inside(h, root):
        raise ValueError(INSIDE_HOME)
    mid = t["meeting_id"]
    manifest = _load_manifest(root)
    old = _find(root, mid, manifest.get(mid)) if root.is_dir() else None
    edited = old is not None and (mid not in manifest or _sha(old.read_bytes()) != manifest[mid]["sha256"])
    stem = safe_name(f"{t['created_at'][:10]} {t['title']}", 100)
    target = _free(root, folder_parts(home, t), stem, mid, old)
    if edited and not force:
        return {"status": "edited", "path": str(old), "audio": None}

    a = t.get("audio") if isinstance(t.get("audio"), dict) else {}
    src = d / a["file"] if isinstance(a.get("file"), str) and a["file"] else None
    att = None
    if with_audio and src and src.is_file():
        att = root / ATTACHMENTS / f"{mid}{src.suffix}"
        if not att.is_file() or att.stat().st_size != src.stat().st_size:
            att.parent.mkdir(parents=True, exist_ok=True)
            tmp = att.with_name(att.name + ".tmp")
            shutil.copyfile(src, tmp)
            tmp.replace(att)

    data = render(d, t, home, summary, att.name if att else None).encode("utf-8")
    status = "created" if old is None else "unchanged" if _same(target, old) and old.read_bytes() == data else "updated"
    if status != "unchanged":
        target.parent.mkdir(parents=True, exist_ok=True)
        _write_atomic(target, data.decode("utf-8"))
        if old is not None and not _same(target, old) and not edited:  # 옮겨 쓴 경우 옛 파일은 고치지 않은 우리 파일일 때만 지운다
            old.unlink(missing_ok=True)
    manifest[mid] = {"path": target.relative_to(root).as_posix(), "sha256": _sha(data)}
    _write_atomic(root / MANIFEST, json.dumps({"notes": manifest}, ensure_ascii=False, indent=1))
    return {"status": status, "path": str(target), "audio": str(att) if att else None}
