"""데이터·모델·도우미 프로그램 위치. CLI와 MCP 서버가 같은 규칙을 쓴다."""

import os
import sys
from pathlib import Path

APP_MODELS = Path("~/Library/Application Support/dev.tractus.app/models")  # 앱 설정 폴더 아래: iCloud 동기화·노트 폴더 밖


def home_dir() -> Path:
    return Path(os.environ.get("TRACTUS_HOME") or Path.home() / "Tractus").expanduser()


def models_dir() -> Path:
    """TRACTUS_MODELS_DIR → (등록된 모델이 이미 있는) $TRACTUS_HOME/models → 앱 설정 폴더의 models."""
    if env := os.environ.get("TRACTUS_MODELS_DIR"):
        return Path(env).expanduser()
    from tractus.models_registry import MODELS  # 늦게 불러온다: 이 모듈은 모델 모듈이 쓰는 가장 아래층이다

    legacy = home_dir() / "models"  # 예전 기본값. 모델이 이미 있는 사용자는 그대로 쓴다
    return legacy if any((legacy / m.local_dir).is_dir() for m in MODELS) else APP_MODELS.expanduser()


REPO_ROOT = Path(__file__).resolve().parents[2]
_HINTS = {  # 없는 도우미 프로그램: (저장소에서 실행 중일 때 쓸 빌드 명령, 아닐 때의 일반 안내)
    "recorder": ("cd {repo}/recorder && swift build -c release --product tractus-rec", "앱을 다시 설치하거나 TRACTUS_REC_BIN에 tractus-rec 위치를 지정하세요"),
    "diar_helper": ("cd {repo}/recorder/diar && swift build -c release", "TRACTUS_DIAR_BIN에 tractus-diar 위치를 지정하세요"),
}


def in_repo() -> bool:
    """저장소를 받아 직접 빌드한 배치인가 (앱 번들이나 설치본이면 아니다). 빌드 안내는 이때만 저장소 경로를 말한다."""
    return (REPO_ROOT / "recorder" / "Package.swift").is_file()


def tool_bin(env: str, name: str, repo_rel: str) -> Path:
    """녹음·도우미 프로그램 위치: $env → 앱 번들(파이썬이 <앱>/Contents/Resources/runtime/bin에 있으면 ../../bin/<name>) → 저장소에서 빌드한 것.
    존재하는 첫 후보를 돌려주고, 없으면 저장소 배치일 때 저장소 경로, 아니면 번들 경로(안내와 점검 표시용)."""
    if value := os.environ.get(env):
        return Path(value)
    exe = Path(sys.executable)  # resolve하지 않는다: venv의 python은 링크다
    repo = REPO_ROOT / repo_rel
    if exe.parts[-6:-1][1:] != ("Contents", "Resources", "runtime", "bin") or not exe.parts[-6].endswith(".app"):  # 앱 번들의 파이썬이 아니면 ~/bin 같은 엉뚱한 곳을 보지 않는다
        return repo
    bundle = exe.parent.parent.parent / "bin" / name
    return next((p for p in (bundle, repo) if p.is_file()), repo if in_repo() else bundle)


def build_hint(item: str) -> str:
    """item(recorder | diar_helper)을 채우는 안내. 저장소 배치일 때만 빌드 명령을 말한다."""
    repo_cmd, generic = _HINTS[item]
    return repo_cmd.format(repo=REPO_ROOT) if in_repo() else generic
