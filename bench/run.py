"""Phase 0 실험 1회 실행: 모델 하나 × 데이터셋 하나 × 조건 하나.

    python run.py qwen3-1.7b hike --lang auto
    python run.py whisper-turbo aihub --lang fixed --chunk 30 --glossary
    python run.py qwen3-1.7b aihub --segments label   # VAD 대신 라벨 발화 경계로 30초 이하 묶음 (utt: 발화 하나씩)

결과:
    results/raw/<dataset>/<tag>.jsonl   전사 원문 (git 제외, AI Hub 파생 텍스트 포함)
    results/summary.jsonl               지표 요약 (커밋 대상)
"""

import argparse
import json
import os
import resource
import time
import traceback
from pathlib import Path

os.environ.setdefault("TQDM_DISABLE", "1")

import mlx.core as mx  # noqa: E402

import score  # noqa: E402
from asr import ASR, MODELS  # noqa: E402
from data import DATASETS, SR  # noqa: E402
from vad import load_chunks, merge  # noqa: E402

RESULTS = Path(__file__).resolve().parent / "results"
LONG_FORM = {"aihub"}  # VAD 청킹을 거치는 장시간 데이터셋. 나머지는 30초 미만 클립이라 통째로 넣는다.


def raw_path_for(model: str, dataset: str, lang: str, chunk: float | None, glossary: bool, segments: str = "vad") -> Path:
    tag = f"{model}__{lang}" + (f"__c{int(chunk)}" if dataset in LONG_FORM else "") + ("__gloss" if glossary else "")
    tag += "" if segments == "vad" else f"__{segments}"
    return RESULTS / "raw" / dataset / f"{tag}.jsonl"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model", choices=MODELS)
    ap.add_argument("dataset", choices=DATASETS)
    ap.add_argument("--lang", choices=["auto", "fixed"], default="fixed")
    ap.add_argument("--chunk", type=float, default=30.0)
    ap.add_argument("--glossary", action="store_true", help="AI Hub 세션의 영문 용어를 용어집으로 넣는다")
    ap.add_argument("--segments", choices=["vad", "label", "utt"], default="vad",
                    help="장시간 데이터셋 자르기: vad(제품과 같은 Silero), label(정답 발화 경계로 --chunk 이하 묶음), utt(정답 발화 하나씩)")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--only", default="", help="쉼표로 구분한 sample id만 실행")
    args = ap.parse_args()

    long_form = args.dataset in LONG_FORM
    if args.segments != "vad" and args.dataset != "aihub":
        ap.error("--segments label|utt는 aihub만 (정답 발화 구간이 있는 데이터)")
    raw_path = raw_path_for(args.model, args.dataset, args.lang, args.chunk, args.glossary, args.segments)
    tag = raw_path.stem
    raw_path.parent.mkdir(parents=True, exist_ok=True)

    t_load = time.perf_counter()
    asr = ASR(args.model)
    load_s = time.perf_counter() - t_load

    only = set(filter(None, args.only.split(",")))
    rows, warmed = [], False
    with raw_path.open("w", encoding="utf-8") as f:
        for i, sample in enumerate(DATASETS[args.dataset]()):
            if only and sample.id not in only:
                continue
            if args.limit and len(rows) >= args.limit:
                break
            lang = sample.lang if args.lang == "fixed" else None
            glossary = sample.meta.get("glossary") if args.glossary else None
            if not warmed:  # 첫 호출의 컴파일·캐시 비용을 RTF에서 뺀다
                asr.transcribe(sample.audio[: 10 * SR], lang, glossary)
                warmed = True
            t0 = time.perf_counter()
            try:
                if long_form:
                    parts = [asr.transcribe(sample.audio[s:e], lang, glossary) for s, e in chunks_for(sample, args.segments, args.chunk)]
                    hyp, error = " ".join(p for p in parts if p), None
                    if args.segments == "utt":  # 발화마다 정답과 짝지어 채점할 수 있게 (score.cer_best)
                        sample.meta["parts"] = parts
                else:
                    hyp, error = asr.transcribe(sample.audio, lang, glossary), None
            except Exception:
                hyp, error = "", traceback.format_exc(limit=3)
            row = {
                "id": sample.id,
                "hyp": hyp,
                "ref": sample.ref,
                "audio_s": len(sample.audio) / SR,
                "proc_s": time.perf_counter() - t0,
                "error": error,
                "meta": sample.meta,
            }
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            rows.append(row)
            if long_form or i % 100 == 0:
                print(f"[{tag}] {sample.id} {row['audio_s'] / 60:.1f}min proc={row['proc_s']:.0f}s err={bool(error)}", flush=True)

    summary = {
        "model": args.model,
        "dataset": args.dataset,
        "lang": args.lang,
        "chunk_s": args.chunk if long_form else None,
        **({"segments": args.segments} if args.segments != "vad" else {}),
        "glossary": args.glossary,
        "n": len(rows),
        "errors": sum(1 for r in rows if r["error"]),
        "audio_min": round(sum(r["audio_s"] for r in rows) / 60, 1),
        "rtf": round(sum(r["proc_s"] for r in rows) / sum(r["audio_s"] for r in rows), 4),
        "load_s": round(load_s, 1),
        "peak_mlx_gb": round(mx.get_peak_memory() / 1e9, 2),
        "max_rss_gb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e9, 2),  # macOS: 바이트 단위
        **metrics(args.dataset, rows),
    }
    with (RESULTS / "summary.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(summary, ensure_ascii=False) + "\n")
    print(json.dumps(summary, ensure_ascii=False, indent=1))


def chunks_for(sample, segments: str, max_s: float) -> list[tuple[int, int]]:
    if segments == "vad":
        return load_chunks(sample.id, max_s)
    spans = sample.meta["spans"]
    if segments == "label":
        return merge(spans, max_s)
    return [c for span in spans for c in merge([span], max_s)]  # utt: 묶지 않고, max_s보다 긴 발화만 자른다


def metrics(dataset: str, rows: list[dict]) -> dict:
    refs, hyps = [r["ref"] for r in rows], [r["hyp"] for r in rows]
    if dataset == "fleurs":
        return {"cer": round(score.cer(refs, hyps), 2)}
    if dataset == "ami":
        return {"wer": round(score.wer_en(refs, hyps), 2)}
    if dataset == "hike":
        return {"hike": {k: {m: round(x, 2) for m, x in v.items()} for k, v in score.hike_scores(rows).items()}}
    # aihub: 철자전사 기준 CER이 주 지표, 발음전사 기준은 숫자·영문 표기 차이 참고용
    return {
        "cer": round(score.cer(refs, hyps), 2),
        "cer_pron": round(score.cer([r["meta"]["ref_pron"] for r in rows], hyps), 2),
        "repetitions": sum(score.repetitions(h) for h in hyps),
        "term_recall": round(score.term_recall(rows), 1),
        **({"cer_utt": {  # 발화 단위 채점: spelling(철자 그대로) 대비 best(짝마다 가까운 표기), num·latin(그 종류만 고름)
            k: round(score.cer_best(rows, frozenset(v)), 2)
            for k, v in {"spelling": (), "best": ("num", "latin", "other"), "num": ("num",), "latin": ("latin",)}.items()
        }} if all("parts" in r["meta"] for r in rows) else {}),
        "per_session": {
            r["id"]: {"cer": round(score.cer([r["ref"]], [r["hyp"]]), 2), "rtf": round(r["proc_s"] / r["audio_s"], 4)}
            for r in rows
        },
    }


if __name__ == "__main__":
    main()
