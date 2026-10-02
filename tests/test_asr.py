from dataclasses import dataclass

from tractus.asr import Transcriber, collapse_repeats, has_loop, max_tokens_for


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
        return self.outputs[kwargs.get("language")]


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


def test_loop_without_retry_option_is_collapsed():
    model = FakeModel({None: FakeOut("준비해 " + LOOP)})
    seg = Transcriber(model).transcribe(AUDIO, language=None)
    assert len(model.calls) == 1
    assert seg.text == "준비해 조사를 하며" and seg.repaired


def test_hitting_token_cap_counts_as_loop():
    model = FakeModel({None: FakeOut("abcdefgh", generation_tokens=max_tokens_for(10.0))})
    seg = Transcriber(model).transcribe(AUDIO, language=None)
    assert seg.repaired
