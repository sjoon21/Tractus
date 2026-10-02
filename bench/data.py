"""Phase 0 데이터셋 로더. 모든 로더는 Sample(16kHz mono float32)을 돌려준다."""

import glob
import io
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import soundfile as sf

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
SR = 16000

# D-4: AMI 시나리오별 첫 회의 3건 (약 45분)
AMI_MEETINGS = ("ES2004a", "IS1009a", "TS3003a")


@dataclass
class Sample:
    id: str
    audio: np.ndarray
    ref: str
    lang: str  # 고정 조건에서 쓸 언어 (ko/en)
    meta: dict = field(default_factory=dict)


def _decode(audio_bytes: bytes) -> np.ndarray:
    a, sr = sf.read(io.BytesIO(audio_bytes), dtype="float32")
    if a.ndim > 1:
        a = a.mean(axis=1)
    if sr != SR:
        raise ValueError(f"샘플레이트 {sr}Hz — 16kHz만 지원")
    return a


def fleurs_ref(raw: str) -> str:
    """괄호 안 원어 병기("키르치네르(Cristina ...)")는 발화되지 않으므로 정답에서 뺀다.
    빼지 않으면 1.7B CER이 4.38%, 빼면 2.62%로 공개 수치(2.57%)와 맞는다."""
    return re.sub(r"\([^()]*\)", "", raw)


def fleurs():
    t = pq.read_table(DATA_DIR / "fleurs/parquet-data/ko_kr/test-00000-of-00001.parquet")
    for r in t.to_pylist():
        yield Sample(f"fleurs-{r['id']}-{r['path']}", _decode(r["audio"]["bytes"]), fleurs_ref(r["raw_transcription"]), "ko")


def hike():
    t = pq.read_table(DATA_DIR / "hike/data/test-00000-of-00001.parquet")
    for r in t.to_pylist():
        meta = {k: r[k] for k in ("text_normalized", "text_pier_labeled", "loanwords", "cs_level", "category")}
        yield Sample(r["sample_id"], _decode(r["audio"]["bytes"]), r["text"], "ko", meta)


def ami():
    for f in sorted(glob.glob(str(DATA_DIR / "ami/ihm/test-*.parquet"))):
        t = pq.read_table(f)
        for r in t.to_pylist():
            if r["meeting_id"] in AMI_MEETINGS:
                yield Sample(r["audio_id"], _decode(r["audio"]["bytes"]), r["text"], "en", {"meeting": r["meeting_id"]})


# --- AI Hub 회의 음성 (D-3, D-5) -------------------------------------------
# 전사 규칙: (발음)/(철자) 이중전사, /(bgm) 같은 잡음 태그, (()) 알아듣기 어려운 구간,
# @이름1 같은 비식별화 태그, 어~ 같은 간투사 표시(~).
_DUAL = re.compile(r"\(([^()]*)\)/\(([^()]*)\)")
_NOISE_TAG = re.compile(r"/\([a-z]+\)")
_DEID = re.compile(r"@\S+")


def aihub_clean(form: str, spelling: bool = True) -> str:
    """spelling=True면 철자전사(6프로, WTO), False면 발음전사(육 프로, 더블유티오)."""
    s = _DUAL.sub(lambda m: m.group(2) if spelling else m.group(1), form)
    s = _NOISE_TAG.sub(" ", s).replace("(())", " ")
    s = _DEID.sub(" ", s).replace("~", "")
    return re.sub(r"\s+", " ", s).strip()


def aihub():
    """회의 세션 단위로 돌려준다. 전체가 (())인 발화 구간은 오디오를 무음 처리한다."""
    for jf in sorted(glob.glob(str(DATA_DIR / "aihub-meeting/라벨링데이터/*/*/*/*.json"))):
        d = json.loads(Path(jf).read_text(encoding="utf-8"))
        sid = d["metadata"]["title"]
        wav = next(Path(DATA_DIR / "aihub-meeting/원천데이터").rglob(f"{sid}.wav"))
        a, sr = sf.read(wav, dtype="float32")
        assert sr == SR
        utts = d["utterance"]
        for u in utts:
            if u["form"].strip() == "(())":
                a[int(float(u["start"]) * SR) : int(float(u["end"]) * SR)] = 0.0
        ref = " ".join(aihub_clean(u["form"]) for u in utts)
        ref_pron = " ".join(aihub_clean(u["form"], spelling=False) for u in utts)
        terms = sorted({re.sub(r"[가-힣]+$", "", t["english"]) for u in utts for t in (u["hangeulToEnglish"] or [])} - {""})
        meta = {"ref_pron": ref_pron, "topic": d["metadata"]["topic"], "glossary": terms}
        yield Sample(sid, a, ref, "ko", meta)


DATASETS = {"fleurs": fleurs, "hike": hike, "ami": ami, "aihub": aihub}
