"""`tractus doctor`와 `tractus models list`가 쓰는 점검 (docs/desktop.md §2.15). 무엇이 없어도 실패하지 않는다."""

import os
import platform
import re
import shutil
import subprocess
from pathlib import Path

from tractus import diarize, platform_compat
from tractus import models_registry as reg
from tractus.models_install import disk_free, lock_held, unregistered
from tractus.paths import tool_bin

MIN_MACOS = (14, 4)
MIN_WINDOWS_BUILD = 19041  # Windows 10 2004 (process loopback 최소, docs/windows/plan.md §7.1)
TRACK_OF = {"asr-std": "standard", "asr-lite": "lite"}  # 모델 ID → cli.Track 값


def recorder_bin() -> Path:
    """$TRACTUS_REC_BIN → 앱 번들 → 저장소에서 빌드한 녹음 프로그램 (fluid_bin과 같은 paths.tool_bin 규칙)."""
    repo_rel = "recorder/win/target/release/tractus-rec" if platform_compat.WINDOWS else "recorder/.build/release/tractus-rec"
    return tool_bin("TRACTUS_REC_BIN", "tractus-rec", repo_rel)


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


def _windows_build() -> tuple[int, ...]:
    return tuple(int(x) for x in re.findall(r"\d+", platform.version())[:3])


def system(root: Path) -> dict:
    """arch·OS 버전·메모리·디스크. macOS: arm64·14.4+·8GB+, Windows: x64(AMD64)·빌드 19041+·8GB+. problems에 이유 코드."""
    memory, os_name, arch = reg.physical_memory(), platform.system(), platform.machine()
    problems = []
    if os_name == "Windows":
        if arch.lower() not in ("amd64", "x86_64"):
            problems.append("unsupported_arch")
        build = _windows_build()
        if len(build) < 3 or build < (10, 0, MIN_WINDOWS_BUILD):
            problems.append("windows_too_old")
    else:
        if arch != "arm64":
            problems.append("not_apple_silicon")
        if os_name != "Darwin" or _macos() < MIN_MACOS:
            problems.append("macos_too_old")
    if memory < reg.MIN_MEMORY:
        problems.append("memory_low")
    return {"arch": arch, "macos_version": platform.mac_ver()[0], "memory_gb": round(memory / 1024**3, 1),
            "meets_min": not problems, "problems": problems, "standard_recommended": memory >= reg.STANDARD_MIN_MEMORY,
            "disk_free_bytes": disk_free(root), "models_dir": str(root)}


def model_row(m: reg.Model, root: Path) -> dict:
    st = reg.inspect(m.id, root)
    return {"id": m.id, "name": m.name, "purpose": m.purpose, "level": m.level, "level_note": m.level_note, "size_bytes": m.size_bytes, "installed": st.installed,
            "installed_bytes": st.installed_bytes, "state": st.state, "needed_by": list(m.needed_by), "group": m.group,
            "path": str(root / m.local_dir), "model_name": m.model_name, "publisher": m.publisher, "converted_by": m.converted_by,
            "source": m.source, "revision": m.revision, "license": m.license, "languages": m.languages, "params": m.params,
            "engine": m.engine, "custom": m.custom}


def models_list(root: Path) -> dict:
    return {"models_dir": str(root), "disk_free_bytes": disk_free(root), "download_active": lock_held(root),
            "models": [model_row(m, root) for m in reg.all_models(root)], "unregistered": unregistered(root)}  # 등록되지 않은 폴더 (옛 모델 등): models prune


def effective_track(root: Path, memory: int | None = None) -> str | None:
    """지금 `--track` 없이 변환하면 쓰는 트랙: 메모리가 권하는 쪽이 쓸 수 있으면 그것, 아니면 다른 쪽, 둘 다 없으면 None."""
    pick = reg.pick_asr(root, memory)
    return pick and TRACK_OF.get(pick, pick)  # 기본 두 엔진은 standard·lite, 나머지는 모델 ID


def report(root: Path) -> dict:
    t = tools()
    states = {m.id: reg.inspect(m.id, root).state for m in reg.all_models(root)}
    memory = reg.physical_memory()
    return {
        "system": system(root),
        "tools": t,
        "models": [{"id": m.id, "level": m.level, "level_note": m.level_note, "state": states[m.id]} for m in reg.all_models(root)],
        "capabilities": reg.capability_status(states, {k: v["found"] for k, v in t.items()}, memory),
        "recommended_track": TRACK_OF[reg.preferred_asr(memory)],
        "effective_track": effective_track(root, memory),
    }
