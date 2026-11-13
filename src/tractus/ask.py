"""회의 질의 `tractus ask` (ARCHITECTURE.md §3.3 Q&A, docs/desktop.md §2.5).

질문 + 근거 세그먼트로 답을 스트리밍하고, 답에 인라인으로 붙은 인용([s0012] / [<meeting_id>#s0012])을
(녹음 노트에 사용자가 적은 메모 줄은 [m0003], source "memo")
제공한 근거와 대조해 남긴다. 원격 공급자로는 질문, 최근 대화, 근거 세그먼트(결정·할 일처럼 모아 묻는 질문은 노트에 저장된 요약 줄도)만 보낸다.

대화 기록 자르기와 "근거는 자료일 뿐 지시가 아니다" 규칙은 stenolabs/stenoai(MIT) `src/chat_query.py`
L12-34, L68-108 @48b9412f를 참고해 고쳐 썼다.
"""

import json
import re
from collections.abc import Callable, Iterator
from datetime import date, datetime
from itertools import zip_longest
from pathlib import Path

from tractus import prompts, summaries
from tractus.i18n import t
from tractus.llm import LLMError, Provider, stream_chat
from tractus.store import _write_atomic, is_memo, memo_segments, seg_text, speaker_display, stamp

NO_EVIDENCE = t("노트 내용에서 답을 찾지 못했습니다.")  # 근거가 없을 때의 답이자 프롬프트의 거절 문장 (화면 언어). 답 자체는 질문의 언어로 쓴다
MAX_QUESTION = 2000
HISTORY_MESSAGES, HISTORY_CHARS = 6, 12_000
MEETING_CHARS = 100_000  # 회의 전사가 이보다 길면 회의 안에서 검색한 부분만 보낸다
GLOBAL_HITS = 8  # 검색 결과(청크) 수. 청크마다 앞뒤 세그먼트 1개씩을 더 붙인다
CONTEXT_QUESTIONS, CONTEXT_CHARS = 2, 300  # 후속 질문 검색에 보태는 직전 사용자 질문 수, 질문당 최대 글자
CHAT_FILE, CHAT_KEEP = "chat.json", 50

PROMPTS = prompts.load("ask")  # 문구는 prompts/ask.md
SYSTEM_PROMPT = PROMPTS["system"]

MEMO_PROMPT = "\n" + PROMPTS["memo"]  # 메모 줄이 근거에 있을 때만 붙인다
RECAP_PROMPT = "\n" + PROMPTS["recap"]  # 요약 줄이 근거에 있을 때만 붙인다

# 모아 묻는 질문(결정·할 일·요약)은 노트마다 저장된 요약으로 답한다. 규칙은 Yogurt(MIT) app/src/main/library/kind.ts를 한국어로 옮겨 넓혔다
RECAP_NOTES, RECAP_UNDATED, RECAP_LINES = 12, 8, 40  # 기간이 있을 때·없을 때 노트 수, 노트당 요약 줄
_GATHER = re.compile(r"결정\s*(?:사항|된|한|했|내용)|합의\s*(?:사항|된|한|했)|정한\s*(?:것|거|내용|사항)|할\s*일(?!정|부|단)|해야\s*할\s*(?:것|거)|액션\s*아이템|후속\s*(?:조치|작업)|다음\s*단계"
                     r"|\b(?:action items?|to-?dos?|tasks|next steps|follow[- ]?ups?|decisions?|takeaways?)\b", re.I)  # i18n-ok: 질문 판별
