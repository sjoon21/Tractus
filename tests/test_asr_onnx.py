"""Qwen3-ASR ONNX 어댑터 (docs/design/asr-onnx.md 7절). 기본 시험은 onnxruntime·가중치 없이 가짜 세션·토크나이저로 돈다.
실제 모델: `uv run --with onnxruntime==1.32.0 pytest -m slow tests/test_asr_onnx.py` (models/qwen3-asr-0.6b-onnx-int4, 받는 명령은 설계 문서 7절)."""

import os
import re
import subprocess
from pathlib import Path

import numpy as np
import pytest

from conftest import NO_MLX, mac_only
from tractus import asr_onnx
from tractus.asr_onnx import Output, OnnxQwen3ASR, build_prompt, decode, log_mel, pad_short, parse_language, pick

V, H, EOS, PAD = 12, 4, {10, 11}, 7


def one_hot(token: int, rows: int = 1) -> np.ndarray:
    x = np.zeros((1, rows, V), np.float32)
    x[0, -1, token] = 5.0
    return x


class FakeInit:
    def __init__(self, first: int):
        self.first, self.feeds = first, None

    def run(self, names, feeds):
        self.feeds = feeds
        s = feeds["input_ids"].shape[1]
        return one_hot(self.first, s), np.zeros((2, 1, 1, s, 2), np.float32), np.zeros((2, 1, 1, s, 2), np.float32)


class FakeStep:
    """정해 둔 토큰을 차례로 내고, 받은 입력을 기록한다. KV는 한 칸씩 늘린다."""

    def __init__(self, tokens: list[int]):
        self.tokens, self.feeds = list(tokens), []

    def run(self, names, feeds):
        self.feeds.append(feeds)
        k = np.concatenate([feeds["past_keys"], feeds["past_keys"][:, :, :, :1]], axis=3)
        return one_hot(self.tokens.pop(0) if self.tokens else 3), k, k


EMB = np.arange(V * H, dtype=np.float16).reshape(V, H)


def run_decode(first, rest, max_tokens=50, ids=(1, 2, PAD, PAD, 3)):
    init, step = FakeInit(first), FakeStep(rest)
    out = decode(init, step, EMB, list(ids), np.zeros((1, 2, H), np.float32), 2, EOS, max_tokens, 0.0, np.random.default_rng(0))
    return out, init, step


def test_decode_stops_at_eos_and_does_not_count_it():
    out, init, step = run_decode(4, [5, 6, 10])
    assert out == [4, 5, 6] and len(step.feeds) == 3
    assert init.feeds["position_ids"].tolist() == [[0, 1, 2, 3, 4]] and init.feeds["audio_offset"].tolist() == [2]
    assert [f["position_ids"].tolist() for f in step.feeds] == [[[5]], [[6]], [[7]]]  # 프롬프트 다음 자리부터 하나씩
    assert step.feeds[1]["input_embeds"].shape == (1, 1, H) and step.feeds[1]["input_embeds"].dtype == np.float32
    assert step.feeds[1]["input_embeds"][0, 0].tolist() == EMB[5].astype(np.float32).tolist()  # 바로 앞 토큰의 임베딩
    assert step.feeds[2]["past_keys"].shape[3] == 7  # KV를 이어 받는다


def test_decode_stops_at_max_tokens_and_returns_exactly_that_many():
    out, _, step = run_decode(4, [4] * 100, max_tokens=8)
    assert out == [4] * 8 and len(step.feeds) == 8  # generation_tokens == 상한 → Transcriber._capped가 루프로 본다


def test_decode_eos_first_gives_no_tokens():
    out, _, step = run_decode(11, [])
    assert out == [] and step.feeds == []


def test_pick_is_argmax_at_zero_and_samples_softmax_with_temperature():
    logits = np.array([0.0, 2.0, 1.0], np.float32)
    assert pick(logits, 0.0, None) == 1
    draws = [pick(logits, 0.3, np.random.default_rng(i)) for i in range(400)]
    assert draws == [pick(logits, 0.3, np.random.default_rng(i)) for i in range(400)]  # 같은 시드 → 같은 결과
    p = np.exp(logits / 0.3) / np.exp(logits / 0.3).sum()
    assert abs(draws.count(1) / 400 - p[1]) < 0.06 and abs(draws.count(2) / 400 - p[2]) < 0.06


