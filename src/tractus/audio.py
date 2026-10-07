"""FFmpeg 호출. 번들하지 않고 외부 바이너리로 실행한다(LGPL/GPL을 Apache-2.0 배포물과 분리)."""

import hashlib
import shutil
import subprocess
from pathlib import Path

import numpy as np

SR = 16000


class FFmpegError(RuntimeError):
    pass


class FFmpegMissing(FFmpegError):
    """ffmpeg가 설치되지 않음. 앱은 code=ffmpeg_missing으로 설치 안내를 보인다."""


def require_ffmpeg() -> None:
    if shutil.which("ffmpeg") is None:
        raise FFmpegMissing("음성 파일을 읽는 데 필요한 ffmpeg가 없습니다. 터미널에서 brew install ffmpeg로 설치하세요.")


def _run(args: list[str], capture: bool = False) -> bytes:
    proc = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", *args], capture_output=True)
    if proc.returncode != 0:
        raise FFmpegError(proc.stderr.decode(errors="replace").strip() or f"ffmpeg 실패 (exit {proc.returncode})")
    return proc.stdout if capture else b""


def _inputs(paths: list[Path]) -> list[str]:
    """입력이 여러 개(녹음의 마이크·시스템 트랙)면 amix로 섞는다. normalize=0: 트랙 수만큼 음량을 줄이지 않는다."""
    args = [a for p in paths for a in ("-i", str(p))]
    if len(paths) > 1:
        args += ["-filter_complex", f"amix=inputs={len(paths)}:duration=longest:normalize=0"]
    return args


def decode(paths: Path | list[Path]) -> np.ndarray:
    """임의 형식(m4a/mp3/wav/webm/mp4/mov…)을 16kHz mono float32로 디코딩한다. 여러 파일이면 섞는다."""
    paths = [paths] if isinstance(paths, Path) else paths
    try:
        raw = _run([*_inputs(paths), "-vn", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"], capture=True)  # -vn: 동영상(mp4·mov)은 소리만
    except FFmpegError as e:
        if "does not contain any stream" in str(e):
            raise FFmpegError(f"소리가 없는 파일입니다. 소리 없는 동영상인지 확인하세요: {', '.join(p.name for p in paths)}") from e
        raise
    audio = np.frombuffer(raw, dtype=np.float32)
    if audio.size == 0:
        raise FFmpegError(f"녹음된 소리가 없습니다: {', '.join(p.name for p in paths)}")
    return audio


def encode_opus(srcs: Path | list[Path], dst: Path) -> None:
    """보관용 mono Opus 32kbps (1시간 약 14MB). dst 확장자가 .ogg면 Ogg 컨테이너 (Obsidian은 .opus를 열지 못함)."""
    srcs = [srcs] if isinstance(srcs, Path) else srcs
    _run(["-y", *_inputs(srcs), "-vn", "-ac", "1", "-c:a", "libopus", "-b:a", "32k", "-application", "voip", str(dst)])


def sha256(paths: Path | list[Path]) -> str:
    """파일 내용의 SHA-256. 여러 파일이면 순서대로 이어서 해시한다 (녹음 트랙 묶음 식별용)."""
    h = hashlib.sha256()
    for path in [paths] if isinstance(paths, Path) else paths:
        with path.open("rb") as f:
            for block in iter(lambda: f.read(1 << 20), b""):
                h.update(block)
    return h.hexdigest()
