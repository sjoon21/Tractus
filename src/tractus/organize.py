"""노트 정리: 즐겨찾기·태그·폴더·정렬 (docs/desktop.md §2.12).

노트(transcript.json 최상위, 모든 종류, 선택 키):
  "favorite": true          (없으면 false)
  "tags": ["아이디어", …]    (20개까지, 한 개 30자까지, 대소문자 구분 없이 하나. 입력한 모양 그대로 저장)
  "folder": "<폴더 ULID>"   (없으면 폴더 없음)
  "updated_at": ISO 시각     (store.edit_transcript가 내용을 고칠 때 맞춘다. 위 세 키만 바꾸면 그대로다)
폴더는 $TRACTUS_HOME/folders.json {"version": 1, "folders": [{"id", "name", "parent", "order", "created_at"}]}.
깊이는 3단계까지, 이름은 40자까지, 같은 위치에서 이름이 겹치지 않는다. 폴더를 지워도 노트는 지우지 않는다(상위로 올린다).
읽는 쪽은 모두 너그럽다: 키가 없거나 모양이 달라도(옛 노트·손상) 정리하지 않은 노트로 본다.
"""

import fcntl
import json
import os
import unicodedata
from collections.abc import Callable
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

from tractus.store import _write_atomic, edit_transcript, is_memo, new_ulid, note_lock, one_line, read_transcript, render_files

FOLDERS_FILE = "folders.json"
FOLDERS_LOCK = ".folders.lock"
MAX_TAGS = 20
MAX_TAG = 30
MAX_FOLDER_NAME = 40
MAX_DEPTH = 3
META_PATCH_KEYS = ("favorite", "tags", "folder")
SORTS = ("created", "updated", "title", "duration")
ORDERS = ("asc", "desc")
NO_FOLDER = "none"  # 폴더 필터·이동 인수에서 '폴더 없음'

TAG_LONG = f"태그는 {MAX_TAG}자까지 쓸 수 있습니다."
TAG_COMMA = "태그에 쉼표는 쓸 수 없습니다."
TAGS_MANY = f"태그는 {MAX_TAGS}개까지 붙일 수 있습니다."
FOLDER_EMPTY = "폴더 이름을 입력하세요."
FOLDER_LONG = f"폴더 이름은 {MAX_FOLDER_NAME}자까지 쓸 수 있습니다."
FOLDER_SLASH = "폴더 이름에 /는 쓸 수 없습니다."
FOLDER_RESERVED = f"‘{NO_FOLDER}’은 폴더 이름으로 쓸 수 없습니다."  # 인수 `none`은 폴더 없음이라 같은 이름의 폴더는 이름으로 고를 수 없다 (resolve_folder)
FOLDER_DUP = "같은 위치에 이름이 같은 폴더가 있습니다."
FOLDER_DEPTH = f"폴더는 {MAX_DEPTH}단계까지 만들 수 있습니다."
FOLDER_MISSING = "폴더를 찾지 못했습니다. 노트 목록을 다시 불러 주세요."
FOLDER_LOOP = "폴더를 자기 안으로 옮길 수 없습니다."
FOLDER_AMBIGUOUS = "이름이 같은 폴더가 여러 개입니다. 폴더 ID로 지정하세요."
SORT_BAD = "기준은 created, updated, title, duration 중 하나여야 합니다."  # words-ok: CLI 인수 문구 (앱이 보내지 않는다)
ORDER_BAD = "순서는 asc 또는 desc여야 합니다."  # words-ok: CLI 인수 문구 (앱이 보내지 않는다)
META_FORMAT = '입력은 {"favorite": true, "tags": ["…"], "folder": "<폴더 ID>"|null} 형식이어야 합니다'  # words-ok: 앱 계약 오류


def _nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def _visible(s: str) -> str:
    """보이지 않는 서식 문자(폭 없는 공백·BOM·소프트 하이픈 같은 Cf)를 뺀다. 눈에 같아 보이는 다른 태그·폴더 이름을 막는다. 이모지를 잇는 ZWJ(U+200D)는 남긴다."""
    return "".join(c for c in s if c == "\u200d" or unicodedata.category(c) != "Cf")


