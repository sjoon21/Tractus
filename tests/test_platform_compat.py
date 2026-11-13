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
