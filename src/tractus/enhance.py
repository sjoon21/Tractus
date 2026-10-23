"""노트 완성: 내 메모를 뼈대로 대화 내용의 세부를 붙인 완성된 노트 (docs/design/enhanced-notes.md).

뼈대(source)는 메모 탭 줄(m####)을 먼저, 녹음 중 메모·북마크(memos.json)를 시각 순으로 그 뒤에 둔다.
녹음 중 메모에는 저장하지 않는 ID r####를 시각 순으로 매번 같은 규칙으로 붙인다. 근거(segment_ids)는 대화 줄(s####)만이다.
결과는 요약 v2(summaries/enhanced.json)에 kind "enhanced"와 섹션별 part·source·at을 더해 저장한다: 목록·내보내기·MCP가 그대로 쓴다.
"""

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from tractus import prompts
from tractus.i18n import ai_prompt, t
from tractus.llm import Provider, complete_json
from tractus.store import _hms, _write_atomic, load_memos, memo_lines
from tractus.summaries import SCHEMA_VERSION, GenericSummary, Item, Section, clean_owners, paths, render_md
from tractus.summarize import build_prompt

KEY = "enhanced"
NAME = t("노트 완성")  # 탭 이름: 만들 때의 화면 언어로 template_name에 저장된다
NO_RECORDING = t("녹음이 없는 노트는 노트 완성을 할 수 없습니다")

PROMPTS = prompts.load("enhance")  # 문구는 prompts/enhance.md
SYSTEM_PROMPT = PROMPTS["system"]

LANG_RULE = PROMPTS["lang"]  # 영어 화면이면 i18n.ai_prompt가 바꾼다


def system_prompt() -> str:
    return ai_prompt(SYSTEM_PROMPT, LANG_RULE)


@dataclass(frozen=True)
class Source:
    """뼈대 한 줄. kind: memo(메모 탭) | recording_memo(녹음 중 메모) | bookmark. at: 녹음 중 메모의 녹음 시각(초)"""

    id: str
    kind: Literal["memo", "recording_memo", "bookmark"]
    text: str
    at: float | None = None


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Block(_Strict):
    source: str | None = Field(description="이 블록의 뼈대가 된 메모 줄 ID(m0001, r0001). 메모에 없던 내용이면 null")  # i18n-ok: AI 프롬프트
    heading: str = Field(description="source가 null일 때만 쓰는 짧은 소제목. source가 있으면 빈 문자열")  # i18n-ok: AI 프롬프트
    items: list[Item]


class EnhancedNote(_Strict):
    title: str = Field(description="내용을 나타내는 짧은 제목")  # i18n-ok: AI 프롬프트
    blocks: list[Block]
    todos: list[Item]


def sources(t: dict, d: Path) -> list[Source]:
    """메모 탭 줄(적은 순서) → 녹음 중 메모·북마크(시각 순, r0001부터). 같은 노트면 언제나 같은 결과다."""
    tab = [Source(m["id"], "memo", m["text"].strip()) for m in memo_lines(t)]
    marks = [m for m in load_memos(d) if m.get("kind") == "bookmark" or (m.get("kind") == "memo" and str(m.get("text") or "").strip())]
    rec = [
        Source(f"r{n:04d}", "bookmark" if m.get("kind") == "bookmark" else "recording_memo", "" if m.get("kind") == "bookmark" else str(m["text"]).strip(), float(m["t"]))
        for n, m in enumerate(marks, 1)
    ]
    return tab + rec


def _line(s: Source) -> str:
    if s.kind == "memo":
        return f"[{s.id}] {s.text}"
    label = "북마크" if s.kind == "bookmark" else "녹음 중 메모"  # i18n-ok: AI 프롬프트
    return f"[{s.id} {_hms(s.at or 0)} {label}]" + (f" {s.text}" if s.text else "")


def build_input(t: dict, srcs: list[Source]) -> str:
    """대화 내용(요약과 같은 줄 모양) + 내가 적은 메모. 요약용 '사용자가 적은 메모' 블록은 넣지 않는다 (뼈대 목록과 겹친다)."""
    body = build_prompt({**t, "memo": None})
    notes = "내가 적은 메모 (적은 순서):\n" + "\n".join(_line(s) for s in srcs) if srcs else "내가 적은 메모: 없음"  # i18n-ok: AI 프롬프트
    return f"{body}\n\n{notes}"


