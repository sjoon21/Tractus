"""목소리 프로필: 등록한 사람의 화자 임베딩과 회의 화자를 맞춰 이름을 **제안**한다 (확정은 사용자가 한다).

ARCHITECTURE.md §2.5. 임베딩은 생체정보다(개인정보보호법 제23조 민감정보). $TRACTUS_HOME/voices.json(권한 0600)에만 두고
회의 폴더·MCP·LLM 프롬프트·색인·내보내기·로그로 내보내지 않는다. 모델은 onnxruntime(CPU)과 kaldi-native-fbank로 돌린다.
"""

import fcntl
import json
import os
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

import numpy as np

SR = 16000
# 3D-Speaker CAM++ zh_en advanced (192차원, Apache-2.0: modelscope iic/speech_campplus_sv_zh_en_16k-common_advanced)
MODEL_ID = "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced"
MODEL_FILE = f"{MODEL_ID}.onnx"
MODEL_URL = f"https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/{MODEL_FILE}"
MODEL_SHA256 = "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2"  # 2026-10-07 내려받아 잰 값 (릴리스에 digest 없음)
MODEL_DIR = "3dspeaker-campplus-zh-en"

# 매칭 기준. 값은 bench/voice_eval.py(AI Hub 한국어 회의, 로컬 전용) 결과로 정한다. 모델이나 이 값을 바꾸면 벤치를 다시 돌린다.
# bench/results/voice_summary.json (AI Hub 4세션·40명, 3구간 중심 벡터 매칭 229회, 등록과 probe가 같은 세션): T=0.70에서
# AI Hub 라벨 그대로 맞음 88.2%, 틀림 1.3%, 제안 없음 10.5%, 본인 미등록 시 오제안 11.4%. 두 세션 사회자 1쌍(서로 0.9)을 같은 사람으로
# 보면(미검증) 95.6% / 1.3% / 3.1% / 2.2%. 그 1쌍의 세션 간 점수는 같은 세션보다 약 0.06 낮아(최소 0.736) 0.75 대신 0.70을 쓴다.
THRESHOLD = 0.70  # 사람 중심 벡터와의 코사인 하한
MARGIN = 0.08  # 1위 사람과 2위 사람 점수 차이 하한. 비슷한 두 사람 중 아무나 고르지 않게 한다

MIN_CLIP_S, MAX_CLIP_S, MAX_CLIPS = 1.5, 10.0, 3  # 화자당 1.5~10초 구간 최대 3개 (긴 것부터)
MAX_SAMPLES = 5  # 한 사람당 등록 표본 수. 넘으면 가장 오래된 것을 버린다
VOICES_FILE = "voices.json"
VERSION = 1


def _unit(v: np.ndarray) -> np.ndarray:
    v = np.asarray(v, np.float32)
    n = float(np.linalg.norm(v))
    return v / n if n > 0 else v


def fbank(pcm: np.ndarray) -> np.ndarray:
    """16kHz mono float32([-1, 1]) → 80차원 Kaldi fbank [프레임, 80], 프레임 평균을 뺀 값 (3D-Speaker 학습과 같은 입력).
    25ms 창, 10ms 이동, povey 창, dither 0, snip_edges=False, 20Hz~(나이퀴스트-400Hz). 모델 메타데이터
    normalize_samples=1(입력을 32768배 하지 않음), feature_normalize_type=global-mean과 맞춘다."""
    import kaldi_native_fbank as knf

    o = knf.FbankOptions()
    o.frame_opts.samp_freq = SR
    o.frame_opts.dither = 0.0
    o.frame_opts.snip_edges = False
    o.mel_opts.num_bins = 80
    o.mel_opts.low_freq = 20.0
    o.mel_opts.high_freq = -400.0
    f = knf.OnlineFbank(o)
    f.accept_waveform(SR, np.asarray(pcm, np.float32).tolist())
    f.input_finished()
    x = np.array([f.get_frame(i) for i in range(f.num_frames_ready)], np.float32).reshape(-1, 80)
    return x - x.mean(axis=0) if len(x) else x


