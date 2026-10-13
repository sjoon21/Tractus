"""Phase 6 회의 질의 평가: 가상 회의 5건 × 한국어 질문 28개 (tests/fixtures/eval/ask_questions.jsonl).

    uv run python bench/ask_eval.py                     # 저장소 루트에서, TRACTUS_LLM_PROVIDER(.env)로
    uv run python bench/ask_eval.py --provider upstage --no-vector

가상 회의만 원격 공급자로 보낸다. 사용자 회의($TRACTUS_HOME)나 AI Hub 데이터는 읽지 않는다(임시 홈에 복사해 색인).

질문 유형: meeting(회의 범위, 전사 전체), cross(전체 범위), date(전체 범위 + 기간), none(답이 없음), follow(후속 질문, --followups).
지표:
  source_recall   전체 범위(cross/date) 질문에서 정답 세그먼트가 LLM에 보낸 근거에 들어 있는 비율 (검색 단계).
                  회의 범위는 전사 전체를 보내 늘 1이라 뺀다. 근거 비율(보낸 세그먼트 / 말뭉치 세그먼트)을 함께 본다:
                  가상 회의 5건(세그먼트 62개)은 작아서 전체 범위도 말뭉치 절반가량을 보내므로 검색 재현율로 읽으면 안 된다
  precision       답의 인용 중 정답(gold) 또는 허용(ok) 세그먼트 비율 (답이 있는 질문, micro)
  recall          정답 세그먼트 중 답에 인용된 비율 (micro)
  hit             정답 세그먼트를 하나 이상 인용한 질문 비율
  refused         답이 있는데 NO_EVIDENCE('노트 내용에서 답을 찾지 못했습니다')로 답한 비율
  no_evidence     답이 없는 질문에서 NO_EVIDENCE + 인용 0개로 답한 비율
  latency         첫 delta까지(TTFT)와 전체 시간의 p50 / 최대 (초)
"""

import argparse
import json
import shutil
import statistics
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from tractus import ask as qa  # noqa: E402
from tractus.embed import load_embedder  # noqa: E402
from tractus.env import load_env  # noqa: E402
from tractus.index import Index  # noqa: E402
from tractus.llm import make_client, resolve_provider  # noqa: E402

EVAL = ROOT / "tests" / "fixtures" / "eval"
REFUSAL = qa.NO_EVIDENCE.rstrip(".")  # 답이 없을 때의 고정 문구 (마침표만 빼고 비교)


def pairs(gold) -> set[tuple[str, str]]:
    return {(m, s) for m, segs in (gold or {}).items() for s in segs} if isinstance(gold, dict) else set()


def run_one(q: dict, idx: Index, transcripts: dict, client, provider: str, model: str, alone: bool = False) -> dict:
    """q["history"]: 후속 질문의 직전 사용자 질문들 (ask_followups.jsonl). alone=True면 검색에는 쓰지 않는다 (이전 동작과 비교용)."""
    history = [{"role": "user", "content": c} for c in q.get("history", [])]
    if q.get("meeting"):
        scope, get = "meeting", lambda: qa.transcript_sources(transcripts[q["meeting"]])
    else:
        scope, get = "global", lambda: qa.search_sources(idx, q["question"], None if alone else history, date_from=q.get("from"), date_to=q.get("to"))
    t0, ttft, sources, done = time.perf_counter(), None, [], None
    for ev in qa.ask(client, provider, model, q["question"], history, scope, get):
        if ev["event"] == "sources":
            sources = ev["sources"]
        elif ev["event"] == "delta" and ttft is None:
            ttft = time.perf_counter() - t0
        elif ev["event"] == "done":
            done = ev
    return {"qid": q["qid"], "type": q["type"], "answer": done["answer"], "cited": {(c["meeting_id"], c["segment_id"]) for c in done["citations"]},
            "sources": {(s["meeting_id"], s["segment_id"]) for s in sources}, "ttft": ttft, "total": time.perf_counter() - t0}