def check(note: EnhancedNote, t: dict, srcs: list[Source]) -> None:
    """어기면 ValueError (complete_json이 1회 재요청한다). 블록 순서는 여기서 따지지 않는다 (to_sections가 맞춘다)."""
    known = {s["id"] for s in t["segments"]}
    items = [i for b in note.blocks for i in b.items] + note.todos
    if bad := sorted({i for item in items for i in item.segment_ids} - known):
        raise ValueError(f"대화에 없는 segment_ids(메모 ID는 근거가 아님): {bad[:20]}")  # words-ok: LLM 재시도·stderr 전용  # i18n-ok: AI 프롬프트
    if empty := [i.text or "(빈 항목)" for i in items if not i.segment_ids]:  # i18n-ok: AI 프롬프트
        raise ValueError(f"근거 segment_ids가 빈 항목: {empty[:10]}")  # words-ok: LLM 재시도·stderr 전용  # i18n-ok: AI 프롬프트
    used = [b.source for b in note.blocks if b.source is not None]
    want = [s.id for s in srcs]
    if unknown := sorted(set(used) - set(want)):
        raise ValueError(f"입력에 없는 메모 source: {unknown}")  # words-ok: LLM 재시도·stderr 전용  # i18n-ok: AI 프롬프트
    if dup := sorted({x for x in used if used.count(x) > 1}):
        raise ValueError(f"같은 메모 source를 두 번 씀: {dup}")  # words-ok: LLM 재시도·stderr 전용  # i18n-ok: AI 프롬프트
    if missing := [x for x in want if x not in used]:
        raise ValueError(f"빠진 메모 source: {missing}")  # words-ok: LLM 재시도·stderr 전용  # i18n-ok: AI 프롬프트
    if not srcs and not items:
        raise ValueError("블록도 할 일도 비어 있습니다")  # words-ok: LLM 재시도·stderr 전용  # i18n-ok: AI 프롬프트


def _clock(sec: float) -> str:
    s = int(sec)
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


def heading(s: Source) -> str:
    """뼈대 줄의 제목: 사용자 원문 그대로. 북마크는 `북마크 1:35`"""
    return t("북마크 {clock}", clock=_clock(s.at or 0)) if s.kind == "bookmark" else s.text


def to_sections(note: EnhancedNote, transcript: dict, srcs: list[Source]) -> list[dict]:
    """메모 블록(입력 순서, 원문 제목) → 메모에 없던 내용 → 할 일. owner 정리는 요약과 같다."""
    by_source = {b.source: b for b in note.blocks if b.source is not None}
    plan = [(heading(s), "bullets", by_source[s.id].items, {"part": "memo", "source": s.id, **({"at": s.at} if s.at is not None else {})}) for s in srcs]
    plan += [(b.heading.strip() or t("메모에 없던 내용"), "bullets", b.items, {"part": "extra", "source": None}) for b in note.blocks if b.source is None]
    if note.todos:
        plan.append((t("할 일"), "checklist", note.todos, {"part": "todos", "source": None}))
    cleaned = clean_owners(GenericSummary(title=note.title, overview="", sections=[Section(heading=h, style=st, items=it) for h, st, it, _ in plan]), transcript)
    return [{**sec.model_dump(), **extra} for sec, (_, _, _, extra) in zip(cleaned.sections, plan)]


def enhance(client, provider: Provider, model: str, t: dict, d: Path) -> dict:
    """완성된 노트(저장할 v2 딕셔너리, provider·시각 제외)를 만든다. 녹음이 없는 노트는 호출하지 않는다 (cli가 거른다)."""
    srcs = sources(t, d)
    note = complete_json(client, provider, model, system_prompt(), build_input(t, srcs), EnhancedNote, validate=lambda n: check(n, t, srcs))
    return {"title": note.title, "sections": to_sections(note, t, srcs)}


def write(d: Path, t: dict, result: dict, provider: str, model: str) -> str:
    data = {"schema_version": SCHEMA_VERSION, "meeting_id": t["meeting_id"], "template": KEY, "template_name": NAME, "kind": KEY,
            "prompt_hash": hashlib.sha256(system_prompt().encode()).hexdigest()[:12], "provider": provider, "model": model, "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "title": result["title"], "overview": "", "sections": result["sections"]}
    jp, mp = paths(d, KEY)
    jp.parent.mkdir(exist_ok=True)
    _write_atomic(mp, render_md(data, t))
    _write_atomic(jp, json.dumps(data, ensure_ascii=False, indent=1))  # json이 마지막: 목록은 json 기준
    return KEY