def test_parse_language_follows_mlx_audio_extract_language():
    assert parse_language("language Korean<asr_text>안녕하세요") == ("Korean", "안녕하세요")
    assert parse_language("language Chinese <asr_text> 你好") == ("Chinese", " 你好")  # 본문은 다듬지 않는다 (Transcriber가 strip)
    assert parse_language("language Korean<asr_text>") == ("Korean", "")  # 빈 본문 → 한국어 재시도가 먹는다
    assert parse_language("") == ("English", "")
    assert parse_language("그냥 글") == ("English", "그냥 글")
    assert parse_language("말하길 language Korean<asr_text>x") == ("English", "말하길 language Korean<asr_text>x")


# mlx-audio 0.5.7 qwen3_asr.py `_build_prompt`(915–945행)·utils.py `merge_hotwords`가 만드는 문자열을 옮긴 것.
# 이 값이 바뀌면 Mac과 Windows 출력이 갈린다: mlx-audio를 올리면 slow 시험으로 토큰 ID를 다시 대조한다 (CLAUDE.md)
MLX_PROMPT_FIXED_HOTWORDS = (
    "<|im_start|>system\nWTO, 쿠버네티스\n<|im_end|>\n"
    "<|im_start|>user\n<|audio_start|><|audio_pad|><|audio_pad|><|audio_pad|><|audio_end|><|im_end|>\n"
    "<|im_start|>assistant\nlanguage Korean<asr_text>"
)
MLX_PROMPT_AUTO = "<|im_start|>system\n<|im_end|>\n<|im_start|>user\n<|audio_start|><|audio_pad|><|audio_end|><|im_end|>\n<|im_start|>assistant\n"


def test_build_prompt_matches_the_mlx_audio_literal():
    assert build_prompt(3, "Korean", ["WTO", " 쿠버네티스 ", "", None]) == MLX_PROMPT_FIXED_HOTWORDS  # 빈 값을 빼고 ", "로 잇는다
    assert build_prompt(1, None, None) == build_prompt(1, None, []) == build_prompt(1, None, ["  "]) == MLX_PROMPT_AUTO  # 단어가 없으면 시스템 칸이 빈다
    assert build_prompt(3, "korean", ["WTO", "쿠버네티스"]) == build_prompt(3, "KOREAN", ["WTO", "쿠버네티스"]) == MLX_PROMPT_FIXED_HOTWORDS  # 대소문자 없이 표기를 맞춘다
    assert build_prompt(1, "Klingon", None).endswith("language Klingon<asr_text>")  # 모르는 이름은 그대로 (mlx-audio와 같음)


@mac_only(NO_MLX)
def test_literals_still_match_the_installed_mlx_audio():
    """Dependabot이 mlx-audio를 올려 프롬프트·언어 나누기가 바뀌면 여기서 먼저 깨진다 → slow 대조를 돌리고 어댑터를 맞춘다."""
    from types import SimpleNamespace

    from mlx_audio.stt.models.qwen3_asr.qwen3_asr import Qwen3ASRModel as Model
    from mlx_audio.stt.utils import merge_hotwords

    seen = []
    tok = SimpleNamespace(encode=lambda prompt, return_tensors=None: seen.append(prompt) or np.zeros((1, 1), np.int64))
    me = SimpleNamespace(config=SimpleNamespace(support_languages=list(asr_onnx.LANGUAGES)), _tokenizer=tok)
    cases = [(3, "Korean", ["WTO", " 쿠버네티스 ", "", None]), (1, None, []), (2, "korean", ["WTO"]), (2, "ENGLISH", None), (2, "Klingon", None)]
    for n, lang, hotwords in cases:
        Model._build_prompt(me, n, lang, merge_hotwords(None, hotwords))
    assert seen[:2] == [MLX_PROMPT_FIXED_HOTWORDS, MLX_PROMPT_AUTO]
    assert seen == [build_prompt(n, lang, hotwords) for n, lang, hotwords in cases]
    for text in ("language Korean<asr_text>안녕", "language Korean<asr_text>", "", "그냥 글", "language Chinese <asr_text> 你好"):
        assert tuple(Model.extract_language(None, text)) == parse_language(text)


def test_short_audio_is_padded_to_one_second():
    assert len(pad_short(np.ones(8000))) == 16000 and pad_short(np.ones(8000))[8000:].sum() == 0
    assert len(pad_short(np.ones(20000))) == 20000


