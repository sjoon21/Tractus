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


def test_prompt_shows_speaker_names_and_labels():
    t = {**TRANSCRIPT, "speakers": {"S1": {"name": "김민수"}, "S2": {"name": None}},
         "segments": [{**TRANSCRIPT["segments"][0], "speaker": "S1"}, {**TRANSCRIPT["segments"][1], "speaker": "S2"}, TRANSCRIPT["segments"][2]]}
    prompt = build_prompt(t)
    assert "[s0001 00:00:00 김민수] 다음 분기" in prompt and "[s0002 00:00:30 S2] 김철수" in prompt and "[s0003 01:00:00] 예산" in prompt


def test_system_prompt_rules_for_speakers():
    from tractus.summarize import SYSTEM_PROMPT

    assert "자동 추정" in SYSTEM_PROMPT and "S1" in SYSTEM_PROMPT and "null" in SYSTEM_PROMPT


def test_clean_owners_drops_speaker_labels_and_placeholders():
    from tractus.summarize import clean_owners

    items = [{"task": t, "owner": o, "due": None, "segment_ids": ["s0001"]} for t, o in
             [("a", "S2"), ("b", "s0006 발언자"), ("c", "화자 1"), ("d", "김민수"), ("e", None), ("f", "Sam"), ("g", "이화자")]]
    s = MeetingSummary.model_validate({**SUMMARY, "action_items": items})
    assert [a.owner for a in clean_owners(s).action_items] == [None, None, None, "김민수", None, "Sam", "이화자"]
    assert s.action_items[0].owner == "S2"  # 원본은 그대로


def test_clean_owners_catches_label_variants():
    from tractus.summarize import clean_owners

    owners = ["s2", "Speaker 1", "speaker", "SPEAKER_02", "S0012 담당", "Sam", "김민수"]
    items = [{"task": "t", "owner": o, "due": None, "segment_ids": ["s0001"]} for o in owners]
    s = MeetingSummary.model_validate({**SUMMARY, "action_items": items})
    assert [a.owner for a in clean_owners(s).action_items] == [None, None, None, None, None, "Sam", "김민수"]
