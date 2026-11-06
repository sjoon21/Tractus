"""캘린더 일정으로 시작한 녹음의 일정 정보 (docs/design/calendar.md).

앱이 녹음 폴더에 event.json을 쓰고, 코어가 노트 폴더로 옮긴다 (memos.json과 같은 방식).
일정 제목은 기본 제목, 참석자 이름은 그 노트의 변환에만 쓰는 음성 인식 힌트(hotwords)가 된다.
"""

import json
from datetime import datetime
from pathlib import Path

from tractus.store import _write_atomic, one_line

EVENT_FILE = "event.json"
MAX_TITLE = 200
MAX_NAME = 80
MAX_ATTENDEES = 50
MAX_ID = 256


def _iso(v) -> str | None:
    try:
        return datetime.fromisoformat(v).isoformat() if isinstance(v, str) else None
    except ValueError:
        return None


def clean_event(raw) -> dict | None:
    """검사한 일정 {"title", "start", "end", "calendar", "attendees"} (+ 캘린더의 일정 ID "id"가 있으면: 앱이 일정과 노트를 잇는다). 제목이 비었거나 시각이 맞지 않으면 None. 긴 제목은 자른다."""
    if not isinstance(raw, dict):
        return None
    title = (one_line(raw["title"]) if isinstance(raw.get("title"), str) else "")[:MAX_TITLE]
    start, end = _iso(raw.get("start")), _iso(raw.get("end"))
    if not title or not start or not end:
        return None
    names: list[str] = []
    for x in raw.get("attendees") if isinstance(raw.get("attendees"), list) else []:
        n = one_line(x) if isinstance(x, str) else ""
        if n and len(n) <= MAX_NAME and "@" not in n and n not in names:  # 이메일은 남기지 않는다
            names.append(n)
    calendar = one_line(raw["calendar"])[:MAX_TITLE] if isinstance(raw.get("calendar"), str) else ""
    ev = {"title": title, "start": start, "end": end, "calendar": calendar, "attendees": names[:MAX_ATTENDEES]}
    eid = raw.get("id")
    if isinstance(eid, str) and 0 < len(eid) <= MAX_ID and eid == one_line(eid):  # 모양이 이상한 ID는 버린다 (잇기만 못 할 뿐)
        ev["id"] = eid
    return ev


def load_event(d: Path | None) -> dict | None:
    """폴더 d의 event.json. 없거나 깨졌으면 None."""
    if d is None:
        return None
    try:
        return clean_event(json.loads((d / EVENT_FILE).read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return None


def save_event(d: Path, ev: dict) -> None:
    """노트 폴더에 옮긴다. 이미 있으면 그대로 둔다 (이어서 하는 실행)."""
    if not (d / EVENT_FILE).is_file():
        _write_atomic(d / EVENT_FILE, json.dumps(ev, ensure_ascii=False, indent=1))
