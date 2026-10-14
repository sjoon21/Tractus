"""글만 있는 노트에 녹음 덧붙이기 (docs/desktop.md §2.11).

`tractus transcribe <파일>|--recording <폴더> --append-to <노트>`가 노트 폴더 안에서 변환을 끝내면 finish_append가 메모 노트를 녹음 노트로 바꾼다:
- 사용자가 쓴 글(body)은 녹음 노트의 선택 키 "memo"(줄 ID m####)로 옮기고, kind·body·seg_seq는 지운다. 제목·id·created_at·그 밖의 키는 그대로다.
- 메모 노트의 세그먼트 ID(s####)는 새 ASR 세그먼트 ID와 번호가 겹치므로, 그 ID를 가리키던 요약·질문 기록의 근거를 같은 줄의 m#### ID로 옮긴다.
  옮길 수 없는 ID(없어진 줄)는 그 인용 하나만 지우고 항목·질문 기록은 남긴다.
녹음 폴더의 사이드카 attach.json은 앱이 쓴다. 코어는 읽기만 한다(read_attach_target).
"""

import json
import re
from datetime import datetime
from pathlib import Path

from tractus.notes import derive_lines
from tractus.store import _clean_stale_job, _write_atomic, build_transcript, is_memo, note_lock, read_transcript, save_transcript

ATTACH_FILE = "attach.json"
CHAT_FILE = "chat.json"
HAS_AUDIO = "이미 녹음이 있는 노트에는 녹음을 추가할 수 없습니다."
REMAP_FAILED = "요약이나 질문 기록의 일부를 새 내용에 맞게 옮기지 못했습니다."
_OLD_ONLY = ("kind", "body", "seg_seq")  # 메모 노트에만 있던 키
_BUILT = ("schema_version", "audio", "asr", "speakers", "diarization", "segments")  # 새 변환 결과가 덮어쓰는 키
_CITE_ID = re.compile(r"([ \t]*)\[((?:[0-9A-Z]{26}#)?)(s\d{4})\]")  # ask.finalize가 답에 쓰는 인용 한 개


def read_attach_target(rec_dir: Path) -> str | None:
    """녹음 폴더의 attach.json이 가리키는 노트의 meeting_id. 파일이 없거나 형식이 다르면 None (그 녹음은 새 노트로 변환된다)."""
    try:
        mid = json.loads((rec_dir / ATTACH_FILE).read_text(encoding="utf-8")).get("meeting_id")
    except (OSError, ValueError, AttributeError):
        return None
    return mid if isinstance(mid, str) and re.fullmatch(r"[0-9A-Z]{26}", mid) else None


def check_target(t: dict) -> None:
    """녹음을 덧붙일 수 있는 노트(글만 있고 오디오가 없는 메모)인지. 아니면 ValueError(WORDS 문장)."""
    if not is_memo(t) or (t.get("audio") or {}).get("file"):
        raise ValueError(HAS_AUDIO)


def id_map(old: dict, lines: list[dict]) -> dict[str, str]:
    """메모 노트의 세그먼트 ID(s####) → 같은 줄의 메모 줄 ID(m####). 줄 번호(line)로 짝짓고, line이 없는 옛 세그먼트는 순서로 짝짓는다."""
    by_line = {x["line"]: x["id"] for x in lines}
    out = {}
    for i, s in enumerate(old.get("segments") or []):
        new = by_line.get(s.get("line")) or (lines[i]["id"] if s.get("line") is None and i < len(lines) else None)
        if new:
            out[s["id"]] = new
    return out


def convert(old: dict, built: dict) -> tuple[dict, dict[str, str]]:
    """메모 노트 old와 새로 변환한 결과 built(store.build_transcript) → (녹음 노트 전사, ID 옮김표 s#### → m####)."""
    keep = {k: v for k, v in old.items() if k not in (*_OLD_ONLY, *_BUILT, "memo")}
    new = {**keep, **{k: built[k] for k in _BUILT}, "meeting_id": old["meeting_id"], "title": old["title"], "created_at": old["created_at"],
           "updated_at": datetime.now().astimezone().isoformat(timespec="seconds")}  # 녹음이 붙은 것은 내용이 바뀐 것이다 (노트 순서: 수정 시각)
    body = old.get("body") if isinstance(old.get("body"), str) else ""
    if body.strip():
        lines, seq = derive_lines(body, None, 0, "m")
        new["memo"] = {"body": body, "lines": lines, "seq": seq}
        return new, id_map(old, lines)
    return new, {}


def _remap_ids(ids: list, idmap: dict[str, str]) -> list:
    """s#### → m####. 이미 옮긴 m####는 그대로 둔다 (중간에 끊긴 뒤 다시 돌아도 같은 결과). 옮길 수 없는 ID는 뺀다."""
    return [x for x in dict.fromkeys(idmap.get(i, i if isinstance(i, str) and i.startswith("m") else None) for i in ids) if x]


