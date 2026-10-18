"""앱·문서로 나가는 문장의 언어 (docs/desktop.md §3.8). 한국어 문장이 원본이자 키다: `t("노트 {n}개", n=3)`.

언어는 `TRACTUS_LANG`(앱이 화면 언어로 정해 넘긴다)이 `en`일 때만 영어, 그 밖은 한국어다. 셸의 `LANG`은 보지 않는다
(한국어 사용자의 터미널도 흔히 `en_US.UTF-8`이다). 영어는 `i18n_en.json`에 두고, 값이 `[한 개, 여러 개]`면 `n`으로 고른다.
`tests/test_i18n.py`가 빠진 번역과 t() 밖에 남은 한국어 문자열을 잡는다(언어와 상관없는 데이터·LLM 프롬프트는 줄 끝 `# i18n-ok`).
"""

from __future__ import annotations

import json
import os
import re
from functools import cache
from pathlib import Path

_VAR = re.compile(r"\{(\w+)\}")


def lang() -> str:
    return "en" if os.environ.get("TRACTUS_LANG", "").strip().lower() == "en" else "ko"


@cache
def _dict() -> dict[str, str | list[str]]:
    return json.loads((Path(__file__).with_name("i18n_en.json")).read_text(encoding="utf-8"))


def t(ko: str, **vars: object) -> str:
    s: str = ko
    if lang() == "en":
        e = _dict().get(ko)
        if isinstance(e, str):
            s = e
        elif isinstance(e, list) and len(e) == 2:
            s = e[0] if vars.get("n") == 1 else e[1]
    return _VAR.sub(lambda m: str(vars[m.group(1)]) if m.group(1) in vars else m.group(0), s) if vars else s


# 영어 화면에서 AI 결과(요약·노트 완성)의 언어 규칙. 프롬프트는 한국어 그대로 두고 언어 규칙 한 줄만 바꾼다 (ARCHITECTURE v3.46)
EN_OUTPUT_RULE = "- 결과는 모두 영어(English)로 쓴다. 노트가 다른 언어여도 영어로 옮겨 쓰고, 영어 기술 용어는 원문 표기를 살린다."  # i18n-ok: AI 프롬프트


def ai_prompt(prompt: str, ko_rule: str) -> str:
    """영어 화면이면 프롬프트의 결과 언어 규칙(ko_rule, '노트에서 쓰인 언어로 쓴다' 줄)을 영어로 쓰라는 규칙으로 바꾼다. 한국어 화면은 그대로다."""
    if lang() != "en":
        return prompt
    if ko_rule not in prompt:
        raise ValueError("결과 언어 규칙이 프롬프트에 없습니다")  # i18n-ok: 개발자 오류 (프롬프트와 규칙 상수가 어긋남)
    return prompt.replace(ko_rule, EN_OUTPUT_RULE)
