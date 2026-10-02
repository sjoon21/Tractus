"""Phase 0 ASR 어댑터. 네 모델을 같은 호출 형태(transcribe)로 감싼다."""

from pathlib import Path

import mlx.core as mx
import numpy as np
from mlx_audio.stt.utils import load

MODELS_DIR = Path(__file__).resolve().parent.parent / "models"

# 벤치마크 이름 -> (models/ 아래 디렉터리, 모델 계열)
MODELS = {
    "qwen3-1.7b": ("qwen3-asr-1.7b-8bit", "qwen"),
    "qwen3-0.6b": ("qwen3-asr-0.6b-8bit", "qwen"),
    "whisper-turbo": ("whisper-large-v3-turbo", "whisper"),
    "nemotron-0.6b": ("nemotron-3.5-asr-streaming-0.6b", "nemotron"),
}

# 언어 코드(ko/en)를 모델별 표기로 바꾼다. None이면 자동 감지.
LANG = {
    "qwen": {"ko": "Korean", "en": "English"},
    "whisper": {"ko": "ko", "en": "en"},
    "nemotron": {"ko": "ko-KR", "en": "en-US"},
}


class ASR:
    def __init__(self, name: str):
        subdir, self.family = MODELS[name]
        self.name = name
        self.model = load(str(MODELS_DIR / subdir))

    def transcribe(self, audio: np.ndarray, lang: str | None = None, glossary: list[str] | None = None) -> str:
        language = LANG[self.family][lang] if lang else None
        x = mx.array(audio.astype(np.float32))
        if self.family == "qwen":
            out = self.model.generate(x, language=language, hotwords=glossary or None)
        elif self.family == "whisper":
            prompt = ", ".join(glossary) if glossary else None
            out = self.model.generate(x, language=language, initial_prompt=prompt, verbose=False)
        else:
            if glossary:
                raise ValueError("Nemotron(RNN-T)은 용어집 프롬프트를 받지 않는다")
            # 청크(≤60초)를 한 번에 디코딩. 기본 attention context [56,13] = 1.12초 청크 설정.
            out = self.model.generate(x, language=language or "auto", chunk_duration=None)
        return out.text.strip()
