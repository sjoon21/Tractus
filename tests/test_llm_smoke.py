"""실제 LLM 공급자 스모크 테스트. `uv run pytest -m llm` (키가 있는 공급자만 실행).

가상 회의 전사(tests/fixtures/sample_meeting.json)만 보낸다. AI Hub 등 외부 반출이 제한된 데이터는 쓰지 않는다.
"""

import json
import os
from pathlib import Path

import pytest

from tractus.env import load_env
from tractus.llm import PROVIDERS, LLMError, make_client, resolve_provider
from tractus.summarize import summarize

ROOT = Path(__file__).resolve().parent.parent
load_env(ROOT)
TRANSCRIPT = json.loads((ROOT / "tests/fixtures/sample_meeting.json").read_text(encoding="utf-8"))


@pytest.mark.llm
@pytest.mark.parametrize("name", list(PROVIDERS))
def test_provider_returns_valid_summary(name):
    if name == "gemma-local" and not os.environ.get("TRACTUS_TEST_LOCAL_LLM"):
        pytest.skip("로컬 LLM 서버 테스트는 TRACTUS_TEST_LOCAL_LLM=1일 때만")
    try:
        provider, model = resolve_provider(name, None)
    except LLMError as e:
        pytest.skip(str(e))
    s = summarize(make_client(provider), provider, model, TRANSCRIPT)  # 스키마·segment_ids 검증은 내부에서 끝남

    tasks = " ".join(f"{a.task} {a.owner} {a.due}" for a in s.action_items)
    assert "김민수" in tasks and "박지영" in tasks, s.model_dump()
    assert any("22" in d.text for d in s.decisions), s.model_dump()  # 릴리스 10월 22일 확정
    assert not any("Notion" in d.text or "Confluence" in d.text for d in s.decisions), "미결 안건을 결정으로 넣음"
    assert not any(a.owner and ("화자" in a.owner or "발언자" in a.owner) for a in s.action_items), "알 수 없는 담당자를 지어냄"
