"""OpenAI 호환 Chat Completions로 구조화 출력을 받는다 (ARCHITECTURE.md §3).

최소 공통분모 설계: 스키마는 항상 system 프롬프트에 넣고, 응답을 Pydantic으로 검증하고, 실패하면
오류를 붙여 1회 재요청한다. `json_schema`를 지원하는 공급자에는 `response_format`(strict)을 추가로 붙인다.
"""

from __future__ import annotations

import copy
import json
import os
import re
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, TypeVar
from urllib.parse import urlsplit

from tractus import prompts
from tractus.i18n import t

if TYPE_CHECKING:
    from pydantic import BaseModel

T = TypeVar("T", bound="BaseModel")  # pydantic은 구조화 응답을 받을 때만 불러온다 (CLI 시작 시간)
TEMPERATURE = 0.2  # 0–1 범위만 사용 (Claude 호환 레이어는 1 초과를 잘라냄)
TIMEOUT_S = 300
TEST_TIMEOUT_S = 30  # `tractus llm test`: 재시도 없이 한 번
TEST_MAX_TOKENS = 256  # 너무 작으면 생각하는 AI가 답을 못 낸다 (그래도 200이면 성공으로 센다)
LOOPBACK_HOSTS = ("localhost", "127.0.0.1", "::1")


class LLMError(RuntimeError):
    """code: 앱이 WORDS.md 문장으로 바꾸는 오류 코드
    (llm_config | llm_local_only | llm_invalid | llm_auth | llm_rate | llm_busy | llm_model | llm_context | llm_conn | llm_api)."""

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
    temperature: float | None = TEMPERATURE  # None이면 요청에 온도를 싣지 않는다


# 모델 ID는 바뀌므로 기본값이 확실하지 않은 공급자는 TRACTUS_LLM_MODEL 또는 --model로 지정하게 한다.
PROVIDERS = {
    p.name: p
    for p in (
        Provider("upstage", "https://api.upstage.ai/v1", "UPSTAGE_API_KEY", "solar-pro4", json_schema=True),
        # gpt-5·o 계열은 기본값이 아닌 온도를 400으로 거절한다 (모델 이름을 사용자가 고르므로 보내지 않는다)
        Provider("openai", "https://api.openai.com/v1", "OPENAI_API_KEY", None, json_schema=True, temperature=None),
        # Claude 호환 레이어는 Claude 4.7 이상에서 온도 1 미만을 400으로 거절한다: 온도를 보내지 않는다
        Provider("claude", "https://api.anthropic.com/v1/", "ANTHROPIC_API_KEY", "claude-sonnet-5-5", json_schema=False, temperature=None),
        # gemini-2.5-flash는 새 사용자에게 404라서(2026-10-15) 항상 최신 flash를 가리키는 별칭을 기본으로 둔다
        Provider("gemini", "https://generativelanguage.googleapis.com/v1beta/openai/", "GEMINI_API_KEY", "gemini-flash-latest", json_schema=True),
        Provider("gemma-local", "http://localhost:11434/v1", None, "gemma4:31b", json_schema=True, local=True),
        # 직접 입력(OpenAI 호환): 주소는 TRACTUS_LLM_BASE_URL, 모델은 TRACTUS_LLM_MODEL로 반드시 지정. 키는 이 주소가 이 Mac일 때만 비워도 된다
        Provider("custom", "", "TRACTUS_LLM_API_KEY", None, json_schema=False),
    )
}


def host_of(url: str) -> str:
    """주소의 호스트(포트가 있으면 함께). 사용자 이름·비밀번호·경로는 버린다 (화면·로그에 안전한 부분만)."""
    u = urlsplit(url)
    host = f"[{u.hostname}]" if u.hostname and ":" in u.hostname else (u.hostname or "")
    try:
        return f"{host}:{u.port}" if u.port else host
    except ValueError:
        return host


def is_loopback(url: str) -> bool:
    """urlsplit이 가른 호스트가 정확히 localhost / 127.0.0.1 / ::1인가 (localhost.evil.com, user@host 속임수는 아니다)."""
    try:
        return urlsplit(url).hostname in LOOPBACK_HOSTS
    except ValueError:
        return False