_ALL = re.compile(r"모든|전체|전부|각\s*(?:노트|회의)|(?:노트|회의)(?:들|마다)|\b(?:all|every|each|across|any|meetings|notes)\b", re.I)  # i18n-ok: 질문 판별
_MINE = re.compile(r"(?:내|제|우리)가?\s*(?:해야\s*)?할\s*(?:일|것|거)|\b(?:my|our)\s+(?:open\s+)?(?:action items?|to-?dos?|tasks|next steps|follow[- ]?ups?)\b", re.I)  # i18n-ok: 질문 판별
_DECIDED = re.compile(r"(?:뭘|뭐|무엇을?|무얼)\s*(?:결정|정했|합의)|\bwhat\s+(?:did|have|has)\s+(?:we|they|i|the team)\s+(?:decide|decided|agree|agreed)\b", re.I)  # i18n-ok: 질문 판별
_RECAP = re.compile(r"요약|정리|돌아보|무슨\s*일|무슨\s*얘기|어떤\s*얘기|뭘\s*했|뭐\s*했|\b(?:summari[sz]e|sum up|recap|overview|catch me up|what happened)\b", re.I)  # i18n-ok: 질문 판별
_PERIOD = re.compile(r"(?:지난|이번|저번|다음)\s*(?:주|달)|오늘|어제|최근|\d{1,2}\s*월|\d\s*분기|올해|작년"
                     r"|\b(?:last|this|past)\s+(?:week|month|quarter|year)\b|\b(?:today|yesterday|recently|lately)\b", re.I)  # i18n-ok: 질문 판별
_LABEL = {"decisions": "결정", "agreed": "결정", "action_items": "할 일", "actions": "할 일"}  # i18n-ok: AI 프롬프트 (요약 파일의 칸 → 줄 앞 이름)

# 몰린 인용: 노트가 4개 이상일 때 한 자리에서 절반 넘는 노트를 함께 인용하면 근거가 아니라 받은 것을 다 붙인 것으로 보고 지운다.
# 한 자리에서 같은 노트의 인용은 3개까지. Yogurt(MIT) app/src/shared/citations.ts tidyCitations를 세그먼트 인용에 맞게 옮겼다
PILE_FROM, PER_NOTE = 4, 3

_ID = r"<?(?:(?:[0-9A-Z]{26}|meeting_id)>?#)?[sm]\d{4}>?"  # meeting_id: 옛 프롬프트 예시의 자리표시자를 베낀 [<meeting_id>#s0012]도 인용으로 보고 정리한다
# 인용 하나: ID, 뒤에 붙은 시각(기록 줄을 베낀 경우). 예시의 <meeting_id> 꺾쇠를 그대로 베낀 [<01K…#s0012>]·[<01K…>#s0012]도 받는다 (solar-pro4 실측)
_ONE = rf"{_ID}(?:\s+\d{{1,2}}:\d{{2}}(?::\d{{2}})?)?"
# 대괄호 대신 괄호로 쓴 (s0012)나 대문자 [S0012]도 인용으로 보고 같은 검증을 거친다 (안 맞는 ID가 답에 남지 않게)
_TOKEN = re.compile(r"(?:([0-9A-Z]{26})>?#)?([sm]\d{4})", re.I)
_CITE = re.compile(rf"[ \t]*[\[(]\s*({_ONE}(?:\s*[,;]?\s*{_ONE})*)\s*[\])]", re.I)
_RUN = re.compile(r"(?:[ \t]*\[(?:[0-9A-Z]{26}#)?[sm]\d{4}\])+")  # 정리한 인용이 나란히 붙은 무리 (_CITE가 바꾼 형태)


# ── 요청 ──────────────────────────────────────────────────────────────


def parse_request(raw: str) -> tuple[str, list[dict]]:
    """stdin: JSON 객체 {"question", "history"?} 또는 (사람이 터미널에서 쓸 때) 질문 평문. 잘못되면 ValueError."""
    raw = raw.strip()
    if raw.startswith("{"):
        req = json.loads(raw)  # JSONDecodeError는 ValueError
        question, history = req.get("question"), req.get("history")
    else:
        question, history = raw, None
    if not isinstance(question, str) or not question.strip():
        raise ValueError(t("질문을 입력하세요."))
    if len(question) > MAX_QUESTION:
        raise ValueError(t("질문이 너무 깁니다 ({n}자, 최대 {max}자)", n=len(question), max=MAX_QUESTION))
    return question.strip(), trim_history(history)