class VoiceEmbedder:
    """onnxruntime(MIT) CPU로 3D-Speaker ONNX를 직접 돌린다. sherpa-onnx는 쓰지 않는다: 휠에 espeak-ng(GPL-3)가 정적 링크돼 있다.
    onnxruntime 1.29 이상이어야 한다. 1.28까지는 AveragePool(ceil_mode)의 마지막 짧은 창을 창 크기 전체로 나눠 PyTorch 원본과
    임베딩이 달라진다(긴 구간에서 cosine 약 0.975)."""

    def __init__(self, model_path: Path):
        import onnxruntime as ort

        so = ort.SessionOptions()
        so.intra_op_num_threads = 2
        so.inter_op_num_threads = 1
        so.log_severity_level = 3  # stdout·stderr에 경고를 쏟지 않는다
        self.session = ort.InferenceSession(str(model_path), so, providers=["CPUExecutionProvider"])
        meta = self.session.get_modelmeta().custom_metadata_map
        if meta.get("feature_normalize_type") != "global-mean" or meta.get("normalize_samples", "1") != "1" \
                or int(meta.get("sample_rate", SR)) != SR:
            raise RuntimeError(f"목소리 인식 파일이 올바르지 않습니다. 다시 받아 주세요: {model_path}")
        self.input = self.session.get_inputs()[0].name

    def embed(self, pcm: np.ndarray) -> np.ndarray:
        """16kHz mono float32 → L2 정규화한 임베딩."""
        x = fbank(pcm)
        if not len(x):
            raise ValueError("목소리 구간이 너무 짧습니다")
        return _unit(self.session.run(None, {self.input: x[None]})[0][0])


def model_path(models_dir: Path) -> Path:
    return models_dir / MODEL_DIR / MODEL_FILE


def model_hint(models_dir: Path) -> str:
    p = model_path(models_dir)
    return f"{p}\n  tractus models download voices\n  (직접 받기: mkdir -p {p.parent} && curl -L -o {p} {MODEL_URL}  sha256 {MODEL_SHA256})"


def model_present(models_dir: Path) -> bool:
    """목소리 인식 파일이 있고 올바른 파일이다 (load_embedder가 쓸 수 있다). 읽을 수 없으면 False."""
    import hashlib

    try:
        return hashlib.sha256(model_path(models_dir).read_bytes()).hexdigest() == MODEL_SHA256
    except OSError:
        return False


def load_embedder(models_dir: Path) -> VoiceEmbedder | None:
    """모델 파일이 없으면 None. 다른 파일이면(sha256 불일치) RuntimeError: 벡터 공간이 달라 등록한 목소리와 비교할 수 없다."""
    import hashlib

    p = model_path(models_dir)
    if not p.is_file():
        return None
    if hashlib.sha256(p.read_bytes()).hexdigest() != MODEL_SHA256:
        raise RuntimeError(f"목소리 인식 파일이 올바르지 않습니다. 다시 받아 주세요: {p}")
    return VoiceEmbedder(p)


# ── 구간 고르기·임베딩 ──────────────────────────────────────────────


def clips(segments: list[dict], label: str) -> list[tuple[float, float]]:
    """그 화자의 구간 중 MIN_CLIP_S 이상을 긴 것부터 MAX_CLIPS개. MAX_CLIP_S보다 길면 앞부분만 쓴다. segments: [{start, end, speaker}] (초)."""
    mine = sorted((s for s in segments if s.get("speaker") == label and s["end"] - s["start"] >= MIN_CLIP_S - 1e-9),
                  key=lambda s: s["end"] - s["start"], reverse=True)
    return [(s["start"], min(s["end"], s["start"] + MAX_CLIP_S)) for s in mine[:MAX_CLIPS]]


def speaker_embedding(embedder, pcm: np.ndarray, segments: list[dict], label: str) -> np.ndarray | None:
    """구간 임베딩의 정규화 평균. 쓸 만한 구간이 없으면 None."""
    embs = [embedder.embed(pcm[round(s * SR): round(e * SR)]) for s, e in clips(segments, label)]
    return _unit(np.mean(embs, axis=0)) if embs else None


def suggest(embedder, pcm: np.ndarray, segments: list[dict], people: list[dict], labels: list[str], dismissed: dict[str, set[str]] | None = None) -> dict:
    """labels 화자들을 등록된 사람과 맞춘 제안 {label: {person_id, name, score}}. dismissed: {label: 사용자가 거절한 person_id들}."""
    embs = {lb: v for lb in labels if (v := speaker_embedding(embedder, pcm, segments, lb)) is not None}
    return match(embs, people, dismissed)


