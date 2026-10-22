"""숫자 표기 바꾸기(tractus.itn) 효과: 저장해 둔 AI Hub 발화 단위 결과(run.py --segments utt)에 적용해 다시 채점한다. 추론 없음.

    uv run python itn_eval.py [results/raw/aihub/<tag>__utt.jsonl]

지표만 찍는다(AI Hub 문장은 찍지 않는다): 철자 기준 CER 전·후, 표기 차이를 뺀 CER 전·후, 바뀐·나아진·나빠진 발화 수,
나빠진 발화가 어느 규칙(한 글자 띄어 씀·한 글자 붙여 씀·여러 글자+단위·단위 없음)에서 나왔는지.
"""

import collections
import json
import sys
from pathlib import Path

from rapidfuzz.distance import Levenshtein

import score
from data import aihub_clean

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
from tractus import itn  # noqa: E402

RAW = Path(sys.argv[1] if len(sys.argv) > 1 else "results/raw/aihub/qwen3-1.7b__fixed__c30__utt.jsonl")


def kinds(text: str) -> set[str]:
    out = set()
    for m in itn._RUN.finditer(text):
        if itn._replace(m) == m.group(0):
            continue
        flat, space, unit = m.group(1).replace(" ", ""), m.group(2), m.group(3)
        out.add("unitless" if unit is None else f"single_{'spaced' if space else 'attached'}:{unit}" if len(flat) == 1 else "multi+unit")
    return out


def main():
    rows = [json.loads(line) for line in RAW.open(encoding="utf-8")]
    after = [{**r, "meta": {**r["meta"], "parts": [itn.korean_numbers(p) for p in r["meta"]["parts"]]}} for r in rows]
    report = {k: {"before": round(score.cer_best(rows, frozenset(v)), 2), "after": round(score.cer_best(after, frozenset(v)), 2)}
              for k, v in {"spelling": (), "best": ("num", "latin", "other")}.items()}
    changed = better = worse = 0
    worse_kinds, all_kinds = collections.Counter(), collections.Counter()
    for r in rows:
        for form, hyp in zip(r["meta"]["forms"], r["meta"]["parts"]):
            new = itn.korean_numbers(hyp)
            if new == hyp:
                continue
            changed += 1
            ref = score.norm_ko(aihub_clean(form))
            d = Levenshtein.distance(ref, score.norm_ko(new)) - Levenshtein.distance(ref, score.norm_ko(hyp))
            ks = kinds(hyp)
            all_kinds.update(ks)
            better += d < 0
            if d > 0:
                worse += 1
                worse_kinds.update(ks)
    print(json.dumps({"raw": RAW.name, "cer_utt": report, "utterances": sum(len(r["meta"]["parts"]) for r in rows),
                      "changed": changed, "better": better, "worse": worse,
                      "rules_used": dict(all_kinds.most_common()), "rules_in_worse": dict(worse_kinds.most_common())}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
