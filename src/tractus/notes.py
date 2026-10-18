"""메모 노트(오디오 없이 직접 쓴 노트)와 제목 바꾸기 (docs/desktop.md §2.10).

메모는 평범한 노트 폴더다. transcript.json에 "kind": "memo"와 "body"(사용자가 쓴 글 그대로)가 있고,
segments는 body의 비어 있지 않은 줄마다 하나씩 body에서 만들어 낸다(검색·질문·요약·내보내기가 그대로 동작하게).
"kind"가 없는 노트는 녹음에서 만든 노트다 (옛 파일을 고치지 않는다).
녹음 노트도 사용자 메모를 가질 수 있다: transcript.json의 선택 키 "memo" {"body", "lines": [{"id": "m0001", "line", "text"}], "seq"}.
줄 ID(m####)는 ASR 세그먼트 ID(s####)와 다른 번호 공간이고, 메모 노트의 세그먼트 ID와 같은 규칙(derive_lines)으로 이어진다.
"""

import difflib
import json
import re
from datetime import datetime
from pathlib import Path

from tractus.i18n import t
from tractus.store import _write_atomic, meeting_dir_name, memo_lines, new_ulid, one_line, save_transcript, SCHEMA_VERSION

MAX_TITLE = 120
MAX_BODY = 200_000  # 자
MAX_LINES = 5000  # 비어 있지 않은 줄. 세그먼트 ID(s0001–s9999)를 모두 쓰지 않도록 여유를 둔다
MAX_ID = 9999
# 크기가 다른 교체에서 닮은 줄을 찾느라 비교할 쌍의 상한 (이보다 크면 짝짓지 않는다)
PAIR_BUDGET = 100_000
SIMILAR = 0.5  # 크기가 다른 교체에서 같은 줄을 고친 것으로 보는 닮은 정도 (difflib ratio)
_CTRL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")  # \t(\x09)와 \n(\x0a)만 남긴다

TITLE_EMPTY = t("제목을 입력하세요.")
TITLE_LONG = t("제목은 {n}자까지 쓸 수 있습니다.", n=MAX_TITLE)
BODY_LONG = t("메모는 {n}자까지 쓸 수 있습니다.", n=f"{MAX_BODY:,}")
LINES_LONG = t("메모는 {n}줄까지 쓸 수 있습니다.", n=f"{MAX_LINES:,}")
MEMO_EDIT_HERE = t("메모의 내용은 메모 화면에서 직접 고칩니다.")
NO_AUDIO_ALIGN = t("녹음이 없는 노트라 단어 싱크를 맞출 수 없습니다.")


def clean_title(raw: str) -> str:
    """공백·줄바꿈을 한 칸으로 줄이고 제어 문자를 뺀다. 비었거나 120자를 넘으면 ValueError (WORDS.md 문장)."""
    title = one_line(raw)
    if not title:
        raise ValueError(TITLE_EMPTY)
    if len(title) > MAX_TITLE:
        raise ValueError(TITLE_LONG)
    return title


def clean_body(raw: str) -> str:
    """줄바꿈은 \\n으로 통일하고 \\n·\\t 외의 제어 문자는 뺀다. 200,000자를 넘으면 ValueError."""
    body = _CTRL.sub("", raw.replace("\r\n", "\n").replace("\r", "\n"))
    if len(body) > MAX_BODY:
        raise ValueError(BODY_LONG)
    return body


def _num(line_id: str, prefix: str) -> int:
    return int(line_id[1:]) if re.fullmatch(rf"{prefix}\d+", line_id) else 0


