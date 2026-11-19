"""Qwen3-ASR ONNX 판을 onnxruntime(CPU)으로 돌린다. Windows 텍스트 변환 경로다 (docs/design/asr-onnx.md).

계열은 `qwen3` 그대로이고 실행 경로만 다르다: 모델 폴더에 `MARKER`가 있으면 `asr.Transcriber.load`가 이 어댑터를 고른다.
반복 루프 재시도·토큰 상한·자주 쓰는 단어 안전장치·ITN은 `asr.Transcriber`가 그대로 하고, 여기서는 mlx-audio 0.5.7
Qwen3-ASR `generate`가 하는 일(프롬프트·특징 추출·디코딩·언어 나누기)만 같게 한다. mlx를 불러오지 않는다.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from tractus.asr import RuntimeMissing

MARKER = "decoder_step.int4.onnx"  # 이 파일이 있으면 ONNX 폴더다 (config.json의 model_type은 MLX판과 같은 qwen3_asr라 가를 수 없다)
FILES = ("encoder.int4.onnx", "decoder_init.int4.onnx", MARKER, "decoder_weights.int4.data", "embed_tokens.bin", "tokenizer.json", "config.json")

SR = 16000
N_FFT, HOP, N_MELS = 400, 160, 128
MIN_S = 1.0  # mlx-audio split_audio_into_chunks(min_chunk_duration=1.0): 짧은 오디오는 0으로 채워 1초로


def ort():
    """onnxruntime을 늦게 불러온다: 이 모듈과 시험은 onnxruntime 없이 돈다."""
    try:
        import onnxruntime
    except ImportError as e:
        raise RuntimeMissing(str(e)) from e
    return onnxruntime


@dataclass
class Output:
    """mlx-audio STTOutput에서 Transcriber가 읽는 세 칸."""

    text: str
    language: str | None
    generation_tokens: int


def _hz_to_mel(f):
    f = np.asarray(f, np.float64)
    return np.where(f >= 1000.0, 15.0 + np.log(np.maximum(f, 1e-10) / 1000.0) * (27.0 / np.log(6.4)), 3.0 * f / 200.0)


def _mel_to_hz(m):
    m = np.asarray(m, np.float64)
    return np.where(m >= 15.0, 1000.0 * np.exp(np.log(6.4) / 27.0 * (m - 15.0)), 200.0 * m / 3.0)


def mel_filters(n_mels: int = N_MELS) -> np.ndarray:
    """Slaney mel 삼각 필터 [n_fft/2+1, n_mels], 0–8kHz, slaney 정규화 (transformers mel_filter_bank와 같은 식)."""
    fft = np.linspace(0, SR // 2, 1 + N_FFT // 2)
    edges = _mel_to_hz(np.linspace(_hz_to_mel(0.0), _hz_to_mel(8000.0), n_mels + 2))
    slopes = edges[None, :] - fft[:, None]
    down, up = -slopes[:, :-2] / np.diff(edges)[:-1], slopes[:, 2:] / np.diff(edges)[1:]
    return np.maximum(0.0, np.minimum(down, up)) * (2.0 / (edges[2:] - edges[:-2]))[None, :]


_MEL = mel_filters()


def log_mel(pcm: np.ndarray) -> np.ndarray:
    """[1,128,T] f32. WhisperFeatureExtractor(128 bins, padding=True, truncation=False)와 같은 값: 30초로 채우지 않는다."""
    x = np.pad(np.asarray(pcm, np.float64), N_FFT // 2, mode="reflect")
    frames = np.lib.stride_tricks.sliding_window_view(x, N_FFT)[::HOP]
    power = np.abs(np.fft.rfft(frames * np.hanning(N_FFT + 1)[:-1], axis=-1)) ** 2  # periodic Hann
    spec = np.log10(np.maximum(power @ _MEL, 1e-10)).T[:, :-1]  # 마지막 프레임은 버린다
    spec = (np.maximum(spec, spec.max() - 8.0) + 4.0) / 4.0
    return spec[None].astype(np.float32)


def build_prompt(n_audio: int, language: str | None, hotwords: list[str] | None) -> str:
    """mlx-audio `merge_hotwords` + `_build_prompt`와 같은 문자열. 토큰 ID를 박아 두지 않고 통째로 토큰화한다(상류의 9125·882 버그)."""
    terms = [str(h).strip() for h in hotwords or [] if h is not None and str(h).strip()]
    system = ", ".join(terms) + "\n" if terms else ""
    prefix = f"language {language}<asr_text>" if language else ""
    return (
        f"<|im_start|>system\n{system}<|im_end|>\n"
        f"<|im_start|>user\n<|audio_start|>{'<|audio_pad|>' * n_audio}<|audio_end|><|im_end|>\n"
        f"<|im_start|>assistant\n{prefix}"
    )


def parse_language(text: str) -> tuple[str, str]:
    """자동 감지 출력 `language Korean<asr_text>본문`을 나눈다. 표지가 없으면 ("English", 글 그대로): mlx-audio extract_language와 같다."""
    if "<asr_text>" in text and text.startswith("language "):
        cut = text.find("<asr_text>")
        return text[len("language "):cut].strip(), text[cut + len("<asr_text>"):]
    return "English", text


def pick(logits: np.ndarray, temperature: float, rng: np.random.Generator) -> int:
    """온도 0은 argmax, 아니면 softmax(logits/T)에서 하나 (Gumbel-max, mlx categorical_sampling과 같은 분포)."""
    if not temperature:
        return int(np.argmax(logits))
    return int(np.argmax(logits.astype(np.float64) / temperature + rng.gumbel(size=logits.shape)))


def decode(init, step, emb, ids: list[int], af: np.ndarray, off: int, eos: set[int], max_tokens: int, temperature: float, rng) -> list[int]:
    """디코딩 고리. 세션(`run(names, feeds)`)을 받아 가짜 세션으로 시험한다. EOS는 돌려주지 않고, 상한에 닿으면 max_tokens개를 돌려준다."""
    i64 = lambda v: np.asarray(v, np.int64)  # noqa: E731
    logits, keys, values = init.run(None, {"input_ids": i64([ids]), "position_ids": i64([range(len(ids))]), "audio_features": af, "audio_offset": i64([off])})
    out, pos = [], len(ids)
    nxt = pick(logits[0, -1], temperature, rng)
    while nxt not in eos and len(out) < max_tokens:
        out.append(nxt)
        logits, keys, values = step.run(None, {"input_embeds": np.asarray(emb[nxt], np.float32)[None, None], "position_ids": i64([[pos]]), "past_keys": keys, "past_values": values})
        pos += 1
        nxt = pick(logits[0, -1], temperature, rng)
    return out


def pad_short(pcm) -> np.ndarray:
    x = np.asarray(pcm, np.float32)
    return np.pad(x, (0, int(MIN_S * SR) - len(x))) if len(x) < MIN_S * SR else x


class OnnxQwen3ASR:
    def __init__(self, enc, init, step, tok, emb, cfg: dict):
        self.enc, self.init, self.step, self.tok, self.emb = enc, init, step, tok, emb
        special = cfg["special_tokens"]
        self.audio_pad = special["audio_pad_token_id"]
        self.eos = set(special["eos_token_ids"])

    @classmethod
    def load(cls, model_dir: Path) -> "OnnxQwen3ASR":
        """세션 셋 + 토크나이저 + 임베딩(memmap). onnxruntime·tokenizers는 여기서만 부른다."""
        rt = ort()
        from tokenizers import Tokenizer

        cfg = json.loads((model_dir / "config.json").read_text(encoding="utf-8"))
        session = lambda name: rt.InferenceSession(str(model_dir / name), providers=["CPUExecutionProvider"])  # noqa: E731
        dec = cfg["decoder"]
        emb = np.memmap(model_dir / "embed_tokens.bin", dtype=np.float16, mode="r", shape=(dec["vocab_size"], dec["hidden_size"]))
        tok = Tokenizer.from_file(str(model_dir / "tokenizer.json"))
        return cls(session("encoder.int4.onnx"), session("decoder_init.int4.onnx"), session(MARKER), tok, emb, cfg)

    def generate(self, audio, *, language: str | None = None, hotwords: list[str] | None = None, max_tokens: int = 8192, temperature: float = 0.0) -> Output:
        af = self.enc.run(["audio_features"], {"mel": log_mel(pad_short(audio))})[0]
        ids = self.tok.encode(build_prompt(af.shape[1], language, hotwords), add_special_tokens=False).ids
        out = decode(self.init, self.step, self.emb, ids, af, ids.index(self.audio_pad), self.eos, max_tokens, temperature, np.random.default_rng())
        text = self.tok.decode(out, skip_special_tokens=True)
        lang, text = (language, text) if language else parse_language(text)
        return Output(text, lang, len(out))
