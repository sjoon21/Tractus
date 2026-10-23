"""AI 프롬프트 문구 (`prompts/<기능>.md`). 조립(메모 블록 붙이기, 영어 화면 규칙, 값 채우기)은 각 기능 모듈이 한다.

파일 형식: 맨 위 `# 제목`과 설명은 읽지 않는다. `## 이름` 줄부터 다음 `## 이름` 줄 전까지가 블록 하나이고, 앞뒤 빈 줄은 뺀다.
블록 안의 `{{이름}}`은 같은 파일의 그 블록으로 바꾼다(한 단계만). 없는 이름이면 KeyError.
"""

from __future__ import annotations

import re
from functools import cache
from pathlib import Path

_HEAD = re.compile(r"^## ([a-z_]+)\n", re.M)
_REF = re.compile(r"\{\{(\w+)\}\}")


@cache
def load(name: str) -> dict[str, str]:
    text = (Path(__file__).parent / f"{name}.md").read_text(encoding="utf-8")
    parts = _HEAD.split(text)[1:]  # [이름, 본문, 이름, 본문, …]
    raw = {k: v.strip("\n") for k, v in zip(parts[::2], parts[1::2])}
    return {k: _REF.sub(lambda m: raw[m.group(1)], v) for k, v in raw.items()}
