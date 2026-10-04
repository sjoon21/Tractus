"""화자 분리: Nemotron 3 Diarization (mlx-audio)으로 회의 전체를 한 번에 돌리고, 화자가 바뀌는 지점에서 VAD 청크를 나눈다.

ARCHITECTURE.md §2.4. 2026-10-03 실측(AI Hub 한국어 회의 84분, 화자 7명): 7/7명 검출, confusion 2.9%, DER 7.6%, 14초.
화자 경계로 자른 청크의 화자 순도 99.6% (기존 30초 VAD 청크는 85.7%).
엔진을 바꿀 때는 Diarizer.diarize만 [(시작 초, 끝 초, "S1"), ...]을 돌려주면 된다 (백업: FluidAudio community-1).
"""

from pathlib import Path

import numpy as np

SR = 16000
MAX_CHUNK_S = 30.0  # vad.MAX_CHUNK_S와 같다. 청크를 나누기만 하므로 늘어나지 않는다
MODEL_REPO = "mlx-community/Nemotron-3-Diarization"
MODEL_REVISION = "59ed2dbfc1346dcea9d423c71306a3a2499c568f"
MODEL_DIR = "nemotron-3-diarization"
MAX_SPEAKERS = 8  # 모델 출력 채널 수

# 단일 화자 평활화 (프레임 = 10ms)
THRESHOLD = 0.5  # 가장 높은 화자 확률이 이보다 낮으면 무음
MEDIAN_FRAMES = 11  # 화자별 다수결 창 (110ms). 짧은 깜빡임을 지운다
MIN_TURN_S = 1.0  # 이보다 짧은 turn은 버린다 (맞장구 등은 이웃 화자에 붙음)
FILL_GAP_S = 1.0  # 같은 화자 turn 사이 무음이 이 이하면 잇는다
MIN_PIECE_S = 1.0  # 청크를 나눈 조각이 이보다 짧으면 이웃 조각에 붙인다

Turn = tuple[float, float, str]


def params(max_speakers: int | None) -> dict:
    return {"threshold": THRESHOLD, "median_frames": MEDIAN_FRAMES, "min_turn_s": MIN_TURN_S, "fill_gap_s": FILL_GAP_S,
            "min_piece_s": MIN_PIECE_S, "max_speakers": max_speakers}


def _fill(turns: list[list], gap: float) -> list[list]:
    out: list[list] = []
    for t in turns:
        if out and out[-1][2] == t[2] and t[0] - out[-1][1] <= gap + 1e-9:
            out[-1][1] = t[1]
        else:
            out.append(list(t))
    return out


def smooth(probs: np.ndarray, stride: float, max_speakers: int | None = None) -> list[Turn]:
    """프레임별 화자 확률 [T, K] → 겹치지 않는 turn 목록. 라벨은 처음 말한 순서대로 S1, S2, …

    max_speakers: 말한 시간이 많은 N명만 남기고, 나머지 프레임은 남은 화자 중 확률이 가장 높은 쪽에 붙인다."""
    p = np.asarray(probs, np.float32)
    if p.size == 0:
        return []
    on = p.max(1) > THRESHOLD
    lab = p.argmax(1)
    if max_speakers and max_speakers < p.shape[1]:
        talk = np.bincount(lab[on], minlength=p.shape[1])
        keep = np.argsort(-talk, kind="stable")[:max_speakers]
        lab = keep[p[:, keep].argmax(1)]
    onehot = np.zeros(p.shape, np.int32)
    onehot[np.flatnonzero(on), lab[on]] = 1
    k = MEDIAN_FRAMES
    c = np.cumsum(np.pad(onehot, ((k // 2 + 1, k // 2), (0, 0))), axis=0)
    active = (c[k:] - c[:-k]) > k // 2  # 이진 median = 창 안 다수결. 프레임마다 화자는 많아야 하나
    frame = np.where(active.any(1), active.argmax(1), -1)
    edges = np.flatnonzero(np.diff(frame)) + 1
    runs = [[s * stride, e * stride, int(frame[s])] for s, e in zip(np.r_[0, edges], np.r_[edges, len(frame)]) if frame[s] >= 0]
    runs = _fill([r for r in _fill(runs, FILL_GAP_S) if r[1] - r[0] >= MIN_TURN_S - 1e-9], FILL_GAP_S)
    names: dict[int, str] = {}
    for r in runs:
        names.setdefault(r[2], f"S{len(names) + 1}")
    return [(round(s, 2), round(e, 2), names[ch]) for s, e, ch in runs]


def split_chunks(chunks: list[tuple[int, int]], turns: list[Turn]) -> list[tuple[int, int, str | None]]:
    """VAD 청크(표본 단위)를 화자가 바뀌는 지점에서 나눈다. 순수 함수.

    - 경계는 앞 turn 끝과 다음 turn 시작의 중간 (무음 한가운데).
    - 1초 미만 조각은 같은 청크 안 이웃 조각에 붙인다 (청크 자체가 1초 미만이면 그대로).
    - 조각은 원래 청크를 빈틈없이 덮고, 청크 안에서만 나누므로 30초를 넘지 않는다.
    - 어느 turn과도 겹치지 않는 청크는 화자 None."""
    ts = sorted((round(s * SR), round(e * SR), spk) for s, e, spk in turns)
    n_min = round(MIN_PIECE_S * SR)
    out: list[tuple[int, int, str | None]] = []
    for s, e in chunks:
        inside = [t for t in ts if t[0] < e and t[1] > s]
        if not inside:
            out.append((s, e, None))
            continue
        pieces, start, spk = [], s, inside[0][2]
        for a, b in zip(inside, inside[1:]):
            if b[2] != spk:
                cut = min(max((a[1] + b[0]) // 2, start), e)
                pieces.append([start, cut, spk])
                start, spk = cut, b[2]
        pieces.append([start, e, spk])
        merged: list[list] = []
        for p in pieces:
            if merged and (p[1] - p[0] < n_min or merged[-1][2] == p[2]):
                merged[-1][1] = p[1]  # 짧은 조각은 앞 조각에 붙인다
            elif merged and merged[-1][1] - merged[-1][0] < n_min:
                merged[-1] = [merged[-1][0], p[1], p[2]]  # 맨 앞 조각이 짧으면 다음 조각에 붙인다
            else:
                merged.append(p)
        out += [tuple(p) for p in merged]
    return out


class Diarizer:
    def __init__(self, model_dir: Path):
        from mlx_audio.vad import load

        self.model = load(str(model_dir), strict=True)
        m = self.model
        self.stride = m._processor_config.hop_length * m.config.output_subsampling_factor / m.sample_rate  # 10ms
        self.info = {"model": MODEL_REPO, "revision": MODEL_REVISION, "params": params(None)}

    def diarize(self, pcm: np.ndarray, max_speakers: int | None = None) -> list[Turn]:
        """16kHz mono float32 → turn 목록. 회의 전체를 한 번에 넣는다 (모델이 긴 녹음을 내부에서 스트리밍 처리)."""
        self.info = {**self.info, "params": params(max_speakers)}
        res = self.model.generate(pcm)
        return smooth(np.array(res.speaker_probs), self.stride, max_speakers)


def load_diarizer(models_dir: Path) -> Diarizer | None:
    """모델 파일이 없으면 None (화자 분리 없이 전사한다)."""
    path = models_dir / MODEL_DIR
    if not (path / "model.safetensors").exists() or not (path / "config.json").exists():
        return None
    return Diarizer(path)
