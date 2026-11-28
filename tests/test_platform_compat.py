"""platform_compat: POSIX 갈래는 이 Mac에서, Windows 잠금 갈래는 가짜 msvcrt로, 나머지 Windows 갈래는 Windows CI에서."""

import os
import subprocess
import sys
import types

import pytest

from tractus import platform_compat as pc

posix_only = pytest.mark.skipif(sys.platform == "win32", reason="POSIX")

_HOLD = """
import sys
from tractus.platform_compat import lock_file
f = open(sys.argv[1], "a+")
lock_file(f)
print("locked", flush=True)
sys.stdin.readline()
"""


def test_lock_blocks_other_process(tmp_path):
    path = tmp_path / ".lock"
    holder = subprocess.Popen([sys.executable, "-c", _HOLD, str(path)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    try:
        assert holder.stdout.readline().strip() == "locked"
        with open(path, "a+") as f:
            with pytest.raises(OSError):
                pc.lock_file(f, blocking=False)
        holder.stdin.write("\n")
        holder.stdin.flush()
        holder.wait(10)
        with open(path, "a+") as f:  # 잡은 프로세스가 끝나면 OS가 풀어 준다
            pc.lock_file(f, blocking=False)
            pc.unlock_file(f)
    finally:
        holder.kill()


def test_lock_accepts_fd(tmp_path):
    fd = os.open(tmp_path / ".lock", os.O_RDWR | os.O_CREAT, 0o600)
    try:
        pc.lock_file(fd)
        pc.unlock_file(fd)
    finally:
        os.close(fd)


def _fake_msvcrt(monkeypatch, busy_times=0):
    calls = []
    state = {"busy": busy_times}

    def locking(fd, mode, n):
        calls.append((mode, os.lseek(fd, 0, os.SEEK_CUR), n))
        if mode == fake.LK_NBLCK and state["busy"]:
            state["busy"] -= 1
            raise PermissionError(13, "locked")

    fake = types.SimpleNamespace(LK_UNLCK=0, LK_NBLCK=2, locking=locking)
    monkeypatch.setitem(sys.modules, "msvcrt", fake)
    monkeypatch.setattr(pc, "WINDOWS", True)
    monkeypatch.setattr(pc.time, "sleep", lambda _s: None)
    return fake, calls


def test_windows_lock_locks_first_byte_and_keeps_position(tmp_path, monkeypatch):
    fake, calls = _fake_msvcrt(monkeypatch, busy_times=2)
    with open(tmp_path / ".lock", "a+") as f:
        f.write("12345")
        f.flush()
        pc.lock_file(f)  # 두 번 바쁘면 기다렸다가 잡는다
        assert f.tell() == 5
        pc.unlock_file(f)
        assert f.tell() == 5
    assert calls == [(fake.LK_NBLCK, 0, 1)] * 3 + [(fake.LK_UNLCK, 0, 1)]


def test_windows_nonblocking_raises(tmp_path, monkeypatch):
    _fake_msvcrt(monkeypatch, busy_times=1)
    with open(tmp_path / ".lock", "a+") as f, pytest.raises(OSError):
        pc.lock_file(f, blocking=False)


@posix_only
def test_restrict_to_owner(tmp_path):
    path = tmp_path / "f"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT, 0o644)
    try:
        pc.restrict_to_owner(fd)
    finally:
        os.close(fd)
    assert path.stat().st_mode & 0o777 == 0o600


def test_restrict_to_owner_noop_on_windows(tmp_path, monkeypatch):
    monkeypatch.setattr(pc, "WINDOWS", True)
    monkeypatch.setattr(pc.os, "fchmod", lambda *_: pytest.fail("Windows에서 fchmod를 부르면 안 된다"), raising=False)
    pc.restrict_to_owner(0)


def test_pid_alive():
    assert pc.pid_alive(os.getpid())
    child = subprocess.Popen([sys.executable, "-c", "pass"])
    child.wait()
    assert not pc.pid_alive(child.pid)


def test_physical_memory():
    assert pc.physical_memory() > 1024**3


@pytest.mark.parametrize("installed_kb,expected", [(16 * 1024**2, 16 * 1024**3), (None, 15 * 1024**3)])
def test_windows_physical_memory_prefers_installed_size(monkeypatch, installed_kb, expected):
    """설치된 용량(16GB 노트북이면 16GiB)을 쓰고, 못 읽으면 예전 값(OS가 쓸 수 있는 메모리)으로 (가짜 kernel32)."""
    import ctypes

    class Kernel32:
        def GetPhysicallyInstalledSystemMemory(self, ref):
            if installed_kb is None:
                return 0
            ref._obj.value = installed_kb
            return 1

        def GlobalMemoryStatusEx(self, ref):
            ref._obj.ullTotalPhys = 15 * 1024**3
            return 1

    monkeypatch.setattr(pc, "WINDOWS", True)
    monkeypatch.setattr(ctypes, "WinDLL", lambda name, use_last_error=False: Kernel32(), raising=False)
    assert pc.physical_memory() == expected


def test_expand_app_dir_falls_back_when_localappdata_is_unset(monkeypatch):
    """환경을 비운 하위 프로세스에서도 모델 폴더가 작업 폴더 아래 `%LOCALAPPDATA%`라는 상대 경로가 되지 않는다"""
    monkeypatch.setenv("LOCALAPPDATA", "/x/Local")
    assert pc.expand_app_dir("%LOCALAPPDATA%/dev.tractus.app/models") == "/x/Local/dev.tractus.app/models"
    monkeypatch.delenv("LOCALAPPDATA")
    out = pc.expand_app_dir("%LOCALAPPDATA%/m")
    assert os.path.isabs(out) and out.endswith(os.path.join("AppData", "Local") + "/m")
    assert pc.expand_app_dir("~/Library/x") == "~/Library/x"  # macOS 값은 그대로


def test_utf8_stdio_switches_windows_code_page_streams_to_utf8(monkeypatch):
    import io

    streams = {name: io.TextIOWrapper(io.BytesIO(), encoding="cp949") for name in ("stdin", "stdout", "stderr")}
    for name, s in streams.items():
        monkeypatch.setattr(sys, name, s)
    monkeypatch.setattr(pc, "WINDOWS", False)
    pc.utf8_stdio()
    assert sys.stdout.encoding == "cp949"  # macOS·Linux는 그대로

    monkeypatch.setattr(pc, "WINDOWS", True)
    pc.utf8_stdio()
    assert [s.encoding for s in streams.values()] == ["utf-8"] * 3
    sys.stdout.write('{"title": "녹음 ✓"}')  # ✓는 cp949에 없다
    sys.stdout.flush()
    assert sys.stdout.buffer.getvalue().decode("utf-8") == '{"title": "녹음 ✓"}'


def test_cli_writes_utf8_json_without_pythonioencoding(tmp_path):
    """앱 밖(번들 -I, 터미널 리디렉션)에서도 JSON이 UTF-8이다. Windows CI에서 기본 코드 페이지로 돌 때 의미가 있다"""
    env = {k: v for k, v in os.environ.items() if not k.startswith("PYTHON")} | {"TRACTUS_HOME": str(tmp_path)}
    p = subprocess.run([sys.executable, "-m", "tractus.cli", "note", "new"], input='{"title": "회의 ✓"}'.encode(), capture_output=True, env=env, cwd=tmp_path, timeout=120)
    assert p.returncode == 0, p.stderr.decode(errors="replace")
    import json
    from pathlib import Path

    out = json.loads(p.stdout.decode("utf-8").strip().splitlines()[-1])
    t = json.loads((Path(out["meeting_dir"]) / "transcript.json").read_text(encoding="utf-8"))
    assert t["title"] == "회의 ✓"


@pytest.mark.parametrize("windows", [False, True])
def test_ffmpeg_hints_follow_the_platform(monkeypatch, windows):
    """ffmpeg 안내: macOS는 brew(예전 그대로), Windows는 winget. Homebrew 줄은 macOS만 (WORDS.md §8)"""
    from tractus import audio, doctor
    from tractus import models_registry as reg

    monkeypatch.setattr(pc, "WINDOWS", windows)
    monkeypatch.setattr(audio.shutil, "which", lambda _: None)
    cmd = "winget install Gyan.FFmpeg" if windows else "brew install ffmpeg"
    with pytest.raises(audio.FFmpegMissing, match=cmd):
        audio.require_ffmpeg()
    assert reg.build_hint("ffmpeg") == cmd
    assert ("컴퓨터" if windows else "Mac") in reg.fix_command("memory")
    assert ("brew" in doctor.tools()) is not windows