def normalize_base_url(raw: str, var: str = "TRACTUS_LLM_BASE_URL") -> str:
    """http/https + 호스트가 있는 주소만 받고 끝의 `/`를 뗀다. 사용자 이름·비밀번호가 들어 있으면 거절한다. 오류 문장에 주소를 넣지 않는다."""
    raw = raw.strip()
    bad = t("서비스 주소가 올바르지 않습니다. http:// 또는 https://로 시작하는 주소를 입력하세요 ({var})", var=var)
    if re.search(r"[\s\\\x00-\x1f]", raw):
        raise LLMError(bad)
    try:
        u = urlsplit(raw)
        u.port  # noqa: B018 — 잘못된 포트는 ValueError
    except ValueError:
        raise LLMError(bad) from None
    if u.scheme not in ("http", "https") or not u.hostname:
        raise LLMError(bad)
    if u.username is not None or u.password is not None:
        raise LLMError(t("서비스 주소에 사용자 이름이나 비밀번호를 넣을 수 없습니다. API 키는 따로 입력하세요"))
    return raw.rstrip("/")


def _env_prefix(provider: Provider) -> str | None:
    """서비스별 환경변수 접두어 (키 변수에서: UPSTAGE_API_KEY → UPSTAGE). 직접 입력·이 Mac의 AI는 없다."""
    env = provider.api_key_env
    return env.removesuffix("_API_KEY") if env and env.endswith("_API_KEY") and provider.name != "custom" else None


def resolve_provider(name: str | None, model: str | None, need_model: bool = True) -> tuple[Provider, str]:
    """주소·AI 모델 우선순위: 인수 > 전역 TRACTUS_LLM_BASE_URL·TRACTUS_LLM_MODEL(TRACTUS_LLM_PROVIDER가 이 서비스이거나 없을 때만) >
    서비스별 <P>_BASE_URL·<P>_MODEL(P: UPSTAGE·OPENAI·ANTHROPIC·GEMINI) > 표의 기본값. 직접 입력은 전역 변수가 곧 자기 변수다."""
    selected = os.environ.get("TRACTUS_LLM_PROVIDER")
    name = name or selected
    if not name:
        raise LLMError(t("AI 서비스를 지정하세요: --provider 또는 TRACTUS_LLM_PROVIDER ({choices})", choices=", ".join(PROVIDERS)))
    if name not in PROVIDERS:
        raise LLMError(t("알 수 없는 AI 서비스 {name}. 가능한 값: {choices}", name=repr(name), choices=", ".join(PROVIDERS)))
    provider = PROVIDERS[name]
    pre = _env_prefix(provider)
    use_global = name == "custom" or not selected or selected == name  # 다른 서비스를 가리키는 전역 값이 이 서비스의 키를 엉뚱한 주소로 보내지 않게
    env = lambda g, specific: (os.environ.get(g, "").strip() if use_global else "", os.environ.get(f"{pre}_{specific}", "").strip() if pre else "")  # noqa: E731
    g_base, s_base = env("TRACTUS_LLM_BASE_URL", "BASE_URL")
    if g_base or s_base:
        provider = replace(provider, base_url=normalize_base_url(g_base or s_base, "TRACTUS_LLM_BASE_URL" if g_base else f"{pre}_BASE_URL"))
    elif not provider.base_url:
        raise LLMError(t("서비스 주소가 필요합니다 (AI 서비스: {name}). TRACTUS_LLM_BASE_URL로 지정하세요", name=name))
    loopback = is_loopback(provider.base_url)
    if local_only() and not loopback:  # 이름이 아니라 호스트로 본다: 직접 입력 주소가 로컬 전용 모드를 우회하지 못하게
        raise LLMError(t("로컬 전용 모드(TRACTUS_LOCAL_ONLY)에서는 외부 AI 서비스({name})를 쓸 수 없습니다", name=name), code="llm_local_only")
    if provider.api_key_env and not os.environ.get(provider.api_key_env) and not (name == "custom" and loopback):
        raise LLMError(t("{var}가 없습니다. .env.local에 넣거나 환경변수로 지정하세요", var=provider.api_key_env))
    g_model, s_model = env("TRACTUS_LLM_MODEL", "MODEL")
    model = model or g_model or s_model or provider.default_model
    if not model and need_model:
        raise LLMError(t("기본 AI 모델이 없습니다 (AI 서비스: {name}). --model 또는 TRACTUS_LLM_MODEL로 AI 모델 ID를 지정하세요", name=name))
    return provider, model or ""


def local_only() -> bool:
    """비어 있거나 0/false/no/off가 아니면 켜진 것으로 본다 (오타가 원격 전송을 허용하지 않도록 닫힌 쪽으로)."""
    return os.environ.get("TRACTUS_LOCAL_ONLY", "").strip().lower() not in ("", "0", "false", "no", "off")


