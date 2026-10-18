"""화자 분리: Nemotron 3 Diarization (mlx-audio)으로 회의 전체를 한 번에 돌리고, 화자가 바뀌는 지점에서 VAD 청크를 나눈다.

ARCHITECTURE.md §2.4. 2026-10-03 실측(AI Hub 한국어 회의 84분, 화자 7명): 7/7명 검출, confusion 2.9%, DER 7.6%, 14초.
화자 경계로 자른 청크의 화자 순도 99.6% (기존 30초 VAD 청크는 85.7%).
엔진을 바꿀 때는 Diarizer.diarize만 [(시작 초, 끝 초, "S1"), ...]을 돌려주면 된다.

두 번째 엔진(v3.15): FluidDiarizer는 Swift 헬퍼 tractus-diar(FluidAudio 오프라인 = pyannote community-1, CoreML)를
subprocess로 부른다. Nemotron은 8명이 상한이라, 9명 이상 회의는 이쪽으로 다시 돌린다 (cli._diarize).
"""

import json
import os
import subprocess
import tempfile
import wave
from pathlib import Path

import numpy as np

from tractus.i18n import t
from tractus.paths import REPO_ROOT, build_hint, in_repo, tool_bin  # noqa: F401 — REPO_ROOT는 테스트가 diarize에서 가져온다

SR = 16000
MAX_CHUNK_S = 30.0  # vad.MAX_CHUNK_S와 같다. 청크를 나누기만 하므로 늘어나지 않는다
MODEL_REPO = "mlx-community/Nemotron-3-Diarization"
MODEL_REVISION = "59ed2dbfc1346dcea9d423c71306a3a2499c568f"
MODEL_DIR = "nemotron-3-diarization"
MAX_SPEAKERS = 8  # 모델 출력 채널 수
NEMOTRON = "nemotron"
FLUID = "fluid"
FLUID_MIN_CLIP_S = 60.0  # community-1(pyannote)은 이보다 짧은 클립에서 화자를 과하게 쪼갠다. --diarizer fluid로 명시했을 때만 경고한다 (auto는 8명을 다 쓴 긴 회의에서만 fluid로 간다)

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
            out[-1][1] = max(out[-1][1], t[1])  # 겹치는 turn(fluid)이 앞 turn을 줄이지 않게
        else:
            out.append(list(t))
    return out


def _tidy(runs: list[list]) -> list[Turn]:
    """turn 단위 정리 (시작 순으로 정렬된 [시작, 끝, 화자]): 같은 화자 사이 짧은 무음 메움 → 짧은 turn 제거 → 다시 메움.
    라벨은 처음 말한 순서대로 S1, S2, …"""
    runs = _fill([r for r in _fill(runs, FILL_GAP_S) if r[1] - r[0] >= MIN_TURN_S - 1e-9], FILL_GAP_S)
    names: dict = {}
    for r in runs:
        names.setdefault(r[2], f"S{len(names) + 1}")
    return [(round(s, 2), round(e, 2), names[k]) for s, e, k in runs]


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
    return _tidy([[s * stride, e * stride, int(frame[s])] for s, e in zip(np.r_[0, edges], np.r_[edges, len(frame)]) if frame[s] >= 0])


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
        self.info = {"engine": NEMOTRON, "model": MODEL_REPO, "revision": MODEL_REVISION, "params": params(None)}

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


# ── FluidAudio 오프라인 화자 분리 (Swift 헬퍼 tractus-diar) ──────────────────

FLUID_REPO = "FluidInference/speaker-diarization-coreml"
FLUID_DIR = "speaker-diarization"  # FluidAudio가 정한 폴더 이름. <models>/<FLUID_DIR>를 --models로 넘기면 헬퍼가 그 폴더를 쓴다
FLUID_FILES = ("Segmentation.mlmodelc", "Embedding.mlmodelc")  # 있는지만 본다. 나머지는 헬퍼가 확인한다
FLUID_TIMEOUT_BASE_S = 120.0  # CoreML 첫 컴파일 포함
FLUID_TIMEOUT_RTF = 0.2  # 2026-10-04 실측 RTF 0.006–0.016의 10배 이상


def fluid_bin() -> Path:
    """$TRACTUS_DIAR_BIN → 앱 번들 → 저장소에서 빌드한 recorder/diar/.build/release/tractus-diar (paths.tool_bin, 녹음 프로그램과 같은 규칙)."""
    return tool_bin("TRACTUS_DIAR_BIN", "tractus-diar", "recorder/diar/.build/release/tractus-diar")


