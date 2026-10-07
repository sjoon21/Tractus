"""회의 요약·결정 사항·할 일 추출 (ARCHITECTURE.md §3.3). 모든 추출 항목은 근거 segment_ids를 가진다."""

import json
import re
from datetime import datetime
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from tractus.llm import Provider, complete_json
from tractus.store import _hms, _write_atomic, seg_text, speaker_display

SCHEMA_VERSION = 1

SYSTEM_PROMPT = """너는 회의록 작성자다. 전사문만 근거로 회의를 정리한다.
- 회의에서 쓰인 언어로 작성한다 (한국어 회의면 한국어). 영어 기술 용어는 원문 표기를 살린다.
- 전사에 없는 내용을 지어내지 않는다. 담당자(owner)와 기한(due)은 전사에 명시된 경우에만 채우고, 아니면 null로 둔다.
- 담당자(owner)는 전사 본문에 이름이 나온 사람만 쓴다. "제가 하겠습니다"처럼 말한 사람만 가리키면 owner는 null로 둔다.
- 줄 앞의 화자 표시(예: `[s0012 00:05:31 김민수]`)는 목소리로 자동 추정한 값이라 틀릴 수 있다. 화자 표시가 사람 이름이면 사용자가 확인한 이름이므로, 그 사람이 "제가 하겠습니다"라고 했다면 owner로 쓸 수 있다.
- 참석자 1, 참석자 2 같은 자동 이름은 사람 이름이 아니다. owner에 절대 넣지 않는다. "화자", "발언자", 세그먼트 ID 같은 값도 넣지 않는다.
- 모든 주제·결정 사항·할 일에는 근거가 되는 세그먼트 ID(예: s0012)를 segment_ids에 하나 이상 넣는다. 전사에 있는 ID만 쓴다.
- 전사는 음성 인식 결과라 오인식이 있을 수 있다. 문맥상 명백한 오인식은 바로잡아 쓴다.
- 결정 사항은 회의에서 합의·확정된 것만, 할 일은 누군가 하기로 한 구체적 행동만 넣는다. 없으면 빈 배열로 둔다.
- 요약·결정 사항·할 일 문장에 '화자', '세그먼트', '전사', s0012 같은 말을 쓰지 않는다. 이름이 붙은 사람만 이름으로 쓰고, 아니면 '참석자 1'처럼 쓴다."""


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Topic(_Strict):
    title: str = Field(description="주제 이름")
    segment_ids: list[str] = Field(description="이 주제를 다룬 세그먼트 ID들")


class Decision(_Strict):
    text: str = Field(description="결정 내용")
    segment_ids: list[str]


class ActionItem(_Strict):
    task: str = Field(description="할 일")
    owner: str | None = Field(description="담당자. 전사에 없으면 null")
    due: str | None = Field(description="기한. 전사에 없으면 null")
    segment_ids: list[str]


class MeetingSummary(_Strict):
    title: str = Field(description="회의 내용을 나타내는 짧은 제목")
    summary: str = Field(description="3–6문장 요약")
    topics: list[Topic]
    decisions: list[Decision]
    action_items: list[ActionItem]


def build_prompt(transcript: dict) -> str:
    def who(s: dict) -> str:
        name = speaker_display(transcript, s.get("speaker"))
        return f" {name}" if name else ""

    lines = [f"[{s['id']} {_hms(s['start'])}{who(s)}] {seg_text(s)}" for s in transcript["segments"]]
    return f"회의 제목(파일 기준): {transcript['title']}\n\n전사:\n" + "\n".join(lines)


def check_segment_ids(summary: MeetingSummary, transcript: dict) -> None:
    """근거가 비었거나 전사에 없는 세그먼트 ID를 쓴 항목이 있으면 ValueError (재요청 대상)."""
    known = {s["id"] for s in transcript["segments"]}
    items = [*summary.topics, *summary.decisions, *summary.action_items]
    unknown = sorted({i for item in items for i in item.segment_ids} - known)
    if unknown:
        raise ValueError(f"전사에 없는 segment_ids: {unknown[:20]}")  # words-ok: LLM 재시도·stderr 전용
    empty = [getattr(item, "title", "") or getattr(item, "text", "") or getattr(item, "task", "") or "(빈 항목)" for item in items if not item.segment_ids]
    if empty:
        raise ValueError(f"근거 segment_ids가 빈 항목: {empty[:10]}")