def derive_lines(body: str, old: list[dict] | None = None, seq: int = 0, prefix: str = "s") -> tuple[list[dict], int]:
    """body → 줄 [{"id", "line", "text"}] (비어 있지 않은 줄마다 하나)과 마지막으로 낸 ID 번호(seq). ID는 prefix + 4자리 번호(s0001 / m0001).
    old는 이전 줄들(id·text). 줄이 그대로면 옛 ID를 이어받는다(요약의 근거 ID가 유효하게). 같은 자리에서 고친 줄도 ID를 유지한다(difflib 'replace'를 짝지음).
    새 줄은 seq 다음 번호를 받는다. 번호는 9999 다음에 처음으로 돌아가 비어 있는 것을 쓴다.
    line은 body에서 1부터 센 줄 번호(빈 줄 포함, 입력창 줄과 같다)."""
    rows = [(n, text) for n, line in enumerate(body.split("\n"), 1) if (text := line.strip())]
    if len(rows) > MAX_LINES:
        raise ValueError(LINES_LONG)
    old = old or []
    ids: list[str | None] = [None] * len(rows)
    sm = difflib.SequenceMatcher(None, [s["text"] for s in old], [r[1] for r in rows], autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal" or (tag == "replace" and i2 - i1 == j2 - j1):
            for k in range(i2 - i1):
                ids[j1 + k] = old[i1 + k]["id"]
        elif tag == "replace" and (i2 - i1) * (j2 - j1) <= PAIR_BUDGET:  # 크기가 다른 교체: 줄을 끼워 넣으며 고친 경우라 자리가 아니라 닮은 줄끼리 짝짓는다 (순서는 유지)
            # ponytail: 큰 교체(통째로 붙여넣기)는 짝짓지 않고 새 ID를 준다. note_lock 안이라 몇 초씩 잡고 있을 수 없다
            nxt = j1
            for i in range(i1, i2):
                scored = [(difflib.SequenceMatcher(None, old[i]["text"], rows[j][1]).ratio(), j) for j in range(nxt, j2)]
                best = max(scored, key=lambda x: x[0], default=None)
                if best is not None and best[0] >= SIMILAR:
                    ids[best[1]] = old[i]["id"]
                    nxt = best[1] + 1
    used = {_num(i, prefix) for i in ids if i}
    seq = max(seq, *(_num(s["id"], prefix) for s in old)) if old else seq
    for j, cur in enumerate(ids):
        if cur is None:
            n = seq
            while True:
                n = n % MAX_ID + 1
                if n not in used:
                    break
            used.add(n)
            seq = n
            ids[j] = f"{prefix}{n:04d}"
    return [{"id": ids[j], "line": n, "text": text} for j, (n, text) in enumerate(rows)], seq


def derive_segments(body: str, old: list[dict] | None = None, seq: int = 0) -> tuple[list[dict], int]:
    """메모 노트의 세그먼트(줄마다 하나)와 seq. start·end는 0, line은 body의 줄 번호 (derive_lines)."""
    lines, seq = derive_lines(body, old, seq, "s")
    return [{"id": l["id"], "start": 0.0, "end": 0.0, "text": l["text"], "lang": None, "speaker": None, "corrected_text": None, "words": None, "line": l["line"]} for l in lines], seq


def new_memo(title: str, body: str, now: datetime, meeting_id: str) -> dict:
    segments, seq = derive_segments(body)
    return {
        "schema_version": SCHEMA_VERSION, "kind": "memo", "meeting_id": meeting_id, "title": title, "created_at": now.isoformat(timespec="seconds"),
        "audio": {"file": None, "duration_sec": 0, "source": "memo", "sha256": None},
        "body": body, "seg_seq": seq, "speakers": {}, "diarization": None, "segments": segments,
    }


def create_memo(meetings: Path, title: str | None, body: str = "", now: datetime | None = None) -> tuple[Path, dict]:
    """meetings/<날짜>_<제목>_<ULID>/에 메모를 만든다. 제목이 없으면 '메모 HH:MM'. 잘못된 제목·본문은 ValueError."""
    now = now or datetime.now().astimezone()
    title = clean_title(title) if title and title.strip() else t("메모 {time}", time=f"{now:%H:%M}")  # 기본 제목은 만들 때의 화면 언어
    body = clean_body(body)
    note = new_memo(title, body, now, new_ulid())  # 줄 수 검사(ValueError)는 폴더를 만들기 전에 끝난다
    d = meetings / meeting_dir_name(now.date().isoformat(), title, note["meeting_id"])
    d.mkdir(parents=True)
    save_transcript(d, note)  # transcript.json이 마지막: 이 파일이 생기면 노트가 생긴 것이다
    return d, note


def apply_body(t: dict, body: str) -> tuple[dict, bool]:
    """노트 t의 글을 body(clean_body를 거친 것)로 바꾼 새 전사와 바뀌었는지.
    메모 노트: 본문과 세그먼트를 바꾼다. 녹음 노트: 선택 키 "memo"를 쓴다 (비어 있으면 키를 지운다. ASR 세그먼트·단어·화자는 건드리지 않는다)."""
    if t.get("kind") == "memo":
        segments, seq = derive_segments(body, t["segments"], int(t.get("seg_seq") or 0))
        new = {**t, "body": body, "seg_seq": seq, "segments": segments}
        return (new, new != t)
    seq = _memo_seq(t)
    if not body.strip():
        # 키는 지우되 마지막 번호는 남긴다: 다시 쓴 메모가 m0001부터 시작해 비운 메모를 가리키던 옛 요약·질문 근거와 겹치지 않게
        new = {k: v for k, v in t.items() if k not in ("memo", "memo_seq")} | ({"memo_seq": seq} if seq else {})
        return (new, new != t)
    lines, seq = derive_lines(body, memo_lines(t), seq, "m")
    new = {k: v for k, v in t.items() if k != "memo_seq"} | {"memo": {"body": body, "lines": lines, "seq": seq}}
    return (new, new != t)


def _memo_seq(t: dict) -> int:
    """녹음 노트 메모가 지금까지 낸 마지막 줄 번호: memo.seq, 줄 ID, 비울 때 남긴 memo_seq 중 가장 큰 것 (모양이 다르면 0)"""
    old = t.get("memo") if isinstance(t.get("memo"), dict) else {}
    nums = [v for v in (old.get("seq"), t.get("memo_seq")) if isinstance(v, int) and not isinstance(v, bool)]
    nums += [_num(m["id"], "m") for m in memo_lines(t)]
    return max(nums, default=0)


def apply_title(t: dict, title: str) -> dict:
    return {**t, "title": clean_title(title)}


def retitle_summary(d: Path, title: str) -> None:
    """요약 파일(summary.json의 title, summary.md의 첫 제목 줄)과 유형별 요약(summaries/*.json·md)을 새 제목으로 바꾼다. 요약이 없으면 아무것도 하지 않는다."""
    _retitle_pair(d / "summary.json", d / "summary.md", title)
    for sj in sorted((d / "summaries").glob("*.json")):
        _retitle_pair(sj, sj.with_suffix(".md"), title)


def _retitle_pair(sj: Path, sm: Path, title: str) -> None:
    try:
        data = json.loads(sj.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = None
    if isinstance(data, dict) and data.get("title") != title:
        _write_atomic(sj, json.dumps({**data, "title": title}, ensure_ascii=False, indent=1))
    try:
        text = sm.read_text(encoding="utf-8")
    except OSError:
        return
    new = re.sub(r"^# .*$", lambda _: f"# {title}", text, count=1, flags=re.M)
    if new != text:
        _write_atomic(sm, new)