def fold(s: str) -> str:
    """이름·태그 비교 키: NFC + casefold (로케일에 따르지 않는다)."""
    return _nfc(s).casefold()


# ── 태그 ──────────────────────────────────────────────────────────────


def clean_tag(raw: str) -> str:
    """공백·줄바꿈은 한 칸으로 줄이고 제어 문자를 빼고 앞의 #을 뗀다. 비면 빈 문자열(건너뛴다). 쉼표·30자 초과는 ValueError."""
    tag = _nfc(_visible(one_line(raw))).lstrip("#").strip()
    if "," in tag:
        raise ValueError(TAG_COMMA)
    if len(tag) > MAX_TAG:
        raise ValueError(TAG_LONG)
    return tag


def clean_tags(raw) -> list[str]:
    """태그 목록 정리: 빈 것은 건너뛰고 대소문자 구분 없이 같은 것은 먼저 쓴 하나만 남긴다(쓴 모양 그대로). 20개 초과는 ValueError."""
    if not isinstance(raw, list) or not all(isinstance(x, str) for x in raw):
        raise ValueError(META_FORMAT)
    out: dict[str, str] = {}
    for x in raw:
        if tag := clean_tag(x):
            out.setdefault(fold(tag), tag)
    if len(out) > MAX_TAGS:
        raise ValueError(TAGS_MANY)
    return list(out.values())


# ── 노트 메타 ─────────────────────────────────────────────────────────


def meta_of(t: dict) -> dict:
    """노트의 정리 정보 {"favorite", "tags", "folder"}. 키가 없거나 모양이 달라도 기본값이다."""
    tags = t.get("tags")
    folder = t.get("folder")
    return {
        "favorite": t.get("favorite") is True,
        "tags": [x for x in tags if isinstance(x, str) and x.strip()] if isinstance(tags, list) else [],
        "folder": folder if isinstance(folder, str) and folder else None,
    }


def apply_meta(t: dict, patch: dict, folder_ids: set[str]) -> tuple[dict, dict]:
    """patch({"favorite"?, "tags"?, "folder"?})를 검증해 반영한 새 전사와 저장된 meta. 기본값(false·빈 목록·null)이 되면 키를 지운다.
    모르는 키·잘못된 형식·없는 폴더 ID는 ValueError."""
    if not isinstance(patch, dict) or set(patch) - set(META_PATCH_KEYS):
        raise ValueError(META_FORMAT)
    new = dict(t)
    if "favorite" in patch:
        if not isinstance(patch["favorite"], bool):
            raise ValueError(META_FORMAT)
        new.pop("favorite", None)
        if patch["favorite"]:
            new["favorite"] = True
    if "tags" in patch:
        tags = clean_tags(patch["tags"])
        new.pop("tags", None)
        if tags:
            new["tags"] = tags
    if "folder" in patch:
        folder = patch["folder"]
        if folder is not None and not isinstance(folder, str):
            raise ValueError(META_FORMAT)
        if folder is not None and folder not in folder_ids:
            raise ValueError(FOLDER_MISSING)
        new.pop("folder", None)
        if folder is not None:
            new["folder"] = folder
    return new, meta_of(new)


def set_note_meta(home: Path, d: Path, patch: dict) -> dict:
    """노트 d의 정리 정보를 patch로 바꾼다 (note_lock 안에서 읽고 쓴다). 폴더를 지정하면 폴더 잠금 안에서 확인해 지우는 중인 폴더로 옮기지 않는다. 저장된 meta를 돌려준다."""
    if not isinstance(patch, dict) or set(patch) - set(META_PATCH_KEYS):
        raise ValueError(META_FORMAT)
    if patch.get("folder") is None:
        return edit_transcript(d, lambda t: apply_meta(t, patch, set()))
    with folders_lock(home):  # 잠금 순서: 폴더 → 노트 (폴더 지우기와 같다)
        ids = {f["id"] for f in load_folders(home)}
        return edit_transcript(d, lambda t: apply_meta(t, patch, ids))


