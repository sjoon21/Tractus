"""청크 전사와 반복 루프 방지. 기본 엔진은 Qwen3-ASR이고, 같은 흐름으로 다른 계열(Whisper·SenseVoice)도 돈다 (docs/design/asr-engines.md).

mlx-audio를 프로세스 안에서 호출한다. `mlx_audio.server`의 HTTP 엔드포인트는 `hotwords`를 모델까지
전달하지 않아 용어집(Phase 0: 용어 재현율 72% → 84%)을 쓸 수 없기 때문이다.
계열마다 다른 것은 `Engine`(호출 인자·자주 쓰는 단어·언어 오감지 재시도)뿐이고, 반복 루프 재시도·접기는 공통이다.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, replace
from pathlib import Path
from typing import TYPE_CHECKING

from tractus import itn

if TYPE_CHECKING:
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
class Engine:
    """변환 엔진 계열 하나. model_types: 모델 폴더 config.json의 model_type 값."""

    family: str
    model_types: tuple[str, ...]
    hotwords: bool  # 자주 쓰는 단어를 모델에 넣는가
    misdetect_retry: bool  # 짧은 청크의 중국어·일본어 오감지를 한국어로 다시 하는가 (Qwen3-ASR 실측)
    token_cap: bool  # generation_tokens로 상한을 보는가 (자기회귀 디코더가 토큰 수를 알려 줄 때)


ENGINES: dict[str, Engine] = {
    "qwen3": Engine("qwen3", ("qwen3_asr",), hotwords=True, misdetect_retry=True, token_cap=True),
    # Phase 0: 영어 용어를 initial_prompt로 주면 출력이 영어로 끌려가 CER 16.7 → 58.3. 한국어 파인튜닝판도 측정 전까지 넣지 않는다
    "whisper": Engine("whisper", ("whisper",), hotwords=False, misdetect_retry=False, token_cap=False),
    "sensevoice": Engine("sensevoice", ("sensevoice",), hotwords=False, misdetect_retry=False, token_cap=False),  # CTC: 프롬프트가 없다
}


def engine_of(model_dir: Path) -> Engine:
    """모델 폴더의 계열 (config.json의 model_type). 모르는 계열은 ValueError: 지원하지 않는 모델을 조용히 Qwen처럼 부르지 않는다."""
    try:
        kind = str(json.loads((model_dir / "config.json").read_text(encoding="utf-8")).get("model_type") or "")
    except (OSError, ValueError, AttributeError):
        kind = ""
    if not kind:
        return ENGINES["qwen3"]  # 옛 직접 만든 폴더·테스트 픽스처 (config.json에 model_type이 없다)
    found = next((e for e in ENGINES.values() if kind in e.model_types), None)
    if found is None:
        raise ValueError(f"지원하지 않는 변환 엔진 계열입니다: model_type={kind} ({', '.join(t for e in ENGINES.values() for t in e.model_types)})")  # i18n-ok: 개발자 오류 (앱은 등록·직접 추가할 때 계열을 검사한다)
    return found


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
    def __init__(self, model, engine: Engine | str = "qwen3"):
        self.model = model
        self.engine = ENGINES[engine] if isinstance(engine, str) else engine

    @classmethod
    def load(cls, model_dir: Path) -> "Transcriber":
        from mlx_audio.stt.utils import load

        engine = engine_of(model_dir)
        return cls(load(str(model_dir)), engine)

    def _generate(self, audio, language: str | None, hotwords: list[str] | None, max_tokens: int, temperature: float = 0.0):
        """language: 계열의 표기 (_lang_arg). 계열마다 generate 인자가 다르다."""
        import numpy as np
        import mlx.core as mx

        x = mx.array(np.asarray(audio, dtype=np.float32))
        if self.engine.family == "whisper":  # 청크마다 따로 (앞 청크 글을 이어 붙이지 않는다: 오류 전파). 온도 재시도는 Whisper가 스스로 한다
            extra = {"temperature": temperature} if temperature else {}
            return self.model.generate(x, language=language, condition_on_previous_text=False, verbose=False, **extra)
        if self.engine.family == "sensevoice":
            return self.model.generate(x, language=language or "auto", use_itn=True)
        extra = {"temperature": temperature} if temperature else {}
        return self.model.generate(x, language=language, hotwords=hotwords or None, max_tokens=max_tokens, **extra)

    def _lang_arg(self, code: str | None) -> str | None:
        """ko | en | None → 계열의 언어 표기 (Qwen3-ASR은 Korean·English, 나머지는 코드 그대로)."""
        if code is None:
            return None
        return LANGUAGE_NAMES[code] if self.engine.family == "qwen3" else code

    def _capped(self, out, cap: int) -> bool:
        return has_loop(out.text) or (self.engine.token_cap and out.generation_tokens >= cap)

    def transcribe(self, audio, language: str | None = None, hotwords: list[str] | None = None) -> Segment:
        """language: None(자동 감지) | "ko" | "en". 한글로 적힌 한자어 수는 숫자로 바꾼다 (itn.korean_numbers, 모든 계열·실시간 자막 공통)."""
        seg = self._transcribe(audio, language, hotwords)
        return replace(seg, text=itn.korean_numbers(seg.text))

    def _transcribe(self, audio, language: str | None, hotwords: list[str] | None) -> Segment:
        cap = max_tokens_for(len(audio) / SR)
        name = self._lang_arg(language)
        hotwords = hotwords if self.engine.hotwords else None
        hw = (hotwords or [])[:HOTWORDS_MAX] if len(audio) / SR >= HOTWORD_MIN_S else []
        out = self._generate(audio, name, hw, cap)
        repaired = False
        if hw and echoes_hotwords(out.text, hw):  # 목록을 받아 적었다: 이 청크만 단어 없이 다시
            out, hw, repaired = self._generate(audio, name, None, cap), [], True
        looped = self._capped(out, cap)
        if looped and name is not None:
            # 언어 고정 시 영어 발화를 번역하다 루프에 빠지는 경우가 많다(Phase 0). 자동 감지로 한 번 더 시도한다.
            out = self._generate(audio, None, hotwords, cap)
            looped = self._capped(out, cap)
            text = collapse_repeats(out.text) if looped else out.text.strip()
            return Segment(text=text, lang=_lang_code(out.language), repaired=True)
        if self.engine.misdetect_retry and not looped and name is None and len(audio) / SR < MISDETECT_MAX_S and _lang_code(out.language) in MISDETECT_LANGS:
            ko = self._generate(audio, self._lang_arg("ko"), hw, cap)
            if not (self._capped(ko, cap)):
                return Segment(text=ko.text.strip(), lang="ko", repaired=True)
        if looped:
            retry = self._generate(audio, None, hw, cap, LOOP_RETRY_TEMPERATURE)
            if not (self._capped(retry, cap)):
                return Segment(text=retry.text.strip(), lang=_lang_code(retry.language), repaired=True)
            return Segment(text=collapse_repeats(out.text), lang=_lang_code(out.language), repaired=True)
        return Segment(text=out.text.strip(), lang=_lang_code(out.language) or language, repaired=repaired)