def match(speaker_embs: dict[str, np.ndarray], people: list[dict], dismissed: dict[str, set[str]] | None = None) -> dict:
    """사람 중심 벡터(표본 정규화 평균)와 코사인 → 헝가리안 1:1 배정. 점수가 THRESHOLD 이상이고 그 화자의 2위 사람보다
    MARGIN 이상 높을 때만 제안한다. dismissed[label]에 든 사람은 그 화자에 배정하지 않는다(거절한 사람을 다시 제안하지 않는다).
    거절한 사람도 2위 비교에는 남겨 둔다: 비슷한 두 사람 중 아무나 고르지 않는다는 기준은 그대로다."""
    from scipy.optimize import linear_sum_assignment

    people = [p for p in people if p.get("samples")]
    labels = list(speaker_embs)
    if not people or not labels:
        return {}
    cent = np.stack([_unit(np.mean([s["embedding"] for s in p["samples"]], axis=0)) for p in people])
    score = np.stack([_unit(speaker_embs[lb]) for lb in labels]) @ cent.T  # [화자, 사람]
    allowed = np.array([[p["id"] not in (dismissed or {}).get(lb, ()) for p in people] for lb in labels])
    out = {}
    for i, j in zip(*linear_sum_assignment(-np.where(allowed, score, -1.0))):
        if not allowed[i, j]:
            continue
        second = max((score[i, k] for k in range(len(people)) if k != j), default=-1.0)
        if score[i, j] >= THRESHOLD and score[i, j] - second >= MARGIN:
            out[labels[i]] = {"person_id": people[j]["id"], "name": people[j]["name"], "score": round(float(score[i, j]), 2)}
    return out


# ── 프로필 파일 ($TRACTUS_HOME/voices.json, 0600) ──────────────────────


def load_profiles(home: Path) -> dict:
    """없으면 빈 프로필. 깨진 파일은 ValueError (덮어써서 등록한 목소리를 잃지 않게)."""
    path = home / VOICES_FILE
    if not path.exists():
        return {"version": VERSION, "model": MODEL_ID, "people": []}
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("people"), list):
        raise ValueError(f"목소리 프로필 형식이 아닙니다: {path}")
    return data


@contextmanager
def profiles_lock(home: Path):
    """voices.json을 읽고 고쳐 쓰는 동안 다른 프로세스의 같은 작업을 막는다 ($TRACTUS_HOME/.voices.lock, fcntl.flock).
    순서는 노트 잠금(store.note_lock) 다음이다. 이 잠금을 쥔 채 노트 잠금을 잡지 않는다 (서로 기다리는 일이 없게)."""
    home.mkdir(parents=True, exist_ok=True)
    fd = os.open(home / ".voices.lock", os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def save_profiles(home: Path, data: dict) -> None:
    """임시 파일을 0600으로 만들어 쓰고 바꿔 끼운다. 기존 파일 권한과 상관없이 결과는 0600."""
    home.mkdir(parents=True, exist_ok=True)
    path = home / VOICES_FILE
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)  # 남아 있던 임시 파일이면 O_CREAT 권한이 적용되지 않는다
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(data, ensure_ascii=False))
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def restore_profiles(home: Path, previous: dict | None) -> None:
    """save_profiles 이전 상태로 되돌린다 (previous가 None이면 파일이 없던 상태)."""
    if previous is None:
        (home / VOICES_FILE).unlink(missing_ok=True)
    else:
        save_profiles(home, previous)


def needs_reenroll(data: dict) -> bool:
    """다른 모델로 등록한 목소리가 있다 (지금 모델로는 비교할 수 없다)."""
    return data.get("model") != MODEL_ID and bool(data.get("people"))


def usable_people(data: dict) -> list[dict]:
    return data["people"] if data.get("model") == MODEL_ID else []


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def enroll(data: dict, name: str, embedding: np.ndarray, meeting_id: str) -> tuple[dict, dict]:
    """이름이 정확히 같은 사람에 표본을 덧붙인다(없으면 새로 만든다). 최대 MAX_SAMPLES개. 새 프로필과 그 사람을 돌려준다.
    다른 모델로 등록한 사람들은 지운다: 그 벡터는 지금 모델과 비교할 수 없어 쓸모없는 생체정보다."""
    from tractus.store import new_ulid

    people = usable_people(data)
    sample = {"embedding": [round(float(x), 6) for x in _unit(embedding)], "meeting_id": meeting_id, "added_at": _now()}
    old = next((p for p in people if p["name"] == name), None)
    if old is None:
        new = {"id": new_ulid(), "name": name, "created_at": _now(), "consent": True, "samples": [sample]}
        people = [*people, new]
    else:
        new = {**old, "consent": True, "samples": [*old["samples"], sample][-MAX_SAMPLES:]}
        people = [new if p is old else p for p in people]
    return {"version": VERSION, "model": MODEL_ID, "people": people}, new


def forget(data: dict, ref: str) -> tuple[dict, list[str]]:
    """이름 또는 id가 ref인 사람을 지운 새 프로필과 지운 id 목록."""
    gone = [p["id"] for p in data["people"] if ref in (p["id"], p["name"])]
    return {**data, "people": [p for p in data["people"] if p["id"] not in gone]}, gone
