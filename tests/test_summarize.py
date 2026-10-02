import json

import pytest

from tractus.summarize import MeetingSummary, build_prompt, check_segment_ids, render_summary_md

TRANSCRIPT = {
    "meeting_id": "01J9X",
    "title": "주간회의",
    "segments": [
        {"id": "s0001", "start": 0.0, "end": 28.0, "text": "다음 분기 budget부터 보겠습니다."},
        {"id": "s0002", "start": 30.0, "end": 55.0, "text": "김철수 님이 금요일까지 견적을 정리해 주세요."},
        {"id": "s0003", "start": 3600.0, "end": 3610.0, "text": "예산은 10% 줄이기로 합니다."},
    ],
}

SUMMARY = {
    "title": "다음 분기 예산 검토",
    "summary": "예산 축소를 결정했다.",
    "topics": [{"title": "예산", "segment_ids": ["s0001", "s0003"]}],
    "decisions": [{"text": "예산 10% 축소", "segment_ids": ["s0003"]}],
    "action_items": [{"task": "견적 정리", "owner": "김철수", "due": "금요일", "segment_ids": ["s0002"]}],
}


def test_prompt_lists_segments_with_ids_and_times():
    prompt = build_prompt(TRANSCRIPT)
    assert "[s0002 00:00:30] 김철수 님이 금요일까지 견적을 정리해 주세요." in prompt
    assert "[s0003 01:00:00]" in prompt


def test_unknown_or_missing_segment_ids_are_rejected():
    ok = MeetingSummary.model_validate(SUMMARY)
    check_segment_ids(ok, TRANSCRIPT)
    bad = MeetingSummary.model_validate({**SUMMARY, "decisions": [{"text": "x", "segment_ids": ["s9999"]}]})
    with pytest.raises(ValueError, match="s9999"):
        check_segment_ids(bad, TRANSCRIPT)
    empty = MeetingSummary.model_validate({**SUMMARY, "action_items": [{"task": "x", "owner": None, "due": None, "segment_ids": []}]})
    with pytest.raises(ValueError, match="근거"):
        check_segment_ids(empty, TRANSCRIPT)


def test_markdown_has_frontmatter_sections_and_timestamps():
    md = render_summary_md(MeetingSummary.model_validate(SUMMARY), TRANSCRIPT, provider="upstage", model="solar-pro4", generated_at="t")
    assert md.startswith("---\nmeeting_id: 01J9X\nprovider: upstage\nmodel: solar-pro4\n")
    assert "- [ ] 견적 정리 — 김철수, 금요일 [00:00:30]" in md
    assert "- 예산 10% 축소 [01:00:00]" in md
    assert "### 예산 [00:00:00–01:00:10]" in md


def test_schema_is_strict_compatible():
    from tractus.llm import strict_schema

    s = json.dumps(strict_schema(MeetingSummary))
    assert '"additionalProperties": false' in s and '"default"' not in s


def test_blank_titles_with_empty_ids_raise_value_error_not_attribute_error():
    s = MeetingSummary.model_validate({**SUMMARY, "topics": [{"title": "", "segment_ids": []}], "decisions": [{"text": "", "segment_ids": []}]})
    with pytest.raises(ValueError, match="근거"):
        check_segment_ids(s, TRANSCRIPT)
