"""LOCAL-ONLY query generation for AI Hub meeting sessions. No LLM, no network. stdlib only.

!!! Output contains AI Hub text (restricted licence). Write it outside any repo / shared dir, never pass it to
!!! Claude Code / Codex / agy / any remote API, and never print it. This script prints counts only.

  python aihub_queries.py LABEL_DIR MEETINGS_DIR OUT.jsonl            # gold mapped onto Tractus ASR transcripts
  python aihub_queries.py LABEL_DIR MEETINGS_DIR OUT.jsonl --oracle   # first write oracle transcripts (reference
                                                                      # text in <=30 s segments) into MEETINGS_DIR
LABEL_DIR: data/aihub-meeting/라벨링데이터 (reads */*/*/*.json). ASR mode matches transcript.json audio.source stem
to the session id (metadata.title), i.e. run `tractus transcribe <sid>.wav` into MEETINGS_DIR first.

Gold = every transcript segment whose [start, end] overlaps a source utterance's [start, end] (time join, so it
works on ASR output whose segmentation differs from the reference).

Query types (all taken verbatim from the human reference, never from the ASR text being searched):
  term      AI Hub hangeulToEnglish annotations (English tech/medical terms), in <=3 utterances corpus-wide
  rare_word Hangul word (trailing particle stripped) of 2-5 syllables found in 1-2 utterances corpus-wide
  fragment  6 consecutive words from the middle of a >=10-word utterance (held-out sentence piece)
"""

import json
import random
import re
import sys
from pathlib import Path

PER_SESSION = 15  # per query type
SEED = 0
SEG_SEC = 30.0
_DUAL = re.compile(r"\(([^()]*)\)/\(([^()]*)\)")  # bench/data.py aihub_clean과 같은 규칙
_NOISE = re.compile(r"/\([a-z]+\)")
_DEID = re.compile(r"@\S+")
# ponytail: 조사 제거는 단순 규칙. rare_word 질의가 지저분하면 형태소 분석기를 검토 (Kiwi는 LGPL이라 선택 의존성으로만)
_JOSA = sorted("에서는 으로는 에게서 까지는 이라는 에서 으로 에게 까지 부터 처럼 보다 라는 이라 은 는 이 가 을 를 의 에 도 만 과 와 로".split(),
               key=len, reverse=True)


def clean(form: str) -> str:
    s = _DUAL.sub(lambda m: m.group(2), form)
    s = _NOISE.sub(" ", s).replace("(())", " ")
    return re.sub(r"\s+", " ", _DEID.sub(" ", s).replace("~", "")).strip()


def strip_josa(w: str) -> str:
    for j in _JOSA:
        if w.endswith(j) and len(w) - len(j) >= 2:
            return w[: -len(j)]
    return w


def load_sessions(label_dir: Path) -> dict[str, list[dict]]:
    out = {}
    for jf in sorted(label_dir.glob("*/*/*/*.json")):
        d = json.loads(jf.read_text(encoding="utf-8"))
        utts = []
        for u in d["utterance"]:
            text = clean(u["form"])
            if text:
                terms = [re.sub(r"[가-힣]+$", "", t["english"]) for t in (u["hangeulToEnglish"] or [])]
                utts.append({"start": float(u["start"]), "end": float(u["end"]), "text": text, "terms": [t for t in terms if t]})
        out[d["metadata"]["title"]] = utts
    return out


def write_oracle(sessions: dict[str, list[dict]], root: Path) -> None:
    for i, (sid, utts) in enumerate(sessions.items()):
        segs, cur = [], []
        for u in utts + [None]:
            if cur and (u is None or u["end"] - cur[0]["start"] > SEG_SEC):
                segs.append({"id": f"s{len(segs) + 1:04d}", "start": cur[0]["start"], "end": cur[-1]["end"],
                             "text": " ".join(x["text"] for x in cur), "lang": "ko", "speaker": None,
                             "corrected_text": None, "words": None})
                cur = []
            if u:
                cur.append(u)
        mid = f"01AIHUBORACLE{i:013d}"
        t = {"schema_version": 1, "meeting_id": mid, "title": sid, "created_at": "2021-01-01T00:00:00+09:00",
             "audio": {"file": "audio.opus", "duration_sec": segs[-1]["end"], "source": f"{sid}.wav", "sha256": "oracle"},
             "asr": {"model": "oracle-reference", "track": "standard", "runtime": "none", "language": "ko", "hotwords": []},
             "segments": segs}
        d = root / f"2021-01-01_{sid}_{mid}"
        d.mkdir(parents=True, exist_ok=True)
        (d / "transcript.json").write_text(json.dumps(t, ensure_ascii=False), encoding="utf-8")


