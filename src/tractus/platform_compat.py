"""운영체제마다 다른 저수준 호출을 한 곳에 모은다 (Windows 이식 0단계, docs/internal/windows-port.md §2).
macOS·Linux는 예전과 같은 호출(fcntl.flock, os.fchmod, os.kill(pid, 0), os.sysconf)을 그대로 쓴다.
표준 `platform`과 겹치지 않게 이름을 platform_compat으로 했다. 새 의존성(portalocker 등)을 넣지 않는다."""

import os
import sys
import time

WINDOWS = sys.platform == "win32"  # 시험에서 바꿔 끼운다


def _fileno(f) -> int:
    return f if isinstance(f, int) else f.fileno()


def lock_file(f, *, blocking: bool = True) -> None:
    """배타 잠금을 잡는다 (f: 파일 기술자 또는 파일 객체). blocking=False면 잡지 못할 때 OSError.
    POSIX: fcntl.flock(LOCK_EX[|LOCK_NB]). 파일 전체에 걸린 권고 잠금이고 닫으면 풀린다.
    Windows: msvcrt.locking으로 0번째 바이트 1개를 잠근다 (파일 길이와 상관없이 같은 바이트를 잠가 flock처럼 쓴다).
    이 잠금은 강제 잠금이라 다른 프로세스가 그 바이트를 읽거나 쓰면 PermissionError가 난다. 닫으면 OS가 푼다."""
    if not WINDOWS:
        import fcntl

        fcntl.flock(f, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        return
    import msvcrt

    fd = _fileno(f)
    while True:
        pos = os.lseek(fd, 0, os.SEEK_CUR)
        os.lseek(fd, 0, os.SEEK_SET)
        try:
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)  # LK_LOCK은 10초 뒤 포기하므로 flock처럼 끝까지 기다리려면 직접 되풀이한다
            return
        except OSError:
            if not blocking:
                raise
        finally:
            os.lseek(fd, pos, os.SEEK_SET)
        time.sleep(0.05)


def unlock_file(f) -> None:
    """lock_file로 잡은 잠금을 푼다. 닫기만 해도 풀리므로 닫기 전에 일찍 풀 때만 쓴다."""
    if not WINDOWS:
        import fcntl

        fcntl.flock(f, fcntl.LOCK_UN)
        return
    import msvcrt

    fd = _fileno(f)
    pos = os.lseek(fd, 0, os.SEEK_CUR)
    os.lseek(fd, 0, os.SEEK_SET)
    try:
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    finally:
        os.lseek(fd, pos, os.SEEK_SET)


def restrict_to_owner(fd: int) -> None:
    """열린 파일을 소유자만 읽고 쓰게(0600) 한다.
    Windows는 아무것도 하지 않는다: 모드 비트가 없고 사용자 폴더(%APPDATA%·홈)의 기본 ACL이 이미 본인 전용이다.
    shortcut: 다른 사용자에게 열린 폴더에 두면 막지 못한다, 공유 PC를 지원할 때 ACL을 직접 건다."""
    if not WINDOWS:
        os.fchmod(fd, 0o600)


def pid_alive(pid: int) -> bool:
    """프로세스가 살아 있는가. 권한이 없어 확인하지 못하면 살아 있다고 본다 (예전 os.kill(pid, 0) 규칙).
    Windows에서 os.kill(pid, 0)은 확인이 아니라 프로세스를 끝내므로 쓰지 않는다."""
    if not WINDOWS:
        try:
            os.kill(pid, 0)
        except PermissionError:
            return True
        except OSError:
            return False
        return True
    import ctypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.GetExitCodeProcess.argtypes = (ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong))
    kernel32.CloseHandle.argtypes = (ctypes.c_void_p,)
    handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return ctypes.get_last_error() == 5  # ERROR_ACCESS_DENIED: 있지만 볼 권한이 없다
    try:
        code = ctypes.c_ulong()
        return bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259  # STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def physical_memory() -> int:
    """물리 메모리 바이트 수."""
    if not WINDOWS:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    import ctypes

    class MemoryStatusEx(ctypes.Structure):
        _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong), ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong), ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong), ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

    status = MemoryStatusEx(dwLength=ctypes.sizeof(MemoryStatusEx))
    if not ctypes.WinDLL("kernel32", use_last_error=True).GlobalMemoryStatusEx(ctypes.byref(status)):
        raise OSError(ctypes.get_last_error(), "GlobalMemoryStatusEx")
    return status.ullTotalPhys
