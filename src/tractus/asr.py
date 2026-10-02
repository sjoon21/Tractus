"""Qwen3-ASR 청크 전사와 반복 루프 방지.

mlx-audio를 프로세스 안에서 호출한다. `mlx_audio.server`의 HTTP 엔드포인트는 `hotwords`를 모델까지
전달하지 않아 용어집(Phase 0: 용어 재현율 72% → 84%)을 쓸 수 없기 때문이다.
"""

import math
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np

SR = 16000

# Phase 0 실측: 정상 발화 p99는 오디오 1초당 6.4토큰, 반복 루프는 31–731토큰. 약 2.5배 여유를 둔다.
TOKENS_PER_SEC_CAP = 16
TOKENS_BASE = 32

LANGUAGE_NAMES = {"ko": "Korean", "en": "English"}
LANGUAGE_CODES = {"korean": "ko", "english": "en", "japanese": "ja", "chinese": "zh"}

_LOOP = re.compile(r"(.{4,}?)(?:\1){2,}", re.DOTALL)


@dataclass(frozen=True)
class Segment:
    text: str
    lang: str | None
    repaired: bool = False  # 반복 루프를 감지해 재시도하거나 잘라냈는지


def max_tokens_for(duration_s: float) -> int:
    return math.ceil(duration_s * TOKENS_PER_SEC_CAP) + TOKENS_BASE


def has_loop(text: str) -> bool:
    """4글자 이상 문자열이 연속 3회 이상 반복되면 루프로 본다."""
    return _LOOP.search(text + " ") is not None


def collapse_repeats(text: str) -> str:
    """연속 반복을 한 번만 남긴다. 끝에 공백을 붙여 마지막 반복("…다. …다. …다.")도 같은 단위로 잡는다."""
    return re.sub(r"\s+", " ", _LOOP.sub(r"\1", text + " ")).strip()


def _lang_code(name: str | list[str] | None) -> str | None:
    if isinstance(name, list):  # mlx-audio Qwen3-ASR은 감지 언어를 ["Korean"]처럼 목록으로 돌려준다
        name = name[0] if name else None
    if not name:
        return None
    return LANGUAGE_CODES.get(name.lower(), name.lower())


class Transcriber:
    def __init__(self, model):
        self.model = model

    @classmethod
    def load(cls, model_dir: Path) -> "Transcriber":
        from mlx_audio.stt.utils import load

        return cls(load(str(model_dir)))

    def _generate(self, audio, language: str | None, hotwords: list[str] | None, max_tokens: int):
        import mlx.core as mx

        x = mx.array(np.asarray(audio, dtype=np.float32))
        return self.model.generate(x, language=language, hotwords=hotwords or None, max_tokens=max_tokens)

    def transcribe(self, audio, language: str | None = None, hotwords: list[str] | None = None) -> Segment:
        """language: None(자동 감지) | "ko" | "en"."""
        cap = max_tokens_for(len(audio) / SR)
        name = LANGUAGE_NAMES[language] if language else None
        out = self._generate(audio, name, hotwords, cap)
        looped = has_loop(out.text) or out.generation_tokens >= cap
        if looped and name is not None:
            # 언어 고정 시 영어 발화를 번역하다 루프에 빠지는 경우가 많다(Phase 0). 자동 감지로 한 번 더 시도한다.
            out = self._generate(audio, None, hotwords, cap)
            looped = has_loop(out.text) or out.generation_tokens >= cap
            text = collapse_repeats(out.text) if looped else out.text.strip()
            return Segment(text=text, lang=_lang_code(out.language), repaired=True)
        if looped:
            return Segment(text=collapse_repeats(out.text), lang=_lang_code(out.language), repaired=True)
        return Segment(text=out.text.strip(), lang=_lang_code(out.language) or language)