def report(qs: list[dict], rs: list[dict], corpus: int) -> None:
    ans = [(q, r) for q, r in zip(qs, rs) if q["gold"] != "none"]
    none = [(q, r) for q, r in zip(qs, rs) if q["gold"] == "none"]
    cited = sum(len(r["cited"]) for _, r in ans)
    good = sum(len(r["cited"] & (pairs(q["gold"]) | pairs(q.get("ok")))) for q, r in ans)
    gold = sum(len(pairs(q["gold"])) for q, _ in ans)
    found = sum(len(r["cited"] & pairs(q["gold"])) for q, r in ans)
    wide = [(q, r) for q, r in ans if not q.get("meeting")]
    g_gold, in_src = sum(len(pairs(q["gold"])) for q, _ in wide), sum(len(r["sources"] & pairs(q["gold"])) for q, r in wide)
    sent = [len(r["sources"]) / corpus for q, r in zip(qs, rs) if not q.get("meeting")]
    total, ttft = [r["total"] for r in rs], [r["ttft"] for r in rs if r["ttft"] is not None]
    print(f"\n질문 {len(rs)}개 (답 있음 {len(ans)}, 답 없음 {len(none)})")
    print(f"source_recall(전체 범위) {in_src / max(g_gold, 1):.2f}  보낸 근거/말뭉치 p50 {statistics.median(sent):.0%} max {max(sent):.0%} "
          f"(세그먼트 {corpus}개)")
    print(f"precision {good / max(cited, 1):.2f}  recall {found / gold:.2f}  "
          f"hit {sum(bool(r['cited'] & pairs(q['gold'])) for q, r in ans) / len(ans):.2f}  "
          f"refused {sum(REFUSAL in r['answer'] for _, r in ans) / len(ans):.2f}")
    print(f"no_evidence {sum(REFUSAL in r['answer'] and not r['cited'] for _, r in none) / len(none):.2f}")
    print(f"latency TTFT p50 {statistics.median(ttft):.2f}s max {max(ttft):.2f}s / 전체 p50 {statistics.median(total):.2f}s max {max(total):.2f}s"
          if ttft else f"latency 전체 p50 {statistics.median(total):.2f}s")
    for t in ("meeting", "cross", "date", "follow"):
        sub = [(q, r) for q, r in ans if q["type"] == t]
        if sub:
            print(f"  {t}: hit {sum(bool(r['cited'] & pairs(q['gold'])) for q, r in sub) / len(sub):.2f} (n={len(sub)})")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider")
    ap.add_argument("--model")
    ap.add_argument("--no-vector", action="store_true", help="임베딩 모델 없이 키워드 검색만")
    ap.add_argument("--followups", action="store_true", help="후속 질문(ask_followups.jsonl)도 함께")
    ap.add_argument("--alone", action="store_true", help="후속 질문 검색에 이전 질문을 쓰지 않는다 (v3.16 동작, 비교용)")
    ap.add_argument("-v", "--verbose", action="store_true", help="질문별 답을 출력")
    args = ap.parse_args()
    load_env(ROOT)
    provider, model = resolve_provider(args.provider, args.model)
    qs = [json.loads(line) for line in (EVAL / "ask_questions.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    if args.followups:
        qs += [json.loads(line) for line in (EVAL / "ask_followups.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    embedder = None if args.no_vector else load_embedder(ROOT / "models")

    with tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp)
        shutil.copytree(EVAL / "meetings", home / "meetings")
        transcripts = {t["meeting_id"]: t for t in (json.loads(p.read_text(encoding="utf-8")) for p in (home / "meetings").glob("*/transcript.json"))}
        idx = Index(home, embedder=embedder)
        idx.sync()
        client = make_client(provider)
        print(f"{provider.name}/{model}, 검색 {'하이브리드' if embedder else '키워드'}")
        rs = []
        for q in qs:
            r = run_one(q, idx, transcripts, client, provider.name, model, args.alone)
            rs.append(r)
            ok = (REFUSAL in r["answer"] and not r["cited"]) if q["gold"] == "none" else bool(r["cited"] & pairs(q["gold"]))
            print(f"{'✓' if ok else '✗'} {q['qid']} {q['type']:<7} {r['total']:.1f}s 인용 {sorted(s for _, s in r['cited'])}")
            if args.verbose or not ok:
                print(f"    Q {q['question']}\n    A {r['answer'][:300]}")
        idx.close()
    report(qs, rs, sum(len(qa.transcript_sources(t)) for t in transcripts.values()))


if __name__ == "__main__":
    main()