class FakeTokenizer:
    """특수 토큰은 하나의 ID(<|audio_pad|> = PAD), 나머지는 글자마다 하나. decode는 그대로 잇는다."""

    def __init__(self, out_text: str):
        self.out_text, self.prompts = out_text, []

    def encode(self, text, add_special_tokens=True):
        assert add_special_tokens is False
        self.prompts.append(text)
        parts = re.findall(r"<\|[a-z_]+\|>|.", text, re.DOTALL)
        return type("Enc", (), {"ids": [PAD if p == "<|audio_pad|>" else 1 + (len(p) % 5) for p in parts]})()

    def decode(self, ids, skip_special_tokens=False):
        assert skip_special_tokens
        return self.out_text


class FakeEncoder:
    def __init__(self, n_audio: int):
        self.n_audio, self.mel = n_audio, None

    def run(self, names, feeds):
        assert names == ["audio_features"]
        self.mel = feeds["mel"]
        return [np.zeros((1, self.n_audio, H), np.float32)]


def fake_model(out_text: str, tokens: list[int], n_audio: int = 3):
    cfg = {"special_tokens": {"audio_pad_token_id": PAD, "eos_token_ids": sorted(EOS)}}
    enc, init, step, tok = FakeEncoder(n_audio), FakeInit(tokens[0]), FakeStep(tokens[1:]), FakeTokenizer(out_text)
    return OnnxQwen3ASR(enc, init, step, tok, EMB, cfg), enc, init, tok


def test_generate_auto_detect_splits_language_and_counts_all_tokens():
    model, enc, init, tok = fake_model("language Korean<asr_text>안녕하세요", [4, 5, 6, 10])
    out = model.generate(np.zeros(8000, np.float32), hotwords=["WTO"], max_tokens=40)
    assert out == Output("안녕하세요", "Korean", 3)  # 자동 감지면 `language X<asr_text>` 토큰도 센다 (mlx-audio와 같음)
    assert enc.mel.shape == (1, 128, 100)  # 0.5초 → 1초로 채운 뒤 특징
    assert tok.prompts == [build_prompt(3, None, ["WTO"])]
    ids = init.feeds["input_ids"][0].tolist()
    assert init.feeds["audio_offset"].tolist() == [ids.index(PAD)] and ids.count(PAD) == 3


def test_generate_fixed_language_keeps_the_name_and_text():
    model, _, _, tok = fake_model("안녕하세요", [4, 11])
    assert model.generate(np.zeros(32000, np.float32), language="Korean") == Output("안녕하세요", "Korean", 1)
    assert tok.prompts[0].endswith("assistant\nlanguage Korean<asr_text>")


def test_generate_through_transcriber_uses_the_shared_safety_nets(monkeypatch):
    """토큰 상한에 닿은 ONNX 출력도 Transcriber가 루프로 보고 다시 한다 (안전장치는 asr.py 하나)."""
    from tractus.asr import Transcriber, max_tokens_for

    model, _, _, _ = fake_model("language Korean<asr_text>안녕하세요 안녕하세요 안녕하세요 안녕하세요", [4] * 200)
    monkeypatch.setattr(asr_onnx, "pick", lambda logits, temperature, rng: int(np.argmax(logits)))  # 온도 0.3에서도 늘 같은 토큰
    calls, generate = [], model.generate

    def recording(audio, **kw):
        out = generate(audio, **kw)
        calls.append((kw, out))
        return out

    model.generate = recording
    seg = Transcriber(model).transcribe(np.zeros(16000, np.float32))
    cap = max_tokens_for(1.0)
    assert cap == 48 and calls[0][0]["max_tokens"] == cap and calls[0][1].generation_tokens == cap  # 상한에 닿았다
    assert len(calls) == 2 and calls[1][0]["temperature"] == 0.3  # 루프: 온도 0.3으로 한 번 더 (그것도 상한)
    assert seg.repaired and seg.text == "안녕하세요"  # 그래도 루프면 반복을 접는다


def test_log_mel_matches_whisper_feature_extractor():
    pytest.importorskip("transformers")
    from transformers import WhisperFeatureExtractor

    fe = WhisperFeatureExtractor(feature_size=128)  # Qwen3-ASR preprocessor_config.json과 같은 값 (16kHz, n_fft 400, hop 160)
    rng = np.random.default_rng(0)
    for seconds, frames in ((5, 500), (31, 3100)):
        x = (rng.standard_normal(16000 * seconds) * 0.1).astype(np.float32)
        ref = fe(x, sampling_rate=16000, return_attention_mask=True, truncation=False, padding=True, return_tensors="np")["input_features"]
        got = log_mel(x)
        assert got.shape == ref.shape == (1, 128, frames) and got.dtype == np.float32
        assert np.abs(got - ref).max() < 1e-4