def trim_history(history) -> list[dict]:
    """최근 메시지 6개까지, 합쳐서 12k자 안에서 최신 것부터 남긴다."""
    if history is None:
        return []
    if not isinstance(history, list) or not all(
        isinstance(t, dict) and t.get("role") in ("user", "assistant") and isinstance(t.get("content"), str) for t in history
    ):
        raise ValueError(t('history는 [{"role": "user"|"assistant", "content": "…"}] 형식이어야 합니다'))
    out, budget = [], HISTORY_CHARS
    for m in reversed(history[-HISTORY_MESSAGES:]):
        if len(m["content"]) > budget:
            break
        out.insert(0, {"role": m["role"], "content": m["content"]})
        budget -= len(m["content"])
    return out


# ── 근거 ──────────────────────────────────────────────────────────────


def _head(t: dict) -> dict:
    return {"meeting_id": t["meeting_id"], "title": str(t.get("title") or ""), "date": str(t.get("created_at") or "")[:10]}


def transcript_sources(t: dict, segments: list[dict] | None = None) -> list[dict]:
    """세그먼트를 근거 형식으로. 표시 텍스트(seg_text)와 화자 표시 이름을 쓴다. 빈 세그먼트는 뺀다.
    메모 노트의 근거는 start가 0이고 줄 번호 line(1부터)이 붙는다. segments를 주지 않으면(전체) 녹음 노트의 사용자 메모 줄이
    맨 뒤에 붙는다: segment_id m0001…, source "memo", line, start 0 (ASR 세그먼트와 같은 형식의 별도 블록)."""
    head = _head(t)
    out = [
        {**head, "segment_id": s["id"], "speaker": speaker_display(t, s.get("speaker")), "start": float(s["start"]), "text": seg_text(s),
         **({"line": s["line"]} if is_memo(t) and s.get("line") else {})}  # 메모: 시각이 없어 줄 번호
        for s in (t["segments"] if segments is None else segments) if seg_text(s).strip()
    ]
    return out + (memo_sources(t) if segments is None else [])


def memo_sources(t: dict, lines: list[dict] | None = None) -> list[dict]:
    """녹음 노트의 사용자 메모 줄(lines를 주면 그 중 일부)을 근거 형식으로."""
    head = _head(t)
    return [{**head, "segment_id": m["id"], "speaker": None, "start": 0.0, "text": m["text"], "line": m["line"], "source": "memo"} for m in (memo_segments(t) if lines is None else lines)]


def _hits(idx, question: str, history: list[dict], **filters) -> list:
    """검색 결과 청크. 후속 질문("그럼 그건 언제까지야?")은 질문만으로는 찾을 것이 없다. 그래서 단독 질문에 모든 단어가 들어 있는
    청크(keyword 일치)가 없으면, 직전 사용자 질문 최대 2개를 앞에 붙인 질의의 결과를 단독 질문 결과와 번갈아 섞는다
    (단독 질문 결과가 매번 먼저라 현재 질문이 우선이고, 겹치면 한 번만 넣는다). 단독 질문이 스스로 근거를 찾으면 기록을 쓰지 않는다.
    LLM 호출 없음. 검색은 이 Mac에서만 일어난다."""
    own = idx.search(question, limit=GLOBAL_HITS, **filters).hits
    prev = [t["content"][:CONTEXT_CHARS] for t in history if t["role"] == "user"][-CONTEXT_QUESTIONS:]
    if not prev or any("keyword" in h.matched for h in own):
        return own
    ctx = idx.search(" ".join([*prev, question]), limit=GLOBAL_HITS, **filters).hits
    out: dict[tuple, object] = {}
    for h in (h for pair in zip_longest(own, ctx) for h in pair if h):
        out.setdefault((h.meeting_id, tuple(h.segment_ids)), h)
    return list(out.values())[:GLOBAL_HITS]


def _with_neighbours(segs: list[dict], ids: set[str]) -> list[int]:
    pos = [i for i, s in enumerate(segs) if s["id"] in ids]
    return sorted({j for i in pos for j in (i - 1, i, i + 1) if 0 <= j < len(segs)})


