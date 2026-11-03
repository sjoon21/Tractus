"""변환 엔진·트랙 고르기: 어떤 모델로 변환할지 정하는 규칙 (명령이 아니라 파이프라인과 명령이 함께 쓰는 로직)."""

from enum import Enum
from pathlib import Path

import typer

from tractus import models_registry as registry
from tractus.commands import common
from tractus.diarize import FLUID
from tractus.diarize import NEMOTRON
from tractus.i18n import t
from tractus.models_registry import STANDARD_MIN_MEMORY
from tractus.paths import models_dir


class Track(str, Enum):
    standard = "standard"
    lite = "lite"


class LiveEngine(str, Enum):  # `tractus live --engine` (개발·벤치 전용)
    lite = "lite"
    std = "std"


class DiarizerEngine(str, Enum):
    auto = "auto"
    nemotron = NEMOTRON
    fluid = FLUID


class Language(str, Enum):
    auto = "auto"
    ko = "ko"
    en = "en"


# Phase 0 확정 모델 (ARCHITECTURE.md §2.2, §8)
# (저장소·리비전·폴더는 models_registry가 원본이다)
MODELS = {Track.standard: registry.get("asr-std").repo, Track.lite: registry.get("asr-lite").repo}
VAD_MODEL = registry.get("vad").repo


def local_model(repo: str) -> Path:
    m = registry.by_repo(repo)
    path = models_dir() / (m.local_dir if m else repo.split("/")[1].lower())
    # 받다 만 모델(config.json만 있고 가중치가 없는 폴더)이 로드 단계에서 트레이스백으로 죽지 않게 레지스트리의 완료 검사를 쓴다
    if not (registry.usable(m.id, models_dir()) if m else (path / "config.json").exists()):
        hint = registry.install_hint(m, models_dir()) if m else f"  hf download {repo} --local-dir {path}"
        raise typer.BadParameter(t("모델이 없습니다: {path}\n{hint}\n(모델 위치는 TRACTUS_MODELS_DIR 환경변수로 바꿀 수 있습니다)", path=path, hint=hint), param_hint=t("모델"))  # words-ok: 앱은 model_missing 코드로 문장을 바꾼다 (원래 문구는 자세히)
    return path


def recommended_track() -> Track:
    return Track.standard if registry.physical_memory() >= STANDARD_MIN_MEMORY else Track.lite


def auto_track() -> Track:
    """`--track` 없이 변환할 때의 트랙: 메모리가 권하는 쪽의 모델이 있으면 그것, 없고 다른 쪽이 있으면 그쪽으로 (경고 asr_track_fallback),
    둘 다 없으면 권하는 쪽을 돌려 local_model이 model_missing으로 알린다."""
    want = recommended_track()
    pick = registry.pick_asr(models_dir(), registry.physical_memory())
    if pick is None or registry.get(pick).repo == MODELS[want]:
        return want
    used = Track.lite if want is Track.standard else Track.standard
    common.warn("asr_track_fallback", t("{want} 변환 엔진이 없어 {used} 엔진으로 변환합니다 (받으려면 tractus models download {model})", want=want.value, used=used.value, model="asr-std" if want is Track.standard else "asr-lite"))
    return used


TRACK_MODEL = {Track.standard: "asr-std", Track.lite: "asr-lite"}


def engine_ready(repo: str) -> bool:
    """작업(.job.json)의 변환 엔진을 지금 쓸 수 있나."""
    m = registry.by_repo(repo)
    return registry.usable(m.id, models_dir()) if m else (models_dir() / repo.split("/")[-1].lower() / "config.json").is_file()


def track_name(m: registry.Model) -> str:
    """작업·transcript의 `track`: 기본 두 엔진은 standard·lite(예전과 같다), 나머지는 모델 ID."""
    return {"asr-std": Track.standard.value, "asr-lite": Track.lite.value}.get(m.id, m.id)


def choose_asr(track: Track | None, engine_id: str | None) -> registry.Model:
    """변환 엔진 고르기 (docs/design/asr-engines.md): `--engine <모델 ID>`(앱 설정 `기본 변환 엔진`) → `--track` → 메모리가 권하는 기본 엔진.
    고른 엔진을 받아 두지 않았으면 경고(asr_engine_missing)하고 기본 엔진으로 변환한다. 변환 엔진이 아닌 ID는 오류."""
    if engine_id:
        m = registry.find(engine_id)
        if m is None or not m.engine:
            raise typer.BadParameter(t("변환 엔진이 아닙니다: {id} ({choices})", id=engine_id, choices=", ".join(registry.asr_ids(models_dir()))), param_hint="--engine")
        if registry.usable(m.id, models_dir()):
            return m
        common.warn("asr_engine_missing", t("고른 변환 엔진({name})이 없어 기본 엔진으로 변환합니다 (받으려면 tractus models download {id})", name=m.name, id=m.id))
    return registry.get(TRACK_MODEL[track or auto_track()])
