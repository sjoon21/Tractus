"""대화 내용 다듬기 제안 (docs/design/transcript-polish.md): AI가 대화 내용 전체를 보고, 잘못 들은 말이 있는 문장만 고친 문장을 제안한다.

- 문장(세그먼트) 단위다. 합치거나 나누지 않고, 고친 문장 전체를 받는다. 고친 글자 수 상한은 두지 않는다(소유자 결정).
- 문맥: 고칠 범위(WINDOW_CHARS)마다 앞뒤 CONTEXT_SEGMENTS문장을 고치지 않는 문맥으로 붙인다. 대화 전체를 한 번에 맡기면 고칠 곳을 다 훑지 못한다.
- 정답 후보로 참석자 이름·자주 쓰는 단어(변환 때 쓴 것 + 지금 목록)·노트 제목·내 메모를 함께 준다 (minutes.build_input과 같은 블록).
- 사용자가 직접 고친 문장(corrected_text)은 고치지 않는다: 사람이 정한 것이 이긴다.
- 문장부호·띄어쓰기만 다른 제안, 원문보다 크게 짧아진 제안(SHORTEN_MIN), 문장 앞·뒤에 낱말을 더하거나 뺀 제안(moves_edge: 경계 옮기기)은 버린다. 원문에 없던 숫자가 생긴 제안은 `number`, 한 자리에서 낱말 셋 이상을 바꾼 제안은 `rewrite` 표시를 단다(버리지 않는다)
  (가상 회의에서 "옵이천" → "5억 2천"처럼 숫자를 짐작한 제안이 있었다: 정답은 5억 1천).
- 제안은 <노트>/polish.json에만 쓴다. transcript.json은 바꾸지 않는다 (받기는 화면과 함께 정한다).
"""

from __future__ import annotations

import difflib
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import re
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Callable, Literal

from pydantic import Field

from tractus import prompts
from tractus.llm import Provider, complete_json
from tractus.minutes import build_input
from tractus.store import _write_atomic, one_line, seg_text
from tractus.summarize import _Strict

FILE = "polish.json"
SCHEMA_VERSION = 1
# 고칠 범위. 한 번에 2만 자를 맡기면 고칠 곳을 일부만 돌려줘 실행마다 크게 달랐다(실제 노트 5개, 두 번 실행의 겹침 0.10–0.45).
# 5천 자씩이면 제안이 2–3배이고 겹침 0.57–0.68 (docs/design/transcript-polish.md 측정)
WINDOW_CHARS = 5_000
CONTEXT_SEGMENTS = 30  # 범위 앞뒤로 붙이는 문맥 문장 수
PARALLEL = 4  # 창을 동시에 보낸다 (서로 기다릴 필요가 없다)
REWRITE_WORDS = 3  # 한 자리에서 낱말 이만큼 이상을 바꾸면 `rewrite` 표시: 잘못 들은 말을 고쳤다기보다 짐작해 다시 쓴 것일 수 있다 (버리지 않는다)
EDGE_CHARS = 10  # 앞·뒤를 바꾼(replace) 경우는 글자 수 차이로 본다
EDGE_WORDS = 3  # 문장 앞·뒤에 이만큼 이상 낱말을 더하거나 빼면 경계를 옮긴 것이다 (실제 노트: 앞 문장의 말을 끌어와 붙이거나 앞부분을 뺐다)
SHORTEN_MIN = 0.75  # 고친 문장이 원문 글자의 이만큼도 안 되면 버린다: 고친 양이 아니라 "내용을 빼지 않는다" 규칙 위반이다 (가상 회의에서 첫 문장을 통째로 뺀 제안)

PROMPTS = prompts.load("polish")  # 문구는 prompts/polish.md
SYSTEM_PROMPT = PROMPTS["system"]


class Edit(_Strict):
    id: str = Field(description="고칠 문장의 ID (예: s0012)")  # i18n-ok: AI 프롬프트
    text: str = Field(description="고친 문장 전체")  # i18n-ok: AI 프롬프트
    kind: Literal["term", "name", "number", "word"]