def search_sources(idx, question: str, history: list[dict] | None = None, *, date_from: str | None = None, date_to: str | None = None,
                   meeting_id: str | None = None) -> list[dict]:
    """하이브리드 검색 상위 8개 청크의 세그먼트 + 앞뒤 이웃 1개씩. 회의는 첫 등장 순, 회의 안은 시간 순.
    history가 있으면 후속 질문 검색에 직전 질문을 보탠다(_hits)."""
    wanted: dict[str, set[str]] = {}
    for h in _hits(idx, question, history or [], date_from=date_from, date_to=date_to, meeting_id=meeting_id):
        wanted.setdefault(h.meeting_id, set()).update(h.segment_ids)
    out = []
    for mid, ids in wanted.items():
        d = idx.meeting_dir(mid)
        if d is None:
            continue
        t = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
        segs = [s for s in t["segments"] if seg_text(s).strip()]  # 색인 청크와 같은 기준으로 이웃을 센다
        out += transcript_sources(t, [segs[j] for j in _with_neighbours(segs, ids)])
        memo = memo_segments(t)  # 메모 청크의 줄도 같은 방식으로 앞뒤 1줄씩 (ASR 대화와는 따로)
        out += memo_sources(t, [memo[j] for j in _with_neighbours(memo, ids)])
    return out


def too_long(sources: list[dict]) -> bool:
    return sum(len(s["text"]) + 30 for s in sources) > MEETING_CHARS


def is_recap(question: str, dated: bool = False) -> bool:
    """여러 노트에서 모아 답할 질문인가(결정사항·할 일·기간 요약). dated: --from/--to가 있다. 질문의 기간 표현(지난주·9월)도 기간으로 본다.
    아니면 특정 내용을 찾는 질문이라 검색 청크로 답한다."""
    dated = dated or bool(_PERIOD.search(question))
    if _MINE.search(question) or _DECIDED.search(question):
        return True
    if _GATHER.search(question):
        return dated or bool(_ALL.search(question))
    return bool(_RECAP.search(question)) and (dated or bool(_ALL.search(question)))


def summary_items(d: Path) -> list[dict]:
    """노트에 저장된 요약 전부(summary.json, summaries/*.json: 회의록·완성된 노트·유형별)에서 근거 ID가 있는 줄만 모은다.
    [{"label", "text", "segment_ids"}], 결정·할 일이 먼저, 같은 문장은 한 번, 최대 RECAP_LINES줄."""
    out, seen = [], set()

    def walk(x, label):
        if isinstance(x, list):
            for v in x:
                walk(v, label)
        elif isinstance(x, dict):
            ids, text = x.get("segment_ids"), str(x.get("text") or x.get("task") or x.get("title") or "").strip()
            if isinstance(ids, list) and ids and text and text not in seen:
                seen.add(text)
                extra = ", ".join(str(x[k]) for k in ("owner", "team", "due") if x.get(k))
                out.append({"label": label, "text": f"{text} ({extra})" if extra else text, "segment_ids": [i for i in ids if isinstance(i, str)]})
            for k, v in x.items():
                walk(v, _LABEL.get(k) or (x.get("heading") if k == "items" else label))

    for s in summaries.list_summaries(d):
        walk(summaries.read_data(d, s["key"]), None)
    return sorted(out, key=lambda i: i["label"] not in _LABEL.values())[:RECAP_LINES]


def recap_sources(idx, question: str, history: list[dict] | None = None, *, date_from: str | None = None, date_to: str | None = None) -> list[dict]:
    """모아 묻는 질문의 근거: 노트마다 저장된 요약 줄(source "summary", segment_ids) + 그 줄이 가리키는 대화·메모 줄(인용 대조용).
    기간이 있으면 그 기간의 노트를 최근 것부터 12개, 없으면 검색에 걸린 노트 → 최근 노트 순으로 8개.
    요약이 없거나 요약의 근거 ID가 지금 대화에 없는 노트는 검색 결과(search_sources)를 그대로 쓴다. 요약 있는 노트가 하나도 없으면 검색 결과만."""
    hits = search_sources(idx, question, history, date_from=date_from, date_to=date_to)
    if date_from or date_to:
        mids = idx.meeting_ids(date_from, date_to)[:RECAP_NOTES]
    else:
        mids = list(dict.fromkeys([s["meeting_id"] for s in hits] + idx.meeting_ids()))[:RECAP_UNDATED]
    out, covered = [], set()
    for mid in mids:
        d = idx.meeting_dir(mid)
        if d is None:
            continue
        note = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
        known = {s["id"] for s in note["segments"] if seg_text(s).strip()} | {m["id"] for m in memo_segments(note)}
        lines = [{**i, "segment_ids": ids} for i in summary_items(d) if (ids := [x for x in i["segment_ids"] if x in known])]  # 다시 변환해 사라진 ID는 뺀다
        if not lines:
            continue
        covered.add(mid)
        used = {x for i in lines for x in i["segment_ids"]}
        out += [{**_head(note), "source": "summary", **i} for i in lines]
        out += transcript_sources(note, [s for s in note["segments"] if s["id"] in used])
        out += memo_sources(note, [m for m in memo_segments(note) if m["id"] in used])
    return out + [s for s in hits if s["meeting_id"] not in covered] if covered else hits