def make_client(provider: Provider, timeout: float = TIMEOUT_S, max_retries: int = 4):  # SDK가 408·409·429·5xx를 0.5→8초 간격으로 다시 보낸다 (Gemini의 일시적 503 "high demand"를 넘기려 4회)
    import httpx
    from openai import OpenAI

    key = os.environ.get(provider.api_key_env, "") if provider.api_key_env else ""
    # 3xx를 따라가지 않는다: 설정한 주소(이 Mac 확인·로컬 전용 검사가 본 곳)가 대화 내용을 다른 곳으로 넘기지 못하게
    http_client = httpx.Client(follow_redirects=False, timeout=timeout)
    return OpenAI(base_url=provider.base_url, api_key=key or "local", timeout=timeout, max_retries=max_retries, http_client=http_client)  # 키 없이 되는 곳(이 Mac의 AI)은 자리표시자


CONTEXT_RE = re.compile(r"context.{0,20}(length|window)|too (long|many tokens)|maximum.{0,20}(context|tokens)|prompt is too long", re.I)
BUSY_RE = re.compile(r"UNAVAILABLE|overloaded|high demand", re.I)
HINT_MAX = 200


def _hint(e) -> str:
    """서버가 준 안내 문장 (예: Gemini 404의 "gemini-3.8-flash를 쓰세요"). 구조화된 본문을 먼저 보고, 없으면 SDK 문구."""
    body = getattr(e, "body", None)
    body = body[0] if isinstance(body, list) and body else body
    body = body.get("error", body) if isinstance(body, dict) else body
    msg = body.get("message") if isinstance(body, dict) else None
    return str(msg or getattr(e, "message", "") or "")


_LONG_TOKEN = re.compile(r"[A-Za-z0-9_.\-]{24,}")
_MODEL_ID = re.compile(r"[a-z0-9]+(?:[-._][a-z0-9]+)+")  # 소문자·숫자 조각이 -._로 이어진 모양 (gemini-3.8-flash-preview-image-generation)


def _mask(m: re.Match) -> str:
    """키처럼 긴 토큰은 가린다. 다만 AI 모델 ID처럼 읽히는 것(소문자 조각들, 조각마다 16자 이하)은 둔다: 안내 문장의 "…를 쓰세요"가 그대로 보이게."""
    t = m.group()
    return t if _MODEL_ID.fullmatch(t) and all(len(p) <= 16 for p in re.split(r"[-._]", t)) else "***"


def _safe(text: str, key: str) -> str:
    """화면·로그에 남겨도 되는 한 줄: 키(그대로 또는 키처럼 긴 토큰)를 가리고 200자로 자른다."""
    text = " ".join(text.split())
    if key:
        text = text.replace(key, "***")
    return _LONG_TOKEN.sub(_mask, text)[:HINT_MAX]


def map_error(e: Exception, provider: Provider) -> LLMError | None:
    """openai SDK 오류 → LLMError. SDK 오류가 아니면 None. 키·요청 헤더·주소의 계정 정보는 문장에 넣지 않는다
    (401/403은 서버 문구를 아예 버린다: 키 일부를 되돌려 주는 서버가 있다)."""
    import openai

    if not isinstance(e, openai.APIError):
        return None
    host = host_of(provider.base_url)
    key = os.environ.get(provider.api_key_env or "", "")
    if isinstance(e, openai.APIConnectionError):  # 시간 초과(APITimeoutError)·거절·DNS 포함
        timed_out = isinstance(e, openai.APITimeoutError)
        return LLMError(t("{host}에 시간이 너무 오래 걸렸습니다", host=host) if timed_out else t("{host}에 연결하지 못했습니다", host=host), code="llm_conn")
    status = getattr(e, "status_code", None)
    body = _safe(_hint(e), key)
    detail = f"{host} HTTP {status}: {body}" if status and body else f"{host} HTTP {status}"
    code = getattr(e, "code", None)
    if status in (401, 403):
        return LLMError(f"{host} HTTP {status}", code="llm_auth")
    if status == 429:
        return LLMError(detail, code="llm_rate")
    if status in (503, 529) or (status and status >= 500 and BUSY_RE.search(body)):  # 서비스가 바쁨: 잠시 뒤 되는 일 (SDK가 이미 재시도했다)
        return LLMError(detail, code="llm_busy")
    if status == 404 or code == "model_not_found":
        return LLMError(detail, code="llm_model")
    if code == "context_length_exceeded" or (status in (400, 413) and CONTEXT_RE.search(body)):
        return LLMError(detail, code="llm_context")
    return LLMError(detail, code="llm_api")


