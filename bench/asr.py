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
    # 2026-10-29 측정 전용: LiquidAI/LFM3-Audio-2B-MLX-8bit (mlx-vlm, LFM Open License v1.0: 연 매출 1천만 달러 이상 상업 사용 불가)
    "lfm3-audio-2b": ("lfm3-audio-2b-mlx-8bit", "lfm3"),
}

# 언어 코드(ko/en)를 모델별 표기로 바꾼다. None이면 자동 감지.
LANG = {
    "qwen": {"ko": "Korean", "en": "English"},
    "whisper": {"ko": "ko", "en": "en"},
    "nemotron": {"ko": "ko-KR", "en": "en-US"},
    "sensevoice": {"ko": "ko", "en": "en"},
    "lfm3": {"ko": "Korean", "en": "English"},
}

# LFM3는 토큰 상한이 없으면 반복 루프가 끝없이 간다. 앱(src/tractus/asr.py)의 상한과 같은 식: 오디오 1초당 16토큰 + 32
LFM3_TOKENS_PER_SEC, LFM3_TOKENS_BASE = 16, 32


class ASR:
    def __init__(self, name: str):
        subdir, self.family = MODELS[name]
        self.name = name
        if self.family == "lfm3":  # mlx-vlm은 LFM3를 쓸 때만 불러온다
            import mlx_vlm

            self.model, self.processor = mlx_vlm.load(str(MODELS_DIR / subdir))
        else:
            self.model = load(str(MODELS_DIR / subdir))

    def transcribe(self, audio: np.ndarray, lang: str | None = None, glossary: list[str] | None = None) -> str:
        language = LANG[self.family][lang] if lang else None
        x = mx.array(audio.astype(np.float32))
        if self.family == "qwen":
            out = self.model.generate(x, language=language, hotwords=glossary or None)
        elif self.family == "whisper":
            prompt = ", ".join(glossary) if glossary else None
            out = self.model.generate(x, language=language, initial_prompt=prompt, verbose=False)
        elif self.family == "lfm3":
            # 용어집(hotwords) 방법이 없어 무시한다. 모델 카드의 ASR 시스템 프롬프트, 사용자 글은 비우고 오디오만
            from mlx_vlm import generate
            from mlx_vlm.prompt_utils import apply_chat_template

            system = f"Perform ASR in {language}." if language else "Perform ASR."
            prompt = apply_chat_template(self.processor, self.model.config, [{"role": "system", "content": system}, ""], num_audios=1)
            cap = int(len(audio) / 16000 * LFM3_TOKENS_PER_SEC) + LFM3_TOKENS_BASE
            out = generate(self.model, self.processor, prompt, audio=[audio.astype(np.float32)], temperature=0.0, max_tokens=cap)
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
