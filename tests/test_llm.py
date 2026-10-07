import json
from types import SimpleNamespace

import pytest
from pydantic import BaseModel, ConfigDict

from tractus.llm import PROVIDERS, LLMError, complete_json, resolve_provider, strict_schema


class Item(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    owner: str | None


class Out(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[Item]


class FakeClient:
    """chat.completions.create 호출을 기록하고, 정해 둔 응답을 차례로 돌려준다."""

    def __init__(self, replies: list[str]):
        self.replies, self.calls = list(replies), []
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=self.replies.pop(0)))])


GOOD = json.dumps({"items": [{"name": "예산", "owner": None}]})


def test_strict_schema_requires_every_property_and_forbids_extras():
    s = strict_schema(Out)
    item = s["$defs"]["Item"]
    assert s["additionalProperties"] is False and item["additionalProperties"] is False
    assert sorted(item["required"]) == ["name", "owner"]
    assert "default" not in json.dumps(s)


def test_json_schema_provider_sends_response_format():
    client = FakeClient([GOOD])
    out = complete_json(client, PROVIDERS["upstage"], "solar-pro4", "sys", "user", Out)
    assert out.items[0].name == "예산"
    rf = client.calls[0]["response_format"]
    assert rf["type"] == "json_schema" and rf["json_schema"]["strict"] is True
    assert [m["role"] for m in client.calls[0]["messages"]] == ["system", "user"]


def test_provider_without_json_schema_gets_schema_in_prompt_only():
    client = FakeClient(["```json\n" + GOOD + "\n```"])
    out = complete_json(client, PROVIDERS["claude"], "m", "sys", "user", Out)
    assert out.items[0].owner is None
    assert "response_format" not in client.calls[0]
    assert '"items"' in client.calls[0]["messages"][0]["content"]  # 스키마가 system 프롬프트에 들어간다


def test_invalid_reply_is_retried_once_with_error_feedback():
    client = FakeClient(['{"items": [{"name": 1}]}', GOOD])
    complete_json(client, PROVIDERS["upstage"], "solar-pro4", "sys", "user", Out)
    retry = client.calls[1]["messages"]
    assert [m["role"] for m in retry] == ["system", "user", "assistant", "user"]
    assert "검증" in retry[-1]["content"]


def test_custom_validator_failure_also_retries_then_raises():
    def no_budget(o: Out):
        if any(i.name == "예산" for i in o.items):
            raise ValueError("없는 근거")

    client = FakeClient([GOOD, GOOD])
    with pytest.raises(LLMError, match="없는 근거"):
        complete_json(client, PROVIDERS["upstage"], "solar-pro4", "sys", "user", Out, validate=no_budget)
    assert len(client.calls) == 2


def test_resolve_provider_reads_env_and_checks_key(monkeypatch):
    monkeypatch.setenv("TRACTUS_LLM_PROVIDER", "upstage")
    monkeypatch.delenv("TRACTUS_LLM_MODEL", raising=False)
    monkeypatch.setenv("UPSTAGE_API_KEY", "k")
    provider, model = resolve_provider(None, None)
    assert provider.name == "upstage" and model == "solar-pro4"
    monkeypatch.delenv("UPSTAGE_API_KEY")
    with pytest.raises(LLMError, match="UPSTAGE_API_KEY"):
        resolve_provider(None, None)


def test_local_only_blocks_remote_providers(monkeypatch):
    monkeypatch.setenv("TRACTUS_LOCAL_ONLY", "1")
    monkeypatch.setenv("UPSTAGE_API_KEY", "k")
    with pytest.raises(LLMError, match="로컬 전용 모드"):
        resolve_provider("upstage", None)
    assert resolve_provider("gemma-local", None)[0].local


def test_provider_without_default_model_requires_explicit_model(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    monkeypatch.delenv("TRACTUS_LLM_MODEL", raising=False)
    with pytest.raises(LLMError, match="모델"):
        resolve_provider("gemini", None)
    assert resolve_provider("gemini", "gemini-x")[1] == "gemini-x"


def test_empty_choices_are_retried_then_raise():
    client = FakeClient([GOOD])
    client.chat.completions.create = lambda **kw: (client.calls.append(kw), SimpleNamespace(choices=[]))[1]
    with pytest.raises(LLMError, match="빈 응답"):
        complete_json(client, PROVIDERS["upstage"], "solar-pro4", "sys", "user", Out)
    assert len(client.calls) == 2


@pytest.mark.parametrize("value", ["1", "true", "on", "Y", " yes "])
def test_local_only_fails_closed_for_any_truthy_value(monkeypatch, value):
    monkeypatch.setenv("TRACTUS_LOCAL_ONLY", value)
    monkeypatch.setenv("UPSTAGE_API_KEY", "k")
    with pytest.raises(LLMError, match="로컬 전용 모드"):
        resolve_provider("upstage", None)


@pytest.mark.parametrize("value", ["", "0", "false", "no", "off"])
def test_local_only_off_values(monkeypatch, value):
    monkeypatch.setenv("TRACTUS_LOCAL_ONLY", value)
    monkeypatch.setenv("UPSTAGE_API_KEY", "k")
    assert resolve_provider("upstage", None)[0].name == "upstage"