def _call(provider: Provider, fn):
    try:
        return fn()
    except LLMError:
        raise
    except Exception as e:  # noqa: BLE001 — SDK 오류만 바꾸고 나머지는 그대로
        mapped = map_error(e, provider)
        if mapped is None:
            raise
        raise mapped from None


def _temperature(provider: Provider) -> dict:
    return {} if provider.temperature is None else {"temperature": provider.temperature}


def _within(seconds: float, fn, provider: Provider):
    """총 시간 제한. httpx 시간 제한은 읽기마다라 조금씩 흘려 주는 서버·DNS를 못 끊는다.
    ponytail: 넘으면 일하던 스레드를 버리고(daemon) 돌아온다. 호출자는 곧 프로세스를 끝낸다"""
    box: dict = {}

    def run():
        try:
            box["value"] = fn()
        except BaseException as e:  # noqa: BLE001 — 호출 스레드에서 다시 던진다
            box["error"] = e

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(seconds)
    if worker.is_alive():
        raise LLMError(t("{host}에 시간이 너무 오래 걸렸습니다", host=host_of(provider.base_url)), code="llm_conn")
    if "error" in box:
        raise box["error"]
    return box["value"]


def check_connection(provider: Provider, model: str) -> dict:
    """짧은 요청 한 번 (재시도 없이, 시간 제한 TEST_TIMEOUT_S). 같은 해석·환경으로 실제 호출과 똑같이 간다.
    HTTP 200이면 성공이다: 생각하는 AI(Gemini 등)는 토큰을 생각에 다 써서 답이 비어 올 수 있다 (`empty`: true)."""
    client = make_client(provider, timeout=TEST_TIMEOUT_S, max_retries=0)
    # ponytail: OpenAI 본가의 새 모델은 max_tokens를 거절한다. 그쪽만 max_completion_tokens (호환 서버는 max_tokens)
    limit = "max_completion_tokens" if provider.name == "openai" else "max_tokens"
    t0 = time.perf_counter()
    req = lambda: client.chat.completions.create(model=model, messages=[{"role": "user", "content": "OK라고만 답하세요."}], **{limit: TEST_MAX_TOKENS}, **_temperature(provider))  # noqa: E731  # i18n-ok: AI 프롬프트
    resp = _within(TEST_TIMEOUT_S, lambda: _call(provider, req), provider)
    empty = not (resp.choices and (resp.choices[0].message.content or "").strip())
    return {"ok": True, "provider": provider.name, "model": model, "host": host_of(provider.base_url), "latency_ms": round((time.perf_counter() - t0) * 1000), "empty": empty}


def list_models(provider: Provider) -> list[str]:
    """GET <주소>/models의 ID 목록 (앞의 `models/`는 뗀다: Gemini). 설정 화면의 AI 모델 칸이 고르는 데 쓴다."""
    client = make_client(provider, timeout=TEST_TIMEOUT_S, max_retries=1)
    ids = _within(TEST_TIMEOUT_S, lambda: _call(provider, lambda: [m.id for m in client.models.list()]), provider)
    return sorted({i.removeprefix("models/") for i in ids if isinstance(i, str) and i})


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
    from pydantic import ValidationError

    spec = strict_schema(schema)
    system = f"{system}\n\n{prompts.load('common')['json_schema']}\n{json.dumps(spec, ensure_ascii=False)}"
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    extra = {"response_format": {"type": "json_schema", "json_schema": {"name": schema.__name__, "strict": True, "schema": spec}}} if provider.json_schema else {}

    error = None
    for _ in range(2):
        resp = _call(provider, lambda: client.chat.completions.create(model=model, messages=messages, **_temperature(provider), **extra))
        if not resp.choices:  # 안전 필터 차단 등으로 choices가 비는 공급자가 있다
            error = t("빈 응답 (choices 없음)")
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
                {"role": "user", "content": prompts.load("common")["retry"].replace("{error}", error)},
            ]
    raise LLMError(t("{name}/{model} 응답이 2회 연속 검증에 실패했습니다: {error}", name=provider.name, model=model, error=error), code="llm_invalid")


def stream_chat(client, provider: Provider, model: str, messages: list[dict]) -> Iterator[str]:
    """평문 응답을 토큰 조각 단위로 흘려 준다 (`stream=True`). 빈 choices·None 조각은 건너뛴다."""
    try:
        for chunk in client.chat.completions.create(model=model, messages=messages, stream=True, **_temperature(provider)):
            if chunk.choices and (text := chunk.choices[0].delta.content):
                yield text
    except LLMError:
        raise
    except Exception as e:  # noqa: BLE001
        mapped = map_error(e, provider)
        if mapped is None:
            raise
        raise mapped from None
