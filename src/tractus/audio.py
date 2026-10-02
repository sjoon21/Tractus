"""FFmpeg 호출. 번들하지 않고 외부 바이너리로 실행한다(LGPL/GPL을 Apache-2.0 배포물과 분리)."""

import hashlib
import shutil
import subprocess
from pathlib import Path

import numpy as np

SR = 16000


class FFmpegError(RuntimeError):
    pass


def require_ffmpeg() -> None:
    if shutil.which("ffmpeg") is None:
        raise FFmpegError("ffmpeg를 찾을 수 없습니다. `brew install ffmpeg`로 설치하세요.")


def _run(args: list[str], capture: bool = False) -> bytes:
    proc = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", *args], capture_output=True)
    if proc.returncode != 0:
        raise FFmpegError(proc.stderr.decode(errors="replace").strip() or f"ffmpeg 실패 (exit {proc.returncode})")
    return proc.stdout if capture else b""


def decode(path: Path) -> np.ndarray:
    """임의 형식(m4a/mp3/wav/webm…)을 16kHz mono float32로 디코딩한다."""
    raw = _run(["-i", str(path), "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"], capture=True)
    audio = np.frombuffer(raw, dtype=np.float32)
    if audio.size == 0:
        raise FFmpegError(f"오디오 트랙이 비어 있습니다: {path}")
    return audio


def encode_opus(src: Path, dst: Path) -> None:
    """보관용 mono Opus 32kbps (1시간 약 14MB)."""
    _run(["-y", "-i", str(src), "-vn", "-ac", "1", "-c:a", "libopus", "-b:a", "32k", "-application", "voip", str(dst)])


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()