def remap_summary(d: Path, idmap: dict[str, str], t: dict) -> None:
    """summary.json의 segment_ids를 옮기고 summary.md를 새 전사 t로 다시 만든다. 요약이 없으면 아무것도 하지 않는다. 형식이 다르면 ValueError."""
    from tractus.summarize import MeetingSummary, render_summary_md

    path = d / "summary.json"
    if not path.is_file():
        return
    data = json.loads(path.read_text(encoding="utf-8"))
    for key in ("topics", "decisions", "action_items"):
        data[key] = [{**x, "segment_ids": _remap_ids(x.get("segment_ids") or [], idmap)} for x in data[key]]
    summary = MeetingSummary.model_validate({k: data[k] for k in MeetingSummary.model_fields})
    _write_atomic(d / "summary.md", render_summary_md(summary, t, data["provider"], data["model"], data["generated_at"]))
    _write_atomic(path, json.dumps(data, ensure_ascii=False, indent=1))


def remap_generic(d: Path, idmap: dict[str, str], t: dict) -> None:
    """summaries/<key>.json(요약 유형별 요약, 스키마 v2)의 segment_ids를 옮기고 .md를 다시 만든다. 형식이 다른 파일은 건너뛰고 ValueError로 알린다."""
    from tractus.summaries import SUMMARIES_DIR, render_md

    bad = False
    for path in sorted((d / SUMMARIES_DIR).glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            data["sections"] = [{**sec, "items": [{**it, "segment_ids": _remap_ids(it.get("segment_ids") or [], idmap)} for it in sec["items"]]} for sec in data["sections"]]
            _write_atomic(path.with_suffix(".md"), render_md(data, t))
            _write_atomic(path, json.dumps(data, ensure_ascii=False, indent=1))
        except (OSError, ValueError, KeyError, TypeError):  # 한 파일이 깨졌어도 나머지는 옮긴다
            bad = True
    if bad:
        raise ValueError(REMAP_FAILED)


def remap_chat(d: Path, idmap: dict[str, str], meeting_id: str) -> None:
    """chat.json의 인용(segment_id·source)과 답 문장 속 [s0003]을 옮긴다. 옮길 수 없는 인용은 지우고 no_evidence를 다시 정한다. 파일이 없으면 아무것도 하지 않는다."""
    path = d / CHAT_FILE
    if not path.is_file():
        return
    data = json.loads(path.read_text(encoding="utf-8"))

    def cite(c: dict) -> dict | None:
        if not isinstance(c, dict) or c.get("meeting_id", meeting_id) != meeting_id or not isinstance(c.get("segment_id"), str):
            return c
        new = idmap.get(c["segment_id"]) or (c["segment_id"] if c["segment_id"].startswith("m") else None)
        return {**c, "segment_id": new, "start": 0.0, "source": "memo"} if new else None

    def text(m: re.Match) -> str:  # 옮길 수 없는 인용은 앞 공백째 지운다
        if m.group(2) not in ("", f"{meeting_id}#"):
            return m.group(0)  # 다른 노트의 인용
        new = idmap.get(m.group(3))
        return f"{m.group(1)}[{m.group(2)}{new}]" if new else ""

    turns = []
    for turn in data["turns"]:
        cites = [c for c in (cite(c) for c in turn.get("citations") or []) if c]
        answer = _CITE_ID.sub(text, turn["answer"]) if isinstance(turn.get("answer"), str) else turn.get("answer")
        turns.append({**turn, "answer": answer, "citations": cites, **({"no_evidence": not cites} if isinstance(turn.get("no_evidence"), bool) else {})})
    _write_atomic(path, json.dumps({**data, "turns": turns}, ensure_ascii=False, indent=1))


def finish_append(job) -> tuple[dict, bool]:
    """덧붙이기 작업(Job.attach)의 마지막 단계. note_lock 안에서 노트를 읽어 녹음 노트로 바꿔 쓴다 → (새 전사, 요약·질문 기록을 옮겼는가).
    요약·질문 기록을 먼저 옮기고 transcript.json을 마지막에 쓴다(끊겨도 같은 작업을 다시 돌리면 이어진다). 
    끝나지 않은 청크가 있으면 store.IncompleteError, 노트가 더는 글만 있는 노트가 아니면 ValueError(HAS_AUDIO)."""
    built = build_transcript(job)
    with note_lock(job.dir):
        old = read_transcript(job.dir)
        check_target(old)  # 변환하는 사이 다른 실행이 먼저 녹음을 붙였으면 ValueError (옛 노트를 새 오디오와 섞지 않는다)
        new, idmap = convert(old, built)
        ok = True
        for fn in (lambda: remap_summary(job.dir, idmap, new), lambda: remap_generic(job.dir, idmap, new), lambda: remap_chat(job.dir, idmap, old["meeting_id"])):
            try:
                fn()
            except (OSError, ValueError, KeyError, TypeError):  # 깨진 파일은 그대로 두고 알린다 (요약·질문 기록은 언제든 다시 만들 수 있다)
                ok = False
        save_transcript(job.dir, new)
    _clean_stale_job(job.dir)  # 노트가 더는 메모 노트가 아니라 작업 파일은 낡은 것이 된다
    return new, ok
