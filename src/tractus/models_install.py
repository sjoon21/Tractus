"""모델 받기·지우기 (docs/desktop.md §2.15). 이벤트는 `emit(event, **data)`로 내보낸다 (cli가 JSON Lines로 바꾼다).

- 받기는 모델 폴더마다 한 프로세스만 한다 (잠금 파일). 이어받기: 같은 명령을 다시 돌리면 .incomplete부터 잇는다.
- 완료 표시(MARKER)는 파일을 모두 확인한 뒤 맨 마지막에 쓴다. 받은 리비전을 적어 두고, 리비전이 바뀌면 `inspect`가 일부만 받은 것으로 본다.
- 지우는 것은 `remove`뿐이다. 손상된 모델은 받기가 거부하고(code `corrupt`) remove 뒤에 다시 받는다.
"""

import contextlib
import errno
import fcntl
import hashlib
import json
import os
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterator

from tractus import diarize
from tractus import models_registry as reg

Emit = Callable[..., None]
DISK_MARGIN = 1.1  # 남은 용량 ≥ 받을 크기 × 1.1
PROGRESS_INTERVAL_S = 0.25
CHUNK = 1 << 20


class ModelError(Exception):
    def __init__(self, code: str, message: str, model: str | None = None):
        super().__init__(message)
        self.code, self.message, self.model = code, message, model


class Cancelled(Exception):
    """SIGTERM으로 멈췄다. 받던 파일은 남겨 둔다 (다시 실행하면 이어받는다)."""


# ── 잠금 ─────────────────────────────────────────────────────────────────────

@contextlib.contextmanager
def download_lock(root: Path) -> Iterator[None]:
    root.mkdir(parents=True, exist_ok=True)
    f = (root / reg.LOCK_NAME).open("a+")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.close()
        raise ModelError(code="busy", message="다른 모델 받기가 이미 진행 중입니다") from None
    f.truncate(0)
    f.write(str(os.getpid()))  # lock_held가 잠그지 않고 읽는다
    f.flush()
    try:
        yield
    finally:
        f.truncate(0)
        fcntl.flock(f, fcntl.LOCK_UN)
        f.close()


def lock_held(root: Path) -> bool:
    """받기가 진행 중인가. 잠금을 잡아 보지 않고 잠금 파일의 PID가 살아 있는지만 본다 (확인하다가 받기를 막지 않는다).
    ponytail: 강제 종료로 PID가 남고 같은 번호를 다른 프로세스가 쓰면 잘못 true. 받기는 flock이 따로 막는다."""
    try:
        pid = int((root / reg.LOCK_NAME).read_text().strip())
        os.kill(pid, 0)
    except (OSError, ValueError) as e:
        return isinstance(e, PermissionError)
    return True


# ── 오류 분류 ────────────────────────────────────────────────────────────────

def _chain(exc: BaseException) -> Iterator[BaseException]:
    seen = set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        yield exc
        exc = exc.__cause__ or exc.__context__


def classify(exc: BaseException) -> str:
    """예외 → 오류 코드: no_network | disk_full | auth | hash_mismatch | unknown (ModelError는 자기 코드)."""
    if isinstance(exc, ModelError):
        return exc.code
    names = {"ConnectError", "ConnectTimeout", "ReadTimeout", "TimeoutException", "NetworkError", "TransportError", "OfflineModeIsEnabled",
             "LocalEntryNotFoundError", "URLError", "gaierror", "ConnectionError", "TimeoutError", "RemoteProtocolError"}
    for e in _chain(exc):
        if isinstance(e, OSError) and e.errno == errno.ENOSPC:
            return "disk_full"
        status = getattr(getattr(e, "response", None), "status_code", None) or getattr(e, "code", None)  # 허브(httpx) · urllib.HTTPError
        if status in (401, 403) or type(e).__name__ in ("GatedRepoError",):
            return "auth"
        if isinstance(e, urllib.error.HTTPError):  # 서버가 답했다: 네트워크 문제가 아니다 (URLError의 하위 클래스라 먼저 거른다)
            return "unknown"
        if isinstance(e, (urllib.error.URLError, socket.gaierror, ConnectionError, TimeoutError)) or any(c.__name__ in names for c in type(e).__mro__):
            return "no_network"
    return "unknown"


# ── 받기 ─────────────────────────────────────────────────────────────────────