def global_sources(idx, question: str, history: list[dict] | None = None, *, date_from: str | None = None, date_to: str | None = None) -> list[dict]:
    """전체 범위 질문의 근거: 모아 묻는 질문(is_recap)은 요약으로, 나머지는 검색으로."""
    if is_recap(question, bool(date_from or date_to)):
        return recap_sources(idx, question, history, date_from=date_from, date_to=date_to)
    return search_sources(idx, question, history, date_from=date_from, date_to=date_to)


def evidence(sources: list[dict]) -> list[dict]:
    """인용할 수 있는 근거 줄(대화·메모). 요약 줄(source "summary")은 프롬프트에만 쓰고 sources 이벤트·인용 대조에는 넣지 않는다."""
    return [s for s in sources if s.get("source") != "summary"]


# ── 프롬프트 ──────────────────────────────────────────────────────────


def _line(s: dict, scope: str) -> str:
    sid = s["segment_id"] if scope == "meeting" else f"{s['meeting_id']}#{s['segment_id']}"
    who = f" {s['speaker']}" if s.get("speaker") else ""
    when = "" if s.get("line") else f" {stamp(s)}"  # 메모에는 시각이 없다: ID만
    return f"[{sid}{when}{who}] {s['text']}"


def _summary_line(s: dict, scope: str) -> str:
    ids = "".join(f"[{x}]" if scope == "meeting" else f"[{s['meeting_id']}#{x}]" for x in s["segment_ids"])
    return f"- {s['label'] + ': ' if s.get('label') else ''}{s['text']} {ids}"


def _examples(sources: list[dict], scope: str) -> tuple[str, str]:
    """프롬프트의 인용 예시. 전체 범위는 <meeting_id> 같은 자리표시자를 쓰면 모델이 그대로 베껴 인용이 전부 버려지므로(a16, 8%)
    실제 기록 줄의 ID로 보여 준다. 예시가 근거 선택을 끌지 않게 첫 줄과 마지막 줄을 쓴다."""
    sources = evidence(sources)
    if scope == "meeting" or not sources:
        return "[s0012]", "[s0012][s0015]"
    one, two = (f"[{s['meeting_id']}#{s['segment_id']}]" for s in (sources[0], sources[-1]))
    return one, one + two