class Polish(_Strict):
    edits: list[Edit]


def _bare(s: str) -> str:
    """문장부호·띄어쓰기를 뺀 글자 (이것만 다르면 제안을 버린다)"""
    s = unicodedata.normalize("NFC", s).lower()
    return "".join(c for c in s if not c.isspace() and not unicodedata.category(c).startswith("P"))


def moves_edge(before: str, text: str) -> bool:
    """문장 맨 앞이나 맨 뒤에 낱말을 EDGE_WORDS개 이상 더하거나 뺐으면 True (고친 것이 아니라 경계를 옮긴 것)."""
    a, b = before.split(), text.split()
    ops = difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes()
    if not ops:
        return False
    for tag, i1, i2, j1, j2 in (ops[0], ops[-1]):
        if tag in ("insert", "delete") and max(i2 - i1, j2 - j1) >= EDGE_WORDS:
            return True
        if tag == "replace" and abs(len(_bare(" ".join(a[i1:i2]))) - len(_bare(" ".join(b[j1:j2])))) >= EDGE_CHARS:  # "I. W. S. 다." → "AWS다."는 고친 것
            return True
    return False


def rewrites(before: str, text: str) -> bool:
    a, b = before.split(), text.split()
    return any(tag == "replace" and max(i2 - i1, j2 - j1) >= REWRITE_WORDS for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes())


def windows(segments: list[dict], limit: int = WINDOW_CHARS) -> list[tuple[int, int]]:
    """고칠 범위 [시작, 끝) 목록. 글자 수가 limit을 넘지 않게 앞에서부터 자른다."""
    out, start, size = [], 0, 0
    for i, s in enumerate(segments):
        n = len(seg_text(s)) + 30
        if size + n > limit and i > start:
            out.append((start, i))
            start, size = i, 0
        size += n
    out.append((start, len(segments)))
    return out


def check(p: Polish, editable: set[str]) -> None:
    """범위 밖 ID·같은 ID 두 번·빈 문장이면 ValueError (재요청)."""
    ids = [e.id for e in p.edits]
    bad = sorted(set(ids) - editable)
    if bad:
        raise ValueError(f"고칠 수 있는 문장이 아닌 ID: {bad[:20]}")  # i18n-ok: AI 프롬프트
    if len(ids) != len(set(ids)):
        raise ValueError("같은 ID를 두 번 썼다. 문장마다 하나만 쓴다")  # i18n-ok: AI 프롬프트
    if any(not one_line(e.text) for e in p.edits):
        raise ValueError("빈 문장은 쓸 수 없다")  # i18n-ok: AI 프롬프트


def _input(t: dict, lo: int, hi: int, glossary: list[str]) -> tuple[str, set[str]]:
    segs = t["segments"]
    a, b = max(0, lo - CONTEXT_SEGMENTS), min(len(segs), hi + CONTEXT_SEGMENTS)
    window = {**t, "segments": segs[a:b]}
    editable = {s["id"] for s in segs[lo:hi] if s.get("corrected_text") is None}
    scope = f"고칠 수 있는 문장: {segs[lo]['id']}–{segs[hi - 1]['id']}"  # i18n-ok: AI 프롬프트
    if a < lo or b > hi:
        scope += " (앞뒤 문장은 문맥으로만 본다)"  # i18n-ok: AI 프롬프트
    fixed = [s["id"] for s in segs[lo:hi] if s.get("corrected_text") is not None]
    if fixed:
        scope += f"\n사용자가 이미 고친 문장(고치지 않는다): {', '.join(fixed)}"  # i18n-ok: AI 프롬프트
    return build_input(window, glossary) + "\n\n" + scope, editable


