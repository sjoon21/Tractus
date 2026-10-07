"""단어 타임스탬프: Qwen3-ForcedAligner-0.6B (mlx-audio)로 세그먼트 표시 텍스트를 오디오에 맞춘다.

ARCHITECTURE.md §2.3, docs/desktop.md §2.6. 2026-10-06 실측(실제 대면 회의 44.7분, 세그먼트 295개): 66초 (RTF 0.025), 294개 성공.
단어 = 표시 텍스트(`seg_text`)의 공백 토큰이다. `words[k]["text"] == seg_text(s).split()[k]`가 언제나 성립한다.

mlx-audio의 한국어 토크나이저(`tokenize_korean`)는 soynlp(LGPL-3)를 불러오므로 공백 토크나이저(`tokenize`)로 바꿔 끼운다.
`tokenize_space_lang`은 한자를 글자마다 나눠 단어 수가 어긋나므로 쓰지 않는다.
"""

import difflib
import unicodedata
from pathlib import Path
from typing import Callable

import numpy as np

from tractus.store import seg_text

SR = 16000
MODEL_REPO = "mlx-community/Qwen3-ForcedAligner-0.6B-8bit"
MODEL_REVISION = "0e1a68e91d815300c7c9754b2a7639378b23db15"
MODEL_DIR = "qwen3-forcedaligner-0.6b-8bit"
MAX_SLICE_S = 60.0  # 8bit 모델은 110~140초를 넘으면 시간이 틀어진다. 세그먼트는 30초 이하라 여유가 크다


def _clean(token: str) -> str:
    """mlx-audio ForceAlignProcessor.clean_token과 같다: 글자·숫자·아포스트로피만 남긴다."""
    return "".join(ch for ch in token if ch == "'" or unicodedata.category(ch)[0] in "LN")


def tokenize(text: str) -> list[str]:
    """모델에 보낼 단어: 공백 토큰마다 하나. 문장부호만 있는 토큰은 뺀다. 한자도 나누지 않는다."""
    return [c for c in map(_clean, text.split()) if c]


class Aligner:
    def __init__(self, model):
        self.model = model
        model.aligner_processor.tokenize_korean = tokenize  # soynlp(LGPL-3) 대신. language="Korean"일 때만 불린다

    def align(self, pcm: np.ndarray, text: str) -> list[dict] | None:
        """슬라이스 기준 상대 시각(초)의 단어 목록. 60초 초과, 빈 텍스트, 모델 단어 수 불일치, 모두 길이 0이면 None.
        문장부호만 있는 토큰은 앞 단어 끝(첫 단어면 0)에 길이 0으로 둔다. 시각은 [0, 슬라이스 길이]로 자르고 줄지 않게 맞춘다."""
        n = len(tokenize(text))
        if not n or len(pcm) > MAX_SLICE_S * SR:
            return None
        items = self.model.generate(np.asarray(pcm, np.float32), text, language="Korean").items
        if len(items) != n:
            return None
        spans = iter([(it.start_time, it.end_time) for it in items])
        dur, cur, words = len(pcm) / SR, 0.0, []
        for tok in text.split():
            s, e = next(spans) if _clean(tok) else (cur, cur)
            s = min(max(s, cur), dur)
            cur = min(max(e, s), dur)
            words.append({"text": tok, "start": s, "end": cur})
        if not any(w["end"] > w["start"] for w in words):
            return None  # 예외 없이 나온 쓰레기 출력 (모두 0)
        return words


def load_aligner(models_dir: Path) -> Aligner | None:
    """모델 파일이 없으면 None (단어 타이밍 없이 둔다)."""
    path = models_dir / MODEL_DIR
    if not (path / "model.safetensors").exists() or not (path / "config.json").exists():
        return None
    from mlx_audio.stt.utils import load

    return Aligner(load(str(path)))


def _absolute(words: list[dict], start: float, end: float) -> list[dict]:
    """상대 시각 → 회의 시각. 소수 둘째 자리로 반올림하고 세그먼트 안으로 자른다 (단조 변환이라 순서는 유지된다)."""
    clamp = lambda x: min(max(round(start + x, 2), start), end)  # noqa: E731
    return [{"text": w["text"], "start": clamp(w["start"]), "end": clamp(w["end"])} for w in words]


def align_segments(
    aligner: Aligner, pcm: np.ndarray, segments: list[dict], on_progress: Callable[[int, int], None] | None = None, only: set[str] | None = None
) -> tuple[list[dict], int, int]:
    """세그먼트마다 표시 텍스트를 정렬한다 → (새 세그먼트 목록, 성공 수, 실패 수). 원본은 건드리지 않는다.
    only가 있으면 그 id만 정렬하고 나머지는 그대로 둔다. 실패한 세그먼트는 words = None."""
    total = sum(1 for s in segments if only is None or s["id"] in only)
    out, done, aligned = [], 0, 0
    for s in segments:
        if only is not None and s["id"] not in only:
            out.append(s)
            continue
        rel = aligner.align(pcm[round(s["start"] * SR):round(s["end"] * SR)], seg_text(s))
        out.append({**s, "words": _absolute(rel, s["start"], s["end"]) if rel else None})
        done, aligned = done + 1, aligned + (rel is not None)
        if on_progress:
            on_progress(done, total)
    return out, aligned, total - aligned


def remap_words(old: list[dict] | None, new_text: str, seg_start: float, seg_end: float) -> list[dict] | None:
    """텍스트를 고친 뒤 단어 시각을 옮긴다. 같은 단어는 시각(과 approx)을 그대로 두고, 바뀌거나 새로 생긴 단어는
    앞 단어 끝과 다음 단어 시작 사이(없으면 세그먼트 경계)에 고르게 펴고 approx: true를 붙인다. None이면 None."""
    if old is None:
        return None
    new = new_text.split()
    out: list[dict | None] = [None] * len(new)
    sm = difflib.SequenceMatcher(None, [w["text"] for w in old], new, autojunk=False)
    for op, i1, _, j1, j2 in sm.get_opcodes():
        if op == "equal":
            out[j1:j2] = [dict(w) for w in old[i1:i1 + j2 - j1]]
    j = 0
    while j < len(out):
        if out[j] is not None:
            j += 1
            continue
        k = next((x for x in range(j, len(out)) if out[x] is not None), len(out))
        lo = out[j - 1]["end"] if j else seg_start
        hi = max(out[k]["start"] if k < len(out) else seg_end, lo)
        step = (hi - lo) / (k - j)
        out[j:k] = [{"text": new[x], "start": round(lo + step * (x - j), 2), "end": round(lo + step * (x - j + 1), 2), "approx": True} for x in range(j, k)]
        j = k
    return out