# ── 폴더 ──────────────────────────────────────────────────────────────


def _folder(raw) -> dict | None:
    if not isinstance(raw, dict) or not isinstance(raw.get("id"), str) or not raw["id"] or not isinstance(raw.get("name"), str) or not raw["name"].strip():
        return None
    order = raw.get("order")
    return {
        "id": raw["id"], "name": raw["name"], "parent": raw["parent"] if isinstance(raw.get("parent"), str) and raw["parent"] else None,
        "order": order if isinstance(order, int) and not isinstance(order, bool) else 0,
        "created_at": raw["created_at"] if isinstance(raw.get("created_at"), str) else "",
    }


def _sane(folders: list[dict]) -> list[dict]:
    """없는 부모는 최상위로, 고리(손으로 고친 파일)는 끊는다. 깊이는 고치지 않는다 (읽기만 한다)."""
    ids = {f["id"] for f in folders}
    out = [{**f, "parent": f["parent"] if f["parent"] in ids and f["parent"] != f["id"] else None} for f in folders]
    by_id = {f["id"]: f for f in out}
    for f in out:
        seen = {f["id"]}
        cur = f
        while cur["parent"] is not None:
            if cur["parent"] in seen:
                cur["parent"] = None
                break
            seen.add(cur["parent"])
            cur = by_id[cur["parent"]]
    return out