def load_transcripts(root: Path) -> dict[str, dict]:
    """session id -> transcript"""
    out = {}
    for p in root.glob("*/transcript.json"):
        t = json.loads(p.read_text(encoding="utf-8"))
        out[Path(t["audio"]["source"]).stem] = t
    return out


def overlapping(t: dict, u: dict) -> list[str]:
    return [s["id"] for s in t["segments"] if s["start"] < u["end"] and u["start"] < s["end"]]


def generate(sessions: dict[str, list[dict]], transcripts: dict[str, dict]) -> list[dict]:
    rng = random.Random(SEED)
    flat = [(sid, u) for sid, utts in sessions.items() for u in utts]

    def gold_for(pred) -> dict[str, list[str]]:
        g = {}
        for sid, u in flat:
            if sid in transcripts and pred(u):
                g.setdefault(transcripts[sid]["meeting_id"], set()).update(overlapping(transcripts[sid], u))
        return {m: sorted(v) for m, v in g.items() if v}

    def df(needle: str) -> int:
        return sum(needle in u["text"] for _, u in flat)

    queries, seen = [], set()
    for sid, utts in sessions.items():
        if sid not in transcripts:
            continue
        terms = sorted({t for u in utts for t in u["terms"] if 1 <= df(t) <= 3})
        words = sorted({w for u in utts for w in map(strip_josa, u["text"].split())
                        if re.fullmatch(r"[가-힣]{2,5}", w) and 1 <= df(w) <= 2})
        frags = [" ".join(ws[len(ws) // 2 - 3: len(ws) // 2 + 3]) for ws in (u["text"].split() for u in utts) if len(ws) >= 10]
        for qtype, pool, pred in [("term", terms, lambda q: lambda u: q in u["text"] or q in u["terms"]),
                                  ("rare_word", words, lambda q: lambda u: q in u["text"]),
                                  ("fragment", frags, lambda q: lambda u: q in u["text"])]:
            for q in rng.sample(pool, min(PER_SESSION, len(pool))):
                gold = gold_for(pred(q))
                if q not in seen and gold:
                    seen.add(q)
                    queries.append({"qid": f"a{len(queries) + 1:04d}", "type": qtype, "query": q, "gold": gold})
    return queries


def main() -> None:
    label_dir, meetings, out, *flags = sys.argv[1:]
    sessions = load_sessions(Path(label_dir))
    if "--oracle" in flags:
        write_oracle(sessions, Path(meetings))
    transcripts = load_transcripts(Path(meetings))
    queries = generate(sessions, transcripts)
    Path(out).write_text("".join(json.dumps(q, ensure_ascii=False) + "\n" for q in queries), encoding="utf-8")
    counts = {t: sum(q["type"] == t for q in queries) for t in ("term", "rare_word", "fragment")}
    print(f"sessions={len(sessions)} matched_transcripts={len(set(sessions) & set(transcripts))} queries={len(queries)} {counts}")


def _selftest() -> None:
    assert clean("(육 프로)/(6프로) @이름 음~ /(noise)") == "6프로 음"
    assert strip_josa("고혈압에서는") == "고혈압" and strip_josa("의사") == "의사"
    t = {"segments": [{"id": "s0001", "start": 0, "end": 30}, {"id": "s0002", "start": 30.5, "end": 60}]}
    assert overlapping(t, {"start": 29, "end": 31}) == ["s0001", "s0002"]
    assert overlapping(t, {"start": 30.1, "end": 30.4}) == []


if __name__ == "__main__":
    _selftest()
    main()
