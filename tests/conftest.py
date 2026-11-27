"""모든 시험 공통."""

import os
import sys
import time

import pytest

# 녹음 시각(+09:00)을 로컬 시각으로 바꿔 비교하는 시험이 있다. 한국 밖의 Mac·UTC인 CI 러너에서도 같게 시간대를 고정한다
if hasattr(time, "tzset"):  # Windows에는 없고 C 런타임이 TZ=Asia/Seoul을 잘못 읽는다: windows-core.yml이 러너 시간대를 tzutil로 맞춘다
    os.environ["TZ"] = "Asia/Seoul"
    time.tzset()

from tractus import paths

WINDOWS = sys.platform == "win32"


def mac_only(reason: str):
    """macOS에서만 뜻이 있는 시험(MLX, Swift 도우미, .sh 스크립트, 유닉스 신호 등)을 다른 OS에서 건너뛴다. `from conftest import mac_only`."""
    return pytest.mark.skipif(sys.platform != "darwin", reason=reason)


# 자주 쓰는 이유 (docs/windows/README.md §2.2)
NO_MLX = "MLX(mlx.core)는 Windows에서 불러와지지 않는다. 변환 런타임은 W4에서 정한다"
FLUID_MAC = "fluid 화자 분리 도우미 tractus-diar는 Swift·CoreML이라 macOS 전용이다 (가짜 도우미도 #! 스크립트)"


@pytest.fixture(autouse=True)
def _app_models_in_tmp(tmp_path_factory, monkeypatch):
    """TRACTUS_MODELS_DIR이 없을 때의 기본 모델 폴더(앱 설정 폴더)가 이 Mac의 실제 `~/Library`를 가리키지 않게 한다."""
    monkeypatch.setattr(paths, "APP_MODELS", tmp_path_factory.mktemp("app-models") / "models")


@pytest.fixture(autouse=True)
def _home_in_tmp(tmp_path_factory, monkeypatch):
    """`env` 픽스처를 빠뜨린 시험이 이 Mac의 실제 노트 폴더(~/Tractus, 저장소 .env의 TRACTUS_HOME)에 노트를 만들지 않게 한다.
    셸 환경변수가 .env보다 이기므로 여기서 정하면 CLI도 이 폴더를 쓴다. `env` 픽스처는 이것을 다시 덮어쓴다."""
    monkeypatch.setenv("TRACTUS_HOME", str(tmp_path_factory.mktemp("home")))


def use_models(monkeypatch, models) -> None:
    """등록 목록을 바꿔 끼운다: `models_registry.MODELS = …` 한 줄에서 import 때 계산되는 것 모두(기능·ID 표·직접 추가 허용, engines의 트랙·VAD 저장소).
    Windows 목록 시험은 `use_models(monkeypatch, reg._windows_models())`, 운영체제와 상관없이 Mac 목록을 보는 시험은 `_mac_models()`."""
    from tractus import models_registry as reg
    from tractus.commands import engines

    windows = any(m.repo in reg.ONNX_REPOS for m in models)
    monkeypatch.setattr(reg, "MODELS", models)
    monkeypatch.setattr(reg, "CAPABILITIES", reg._capabilities(models))
    monkeypatch.setattr(reg, "_BY_ID", {m.id: m for m in models})
    monkeypatch.setattr(reg, "CUSTOM_SUPPORTED", not windows)
    track_model = {tr: mid for tr, mid in ((engines.Track.standard, "asr-std"), (engines.Track.lite, "asr-lite")) if reg.find(mid)}
    monkeypatch.setattr(engines, "TRACK_MODEL", track_model)
    monkeypatch.setattr(engines, "MODELS", {tr: reg.get(mid).repo for tr, mid in track_model.items()})
    monkeypatch.setattr(engines, "VAD_MODEL", reg.get("vad").repo)


@pytest.fixture(autouse=True)
def _mac_model_list(monkeypatch):
    """Windows CI에서도 지금까지의 시험은 Mac 목록을 본다(Windows 목록은 그것을 바꿔 끼운 시험이 따로 본다). macOS에서는 아무것도 바꾸지 않는다."""
    if WINDOWS:
        from tractus import models_registry as reg

        use_models(monkeypatch, reg._mac_models())