_NOT_OWNER = re.compile(r"^\s*(S\d+|참석자\s*\d+|speaker[\s_]*\d*|화자\s*\d*|발언자\s*\d*)\s*$|\bs\d{4}\b", re.IGNORECASE)  # "이화자" 같은 이름은 남긴다


def _suggested_only(transcript: dict | None) -> set[str]:
    """목소리 제안으로만 나온 이름 (사용자가 확정한 이름과 겹치지 않는 것)."""
    speakers = (transcript or {}).get("speakers") or {}
    confirmed = {(v or {}).get("name") for v in speakers.values()}
    return {v["suggested"]["name"] for v in speakers.values() if (v or {}).get("suggested")} - confirmed


def clean_owners(s: MeetingSummary, transcript: dict | None = None) -> MeetingSummary:
    """자동 화자 라벨(S2)·"발언자" 같은 owner는 null로 바꾼 새 요약. 프롬프트로 막아도 모델이 넣는 경우가 있다
    (2026-10-04 solar-pro4: 라벨이 붙은 가상 회의에서 3회 중 3회).
    transcript를 주면 확정되지 않은 목소리 제안 이름도 지운다 (제안은 프롬프트에 넣지 않지만 에이전트가 save_summary로 넣을 수 있다)."""
    bad = _suggested_only(transcript)
    items = [a.model_copy(update={"owner": None}) if a.owner and (_NOT_OWNER.search(a.owner) or a.owner.strip() in bad) else a
             for a in s.action_items]
    return s.model_copy(update={"action_items": items})


def summarize(client, provider: Provider, model: str, transcript: dict) -> MeetingSummary:
    return clean_owners(complete_json(
        client, provider, model, SYSTEM_PROMPT, build_prompt(transcript), MeetingSummary,
        validate=lambda s: check_segment_ids(s, transcript),
    ))


def _span(ids: list[str], transcript: dict) -> str:
    seg = {s["id"]: s for s in transcript["segments"]}
    starts = [seg[i]["start"] for i in ids]
    return _hms(min(starts))


def render_summary_md(s: MeetingSummary, transcript: dict, provider: str, model: str, generated_at: str) -> str:
    seg = {x["id"]: x for x in transcript["segments"]}
    out = [
        "---",
        f"meeting_id: {transcript['meeting_id']}",
        f"provider: {provider}",
        f"model: {model}",
        f"generated_at: {generated_at}",
        "---",
        "",
        f"# {s.title}",
        "",
        s.summary,
        "",
        "## 주제",
        "",
    ]
    for t in s.topics:
        start = min(seg[i]["start"] for i in t.segment_ids)
        end = max(seg[i]["end"] for i in t.segment_ids)
        out += [f"### {t.title} [{_hms(start)}–{_hms(end)}]", ""]
    out += ["## 결정 사항", ""] + ([f"- {d.text} [{_span(d.segment_ids, transcript)}]" for d in s.decisions] or ["- 없음"])
    out += ["", "## 할 일", ""]
    for a in s.action_items:
        who = ", ".join(x for x in (a.owner, a.due) if x)
        out.append(f"- [ ] {a.task}{' — ' + who if who else ''} [{_span(a.segment_ids, transcript)}]")
    if not s.action_items:
        out.append("- 없음")
    return "\n".join(out) + "\n"


def write_summary(meeting_dir: Path, s: MeetingSummary, transcript: dict, provider: str, model: str) -> None:
    """저장 경로는 이것 하나라 MCP save_summary(에이전트 작성)도 여기서 owner 정리를 거친다."""
    s = clean_owners(s, transcript)
    generated_at = datetime.now().astimezone().isoformat(timespec="seconds")
    data = {"schema_version": SCHEMA_VERSION, "meeting_id": transcript["meeting_id"], "provider": provider,
            "model": model, "generated_at": generated_at, **s.model_dump()}
    _write_atomic(meeting_dir / "summary.md", render_summary_md(s, transcript, provider, model, generated_at))
    _write_atomic(meeting_dir / "summary.json", json.dumps(data, ensure_ascii=False, indent=1))