def test_loading_without_onnxruntime_is_a_runtime_missing_error(monkeypatch, tmp_path):
    import builtins

    real = builtins.__import__

    def no_ort(name, *a, **k):
        if name == "onnxruntime":
            raise ImportError("DLL load failed while importing onnxruntime_pybind11_state")
        return real(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", no_ort)
    with pytest.raises(asr_onnx.RuntimeMissing, match="DLL load failed"):
        OnnxQwen3ASR.load(tmp_path)


def test_loading_names_missing_files_before_making_sessions(monkeypatch, tmp_path):
    made = []
    monkeypatch.setattr(asr_onnx, "ort", lambda: type("Rt", (), {"InferenceSession": lambda *a, **k: made.append(a)}))
    for name in asr_onnx.FILES:
        if name not in ("encoder.int4.onnx", "embed_tokens.bin"):
            (tmp_path / name).write_bytes(b"")
    with pytest.raises(FileNotFoundError, match=r"encoder\.int4\.onnx, embed_tokens\.bin"):
        OnnxQwen3ASR.load(tmp_path)
    assert made == []


# ── 실제 모델 (Mac: uv run --with onnxruntime==1.32.0 pytest -m slow tests/test_asr_onnx.py) ──

MODELS = Path(os.environ.get("TRACTUS_MODELS_DIR", Path(__file__).resolve().parent.parent / "models"))
ONNX_DIR, MLX_DIR = MODELS / "qwen3-asr-0.6b-onnx-int4", MODELS / "qwen3-asr-0.6b-8bit"


@pytest.mark.slow
def test_real_prompt_token_ids_and_audio_length_match_mlx_audio():
    """토큰 ID를 박아 둔 상류 코드의 버그(system·user = 9125·882)가 없는지: mlx-audio가 실제로 만드는 ID와 같아야 한다."""
    pytest.importorskip("onnxruntime")
    from types import SimpleNamespace

    from mlx_audio.stt.models.qwen3_asr.qwen3_asr import Qwen3ASRModel as Model
    from mlx_audio.stt.utils import merge_hotwords
    from transformers import AutoTokenizer, WhisperFeatureExtractor

    model = OnnxQwen3ASR.load(ONNX_DIR)
    me = SimpleNamespace(config=SimpleNamespace(support_languages=["Korean", "English"]), _tokenizer=AutoTokenizer.from_pretrained(str(MLX_DIR)), _feature_extractor=WhisperFeatureExtractor.from_pretrained(str(MLX_DIR)))
    rng = np.random.default_rng(1)
    for seconds, language, hotwords in ((0.4, None, None), (5.3, "Korean", ["WTO", "쿠버네티스", "Project Atlas"]), (30.0, None, ["예산"])):
        pcm = pad_short((rng.standard_normal(int(16000 * seconds)) * 0.05).astype(np.float32))
        n_audio = Model._preprocess_audio(me, pcm)[2]
        af = model.enc.run(["audio_features"], {"mel": log_mel(pcm)})[0]
        assert af.shape[1] == n_audio  # 인코더 출력 길이 = mlx-audio가 셈한 오디오 토큰 수
        want = np.array(Model._build_prompt(me, n_audio, language, merge_hotwords(None, hotwords))).reshape(-1).tolist()
        assert model.tok.encode(build_prompt(n_audio, language, hotwords), add_special_tokens=False).ids == want
    assert want[:3] == [151644, 8948, 198]  # <|im_start|> system \n


@pytest.mark.slow
def test_real_onnx_transcribes_a_virtual_korean_voice(tmp_path):
    pytest.importorskip("onnxruntime")
    from difflib import SequenceMatcher

    from tractus import audio
    from tractus.asr import Transcriber

    text = "안녕하세요. 오늘 회의는 다음 분기 예산 검토입니다. 먼저 인건비부터 보겠습니다."
    wav = tmp_path / "say.wav"
    subprocess.run(["say", "-v", "Yuna", "-o", str(wav), "--data-format=LEI16@16000", text], check=True)
    pcm = audio.decode(wav)
    tr = Transcriber.load(ONNX_DIR)
    assert isinstance(tr.model, OnnxQwen3ASR)
    plain = lambda s: re.sub(r"[\s.,?!]", "", s)  # noqa: E731
    for kw in ({}, {"language": "ko", "hotwords": ["인건비", "예산"]}):
        seg = tr.transcribe(pcm, **kw)
        assert seg.lang == "ko" and not seg.repaired
        assert SequenceMatcher(None, plain(seg.text), plain(text)).ratio() > 0.9, seg.text