def _clean(t: dict, p: Polish, dropped: dict | None) -> list[dict]:
    by_id = {s["id"]: s for s in t["segments"]}
    out = []
    for e in p.edits:
        s = by_id[e.id]
        before, text = seg_text(s), one_line(e.text)
        why = ("same" if _bare(before) == _bare(text) else "short" if len(_bare(text)) < SHORTEN_MIN * len(_bare(before))
               else "edge" if moves_edge(before, text) else None)
        if why:
            if dropped is not None:
                dropped[why] = dropped.get(why, 0) + 1
            continue
        flags = [f for f, on in (("number", bool(set(re.findall(r"\d+", text)) - set(re.findall(r"\d+", before)))), ("rewrite", rewrites(before, text))) if on]
        out.append({"id": e.id, "start": s["start"], "before": before, "text": text, "kind": e.kind, "flags": flags})
    return out


def suggest(client, provider: Provider, model: str, t: dict, glossary: list[str] = (), dropped: dict | None = None,
            on_window: Callable[[int, int, list[dict], tuple[str, str]], None] | None = None) -> list[dict]:
    """제안 목록 [{id, start, before, text, kind, flags}] (문장 순서). dropped가 있으면 버린 제안을 까닭별로 센다(측정용).
    on_window(끝난 창 수, 창 수, 그 창의 제안, (범위 첫 ID, 끝 ID))는 창이 끝날 때마다 부른다 (앱이 끝난 구간부터 빛을 끄고 제안을 보인다)."""
    segs = t["segments"]
    jobs = [(job, (segs[lo]["id"], segs[hi - 1]["id"])) for lo, hi in windows(segs, WINDOW_CHARS) if (job := _input(t, lo, hi, list(glossary)))[1]]

    def ask(job: tuple[str, set[str]]) -> Polish:
        user, editable = job
        return complete_json(client, provider, model, SYSTEM_PROMPT, user, Polish, validate=lambda x: check(x, editable))

    out: list[dict] = []
    with ThreadPoolExecutor(max_workers=PARALLEL) as pool:
        futures = {pool.submit(ask, j): span for j, span in jobs}
        for done, f in enumerate(as_completed(futures), 1):
            got = _clean(t, f.result(), dropped)
            out += got
            if on_window:
                on_window(done, len(jobs), got, futures[f])
    order = {s["id"]: i for i, s in enumerate(t["segments"])}
    return sorted(out, key=lambda x: order[x["id"]])


def write(d: Path, t: dict, suggestions: list[dict], provider: str, model: str) -> Path:
    data = {"schema_version": SCHEMA_VERSION, "meeting_id": t["meeting_id"], "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "provider": provider, "model": model, "prompt_hash": hashlib.sha256(SYSTEM_PROMPT.encode()).hexdigest()[:12], "suggestions": suggestions}
    path = d / FILE
    _write_atomic(path, json.dumps(data, ensure_ascii=False, indent=1))
    return path


def pending(d: Path, t: dict) -> list[dict]:
    """아직 정하지 않은 제안 중 지금도 맞는 것: 문장이 있고, 제안을 만든 뒤 아무도 고치지 않았다(before == 지금 문장). 파일이 없거나 깨졌으면 빈 목록."""
    try:
        data = json.loads((d / FILE).read_text(encoding="utf-8"))
        items = data["suggestions"] if data.get("meeting_id") == t["meeting_id"] else []
    except (OSError, ValueError, KeyError, TypeError):
        return []
    now = {s["id"]: seg_text(s) for s in t["segments"]}
    return [x for x in items if isinstance(x, dict) and now.get(x.get("id")) == x.get("before") and isinstance(x.get("text"), str)]


def resolve(d: Path, t: dict, ids: set[str]) -> int:
    """받았거나 버린 제안(ids)과 더는 맞지 않는 제안을 polish.json에서 뺀다. 남은 수를 돌려준다. 하나도 안 남으면 파일을 지운다."""
    left = [x for x in pending(d, t) if x["id"] not in ids]
    path = d / FILE
    if not left:
        path.unlink(missing_ok=True)
        return 0
    data = json.loads(path.read_text(encoding="utf-8"))
    _write_atomic(path, json.dumps({**data, "suggestions": left}, ensure_ascii=False, indent=1))
    return len(left)
