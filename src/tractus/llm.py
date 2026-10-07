"""OpenAI 호환 Chat Completions로 구조화 출력을 받는다 (ARCHITECTURE.md §3).

최소 공통분모 설계: 스키마는 항상 system 프롬프트에 넣고, 응답을 Pydantic으로 검증하고, 실패하면
오류를 붙여 1회 재요청한다. `json_schema`를 지원하는 공급자에는 `response_format`(strict)을 추가로 붙인다.
"""

import copy
import json
import os
import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import TypeVar

from pydantic import BaseModel, ValidationError

T = TypeVar("T", bound=BaseModel)
TEMPERATURE = 0.2  # 0–1 범위만 사용 (Claude 호환 레이어는 1 초과를 잘라냄)
TIMEOUT_S = 300


class LLMError(RuntimeError):
    """code: 앱이 WORDS.md 문장으로 바꾸는 오류 코드 (llm_config | llm_local_only | llm_invalid)."""

    def __init__(self, message: str, code: str = "llm_config"):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Provider:
    name: str
    base_url: str
    api_key_env: str | None
    default_model: str | None
    json_schema: bool  # response_format json_schema(strict) 지원 여부
    local: bool = False


# 모델 ID는 바뀌므로 기본값이 확실하지 않은 공급자는 TRACTUS_LLM_MODEL 또는 --model로 지정하게 한다.
PROVIDERS = {
    p.name: p
    for p in (
        Provider("upstage", "https://api.upstage.ai/v1", "UPSTAGE_API_KEY", "solar-pro4", json_schema=True),
        Provider("openai", "https://api.openai.com/v1", "OPENAI_API_KEY", None, json_schema=True),
        Provider("claude", "https://api.anthropic.com/v1/", "ANTHROPIC_API_KEY", "claude-sonnet-5-5", json_schema=False),
        Provider("gemini", "https://generativelanguage.googleapis.com/v1beta/openai/", "GEMINI_API_KEY", None, json_schema=True),
        Provider("gemma-local", "http://localhost:11434/v1", None, "gemma4:31b", json_schema=True, local=True),
    )
}


def resolve_provider(name: str | None, model: str | None) -> tuple[Provider, str]:
    name = name or os.environ.get("TRACTUS_LLM_PROVIDER")
    if not name:
        raise LLMError(f"AI 서비스를 지정하세요: --provider 또는 TRACTUS_LLM_PROVIDER ({', '.join(PROVIDERS)})")
    if name not in PROVIDERS:
        raise LLMError(f"알 수 없는 AI 서비스 {name!r}. 가능한 값: {', '.join(PROVIDERS)}")
    provider = PROVIDERS[name]
    if local_only() and not provider.local:
        raise LLMError(f"로컬 전용 모드(TRACTUS_LOCAL_ONLY)에서는 외부 AI 서비스 {name}를 쓸 수 없습니다", code="llm_local_only")
    if provider.api_key_env and not os.environ.get(provider.api_key_env):
        raise LLMError(f"{provider.api_key_env}가 없습니다. .env.local에 넣거나 환경변수로 지정하세요")
    model = model or os.environ.get("TRACTUS_LLM_MODEL") or provider.default_model
    if not model:
        raise LLMError(f"{name}는 기본 AI 모델이 없습니다. --model 또는 TRACTUS_LLM_MODEL로 AI 모델 ID를 지정하세요")
    return provider, model


def local_only() -> bool:
    """비어 있거나 0/false/no/off가 아니면 켜진 것으로 본다 (오타가 원격 전송을 허용하지 않도록 닫힌 쪽으로)."""
    return os.environ.get("TRACTUS_LOCAL_ONLY", "").strip().lower() not in ("", "0", "false", "no", "off")


def make_client(provider: Provider):
    from openai import OpenAI

    key = os.environ.get(provider.api_key_env) if provider.api_key_env else "local"
    return OpenAI(base_url=provider.base_url, api_key=key, timeout=TIMEOUT_S, max_retries=2)


def strict_schema(model: type[BaseModel]) -> dict:
    """Pydantic 스키마를 OpenAI strict 규약에 맞춘다: 모든 객체에 additionalProperties=false,
    모든 속성을 required에, default 제거. 값이 없을 수 있는 필드는 `X | None`으로 null을 허용한다."""
    schema = copy.deepcopy(model.model_json_schema())

    def fix(node):
        if isinstance(node, dict):
            node.pop("default", None)
            if node.get("type") == "object" and "properties" in node:
                node["additionalProperties"] = False
                node["required"] = list(node["properties"])
            for v in node.values():
                fix(v)
        elif isinstance(node, list):
            for v in node:
                fix(v)

    fix(schema)
    return schema


def _extract_json(text: str) -> str:
    """```json … ``` 코드 펜스로 감싼 응답도 받는다."""
    m = re.search(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL)
    return m.group(1) if m else text.strip()


def complete_json(
    client,
    provider: Provider,
    model: str,
    system: str,
    user: str,
    schema: type[T],
    validate: Callable[[T], None] | None = None,
) -> T:
    """구조화 응답을 받아 검증한다. 스키마·validate 실패 시 오류를 알려 주고 1회 재요청한다."""
    spec = strict_schema(schema)
    system = f"{system}\n\n반드시 아래 JSON Schema를 따르는 JSON 객체 하나만 출력한다. 설명이나 코드 펜스를 붙이지 않는다.\n{json.dumps(spec, ensure_ascii=False)}"
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    extra = {"response_format": {"type": "json_schema", "json_schema": {"name": schema.__name__, "strict": True, "schema": spec}}} if provider.json_schema else {}

    error = None
    for _ in range(2):
        resp = client.chat.completions.create(model=model, messages=messages, temperature=TEMPERATURE, **extra)
        if not resp.choices:  # 안전 필터 차단 등으로 choices가 비는 공급자가 있다
            error = "빈 응답 (choices 없음)"
            continue
        text = resp.choices[0].message.content or ""
        try:
            parsed = schema.model_validate_json(_extract_json(text))
            if validate:
                validate(parsed)
            return parsed
        except (ValidationError, ValueError) as e:
            error = str(e)
            messages = [
                *messages,
                {"role": "assistant", "content": text},
                {"role": "user", "content": f"응답이 검증에 실패했습니다:\n{error}\n스키마와 조건에 맞는 JSON만 다시 출력하세요."},
            ]
    raise LLMError(f"{provider.name}/{model} 응답이 2회 연속 검증에 실패했습니다: {error}", code="llm_invalid")


def stream_chat(client, model: str, messages: list[dict]) -> Iterator[str]:
    """평문 응답을 토큰 조각 단위로 흘려 준다 (`stream=True`). 빈 choices·None 조각은 건너뛴다."""
    for chunk in client.chat.completions.create(model=model, messages=messages, temperature=TEMPERATURE, stream=True):
        if chunk.choices and (text := chunk.choices[0].delta.content):
            yield text
