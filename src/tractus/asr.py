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

# 자주 쓰는 단어(hotwords) 안전장치 (2026-10-18 리서치, ARCHITECTURE v3.51). Qwen3-ASR의 context는 공식적으로 "실험적"이다.
HOTWORD_MIN_S = 1.0  # 이보다 짧은 청크에는 넣지 않는다: 무음·짧은 소리에서 목록을 그대로 받아 적는다 (QwenLM/Qwen3-ASR issue #186)
HOTWORDS_MAX = 50  # 방해 단어가 100개를 넘으면 크게 나빠진다 (Huber & Waibel, arXiv 2608.05759). 앞에 둔 것이 먼저 남는다
ECHO_MIN_TERMS = 3  # 서로 다른 단어가 이만큼 나오고
ECHO_COVER = 0.8  # 출력 글자의 이만큼을 덮으면 목록을 받아 적은 것으로 본다 (용어가 많은 정상 문장도 절반 넘게 덮는다)
LOOP_RETRY_TEMPERATURE = 0.3
# 짧은 한국어 맞장구("네", "음", "아 맞아요")를 중국어·일본어로 감지해 한자로 받아 적는다 (실제 회의 노트 2026-10-18: 앞 70줄 중 3줄).
# ponytail: 짧은 청크·중국어/일본어 감지만 한국어로 다시 한다. 정말 중국어·일본어 회의면 짧은 맞장구가 한국어가 된다 (노트 전체 언어로 판단하게 바꿀 때까지)
MISDETECT_MAX_S = 5.0
MISDETECT_LANGS = {"zh", "ja"}  # 반복 루프가 난 청크만 한 번 더 (탐욕 디코딩이 같은 루프에 다시 빠지지 않게)


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


def echoes_hotwords(text: str, hotwords: list[str]) -> bool:
    """출력이 자주 쓰는 단어 목록을 받아 적은 것 같은가: 서로 다른 단어 ECHO_MIN_TERMS개 이상이 출력 글자의 ECHO_COVER 이상을 덮는다."""
    low = text.lower()
    found = [h for h in dict.fromkeys(hotwords) if h.strip() and h.lower() in low]
    if len(found) < ECHO_MIN_TERMS:
        return False
    body = re.sub(r"[\s,.、·]", "", text)
    return sum(len(re.sub(r"\s", "", h)) for h in found) >= ECHO_COVER * max(len(body), 1)


# 노트에서 고른 용어 (v3.53): 제목·녹음 중 메모·내가 쓴 메모의 낱말을 그 노트 변환의 hotwords 끝에 붙인다.
# 사용자가 자주 쓰는 단어를 거의 채우지 않는다(실제 노트 0개). 흔한 말은 빼고, 자주 쓰는 단어보다 뒤라 상한(HOTWORDS_MAX)에 먼저 잘린다
NOTE_TERMS_MAX = 20
_JOSA = ("에서는", "에서", "으로", "이랑", "한테", "까지", "부터", "처럼", "보다", "에게", "로", "를", "을", "이", "가", "은", "는", "에", "와", "과", "도", "의", "랑", "만")  # i18n-ok: 조사 (데이터)
_COMMON = {"회의", "미팅", "메모", "녹음", "노트", "오늘", "내일", "어제", "다음", "이번", "지난", "확인", "정리", "논의", "관련", "진행", "공유", "그리고", "그래서", "하지만", "예시", "recording", "memo", "meeting", "note", "the", "and", "for", "with"}  # i18n-ok: 흔한 말 (데이터)


def note_terms(*texts: str) -> list[str]:
    """노트의 글(제목·메모)에서 용어 후보: 영문·숫자가 섞인 낱말과 두 글자 이상 한글 낱말(조사를 뗀다). 흔한 말·숫자·시각은 뺀다. 처음 나온 순서로 NOTE_TERMS_MAX개"""
    out: list[str] = []
    for text in texts:
        for raw in (text or "").split():
            w = raw.strip(".,!?;:()[]{}\"'“”‘’「」『』·-–—~*#>")
            if re.search(r"[가-힣]$", w):  # i18n-ok: 한글 판별
                w = next((w[: -len(j)] for j in _JOSA if w.endswith(j) and len(w) - len(j) >= 2), w)
            keep = len(w) >= 2 and not re.fullmatch(r"[\d:./%]+", w) and (re.search(r"[A-Za-z]", w) or re.fullmatch(r"[가-힣]+", w))  # i18n-ok: 한글 판별
            if keep and w.lower() not in _COMMON and w not in out:
                out.append(w)
            if len(out) >= NOTE_TERMS_MAX:
                return out
    return out


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

    def _generate(self, audio, language: str | None, hotwords: list[str] | None, max_tokens: int, temperature: float = 0.0):
        import mlx.core as mx

        x = mx.array(np.asarray(audio, dtype=np.float32))
        extra = {"temperature": temperature} if temperature else {}
        return self.model.generate(x, language=language, hotwords=hotwords or None, max_tokens=max_tokens, **extra)

    def transcribe(self, audio, language: str | None = None, hotwords: list[str] | None = None) -> Segment:
        """language: None(자동 감지) | "ko" | "en"."""
        cap = max_tokens_for(len(audio) / SR)
        name = LANGUAGE_NAMES[language] if language else None
        hw = (hotwords or [])[:HOTWORDS_MAX] if len(audio) / SR >= HOTWORD_MIN_S else []
        out = self._generate(audio, name, hw, cap)
        repaired = False
        if hw and echoes_hotwords(out.text, hw):  # 목록을 받아 적었다: 이 청크만 단어 없이 다시
            out, hw, repaired = self._generate(audio, name, None, cap), [], True
        looped = has_loop(out.text) or out.generation_tokens >= cap
        if looped and name is not None:
            # 언어 고정 시 영어 발화를 번역하다 루프에 빠지는 경우가 많다(Phase 0). 자동 감지로 한 번 더 시도한다.
            out = self._generate(audio, None, hotwords, cap)
            looped = has_loop(out.text) or out.generation_tokens >= cap
            text = collapse_repeats(out.text) if looped else out.text.strip()
            return Segment(text=text, lang=_lang_code(out.language), repaired=True)
        if not looped and name is None and len(audio) / SR < MISDETECT_MAX_S and _lang_code(out.language) in MISDETECT_LANGS:
            ko = self._generate(audio, LANGUAGE_NAMES["ko"], hw, cap)
            if not (has_loop(ko.text) or ko.generation_tokens >= cap):
                return Segment(text=ko.text.strip(), lang="ko", repaired=True)
        if looped:
            retry = self._generate(audio, None, hw, cap, LOOP_RETRY_TEMPERATURE)
            if not (has_loop(retry.text) or retry.generation_tokens >= cap):
                return Segment(text=retry.text.strip(), lang=_lang_code(retry.language), repaired=True)
            return Segment(text=collapse_repeats(out.text), lang=_lang_code(out.language), repaired=True)
        return Segment(text=out.text.strip(), lang=_lang_code(out.language) or language, repaired=repaired)
