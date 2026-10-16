"""모든 시험 공통."""

import os
import time

import pytest

# 녹음 시각(+09:00)을 로컬 시각으로 바꿔 비교하는 시험이 있다. 한국 밖의 Mac·UTC인 CI 러너에서도 같게 시간대를 고정한다
os.environ["TZ"] = "Asia/Seoul"
time.tzset()

from tractus import paths


@pytest.fixture(autouse=True)
def _app_models_in_tmp(tmp_path_factory, monkeypatch):
    """TRACTUS_MODELS_DIR이 없을 때의 기본 모델 폴더(앱 설정 폴더)가 이 Mac의 실제 `~/Library`를 가리키지 않게 한다."""
    monkeypatch.setattr(paths, "APP_MODELS", tmp_path_factory.mktemp("app-models") / "models")
