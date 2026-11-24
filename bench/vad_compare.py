"""같은 음성에서 MLX Silero VAD와 ONNX Silero VAD(tractus.vad_onnx)의 경계를 비교한다. 지표만 낸다 (Mac에서 실행).

    uv run --with onnxruntime==1.32.0 python vad_compare.py aihub [--limit N]

지표: 발화 표본 일치율(%), 발화 구간 수, 30초 청크 수와 그 차이(%). 결과: results/vad_summary.json (지표만, 전사 없음)
VAD만 바꾼 CER 차이는 run.py --app --vad로 따로 잰다 (docs/design/asr-onnx.md 5·8절).
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from data import DATASETS, SR  # noqa: E402
from tractus.vad import merge  # noqa: E402

RESULTS = Path(__file__).resolve().parent / "results"


def mask(spans: list[tuple[int, int]], n: int) -> np.ndarray:
    m = np.zeros(n, dtype=bool)
    for s, e in spans:
        m[s:e] = True
    return m


def agreement(a: list[tuple[int, int]], b: list[tuple[int, int]], n: int) -> float:
    """두 VAD가 표본마다 발화/무음을 같게 본 비율(%)."""
    return float((mask(a, n) == mask(b, n)).mean() * 100) if n else 100.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dataset", choices=DATASETS)
    ap.add_argument("--mlx", type=Path, default=ROOT / "models/silero-vad-v6")
    ap.add_argument("--onnx", type=Path, default=ROOT / "models/silero-vad-v6-onnx")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    import onnxruntime as ort
    from mlx_audio.vad.utils import load

    from tractus.vad_onnx import speech_timestamps

    mlx_vad = load(str(args.mlx))
    session = ort.InferenceSession(str(args.onnx / "silero_vad_16k_op15.onnx"), providers=["CPUExecutionProvider"])
    per, total = {}, {"samples": 0, "same": 0.0, "chunks_mlx": 0, "chunks_onnx": 0}
    for i, sample in enumerate(DATASETS[args.dataset]()):
        if args.limit and i >= args.limit:
            break
        audio, n = sample.audio, len(sample.audio)
        a = [(t["start"], t["end"]) for t in mlx_vad.get_speech_timestamps(audio, sample_rate=SR)]
        b = [(int(s), int(e)) for s, e in speech_timestamps(audio, session)]
        ca, cb = len(merge(a)), len(merge(b))
        same = agreement(a, b, n)
        per[sample.id] = {"agree": round(same, 3), "spans": [len(a), len(b)], "chunks": [ca, cb]}
        total["samples"] += n
        total["same"] += same * n / 100
        total["chunks_mlx"] += ca
        total["chunks_onnx"] += cb
        print(f"{sample.id} {n / SR / 60:.1f}min agree={same:.3f}% spans={len(a)}/{len(b)} chunks={ca}/{cb}", flush=True)
    summary = {
        "dataset": args.dataset,
        "onnx": args.onnx.name,
        "n": len(per),
        "agree": round(total["same"] / max(total["samples"], 1) * 100, 3),
        "chunks": [total["chunks_mlx"], total["chunks_onnx"]],
        "chunk_diff_pct": round(abs(total["chunks_onnx"] - total["chunks_mlx"]) / max(total["chunks_mlx"], 1) * 100, 2),
        **({"per_session": per} if args.dataset == "aihub" else {}),
    }
    RESULTS.mkdir(exist_ok=True)
    (RESULTS / "vad_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k != "per_session"}, ensure_ascii=False))


if __name__ == "__main__":
    assert agreement([(0, 5)], [(0, 5)], 10) == 100.0
    assert agreement([(0, 5)], [(0, 4)], 10) == 90.0
    main()
