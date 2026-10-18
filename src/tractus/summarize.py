"""회의 요약·결정 사항·할 일 추출 (ARCHITECTURE.md §3.3). 모든 추출 항목은 근거 segment_ids를 가진다."""

import json
import re
from datetime import datetime
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from tractus.i18n import ai_prompt, t
from tractus.llm import Provider, complete_json
from tractus.store import _hms, _write_atomic, is_memo, memo_lines, seg_text, speaker_display

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
- 요약·결정 사항·할 일 문장에 '화자', '세그먼트', '전사', s0012 같은 말을 쓰지 않는다. 이름이 붙은 사람만 이름으로 쓰고, 아니면 '참석자 1'처럼 쓴다."""  # i18n-ok: AI 프롬프트


MEMO_PROMPT = """
- 이 입력은 회의 전사가 아니라 사용자가 직접 쓴 메모다. 줄 앞에는 세그먼트 ID만 있고 시각·화자 표시는 없다. 담당자는 메모 본문에 이름이 나온 사람만 쓰고, '회의' 대신 '메모'라고 쓴다."""  # i18n-ok: AI 프롬프트


RECORDING_MEMO_PROMPT = """
- 입력 끝의 '사용자가 적은 메모'는 사용자가 직접 쓴 글이라 음성 인식 결과가 아니다. 줄 앞에는 m으로 시작하는 ID만 있다. 메모는 사용자가 따로 챙겨 둔 내용이므로 요약·주제·할 일에 빠뜨리지 않고 반영하고, 그 항목의 segment_ids에 해당 메모 줄 ID(예: m0001)를 넣는다. 전사와 겹치면 전사 ID와 메모 ID를 함께 넣는다. 결정 사항은 전사에서 합의·확정된 것이 우선이고, 메모는 '결정'이라고 분명히 적은 것만 넣는다. 메모에 적힌 일은 하기로 한 사람이 분명하지 않아도 할 일(owner null)로 넣을 수 있다."""  # i18n-ok: AI 프롬프트


LANG_RULE = "- 회의에서 쓰인 언어로 작성한다 (한국어 회의면 한국어). 영어 기술 용어는 원문 표기를 살린다."  # i18n-ok: AI 프롬프트 (영어 화면이면 i18n.ai_prompt가 바꾼다)


def system_prompt(transcript: dict) -> str:
    return ai_prompt(SYSTEM_PROMPT, LANG_RULE) + (MEMO_PROMPT if is_memo(transcript) else RECORDING_MEMO_PROMPT if memo_lines(transcript) else "")


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Topic(_Strict):
    title: str = Field(description="주제 이름")  # i18n-ok: AI 프롬프트
    segment_ids: list[str] = Field(description="이 주제를 다룬 세그먼트 ID들")  # i18n-ok: AI 프롬프트


class Decision(_Strict):
    text: str = Field(description="결정 내용")  # i18n-ok: AI 프롬프트
    segment_ids: list[str]


class ActionItem(_Strict):
    task: str = Field(description="할 일")  # i18n-ok: AI 프롬프트
    owner: str | None = Field(description="담당자. 전사에 없으면 null")  # i18n-ok: AI 프롬프트
    due: str | None = Field(description="기한. 전사에 없으면 null")  # i18n-ok: AI 프롬프트
    segment_ids: list[str]


class MeetingSummary(_Strict):
    title: str = Field(description="회의 내용을 나타내는 짧은 제목")  # i18n-ok: AI 프롬프트
    summary: str = Field(description="3–6문장 요약")  # i18n-ok: AI 프롬프트
    topics: list[Topic]
    decisions: list[Decision]
    action_items: list[ActionItem]


def build_prompt(transcript: dict) -> str:
    if is_memo(transcript):
        lines = [f"[{s['id']}] {seg_text(s)}" for s in transcript["segments"]]
        return f"메모 제목: {transcript['title']}\n\n메모:\n" + "\n".join(lines)  # i18n-ok: AI 프롬프트

    def who(s: dict) -> str:
        name = speaker_display(transcript, s.get("speaker"))
        return f" {name}" if name else ""

    lines = [f"[{s['id']} {_hms(s['start'])}{who(s)}] {seg_text(s)}" for s in transcript["segments"]]
    prompt = f"회의 제목(파일 기준): {transcript['title']}\n\n전사:\n" + "\n".join(lines)  # i18n-ok: AI 프롬프트
    if memo := memo_lines(transcript):  # 사용자가 직접 쓴 메모: 전사와 따로 라벨을 붙이고 시각 없이 ID만
        prompt += "\n\n사용자가 적은 메모:\n" + "\n".join(f"[{m['id']}] {m['text']}" for m in memo)  # i18n-ok: AI 프롬프트
    return prompt


def check_segment_ids(summary: MeetingSummary, transcript: dict) -> None:
    """근거가 비었거나 전사(또는 사용자 메모 줄)에 없는 세그먼트 ID를 쓴 항목이 있으면 ValueError (재요청 대상)."""
    known = {s["id"] for s in transcript["segments"]} | {m["id"] for m in memo_lines(transcript)}
    items = [*summary.topics, *summary.decisions, *summary.action_items]
    unknown = sorted({i for item in items for i in item.segment_ids} - known)
    if unknown:
        raise ValueError(f"전사에 없는 segment_ids: {unknown[:20]}")  # words-ok: LLM 재시도·stderr 전용  # i18n-ok: AI 프롬프트
    empty = [getattr(item, "title", "") or getattr(item, "text", "") or getattr(item, "task", "") or "(빈 항목)" for item in items if not item.segment_ids]  # i18n-ok: AI 프롬프트
    if empty:
        raise ValueError(f"근거 segment_ids가 빈 항목: {empty[:10]}")  # i18n-ok: AI 프롬프트


_NOT_OWNER = re.compile(r"^\s*(S\d+|참석자\s*\d+|speaker[\s_]*\d*|화자\s*\d*|발언자\s*\d*)\s*$|\bs\d{4}\b", re.IGNORECASE)  # "이화자" 같은 이름은 남긴다  # i18n-ok: 요약 출력 판별


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
        client, provider, model, system_prompt(transcript), build_prompt(transcript), MeetingSummary,
        validate=lambda s: check_segment_ids(s, transcript),
    ))


def _where(ids: list[str], transcript: dict, rng: bool = False) -> str:
    """summary.md 항목 끝의 위치 ` [HH:MM:SS]`(rng면 `[시작–끝]`). 녹음 노트의 사용자 메모 줄은 시각 없이 `메모 n번째 줄`(여러 줄이면 `메모 n–m번째 줄`).
    시각이 없는 메모 노트와 모르는 ID만 있는 항목은 빈 문자열."""
    if is_memo(transcript):
        return ""
    seg = {x["id"]: x for x in transcript["segments"] if x["id"] in ids}
    parts = []
    if seg:
        lo, hi = _hms(min(x["start"] for x in seg.values())), _hms(max(x["end"] for x in seg.values()))
        parts.append(f"{lo}–{hi}" if rng else lo)
    lines = sorted(m["line"] for m in memo_lines(transcript) if m["id"] in ids)
    if lines:
        parts.append(t("메모 {n}번째 줄", n=lines[0]) if lines[0] == lines[-1] else t("메모 {a}–{b}번째 줄", a=lines[0], b=lines[-1]))  # summary.md는 만들 때의 화면 언어
    return f" [{', '.join(parts)}]" if parts else ""


def render_summary_md(s: MeetingSummary, transcript: dict, provider: str, model: str, generated_at: str) -> str:
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
        "## " + t("주제"),
        "",
    ]
    for topic in s.topics:
        out += [f"### {topic.title}{_where(topic.segment_ids, transcript, rng=True)}", ""]
    out += ["## " + t("결정 사항"), ""] + ([f"- {d.text}{_where(d.segment_ids, transcript)}" for d in s.decisions] or ["- " + t("없음")])
    out += ["", "## " + t("할 일"), ""]
    for a in s.action_items:
        who = ", ".join(x for x in (a.owner, a.due) if x)
        out.append(f"- [ ] {a.task}{' — ' + who if who else ''}{_where(a.segment_ids, transcript)}")
    if not s.action_items:
        out.append("- " + t("없음"))
    return "\n".join(out) + "\n"


def write_summary(meeting_dir: Path, s: MeetingSummary, transcript: dict, provider: str, model: str) -> None:
    """저장 경로는 이것 하나라 MCP save_summary(에이전트 작성)도 여기서 owner 정리를 거친다."""
    s = clean_owners(s, transcript)
    generated_at = datetime.now().astimezone().isoformat(timespec="seconds")
    data = {"schema_version": SCHEMA_VERSION, "meeting_id": transcript["meeting_id"], "provider": provider,
            "model": model, "generated_at": generated_at, **s.model_dump()}
    _write_atomic(meeting_dir / "summary.md", render_summary_md(s, transcript, provider, model, generated_at))
    _write_atomic(meeting_dir / "summary.json", json.dumps(data, ensure_ascii=False, indent=1))
