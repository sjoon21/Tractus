"""raw 전사에서 지표만 다시 계산해 results/summary.jsonl을 갱신한다. RTF·메모리는 그대로 둔다.

정답 정규화나 지표를 고친 뒤 추론을 다시 돌리지 않고 반영할 때 쓴다.
    python rescore.py
"""

import json

from data import fleurs_ref
from run import RESULTS, metrics, raw_path_for


def main():
    path = RESULTS / "summary.jsonl"
    out = []
    for line in path.open(encoding="utf-8"):
        s = json.loads(line)
        raw = raw_path_for(s["model"], s["dataset"], s["lang"], s["chunk_s"], s["glossary"])
        rows = [json.loads(x) for x in raw.open(encoding="utf-8")]
        if s["dataset"] == "fleurs":
            rows = [{**r, "ref": fleurs_ref(r["ref"])} for r in rows]
        out.append({**s, **metrics(s["dataset"], rows)})
    path.write_text("".join(json.dumps(s, ensure_ascii=False) + "\n" for s in out), encoding="utf-8")
    print(f"{len(out)}개 결과 재채점")


if __name__ == "__main__":
    main()