def load_folders(home: Path) -> list[dict]:
    """folders.json의 폴더 [{id, name, parent, order, created_at}] (위치별로 order·이름 순). 없거나 깨졌으면 빈 목록."""
    try:
        data = json.loads((home / FOLDERS_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    items = data.get("folders") if isinstance(data, dict) else None
    seen: set[str] = set()
    folders = []
    for raw in items if isinstance(items, list) else []:
        if (f := _folder(raw)) and f["id"] not in seen:
            seen.add(f["id"])
            folders.append(f)
    return sorted(_sane(folders), key=lambda f: (f["parent"] or "", f["order"], fold(f["name"]), f["id"]))


@contextmanager
def folders_lock(home: Path):
    """folders.json을 읽고 고쳐 쓰는 동안 다른 프로세스의 같은 작업을 막는다 ($TRACTUS_HOME/.folders.lock, fcntl.flock). 같은 스레드에서 겹쳐 부르지 않는다."""
    home.mkdir(parents=True, exist_ok=True)
    fd = os.open(home / FOLDERS_LOCK, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def _save_folders(home: Path, folders: list[dict]) -> None:
    path = home / FOLDERS_FILE
    if path.exists():
        try:
            json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            path.replace(home / f"{FOLDERS_FILE}.corrupt")  # 깨진 파일은 지우지 않고 옆에 남긴다
    _write_atomic(path, json.dumps({"version": 1, "folders": folders}, ensure_ascii=False, indent=1))


def clean_folder_name(raw: str) -> str:
    name = _nfc(_visible(one_line(raw)))
    if not name:
        raise ValueError(FOLDER_EMPTY)
    if name.casefold() == NO_FOLDER:
        raise ValueError(FOLDER_RESERVED)
    if "/" in name:
        raise ValueError(FOLDER_SLASH)
    if len(name) > MAX_FOLDER_NAME:
        raise ValueError(FOLDER_LONG)
    return name


def _by_id(folders: list[dict]) -> dict[str, dict]:
    return {f["id"]: f for f in folders}


def folder_depth(folders: list[dict], fid: str | None) -> int:
    """폴더 fid의 깊이 (최상위 폴더 1, fid가 None이면 0)."""
    by_id = _by_id(folders)
    n = 0
    while fid is not None and fid in by_id and n <= len(folders):
        n += 1
        fid = by_id[fid]["parent"]
    return n


def children_of(folders: list[dict], fid: str | None) -> list[dict]:
    return [f for f in folders if f["parent"] == fid]


def descendants(folders: list[dict], fid: str) -> set[str]:
    """fid와 그 아래 모든 폴더의 ID."""
    out = {fid}
    stack = [fid]
    while stack:
        for c in children_of(folders, stack.pop()):
            if c["id"] not in out:
                out.add(c["id"])
                stack.append(c["id"])
    return out


def _height(folders: list[dict], fid: str) -> int:
    """fid 아래 가장 깊은 가지의 단계 수 (fid 자신 포함, 하위가 없으면 1)."""
    return 1 + max((_height(folders, c["id"]) for c in children_of(folders, fid)), default=0)


def _free_name(folders: list[dict], parent: str | None, name: str, skip: str | None = None) -> str:
    """parent 아래에서 겹치지 않는 이름: 겹치면 '이름 (2)', '이름 (3)' … (40자 안에서 앞을 줄인다)."""
    taken = {fold(f["name"]) for f in children_of(folders, parent) if f["id"] != skip}
    n, cand = 1, name
    while fold(cand) in taken:
        n += 1
        suffix = f" ({n})"
        cand = name[: MAX_FOLDER_NAME - len(suffix)] + suffix
    return cand


def _check_unique(folders: list[dict], parent: str | None, name: str, skip: str | None = None) -> None:
    if any(fold(f["name"]) == fold(name) for f in children_of(folders, parent) if f["id"] != skip):
        raise ValueError(FOLDER_DUP)


def _known(folders: list[dict], fid: str | None) -> dict:
    f = _by_id(folders).get(fid or "")
    if f is None:
        raise ValueError(FOLDER_MISSING)
    return f


def create_folder(home: Path, name: str, parent: str | None = None, now: datetime | None = None) -> dict:
    name = clean_folder_name(name)
    with folders_lock(home):
        folders = load_folders(home)
        if parent is not None:
            _known(folders, parent)
        if folder_depth(folders, parent) + 1 > MAX_DEPTH:
            raise ValueError(FOLDER_DEPTH)
        _check_unique(folders, parent, name)
        order = max((f["order"] for f in children_of(folders, parent)), default=0) + 1
        made = {"id": new_ulid(), "name": name, "parent": parent, "order": order, "created_at": (now or datetime.now().astimezone()).isoformat(timespec="seconds")}
        _save_folders(home, [*folders, made])
        return made


def rename_folder(home: Path, fid: str, name: str) -> dict:
    """이름만 바꾼다. 그 폴더의 노트 transcript.md는 다시 만든다 (frontmatter의 folder)."""
    name = clean_folder_name(name)
    with folders_lock(home):
        folders = load_folders(home)
        cur = _known(folders, fid)
        _check_unique(folders, cur["parent"], name, skip=fid)
        renamed = {**cur, "name": name}
        _save_folders(home, [renamed if f["id"] == fid else f for f in folders])
    rerender(note_dirs_in(home, {fid}))
    return renamed


def move_folder(home: Path, fid: str, parent: str | None) -> dict:
    """폴더를 다른 폴더 아래(또는 최상위)로 옮긴다. 자기 안으로·3단계를 넘게 옮기거나 이름이 겹치면 ValueError. 새 위치의 맨 끝에 놓는다."""
    with folders_lock(home):
        folders = load_folders(home)
        cur = _known(folders, fid)
        if parent is not None:
            _known(folders, parent)
            if parent in descendants(folders, fid):
                raise ValueError(FOLDER_LOOP)
        if folder_depth(folders, parent) + _height(folders, fid) > MAX_DEPTH:
            raise ValueError(FOLDER_DEPTH)
        if parent != cur["parent"]:
            _check_unique(folders, parent, cur["name"], skip=fid)
        order = max((f["order"] for f in children_of(folders, parent) if f["id"] != fid), default=0) + 1
        moved = {**cur, "parent": parent, "order": order} if parent != cur["parent"] else cur
        _save_folders(home, [moved if f["id"] == fid else f for f in folders])
        return moved


def delete_folder(home: Path, fid: str) -> dict:
    """폴더를 지운다. 노트는 상위 폴더(없으면 폴더 없음)로, 하위 폴더는 한 단계 위로 올린다 (이름이 겹치면 '이름 (2)').
    순서: 노트 → folders.json → md. 중간에 끊겨도 노트는 지워지지 않고, 지울 폴더가 비어 남을 뿐이라 같은 명령을 다시 하면 된다.
    {"deleted": ID, "moved_notes": N, "moved_folders": M}."""
    with folders_lock(home):
        folders = load_folders(home)
        cur = _known(folders, fid)
        target = cur["parent"]
        patch = {"folder": target}
        moved_dirs = []
        for d in note_dirs_in(home, {fid}):  # 부모가 None이면 폴더 키를 지운다 (검사할 폴더 ID 집합은 필요 없다)
            try:
                edit_transcript(d, lambda t: apply_meta(t, patch, {target} if target else set()))
            except OSError:
                continue  # 그 사이 휴지통으로 옮겨진 노트
            moved_dirs.append(d)
        out, order = [], max((f["order"] for f in children_of(folders, target) if f["id"] != fid), default=0)
        kids = children_of(folders, fid)
        siblings = [f for f in folders if f["id"] != fid]
        for f in folders:
            if f["id"] == fid:
                continue
            if f["parent"] == fid:
                order += 1
                f = {**f, "parent": target, "order": order, "name": _free_name(siblings, target, f["name"], skip=f["id"])}
                siblings = [f if s["id"] == f["id"] else s for s in siblings]
            out.append(f)
        _save_folders(home, out)
    rerender(moved_dirs)
    return {"deleted": fid, "moved_notes": len(moved_dirs), "moved_folders": len(kids)}


def resolve_folder(home: Path, ref: str) -> str | None:
    """폴더 ID, 또는 (겹치지 않는) 이름, 또는 'none'(→ None, 폴더 없음) → 폴더 ID. 없거나 이름이 여러 개면 ValueError."""
    if ref == NO_FOLDER:
        return None
    folders = load_folders(home)
    if ref in _by_id(folders):
        return ref
    hits = [f["id"] for f in folders if fold(f["name"]) == fold(ref)]
    if len(hits) > 1:
        raise ValueError(FOLDER_AMBIGUOUS)
    if not hits:
        raise ValueError(FOLDER_MISSING)
    return hits[0]


def folder_name_for(d: Path, t: dict) -> str | None:
    """노트 d의 폴더 이름 (transcript.md frontmatter용). 노트가 $TRACTUS_HOME/meetings/<폴더>에 있다고 보고 folders.json을 읽는다."""
    fid = meta_of(t)["folder"]
    if fid is None:
        return None
    return next((f["name"] for f in load_folders(d.resolve().parent.parent) if f["id"] == fid), None)


# ── 노트 목록 ─────────────────────────────────────────────────────────


def _ts(s: str | None) -> float:
    try:
        return datetime.fromisoformat(s).timestamp() if s else 0.0
    except ValueError:
        return 0.0


def iter_notes(home: Path, raw_ok: Callable[[str], bool] | None = None):
    """(폴더, transcript) 한 쌍씩. 읽을 수 없거나 모양이 틀린 노트는 건너뛴다.
    raw_ok: 파일 글자만 보고 먼저 거른다 (False면 JSON을 해석하지 않는다). 1시간짜리 노트는 0.9MB쯤이라 해석이 읽기보다 수십 배 느리다."""
    for p in sorted((home / "meetings").glob("*/transcript.json")):
        try:
            raw = p.read_text(encoding="utf-8")
            if raw_ok and not raw_ok(raw):
                continue
            t = json.loads(raw)
        except (OSError, ValueError):
            continue
        if isinstance(t, dict) and isinstance(t.get("meeting_id"), str):
            yield p.parent, t


def note_dirs_in(home: Path, folder_ids: set[str]) -> list[Path]:
    # 폴더 ID(ULID)는 그 폴더 노트의 transcript.json에 글자로 들어 있다: 없는 노트는 해석하지 않는다
    return [d for d, t in iter_notes(home, lambda raw: any(f in raw for f in folder_ids)) if meta_of(t)["folder"] in folder_ids]


def rerender(dirs: list[Path]) -> None:
    for d in dirs:
        try:
            with note_lock(d):
                render_files(d, read_transcript(d))
        except (OSError, ValueError, KeyError, TypeError):
            continue  # 문서는 `tractus render`로 다시 만들 수 있다


def note_row(d: Path, t: dict, folder_ids: set[str] | None = None) -> dict:
    """목록 한 줄: meeting_id, title, kind, created_at, updated_at, duration_sec, favorite, tags, folder(없는 폴더 ID면 None).
    updated_at이 없는 옛 노트는 created_at, 그것도 없으면 파일 수정 시각."""
    meta = meta_of(t)
    if folder_ids is not None and meta["folder"] not in folder_ids:
        meta["folder"] = None
    created = t.get("created_at") if isinstance(t.get("created_at"), str) else ""
    updated = t.get("updated_at") if isinstance(t.get("updated_at"), str) and t["updated_at"] else created
    if not updated:
        try:
            updated = datetime.fromtimestamp((d / "transcript.json").stat().st_mtime).astimezone().isoformat(timespec="seconds")
        except OSError:
            updated = ""
    duration = (t.get("audio") or {}).get("duration_sec") if isinstance(t.get("audio"), dict) else 0
    return {
        "meeting_id": t["meeting_id"], "title": str(t.get("title") or ""), "kind": "memo" if is_memo(t) else "recording",
        "created_at": created, "updated_at": updated, "duration_sec": float(duration) if isinstance(duration, (int, float)) else 0.0, **meta,
    }


def _sort_key(sort: str):
    if sort == "title":
        return lambda r: (fold(r["title"]), _ts(r["created_at"]), r["meeting_id"])
    field = {"created": "created_at", "updated": "updated_at"}.get(sort)
    if field:
        return lambda r: (_ts(r[field]), r["meeting_id"])
    return lambda r: (r["duration_sec"], _ts(r["created_at"]), r["meeting_id"])


def list_notes(home: Path, favorite: bool = False, tags: list[str] | tuple[str, ...] = (), folder: str | None = None, sort: str = "updated", order: str = "desc") -> list[dict]:
    """노트 목록(note_row). favorite: 즐겨찾기만. tags: 모두 붙은 노트만 (AND, 대소문자 구분 없음).
    folder: 폴더 ID·이름(그 폴더와 하위 폴더의 노트) 또는 'none'(폴더 없는 노트). 없는 폴더는 ValueError. 정렬은 안정적이고 제목은 NFC·casefold 기준이다."""
    if sort not in SORTS:
        raise ValueError(SORT_BAD)
    if order not in ORDERS:
        raise ValueError(ORDER_BAD)
    folders = load_folders(home)
    ids = {f["id"] for f in folders}
    want = {fold(clean_tag(x)) for x in tags}
    scope: set[str] = set()
    only_root = False
    if folder is not None:
        fid = resolve_folder(home, folder)
        only_root = fid is None
        scope = descendants(folders, fid) if fid else set()
    keys = [k for k, on in (('"favorite"', favorite), ('"tags"', bool(want)), ('"folder"', folder is not None and not only_root)) if on]  # 그 키가 아예 없는 노트는 해석하지 않는다
    rows = []
    for d, t in iter_notes(home, (lambda raw: all(k in raw for k in keys)) if keys else None):
        row = note_row(d, t, ids)
        if favorite and not row["favorite"]:
            continue
        if want and not want <= {fold(x) for x in row["tags"]}:
            continue
        if folder is not None and (row["folder"] is not None if only_root else row["folder"] not in scope):
            continue
        rows.append(row)
    return sorted(rows, key=_sort_key(sort), reverse=order == "desc")


def matching_ids(home: Path, favorite: bool = False, tags: list[str] | tuple[str, ...] = (), folder: str | None = None) -> set[str] | None:
    """검색·목록 필터에 맞는 meeting_id 집합. 필터가 하나도 없으면 None (제한 없음)."""
    if not favorite and not tags and folder is None:
        return None
    return {r["meeting_id"] for r in list_notes(home, favorite, tags, folder)}
