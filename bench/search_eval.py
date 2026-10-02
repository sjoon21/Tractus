"""Phase 3 검색 평가: 가상 회의 5건 × 질의 30개 (tests/fixtures/eval). 외부 데이터 없음.

    uv run python bench/search_eval.py              # 저장소 루트에서
    uv run python bench/search_eval.py --no-vector  # 임베딩 모델 없이 키워드만

지표 (K=5, 결과 1개 = 청크 1개, 청크의 segment_ids 전체를 정답과 비교):
  hit@1          1위 결과가 정답 세그먼트를 포함하면 1
  hit@5          상위 5개 중 정답 세그먼트를 포함한 결과가 있으면 1
  recall@5       min(1, |정답 ∩ 상위 5개의 세그먼트| / min(|정답|, 5))
  mrr@10         정답을 포함한 첫 결과 순위의 역수 (10위 밖이면 0)
  meeting_hit@5  상위 5개 중 정답 회의가 있으면 1
청크가 세그먼트 여러 개를 묶으므로 세그먼트 단위 평가보다 recall이 기계적으로 높게 나온다(청크 300–500자).
"""

import argparse
import json
import shutil
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from tractus.embed import load_embedder  # noqa: E402
from tractus.index import Index, rrf  # noqa: E402

EVAL = ROOT / "tests" / "fixtures" / "eval"
K, MRR_K = 5, 10
METRICS = ["hit@1", "hit@5", "recall@5", "mrr@10", "meeting_hit@5"]


def metrics(q: dict, results: list[dict]) -> dict[str, float]:
    gold = {(m, s) for m, segs in q["gold"].items() for s in segs}
    units = [{(r["meeting_id"], s) for s in r["segment_ids"]} for r in results]
    first = next((i for i, u in enumerate(units[:MRR_K], 1) if u & gold), None)
    top = set().union(*units[:K]) if units else set()
    return {
        "hit@1": float(bool(units and units[0] & gold)),
        "hit@5": float(bool(top & gold)),
        "recall@5": min(1.0, len(top & gold) / min(len(gold), K)),  # 청크 하나에 정답 세그먼트가 여러 개 들어갈 수 있다
        "mrr@10": 1 / first if first else 0.0,
        "meeting_hit@5": float(any(r["meeting_id"] in q["gold"] for r in results[:K])),
    }


def run_variant(idx: Index, queries: list[dict], mode: str) -> dict[str, dict[str, float]]:
    groups = defaultdict(list)
    for q in queries:
        f = q.get("filters", {})
        lo, hi = f.get("date_from", "0000-00-00"), f.get("date_to", "9999-12-31")
        if mode == "hybrid":
            hits = idx.search(q["query"], limit=MRR_K, date_from=lo, date_to=hi).hits
            results = [{"meeting_id": h.meeting_id, "segment_ids": h.segment_ids} for h in hits]
        else:
            ids = idx._keyword(q["query"], lo, hi, None)[0] if mode == "keyword" else list(idx._vector(q["query"], lo, hi, None) or {})
            order, _ = rrf(ids)
            results = []
            for cid in order[:MRR_K]:
                mid, segs = idx.db.execute("SELECT meeting_id, segments FROM chunks WHERE chunk_id=?", (cid,)).fetchone()
                results.append({"meeting_id": mid, "segment_ids": [s["id"] for s in json.loads(segs)]})
        m = metrics(q, results)
        groups["ALL"].append(m)
        groups[q["type"]].append(m)
    return {g: {n: sum(x[n] for x in ms) / len(ms) for n in METRICS} | {"n": len(ms)} for g, ms in groups.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-vector", action="store_true")
    args = ap.parse_args()
    queries = [json.loads(line) for line in (EVAL / "queries.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    embedder = None if args.no_vector else load_embedder(ROOT / "models")
    if embedder is None and not args.no_vector:
        sys.exit("models/qwen3-embedding-0.6b 없음 (README '모델 받기')")

    table = {}
    for with_summary in (False,):  # 요약 항목 색인은 hit@1을 0.97 → 0.87로 떨어뜨려 제외했다 (2026-10-02)
        home = Path(tempfile.mkdtemp())
        shutil.copytree(EVAL / "meetings", home / "meetings")
        if not with_summary:
            for p in (home / "meetings").glob("*/summary.json"):
                p.unlink()
        idx = Index(home, embedder=embedder)
        idx.sync()
        for mode in ("keyword", "vector", "hybrid") if embedder else ("keyword",):
            table[(mode, with_summary)] = run_variant(idx, queries, mode)
        idx.close()
        shutil.rmtree(home)

    types = ["ALL", "keyword_ko", "keyword_en", "semantic", "time", "cross"]
    print("| 방식 | 요약 색인 | " + " | ".join(f"{t} hit@1 / MRR" for t in types) + " | ALL recall@5 |")
    print("| --- | --- | " + " | ".join("---" for _ in types) + " | --- |")
    for (mode, ws), r in table.items():
        cells = " | ".join(f"{r[t]['hit@1']:.2f} / {r[t]['mrr@10']:.2f}" for t in types)
        print(f"| {mode} | {'O' if ws else 'X'} | {cells} | {r['ALL']['recall@5']:.2f} |")


if __name__ == "__main__":
    main()
