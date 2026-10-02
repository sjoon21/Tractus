"""Silero VAD로 무음 지점에서 청크 경계를 정해 캐시에 저장한다.

모든 모델이 같은 경계를 쓰도록 미리 한 번만 계산한다(공정 비교 규칙).
torch를 벤치마크 프로세스에 올리지 않으려고 별도 단계로 분리했다.

    python vad.py aihub 15 30 60
"""

import json
import sys
from pathlib import Path

CACHE_DIR = Path(__file__).resolve().parent / "cache"
SR = 16000


def merge(speech: list[tuple[int, int]], max_s: float) -> list[tuple[int, int]]:
    """발화 구간을 max_s 이하 청크로 묶는다. 경계는 발화 사이 무음에 놓인다.
    max_s보다 긴 단일 발화는 max_s 단위로 자른다."""
    max_n = int(max_s * SR)
    chunks: list[tuple[int, int]] = []
    for s, e in speech:
        while e - s > max_n:  # ponytail: 긴 발화는 고정 길이로 자름, 문장 중간 절단 가능
            chunks.append((s, s + max_n))
            s += max_n
        if chunks and e - chunks[-1][0] <= max_n:
            chunks[-1] = (chunks[-1][0], e)
        else:
            chunks.append((s, e))
    return chunks


def cache_path(sample_id: str, max_s: float) -> Path:
    return CACHE_DIR / f"{sample_id}.vad{int(max_s)}.json"


def load_chunks(sample_id: str, max_s: float) -> list[tuple[int, int]]:
    p = cache_path(sample_id, max_s)
    if not p.exists():
        raise FileNotFoundError(f"{p} 없음 — 먼저 `python vad.py <dataset> {int(max_s)}` 실행")
    return [tuple(c) for c in json.loads(p.read_text())]


def main(dataset: str, max_list: list[float]):
    import torch
    from silero_vad import get_speech_timestamps, load_silero_vad

    from data import DATASETS

    CACHE_DIR.mkdir(exist_ok=True)
    vad = load_silero_vad()
    for sample in DATASETS[dataset]():
        ts = get_speech_timestamps(torch.from_numpy(sample.audio), vad, sampling_rate=SR)
        speech = [(t["start"], t["end"]) for t in ts]
        for max_s in max_list:
            chunks = merge(speech, max_s)
            cache_path(sample.id, max_s).write_text(json.dumps(chunks))
            print(f"{sample.id} max={max_s:.0f}s chunks={len(chunks)} speech={sum(e - s for s, e in chunks) / SR / 60:.1f}min")


if __name__ == "__main__":
    assert merge([(0, 16000), (32000, 48000), (10 * SR, 40 * SR)], 30) == [(0, 48000), (10 * SR, 40 * SR)]
    main(sys.argv[1], [float(x) for x in sys.argv[2:]])