def nearest_existing(p: Path) -> Path:
    while not p.exists() and p != p.parent:
        p = p.parent
    return p


def disk_free(root: Path) -> int:
    return shutil.disk_usage(nearest_existing(root)).free


def _write_marker(m: reg.Model, d: Path) -> None:
    data = {"id": m.id, "revision": m.revision, "files": m.files, "completed_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    tmp = d / (reg.MARKER + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(d / reg.MARKER)


class _Reporter:
    """진행 이벤트를 0.25초에 한 번으로 줄인다."""

    def __init__(self, emit: Emit, m: reg.Model, d: Path, base: int, overall: int):
        self.emit, self.m, self.dir, self.base, self.overall, self.last = emit, m, d, base, overall, 0.0

    def __call__(self, done: int, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self.last < PROGRESS_INTERVAL_S:
            return
        self.last = now
        done = min(done, self.m.size_bytes)
        self.emit("progress", model=self.m.id, file=self._file(), bytes_done=done, bytes_total=self.m.size_bytes,
                  overall_done=self.base + done, overall_total=self.overall)

    def _file(self) -> str | None:
        """지금 받는 파일 (최선): 아직 크기가 다 차지 않은 파일 중 가장 큰 것. 허브는 이름을 알려 주지 않는다."""
        pending = [(size, rel) for rel, size in self.m.files.items() if reg._size(self.dir / rel) != size]
        return max(pending)[1] if pending else None


def _download_hf(m: reg.Model, root: Path, report: _Reporter, cancel: threading.Event) -> None:
    import io

    from huggingface_hub import constants, snapshot_download
    from tqdm.auto import tqdm

    # hf_xet은 진행을 자기 스레드에서 알려서 Bar.update의 Cancelled가 전송을 멈추지 못한다. 일반 HTTP 경로는 청크마다 update를 불러 멈추고, 이어받기도 .incomplete로 한다
    constants.HF_HUB_DISABLE_XET = True

    class Bar(tqdm):  # 허브가 만드는 막대 중 "Downloading bytes"(전체 바이트)만 따라간다
        def __init__(self, *a, **k):
            k["file"], k["mininterval"], k["disable"] = io.StringIO(), 0, False  # cli가 TQDM_DISABLE=1을 걸어 두므로 명시한다
            super().__init__(*a, **k)

        def update(self, n=1):
            if cancel.is_set():
                raise Cancelled()
            r = super().update(n)
            if "Downloading" in str(self.desc):
                report(int(self.n))
            return r

    snapshot_download(repo_id=m.repo, revision=m.revision, local_dir=str(root / m.local_dir), allow_patterns=list(m.files), tqdm_class=Bar)


def _download_url(m: reg.Model, root: Path, report: _Reporter, cancel: threading.Event) -> None:
    d = root / m.local_dir
    d.mkdir(parents=True, exist_ok=True)
    name = next(iter(m.files))
    final, part = d / name, d / (name + ".part")
    have = part.stat().st_size if part.exists() else 0
    if have < m.files[name]:  # 이미 다 받은 .part는 다시 요청하지 않고 검증만 한다 (Range가 416으로 거절된다)
        req = urllib.request.Request(m.url, headers={"User-Agent": "tractus", **({"Range": f"bytes={have}-"} if have else {})})
        with urllib.request.urlopen(req, timeout=30) as resp:
            resumed = have and resp.status == 206
            with part.open("ab" if resumed else "wb") as out:
                done = have if resumed else 0
                while block := resp.read(CHUNK):
                    if cancel.is_set():
                        raise Cancelled()
                    out.write(block)
                    done += len(block)
                    report(done)
    if hashlib.sha256(part.read_bytes()).hexdigest() != m.sha256:
        part.unlink()
        raise ModelError("hash_mismatch", f"내려받은 파일의 sha256이 맞지 않아 지웠습니다: {name}", m.id)
    part.replace(final)


def _download_helper(m: reg.Model, root: Path, report: _Reporter, cancel: threading.Event) -> None:
    binary = diarize.fluid_bin()
    if not diarize._executable(binary):
        raise ModelError("helper_missing", f"tractus-diar 도우미 프로그램이 없습니다. 먼저 빌드하세요:\n  {reg.BUILD_HINTS['diar_helper']}", m.id)
    proc = subprocess.Popen([str(binary), "download", "--models", str(root / m.local_dir)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    threading.Thread(target=lambda: (cancel.wait(), proc.poll() is None and proc.terminate()), daemon=True).start()
    out, err = proc.communicate()
    if cancel.is_set():
        raise Cancelled()
    if proc.returncode:
        message = ""
        for line in out.splitlines():
            with contextlib.suppress(ValueError):
                ev = json.loads(line)
                if isinstance(ev, dict) and ev.get("event") == "error":
                    message = str(ev.get("message"))
        raise ModelError("no_network" if "network" in (message + err).lower() or "offline" in (message + err).lower() else "unknown",
                         message or err.strip()[-300:] or f"tractus-diar 종료 코드 {proc.returncode}", m.id)


_FETCH = {"hf": _download_hf, "url": _download_url, "helper": _download_helper}


def plan(ids: list[str], root: Path) -> tuple[list[str], int]:
    """받을 모델(이미 설치된 것 제외)과 남은 바이트. 손상된 모델이 있으면 ModelError(corrupt)."""
    todo, need = [], 0
    for i in ids:
        st = reg.inspect(i, root)
        if st.installed:
            continue
        if st.state == "corrupt":
            raise ModelError("corrupt", f"파일이 손상됐습니다. `tractus models remove {i} --yes`로 지운 뒤 다시 받으세요", i)
        todo.append(i)
        need += max(reg.get(i).size_bytes - st.installed_bytes, 0)
    return todo, need


def download(ids: list[str], root: Path, emit: Emit, cancel: threading.Event) -> list[str]:
    """ids를 차례로 받는다. 받은 모델 ID를 돌려준다. ModelError·Cancelled를 던진다 (인수 오류는 ValueError)."""
    root.mkdir(parents=True, exist_ok=True)
    todo, need = plan(ids, root)
    if need and (free := disk_free(root)) < need * DISK_MARGIN:
        raise ModelError("disk_full", f"저장 공간이 모자랍니다: 필요 {need * DISK_MARGIN / 1e9:.1f}GB, 남은 공간 {free / 1e9:.1f}GB ({root})")
    overall, base, done = sum(reg.get(i).size_bytes for i in todo), 0, []
    with download_lock(root):
        for n, i in enumerate(todo, 1):
            m = reg.get(i)
            emit("stage", stage="download", model=i, index=n, count=len(todo), size_bytes=m.size_bytes)
            report = _Reporter(emit, m, root / m.local_dir, base, overall)
            try:
                _FETCH[m.kind](m, root, report, cancel)
            except (ModelError, Cancelled):
                raise
            except Exception as e:  # noqa: BLE001 — 허브·네트워크 예외를 코드로 바꾼다
                raise ModelError(classify(e), f"{m.name}을(를) 받지 못했습니다: {e}", i) from e
            if m.kind != "helper" and not reg.inspect(i, root).installed:
                raise ModelError("hash_mismatch", f"받은 파일의 크기가 맞지 않습니다: {m.name}", i)
            if m.kind == "hf":
                _write_marker(m, root / m.local_dir)
            report(m.size_bytes, force=True)
            base += m.size_bytes
            emit("model_done", model=i)
            done.append(i)
    return done


# ── 지우기 ───────────────────────────────────────────────────────────────────

def remove(model_id: str, root: Path) -> dict:
    """모델 폴더 하나를 지운다. 모델 폴더 바깥을 가리키거나 심볼릭 링크면 거부, 받기 중이면 busy.
    → {"id", "removed": bool, "freed_bytes"}. fluid는 모델 폴더만 지운다 (도우미 프로그램은 그대로)."""
    m = reg.get(model_id)
    path = root / m.local_dir
    if path.is_symlink() or path.resolve().parent != root.resolve():
        raise ModelError(code="unsafe_path", message=f"모델 폴더가 아닌 곳은 지우지 않습니다: {path}", model=model_id)
    if not path.exists():
        return {"id": model_id, "removed": False, "freed_bytes": 0}
    if not path.is_dir():
        raise ModelError(code="unsafe_path", message=f"모델 폴더가 아니어서 지우지 않습니다: {path}", model=model_id)
    with download_lock(root):
        freed = reg._dir_bytes(path)
        shutil.rmtree(path)
    return {"id": model_id, "removed": True, "freed_bytes": freed}
