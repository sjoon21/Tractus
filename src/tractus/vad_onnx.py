"""Silero VAD ONNX 판(`istupakov/silero-vad-onnx`, 16k 전용)을 onnxruntime으로 돌린다. Windows의 VAD 경로다 (docs/design/asr-onnx.md 5절).

mlx-audio 0.5.7 `SileroVAD._predict_proba_array`·`_probs_to_timestamps`를 numpy로 옮겼다. mlx를 불러오지 않는다.
값은 MLX 모델(`silero-vad-v6/config.json`)과 같다.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from tractus.asr_onnx import ort

MARKER = "silero_vad_16k_op15.onnx"  # 이 파일이 있으면 ONNX 폴더다 (vad.find_chunks)
SR = 16000
CHUNK, CONTEXT = 512, 64
THRESHOLD = 0.5
MIN_SPEECH_MS, MIN_SILENCE_MS, PAD_MS = 250, 100, 30


def probabilities(audio, session) -> np.ndarray:
    """512표본 창마다 발화 확률. 창 앞에 앞 창의 마지막 64표본(처음은 0)을 붙이고 state를 이어 받는다. 끝은 512의 배수로 0 채움."""
    x = np.asarray(audio, np.float32)
    if not len(x):
        return np.zeros(0, np.float32)
    x = np.pad(x, (CONTEXT, (-len(x)) % CHUNK))
    state, sr, out = np.zeros((2, 1, 128), np.float32), np.array(SR, np.int64), []
    for pos in range(CONTEXT, len(x), CHUNK):
        p, state = session.run(["output", "stateN"], {"input": x[None, pos - CONTEXT : pos + CHUNK], "state": state, "sr": sr})
        out.append(float(np.asarray(p).reshape(-1)[0]))
    return np.array(out, np.float32)


def timestamps(probs, audio_len: int) -> list[tuple[int, int]]:
    """확률열 → 발화 구간(표본). 임계값 0.5, 내려갈 때 0.35, 최소 발화 250ms, 최소 무음 100ms, 앞뒤 30ms 덧붙임 (겹치면 합침)."""
    min_speech, min_silence, pad = SR * MIN_SPEECH_MS / 1000, SR * MIN_SILENCE_MS / 1000, int(SR * PAD_MS / 1000)
    neg = max(THRESHOLD - 0.15, 0.01)
    speeches, triggered, start, temp_end = [], False, 0, 0
    for idx, p in enumerate(np.asarray(probs).tolist()):
        at = idx * CHUNK
        if p >= THRESHOLD:
            if not triggered:
                triggered, start = True, at
            temp_end = 0
            continue
        if triggered and p < neg:
            temp_end = temp_end or at
            if at - temp_end >= min_silence:
                if temp_end - start >= min_speech:
                    speeches.append((start, temp_end))
                triggered, temp_end = False, 0
    if triggered:
        end = min(audio_len, len(probs) * CHUNK)
        if end - start >= min_speech:
            speeches.append((start, end))
    padded: list[tuple[int, int]] = []
    for s, e in speeches:
        s, e = max(0, s - pad), min(audio_len, e + pad)
        if padded and s <= padded[-1][1]:
            padded[-1] = (padded[-1][0], max(padded[-1][1], e))
        else:
            padded.append((s, e))
    return padded


def speech_timestamps(audio, session) -> list[tuple[int, int]]:
    return timestamps(probabilities(audio, session), len(audio))


def load(model_dir: Path):
    rt = ort()
    opts = rt.SessionOptions()
    opts.intra_op_num_threads = opts.inter_op_num_threads = 1  # 작은 모델을 창마다 부른다: 스레드를 늘리면 오히려 느리다 (Silero 공식 래퍼와 같음)
    return rt.InferenceSession(str(model_dir / MARKER), sess_options=opts, providers=["CPUExecutionProvider"])
