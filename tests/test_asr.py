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


def test_short_chunk_detected_as_chinese_is_redone_in_korean():
    short = [0.0] * 16000 * 2
    model = FakeModel({None: FakeOut("对，嗯，对。", language=["Chinese"]), "Korean": FakeOut("네 음 네")})
    seg = Transcriber(model).transcribe(short)
    assert [c["language"] for c in model.calls] == [None, "Korean"]
    assert seg.text == "네 음 네" and seg.lang == "ko" and seg.repaired


def test_long_chunks_and_other_languages_are_left_alone():
    model = FakeModel({None: FakeOut("我们开始开会吧", language=["Chinese"])})
    assert Transcriber(model).transcribe(AUDIO).text == "我们开始开会吧"  # 10초: 정말 중국어일 수 있다
    model = FakeModel({None: FakeOut("Ja, genau.", language=["German"])})
    assert Transcriber(model).transcribe([0.0] * 16000 * 2).text == "Ja, genau."



def test_note_terms_pick_term_like_words_from_title_and_memos():
    from tractus.asr import NOTE_TERMS_MAX, note_terms

    assert note_terms("자원 온톨로지 미팅", "GraphRAG로 루트 코즈 찾기, K8s 파드는?") == ["자원", "온톨로지", "GraphRAG", "루트", "코즈", "찾기", "K8s", "파드"]
    assert note_terms("녹음 14:05") == [] and note_terms("Recording 2:05 PM", "") == ["PM"]
    assert note_terms("온톨로지 온톨로지를") == ["온톨로지"]  # 조사를 떼고 한 번만
    assert len(note_terms(" ".join(f"용어{chr(0xAC00 + i)}" for i in range(40)))) == NOTE_TERMS_MAX


# ── 변환 엔진 계열 (docs/design/asr-engines.md) ─────────────────────────────


def test_engine_comes_from_the_model_folder_config(tmp_path):
    import json

    import pytest

    from tractus.asr import engine_of

    for kind, family in (("qwen3_asr", "qwen3"), ("whisper", "whisper"), ("sensevoice", "sensevoice")):
        (tmp_path / "config.json").write_text(json.dumps({"model_type": kind}))
        assert engine_of(tmp_path).family == family
    (tmp_path / "config.json").write_text("{}")
    assert engine_of(tmp_path).family == "qwen3"  # 옛 직접 만든 폴더·픽스처
    (tmp_path / "config.json").write_text(json.dumps({"model_type": "wav2vec2"}))
    with pytest.raises(ValueError, match="model_type=wav2vec2"):
        engine_of(tmp_path)


def test_whisper_gets_a_language_code_and_never_the_hotwords():
    model = FakeModel({"ko": FakeOut("쿠버네티스 배포", language="ko", generation_tokens=0)})
    seg = Transcriber(model, "whisper").transcribe(AUDIO, language="ko", hotwords=["Kubernetes"])
    assert seg.text == "쿠버네티스 배포" and seg.lang == "ko"
    assert model.calls == [{"language": "ko", "condition_on_previous_text": False, "verbose": False}]


def test_sensevoice_runs_auto_language_with_itn_and_no_misdetect_retry():
    model = FakeModel({"auto": FakeOut("你好", language="zh", generation_tokens=0)})
    seg = Transcriber(model, "sensevoice").transcribe([0.0] * 16000 * 2)  # 짧은 청크·중국어 감지: Qwen만 한국어로 다시 한다
    assert seg.lang == "zh" and len(model.calls) == 1
    assert model.calls[0] == {"language": "auto", "use_itn": True}


def test_non_qwen_engines_do_not_treat_zero_tokens_as_the_cap():
    model = FakeModel({None: FakeOut("정상 문장입니다", language="ko", generation_tokens=10_000)})
    assert not Transcriber(model, "whisper").transcribe(AUDIO).repaired  # 토큰 수를 상한 판단에 쓰지 않는다


def test_transcribe_writes_sino_korean_numbers_as_digits():
    model = FakeModel({None: FakeOut("점유율이 삼십 프로이고 이번 주에 칠 명이 옵니다")})
    seg = Transcriber(model).transcribe(AUDIO, language=None)
    assert seg.text == "점유율이 30프로이고 이번 주에 7명이 옵니다"
