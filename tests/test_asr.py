from dataclasses import dataclass

from tractus.asr import HOTWORDS_MAX, LOOP_RETRY_TEMPERATURE, Transcriber, collapse_repeats, echoes_hotwords, has_loop, max_tokens_for


def test_max_tokens_scales_with_duration():
    assert max_tokens_for(30.0) == 16 * 30 + 32
    assert max_tokens_for(0.5) == 40


def test_has_loop_detects_repeated_phrase():
    assert has_loop("조사를 하며 조사를 하며 조사를 하며 조사를 하며")
    assert not has_loop("네 네 네 좋습니다")
    assert not has_loop("회의를 시작하겠습니다. 오늘 안건은 두 가지입니다.")


def test_collapse_repeats_keeps_one_copy():
    assert collapse_repeats("준비해 조사를 하며 조사를 하며 조사를 하며 끝") == "준비해 조사를 하며 끝"
    assert collapse_repeats("한국어의 동일한 의미입니다. 한국어의 동일한 의미입니다. 한국어의 동일한 의미입니다.") == "한국어의 동일한 의미입니다."
    assert collapse_repeats("네 네 네 좋습니다") == "네 네 네 좋습니다"


@dataclass
class FakeOut:
    text: str
    language: str = "Korean"
    generation_tokens: int = 10


class FakeModel:
    """language 인자별로 정해 둔 출력을 돌려주고, 받은 호출을 기록한다."""

    def __init__(self, outputs: dict):
        self.outputs = outputs
        self.calls: list[dict] = []

    def generate(self, audio, **kwargs):
        self.calls.append(kwargs)
        key = kwargs.get("language")
        if kwargs.get("temperature") and ("t", key) in self.outputs:
            return self.outputs[("t", key)]
        if kwargs.get("hotwords") is None and ("nohw", key) in self.outputs:
            return self.outputs[("nohw", key)]
        return self.outputs[key]


LOOP = "조사를 하며 " * 20
AUDIO = [0.0] * 16000 * 10  # 10초


def test_transcribe_passes_hotwords_and_token_cap():
    model = FakeModel({None: FakeOut("WTO 가입 문제입니다", language=["Korean"])})
    seg = Transcriber(model).transcribe(AUDIO, language=None, hotwords=["WTO"])
    assert seg.text == "WTO 가입 문제입니다" and seg.lang == "ko" and not seg.repaired
    assert model.calls == [{"language": None, "hotwords": ["WTO"], "max_tokens": max_tokens_for(10.0)}]


def test_fixed_language_loop_retries_with_auto_detect():
    model = FakeModel({"Korean": FakeOut(LOOP), None: FakeOut("Thank you all", language="English")})
    seg = Transcriber(model).transcribe(AUDIO, language="ko")
    assert [c["language"] for c in model.calls] == ["Korean", None]
    assert seg.text == "Thank you all" and seg.lang == "en" and seg.repaired


def test_loop_is_retried_once_with_temperature_then_collapsed():
    model = FakeModel({None: FakeOut("준비해 " + LOOP)})
    seg = Transcriber(model).transcribe(AUDIO, language=None)
    assert [c.get("temperature") for c in model.calls] == [None, LOOP_RETRY_TEMPERATURE]
    assert seg.text == "준비해 조사를 하며" and seg.repaired


def test_loop_retry_with_temperature_can_recover_the_sentence():
    model = FakeModel({None: FakeOut("준비해 " + LOOP), ("t", None): FakeOut("준비해서 조사를 하며 정리했습니다")})
    seg = Transcriber(model).transcribe(AUDIO, language=None)
    assert seg.text == "준비해서 조사를 하며 정리했습니다" and seg.repaired


def test_hotwords_are_capped_and_skipped_on_short_chunks():
    model = FakeModel({None: FakeOut("짧은 말")})
    words = [f"단어{i}" for i in range(HOTWORDS_MAX + 10)]
    Transcriber(model).transcribe(AUDIO, hotwords=words)
    Transcriber(model).transcribe([0.0] * 8000, hotwords=words)  # 0.5초
    assert len(model.calls[0]["hotwords"]) == HOTWORDS_MAX and model.calls[0]["hotwords"][0] == "단어0"
    assert model.calls[1]["hotwords"] is None


def test_output_that_echoes_the_hotword_list_is_redone_without_hotwords():
    hw = ["Kubernetes", "Project Atlas", "김민수", "p95"]
    model = FakeModel({None: FakeOut("Kubernetes, Project Atlas, 김민수, p95"), ("nohw", None): FakeOut("네 감사합니다")})
    seg = Transcriber(model).transcribe(AUDIO, hotwords=hw)
    assert [c["hotwords"] for c in model.calls] == [hw, None]
    assert seg.text == "네 감사합니다" and seg.repaired


def test_echo_detection_needs_several_terms_covering_most_of_the_text():
    hw = ["Kubernetes", "Project Atlas", "김민수"]
    assert echoes_hotwords("Kubernetes, Project Atlas, 김민수", hw)
    assert not echoes_hotwords("김민수 님이 Kubernetes 클러스터를 Project Atlas 일정에 맞춰 올리기로 했습니다", hw)  # 정상 문장 속 용어
    assert not echoes_hotwords("Kubernetes Kubernetes", hw)


def test_hitting_token_cap_counts_as_loop():
    model = FakeModel({None: FakeOut("abcdefgh", generation_tokens=max_tokens_for(10.0))})
    seg = Transcriber(model).transcribe(AUDIO, language=None)
    assert seg.repaired
