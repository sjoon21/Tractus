"""`tractus doctor`와 `tractus models list`가 쓰는 점검 (docs/desktop.md §2.15). 무엇이 없어도 실패하지 않는다."""

import os
import platform
import re
import shutil
import subprocess
from pathlib import Path

from tractus import diarize
from tractus import models_registry as reg
from tractus.models_install import disk_free, lock_held, unregistered
from tractus.paths import tool_bin

MIN_MACOS = (14, 4)
TRACK_OF = {"asr-std": "standard", "asr-lite": "lite"}  # 모델 ID → cli.Track 값


def recorder_bin() -> Path:
    """$TRACTUS_REC_BIN → 앱 번들 → 저장소에서 빌드한 recorder/.build/release/tractus-rec (fluid_bin과 같은 paths.tool_bin 규칙)."""
    return tool_bin("TRACTUS_REC_BIN", "tractus-rec", "recorder/.build/release/tractus-rec")


def _version(cmd: list[str], pattern: str) -> str | None:
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(pattern, out)
    return m.group(1) if m else None


def tools() -> dict:
    ffmpeg = shutil.which("ffmpeg")
    rec, diar = recorder_bin(), diarize.fluid_bin()
    brew = shutil.which("brew") or next((p for p in ("/opt/homebrew/bin/brew", "/usr/local/bin/brew") if os.access(p, os.X_OK)), None)  # ffmpeg 설치 안내용
    return {
        "brew": {"found": bool(brew), "path": brew, "version": None},
        "ffmpeg": {"found": bool(ffmpeg), "path": ffmpeg, "version": _version([ffmpeg, "-version"], r"ffmpeg version (\S+)") if ffmpeg else None},
        "recorder": {"found": diarize._executable(rec), "path": str(rec)},
        "diar_helper": {"found": diarize._executable(diar), "path": str(diar)},
    }


def _macos() -> tuple[int, ...]:
    return tuple(int(x) for x in re.findall(r"\d+", platform.mac_ver()[0])[:2])


def system(root: Path) -> dict:
    """arch·macOS·메모리·디스크. meets_min: Apple Silicon, macOS 14.4 이상, 메모리 8GB 이상. problems에 이유 코드."""
    memory, mac = reg.physical_memory(), _macos()
    problems = []
    if platform.machine() != "arm64":
        problems.append("not_apple_silicon")
    if platform.system() != "Darwin" or mac < MIN_MACOS:
        problems.append("macos_too_old")
    if memory < reg.MIN_MEMORY:
        problems.append("memory_low")
    return {"arch": platform.machine(), "macos_version": platform.mac_ver()[0], "memory_gb": round(memory / 1024**3, 1),
            "meets_min": not problems, "problems": problems, "standard_recommended": memory >= reg.STANDARD_MIN_MEMORY,
            "disk_free_bytes": disk_free(root), "models_dir": str(root)}


def model_row(m: reg.Model, root: Path) -> dict:
    st = reg.inspect(m.id, root)
    return {"id": m.id, "name": m.name, "purpose": m.purpose, "level": m.level, "level_note": m.level_note, "size_bytes": m.size_bytes, "installed": st.installed,
            "installed_bytes": st.installed_bytes, "state": st.state, "needed_by": list(m.needed_by), "group": m.group,
            "path": str(root / m.local_dir), "model_name": m.model_name, "publisher": m.publisher, "converted_by": m.converted_by,
            "source": m.source, "revision": m.revision, "license": m.license, "languages": m.languages, "params": m.params}


def models_list(root: Path) -> dict:
    return {"models_dir": str(root), "disk_free_bytes": disk_free(root), "download_active": lock_held(root),
            "models": [model_row(m, root) for m in reg.MODELS], "unregistered": unregistered(root)}  # 등록되지 않은 폴더 (옛 모델 등): models prune


def effective_track(root: Path, memory: int | None = None) -> str | None:
    """지금 `--track` 없이 변환하면 쓰는 트랙: 메모리가 권하는 쪽이 쓸 수 있으면 그것, 아니면 다른 쪽, 둘 다 없으면 None."""
    pick = reg.pick_asr(root, memory)
    return pick and TRACK_OF[pick]


def report(root: Path) -> dict:
    t = tools()
    states = {m.id: reg.inspect(m.id, root).state for m in reg.MODELS}
    memory = reg.physical_memory()
    return {
        "system": system(root),
        "tools": t,
        "models": [{"id": m.id, "level": m.level, "level_note": m.level_note, "state": states[m.id]} for m in reg.MODELS],
        "capabilities": reg.capability_status(states, {k: v["found"] for k, v in t.items()}, memory),
        "recommended_track": TRACK_OF[reg.preferred_asr(memory)],
        "effective_track": effective_track(root, memory),
    }
