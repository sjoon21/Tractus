"""ASR 어댑터 (Phase 0 + 0.4.2 한국어 후보). 모델들을 같은 호출 형태(transcribe)로 감싼다."""

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
    # 한국어 특화 후보 (2026-10-21, 0.4.2 모델 교체 검토). Whisper 계열은 HF 원본을 mlx_audio.convert로 8bit 변환
    "buzz-ko": ("buzzasr-ko-8bit", "whisper"),  # BuzzASR/korean (large-v3, MIT)
    "ghost613-turbo-ko": ("ghost613-turbo-ko-8bit", "whisper"),  # ghost613/whisper-large-v3-turbo-korean (라이선스 표기 없음)
    "seastar-medium-ko": ("seastar-medium-ko-8bit", "whisper"),  # seastar105/whisper-medium-komixv2 (AI Hub 회의 데이터로 학습: aihub 지표 오염)
    "sorimac-1.7b": ("sorimac-ko-1.7b-8bit", "qwen"),  # Sorimac/Sorimac-V2.1-Korean-1.7B-MLX-8bit (Qwen3-ASR 한국어 파인튜닝, 라이선스 표기 없음)
    "sensevoice": ("sensevoice-small", "sensevoice"),  # mlx-community/SenseVoiceSmall (FunASR Model License)
}

# 언어 코드(ko/en)를 모델별 표기로 바꾼다. None이면 자동 감지.
LANG = {
    "qwen": {"ko": "Korean", "en": "English"},
    "whisper": {"ko": "ko", "en": "en"},
    "nemotron": {"ko": "ko-KR", "en": "en-US"},
    "sensevoice": {"ko": "ko", "en": "en"},
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
        elif self.family == "sensevoice":
            if glossary:
                raise ValueError("SenseVoice(CTC)는 용어집 프롬프트를 받지 않는다")
            out = self.model.generate(x, language=language or "auto", use_itn=True)
        else:
            if glossary:
                raise ValueError("Nemotron(RNN-T)은 용어집 프롬프트를 받지 않는다")
            # 청크(≤60초)를 한 번에 디코딩. 기본 attention context [56,13] = 1.12초 청크 설정.
            out = self.model.generate(x, language=language or "auto", chunk_duration=None)
        return out.text.strip()
