"""데이터·모델 위치. CLI와 MCP 서버가 같은 규칙을 쓴다."""

import os
from pathlib import Path


def home_dir() -> Path:
    return Path(os.environ.get("TRACTUS_HOME") or Path.home() / "Tractus").expanduser()


def models_dir() -> Path:
    return Path(os.environ.get("TRACTUS_MODELS_DIR") or home_dir() / "models").expanduser()
