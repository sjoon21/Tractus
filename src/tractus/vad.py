"""Silero VAD(MLX 포팅)로 무음 지점에서 청크 경계를 정한다.

MLX 포팅은 Phase 0에서 쓴 torch 버전과 발화 구간이 100% 일치했다(10분 구간 비교). torch 의존성을 피하려고 이쪽을 쓴다.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import numpy as np



SR = 16000
MAX_CHUNK_S = 30.0  # Phase 0 E4: 15/30/60초 CER 차이 0.3%p 이내


def merge(speech: list[tuple[int, int]], max_s: float = MAX_CHUNK_S) -> list[tuple[int, int]]:
    """발화 구간을 max_s 이하 청크로 묶는다. 경계는 발화 사이 무음에 놓인다.
    max_s보다 긴 단일 발화는 max_s 단위로 자른다."""
    max_n = int(max_s * SR)
    chunks: list[tuple[int, int]] = []
    for s, e in speech:
        while e - s > max_n:  # ponytail: 쉼 없이 30초 넘게 이어진 발화는 고정 길이로 자름, 문장 중간 절단 가능
            chunks.append((s, s + max_n))
            s += max_n
        if chunks and e - chunks[-1][0] <= max_n:
            chunks[-1] = (chunks[-1][0], e)
        else:
            chunks.append((s, e))
    return chunks


def find_chunks(audio: np.ndarray, vad_model_dir: Path, max_s: float = MAX_CHUNK_S) -> list[tuple[int, int]]:
    from mlx_audio.vad.utils import load

    model = load(str(vad_model_dir))
    speech = model.get_speech_timestamps(audio, sample_rate=SR)
    return merge([(t["start"], t["end"]) for t in speech], max_s)