def build_messages(question: str, history: list[dict], sources: list[dict], scope: str, today: str | None = None) -> list[dict]:
    """system 하나 + 최근 대화 + (회의 기록 + 질문). scope: meeting(전사 한 개, [s0012]) | global(여러 회의, [<meeting_id>#s0012])."""
    ex, ex2 = _examples(sources, scope)
    system = SYSTEM_PROMPT.format(example=ex, example2=ex2, no_evidence=NO_EVIDENCE, today=today or date.today().isoformat())
    if any(s.get("source") == "memo" for s in sources):
        system += MEMO_PROMPT  # 메모가 없는 노트의 프롬프트는 그대로다
    if any(s.get("source") == "summary" for s in sources):
        system += RECAP_PROMPT  # 요약 줄이 없는 질문의 프롬프트는 그대로다
    blocks, by_meeting = [], {}
    for s in sources:
        by_meeting.setdefault(s["meeting_id"], []).append(s)
    for rows in by_meeting.values():
        head = rows[0]
        blocks.append(f"\n## {head['title']} ({head['date']})" if scope == "global" else f"회의: {head['title']} ({head['date']})")  # i18n-ok: AI 프롬프트
        summ, memo, talk = ([s for s in rows if s.get("source") == k] for k in ("summary", "memo", None))
        if summ:  # 저장된 요약: 줄마다 끝에 그 줄의 근거 ID. 근거 줄 자체는 아래 블록에 있다
            blocks += ["[노트 요약]", *(_summary_line(s, scope) for s in summ)]  # i18n-ok: AI 프롬프트
            blocks += [""] if memo else ["", "[대화 기록]"] if talk else []  # i18n-ok: AI 프롬프트
        if memo:  # 사용자가 직접 쓴 글은 대화 기록 앞에 따로 라벨을 붙인다 (뒤에 두면 solar-pro4가 20회 중 5회 메모를 못 보고 거절했다, 2026-10-13)
            blocks += ["[내가 적은 메모]", *(_line(s, scope) for s in memo)]  # i18n-ok: AI 프롬프트
            blocks += ["", "[대화 기록]"] if talk else []  # i18n-ok: AI 프롬프트
        blocks += [_line(s, scope) for s in talk]
    user = "[회의 기록]\n" + "\n".join(blocks).strip() + f"\n\n[질문]\n{question}"  # i18n-ok: AI 프롬프트
    return [{"role": "system", "content": system}, *history, {"role": "user", "content": user}]


# ── 인용 ──────────────────────────────────────────────────────────────


def finalize(answer: str, sources: list[dict], scope: str) -> tuple[str, list[dict]]:
    """답의 인용을 근거와 대조한다. 근거에 있는 것만 [s0012] / [<meeting_id>#s0012] 형태로 하나씩 다시 쓰고,
    없는 ID는 지운다. 전체 범위에서 회의 ID 없는 [s0012]는 그 세그먼트 ID가 근거 중 한 회의에만 있을 때만 살린다.
    citations = 답에 남은 인용 (처음 나온 순서, 중복 제거). 메모 줄의 인용에는 줄 번호 line이 붙는다 (start는 0).
    녹음 노트의 사용자 메모 줄(m0003)은 source "memo"도 붙는다."""
    start = {(s["meeting_id"], s["segment_id"]): s for s in evidence(sources)}
    by_seg: dict[str, list[str]] = {}
    for mid, sid in start:
        by_seg.setdefault(sid, []).append(mid)
    notes = len({mid for mid, _ in start})
    cited: dict[tuple[str, str], dict] = {}

    def resolve(mid: str, sid: str) -> tuple[str, str] | None:
        if mid:
            return (mid, sid) if (mid, sid) in start else None
        mids = by_seg.get(sid, [])
        return (mids[0], sid) if len(mids) == 1 else None

    def repl(m: re.Match) -> str:
        keys = list(dict.fromkeys(k for mid, sid in _TOKEN.findall(m.group(1)) if (k := resolve(mid.upper(), sid.lower()))))
        lead = m.group(0)[: len(m.group(0)) - len(m.group(0).lstrip(" \t"))]
        return lead + "".join(f"[{sid}]" if scope == "meeting" else f"[{mid}#{sid}]" for mid, sid in keys) if keys else ""

    def tidy(m: re.Match) -> str:
        """나란히 붙은 인용 한 무리: 중복을 빼고, 노트마다 PER_NOTE개까지, 몰린 인용(PILE_FROM)은 통째로 지운다."""
        keys, per = [], {}
        for k in dict.fromkeys(resolve(mid, sid) for mid, sid in _TOKEN.findall(m.group(0))):
            if k and per.get(k[0], 0) < PER_NOTE:
                per[k[0]] = per.get(k[0], 0) + 1
                keys.append(k)
        if not keys or (scope != "meeting" and notes >= PILE_FROM and len(per) > notes / 2):
            return ""
        for k in keys:
            cited.setdefault(k, start[k])
        lead = m.group(0)[: len(m.group(0)) - len(m.group(0).lstrip(" \t"))]
        return lead + "".join(f"[{sid}]" if scope == "meeting" else f"[{mid}#{sid}]" for mid, sid in keys)

    text = _RUN.sub(tidy, _CITE.sub(repl, answer)).strip()
    return text, [{"meeting_id": mid, "segment_id": sid, "start": s["start"], **({"line": s["line"]} if s.get("line") else {}), **({"source": "memo"} if s.get("source") == "memo" else {})} for (mid, sid), s in cited.items()]