def fluid_timeout(duration_s: float) -> float:
    return FLUID_TIMEOUT_BASE_S + FLUID_TIMEOUT_RTF * duration_s


def fluid_params(max_speakers: int | None) -> dict:
    """turn 단위 정리만 한다. smooth의 threshold·median은 Nemotron 프레임 확률용이라 쓰지 않는다."""
    return {"min_turn_s": MIN_TURN_S, "fill_gap_s": FILL_GAP_S, "min_piece_s": MIN_PIECE_S, "max_speakers": max_speakers}


def _executable(p: Path) -> bool:
    return p.is_file() and os.access(p, os.X_OK)


def _fluid_models_ok(path: Path) -> bool:
    return all((path / f).exists() for f in FLUID_FILES)


def fluid_hint(models_dir: Path) -> str:
    """빠진 것(헬퍼 빌드·모델)을 채우는 명령."""
    binary, path = fluid_bin(), models_dir / FLUID_DIR
    lines = []
    if not _executable(binary):
        lines.append("  " + t("헬퍼: {hint}", hint=build_hint("diar_helper")) + ("  " + t("(Swift 6.2 이상, 다른 위치면 TRACTUS_DIAR_BIN)") if in_repo() else ""))
    if not _fluid_models_ok(path):
        lines.append("  " + t("모델 받기: tractus models download fluid  (직접: {cmd})", cmd=f"{binary} download --models {path}"))
    return "\n".join(lines)


def _write_wav(path: Path, pcm: np.ndarray) -> None:
    x = (np.clip(np.asarray(pcm, np.float32), -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(x.tobytes())


def _parse_events(stdout: str) -> tuple[dict | None, str | None]:
    """JSON Lines → (마지막 result, 마지막 error 메시지). JSON이 아닌 줄은 건너뛴다."""
    result = error = None
    for line in stdout.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if isinstance(ev, dict) and ev.get("event") == "result":
            result = ev
        elif isinstance(ev, dict) and ev.get("event") == "error":
            error = str(ev.get("message"))
    return result, error


def _fluid_turns(raw) -> list[list]:
    try:
        turns = sorted([float(s), float(e), str(k)] for s, e, k in raw)
    except (TypeError, ValueError) as e:
        raise RuntimeError(t("tractus-diar 결과 형식이 잘못됐습니다: {error}", error=e)) from None
    return [t for t in turns if t[1] > t[0]]


class FluidDiarizer:
    """Diarizer와 같은 인터페이스. 회의 전체를 임시 16 kHz WAV로 써서 헬퍼에 넘기고, 결과 turn을 _tidy로 정리한다.
    헬퍼는 오프라인으로 돈다 (모델은 --models 폴더에서만 읽는다)."""

    def __init__(self, binary: Path, model_dir: Path):
        self.binary, self.model_dir = binary, model_dir
        self.info = {"engine": FLUID, "model": FLUID_REPO, "revision": None, "params": fluid_params(None)}

    def diarize(self, pcm: np.ndarray, max_speakers: int | None = None) -> list[Turn]:
        with tempfile.TemporaryDirectory(prefix="tractus-diar-") as tmp:
            wav = Path(tmp) / "audio.wav"
            _write_wav(wav, pcm)
            cmd = [str(self.binary), "run", "--audio", str(wav), "--models", str(self.model_dir)]
            if max_speakers:
                cmd += ["--max-speakers", str(max_speakers)]
            try:
                p = subprocess.run(cmd, capture_output=True, text=True, timeout=fluid_timeout(len(pcm) / SR))
            except subprocess.TimeoutExpired as e:
                raise RuntimeError(t("tractus-diar 시간 초과 ({seconds}초)", seconds=f"{e.timeout:.0f}")) from None
        result, error = _parse_events(p.stdout)
        if p.returncode or result is None:
            detail = error or p.stderr.strip()[-500:] or t("결과 없음")
            raise RuntimeError(t("tractus-diar 실패 (종료 코드 {code}): {detail}", code=p.returncode, detail=detail))
        turns = _fluid_turns(result.get("turns") or [])
        model, _, revision = str(result.get("model") or FLUID_REPO).partition("@")
        self.info = {"engine": FLUID, "model": model, "revision": revision or None, "params": fluid_params(max_speakers)}
        return _tidy(turns)


def load_fluid(models_dir: Path) -> FluidDiarizer | None:
    """헬퍼 바이너리나 모델이 없으면 None (fluid_hint로 안내한다)."""
    binary, path = fluid_bin(), models_dir / FLUID_DIR
    if not _executable(binary) or not _fluid_models_ok(path):
        return None
    return FluidDiarizer(binary, path)