# ── 흐름 ──────────────────────────────────────────────────────────────


def turn_no_evidence(turn: dict) -> bool:
    """저장된 질문·답 한 쌍(chat.json의 turn)이 근거 없는 답인가. 판단은 답 문장이 아니라 인용으로 한다:
    문장은 코어 버전(옛 "회의 기록에서 근거를 찾지 못했습니다")과 질문 언어에 따라 달라진다.
    no_evidence 키가 없는 옛 기록은 citations가 비었는지로 본다."""
    flag = turn.get("no_evidence")
    return flag if isinstance(flag, bool) else not turn.get("citations")


def _done(answer: str, citations: list[dict], provider: str | None, model: str | None) -> dict:
    """no_evidence: 답에 근거 인용이 하나도 남지 않았다 (거절 답이거나, 모델이 인용을 빠뜨렸거나, 인용이 모두 근거와 맞지 않았다).
    앱의 '근거 대화 없음' 배지는 이 값으로 정한다 (옛 기록은 turn_no_evidence)."""
    return {"event": "done", "answer": answer, "citations": citations, "provider": provider, "model": model, "no_evidence": not citations}


def ask(client, provider: str, model: str, question: str, history: list[dict], scope: str,
        get_sources: Callable[[], list[dict]], policy: Provider | None = None) -> Iterator[dict]:
    """진행 이벤트: stage(retrieve) → sources → stage(answer) → delta* → done. 근거가 없으면 LLM을 부르지 않는다.
    delta는 정리 전 원문 조각이다. 앱은 done의 answer(인용 정리본)로 바꿔 표시한다.
    근거가 없어 아무것도 보내지 않은 done은 provider·model이 null이다 (앱의 전송 안내가 거짓이 되지 않게).
    policy: 실제 공급자 설정 (온도 정책·오류 문장의 호스트). 없으면 기본값(온도 0.2)."""
    yield {"event": "stage", "stage": "retrieve"}
    sources = get_sources()
    yield {"event": "sources", "sources": evidence(sources)}  # 요약 줄은 프롬프트에만
    if not sources:
        yield _done(NO_EVIDENCE, [], None, None)
        return
    yield {"event": "stage", "stage": "answer"}
    parts = []
    for text in stream_chat(client, policy or Provider(provider, "", None, None, False), model, build_messages(question, history, sources, scope)):
        parts.append(text)
        yield {"event": "delta", "text": text}
    if not "".join(parts).strip():
        raise LLMError(t("AI가 빈 답변을 보냈습니다. 다시 질문해 주세요."), code="llm_invalid")
    answer, citations = finalize("".join(parts), sources, scope)
    yield _done(answer, citations, provider, model)


def save_chat(d: Path, meeting_id: str, turn: dict) -> None:
    """<회의>/chat.json에 질문·답 한 쌍을 덧붙인다. 최근 50개만 남기고 원자적으로 쓴다.
    파일이 없으면 새로 만들고, 깨졌거나 다른 형식(schema_version ≠ 1)이면 기록을 잃지 않게 덮어쓰지 않고 ValueError."""
    path = d / CHAT_FILE
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        data = {"schema_version": 1, "turns": []}
    except ValueError:
        data = None
    if not (isinstance(data, dict) and data.get("schema_version") == 1 and isinstance(data.get("turns"), list)):
        raise ValueError(t("{path}을(를) 읽을 수 없거나 형식이 달라 덮어쓰지 않았습니다", path=path))
    # ponytail: 잠금 없음. 같은 회의에 --save 두 개가 겹치면 나중 쓰기가 앞 질문을 덮는다. 앱은 회의마다 한 번에 하나만 묻는다
    turn = {**turn, "created_at": datetime.now().astimezone().isoformat(timespec="seconds")}
    data = {"schema_version": 1, "meeting_id": meeting_id, "turns": [*data["turns"], turn][-CHAT_KEEP:]}
    _write_atomic(path, json.dumps(data, ensure_ascii=False, indent=1))
