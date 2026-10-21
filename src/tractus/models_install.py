"""모델 받기·지우기 (docs/desktop.md §2.15). 이벤트는 `emit(event, **data)`로 내보낸다 (cli가 JSON Lines로 바꾼다).

- 받기는 모델 폴더마다 한 프로세스만 한다 (잠금 파일). 이어받기: 같은 명령을 다시 돌리면 .incomplete부터 잇는다.
- 완료 표시(MARKER)는 파일을 모두 확인한 뒤 맨 마지막에 쓴다. 받은 리비전을 적어 두고, 리비전이 바뀌면 `inspect`가 일부만 받은 것으로 본다.
- 지우는 것은 `remove`뿐이다. 손상된 모델은 받기가 거부하고(code `corrupt`) remove 뒤에 다시 받는다.
"""

import contextlib
import errno
import fcntl
import fnmatch
import re
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterator

from tractus import diarize, paths
from tractus import models_registry as reg
from tractus.i18n import t

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
        raise ModelError(code="busy", message=t("다른 모델 받기가 이미 진행 중입니다")) from None
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
        raise ModelError("hash_mismatch", t("내려받은 파일의 sha256이 맞지 않아 지웠습니다: {name}", name=name), m.id)
    part.replace(final)


def _download_helper(m: reg.Model, root: Path, report: _Reporter, cancel: threading.Event) -> None:
    binary = diarize.fluid_bin()
    if not diarize._executable(binary):
        raise ModelError("helper_missing", t("tractus-diar 도우미 프로그램이 없습니다:\n  {hint}", hint=reg.build_hint("diar_helper")), m.id)
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
                         message or err.strip()[-300:] or t("tractus-diar 종료 코드 {code}", code=proc.returncode), m.id)


_FETCH = {"hf": _download_hf, "url": _download_url, "helper": _download_helper}


def plan(ids: list[str], root: Path) -> tuple[list[str], int]:
    """받을 모델(이미 설치된 것 제외)과 남은 바이트. 손상된 모델이 있으면 ModelError(corrupt)."""
    todo, need = [], 0
    for i in ids:
        st = reg.inspect(i, root)
        if st.installed:
            continue
        if st.state == "corrupt":
            raise ModelError("corrupt", t("파일이 손상됐습니다. `tractus models remove {id} --yes`로 지운 뒤 다시 받으세요", id=i), i)
        todo.append(i)
        need += max(reg.get(i).size_bytes - st.installed_bytes, 0)
    return todo, need


def download(ids: list[str], root: Path, emit: Emit, cancel: threading.Event) -> list[str]:
    """ids를 차례로 받는다. 받은 모델 ID를 돌려준다. ModelError·Cancelled를 던진다 (인수 오류는 ValueError)."""
    root.mkdir(parents=True, exist_ok=True)
    todo, need = plan(ids, root)
    if need and (free := disk_free(root)) < need * DISK_MARGIN:
        raise ModelError("disk_full", t("저장 공간이 모자랍니다: 필요 {need}GB, 남은 공간 {free}GB ({path})", need=f"{need * DISK_MARGIN / 1e9:.1f}", free=f"{free / 1e9:.1f}", path=root))
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
                raise ModelError(classify(e), t("{name}을(를) 받지 못했습니다: {error}", name=m.name, error=e), i) from e
            if m.kind != "helper" and not reg.inspect(i, root).installed:
                raise ModelError("hash_mismatch", t("받은 파일의 크기가 맞지 않습니다: {name}", name=m.name), i)
            if m.kind == "hf":
                _write_marker(m, root / m.local_dir)
            report(m.size_bytes, force=True)
            base += m.size_bytes
            emit("model_done", model=i)
            done.append(i)
    return done


# ── 지우기 ───────────────────────────────────────────────────────────────────

def _inside(path: Path, root: Path) -> bool:
    """모델 폴더 바로 아래의 진짜 폴더(심볼릭 링크 아님)인가. 지우기 전에 반드시 본다."""
    return not path.is_symlink() and path.resolve().parent == root.resolve()


def _is_notes_home(root: Path) -> bool:
    """노트 폴더(TRACTUS_HOME)이거나 회의·녹음 폴더를 품은 곳인가. 모델 폴더로 잘못 고른 것이라 아무것도 지우지 않는다."""
    return root.resolve() == paths.home_dir().resolve() or (root / "meetings").exists() or (root / "recordings").exists()


def _looks_like_model(p: Path) -> bool:
    """모델 가중치 폴더 모양인가: 완료 표시·config.json·*.safetensors 중 하나가 있다. 사진·문서 폴더는 아니다."""
    return (p / reg.MARKER).is_file() or (p / "config.json").is_file() or any(p.glob("*.safetensors"))


def unregistered(root: Path) -> list[dict]:
    """모델 폴더 바로 아래의 등록되지 않은 모델 폴더(옛 버전 모델 등) → [{"name", "bytes"}] 이름순.
    파일·숨김 항목(잠금 파일 포함)·심볼릭 링크는 세지 않는다 (그래서 prune이 건드리지도 않는다).
    모델이 하나도 없는 곳, 노트 폴더, 모델 모양이 아닌 폴더는 비운다: 사용자가 모델 폴더를 문서·바탕화면 같은 곳으로 잘못 골랐을 때 prune이 지우지 않게."""
    known = {m.local_dir for m in reg.all_models(root)}  # 직접 추가한 변환 엔진도 등록된 것이다 (prune이 지우지 않는다)
    if not root.is_dir() or _is_notes_home(root) or not any((root / d).is_dir() for d in known):
        return []
    return [{"name": p.name, "bytes": reg._dir_bytes(p)} for p in sorted(root.iterdir())
            if p.is_dir() and not p.is_symlink() and not p.name.startswith(".") and p.name not in known and _looks_like_model(p)]


def prune(root: Path) -> dict:
    """등록되지 않은 폴더를 모두 지운다. 받기 중이면 busy. → {"removed": [{"name", "bytes"}], "freed_bytes"}"""
    if not unregistered(root):
        return {"removed": [], "freed_bytes": 0}
    removed = []
    with download_lock(root):
        for u in unregistered(root):  # 잠근 뒤 다시 본다: 확인 사이에 바뀐 것을 지우지 않게
            path = root / u["name"]
            if not _inside(path, root):
                raise ModelError(code="unsafe_path", message=t("모델 폴더가 아닌 곳은 지우지 않습니다: {path}", path=path))
            shutil.rmtree(path)
            removed.append(u)
    return {"removed": removed, "freed_bytes": sum(u["bytes"] for u in removed)}


def remove(model_id: str, root: Path) -> dict:
    """모델 폴더 하나를 지운다. 모델 폴더 바깥을 가리키거나 심볼릭 링크면 거부, 받기 중이면 busy.
    → {"id", "removed": bool, "freed_bytes"}. fluid는 모델 폴더만 지운다 (도우미 프로그램은 그대로)."""
    m = reg.get(model_id)
    path = root / m.local_dir
    if not _inside(path, root):
        raise ModelError(code="unsafe_path", message=t("모델 폴더가 아닌 곳은 지우지 않습니다: {path}", path=path), model=model_id)
    if not path.exists():
        if m.custom:  # 직접 추가한 엔진: 받지 않았어도 목록에서 뺀다
            return {"id": model_id, "removed": forget_custom(model_id, root), "freed_bytes": 0}
        return {"id": model_id, "removed": False, "freed_bytes": 0}
    if not path.is_dir():
        raise ModelError(code="unsafe_path", message=t("모델 폴더가 아니어서 지우지 않습니다: {path}", path=path), model=model_id)
    with download_lock(root):
        freed = reg._dir_bytes(path)
        shutil.rmtree(path)
    if m.custom:  # 잠금을 푼 뒤 (forget_custom이 다시 잠근다)
        forget_custom(model_id, root)
    return {"id": model_id, "removed": True, "freed_bytes": freed}


# ── 직접 추가한 변환 엔진 (docs/design/asr-engines.md) ─────────────────────────

REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}/[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$")
CUSTOM_PATTERNS = ("*.json", "*.safetensors", "*.npz", "*.txt", "*.tiktoken", "*.model", "am.mvn")  # mlx-audio가 읽는 가중치는 safetensors·npz  # 맨 위 폴더의 가중치·설정·토크나이저 (학습 기록·.bin·onnx는 받지 않는다)


def _custom_id(repo: str, taken: set[str]) -> str:
    """저장소 → custom-<소문자-이름> (40자까지, 겹치면 -2·-3)."""
    base = (reg.CUSTOM_PREFIX + re.sub(r"[^a-z0-9]+", "-", repo.lower()).strip("-"))[:37].rstrip("-")
    mid, n = base, 2
    while mid in taken:
        mid, n = f"{base}-{n}", n + 1
    return mid


def _read_custom(root: Path) -> list[dict]:
    try:
        raw = json.loads((root / reg.CUSTOM_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [e for e in raw.get("models", []) if isinstance(e, dict)] if isinstance(raw, dict) and isinstance(raw.get("models"), list) else []


def _write_custom(root: Path, entries: list[dict]) -> None:
    root.mkdir(parents=True, exist_ok=True)
    tmp = root / (reg.CUSTOM_FILE + ".tmp")
    tmp.write_text(json.dumps({"models": entries}, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(root / reg.CUSTOM_FILE)


# 계열마다 mlx-audio가 불러올 때 꼭 있어야 하는 파일 (하나라도 있으면 되는 묶음들). 없으면 받아도 불러오지 못한다 (실측: mlx-community/whisper-tiny는 토크나이저가 없다)
NEEDED_FILES = {
    "qwen3": (("vocab.json", "tokenizer.json"), ("preprocessor_config.json",)),
    "whisper": (("tokenizer.json", "vocab.json"), ("preprocessor_config.json",)),
    "sensevoice": (("am.mvn",), (".model",)),
}


def _missing_files(engine: str, files: dict[str, int]) -> list[str]:
    return [" / ".join(g) for g in NEEDED_FILES.get(engine, ()) if not any(k == n or (n.startswith(".") and k.endswith(n)) for k in files for n in g)]


def _engine_of_config(cfg: dict) -> str | None:
    from tractus.asr import ENGINES

    kind = str(cfg.get("model_type") or "")
    return next((e.family for e in ENGINES.values() if kind in e.model_types), None)


def add_custom(repo: str, root: Path, revision: str | None = None) -> reg.Model:
    """HF 저장소의 변환 엔진을 직접 추가 목록에 넣는다 (받지는 않는다: `models download <ID>`).
    파일 목록·크기·리비전(커밋 해시)은 지금 허브에서 읽어 고정한다. config.json의 model_type이 지원 계열이 아니면 거부한다.
    같은 저장소를 다시 추가하면 같은 ID로 리비전·파일을 새로 고친다."""
    repo = repo.strip()
    if not REPO_RE.fullmatch(repo):
        raise ModelError("bad_repo", t("Hugging Face 저장소 ID를 확인하세요 (예: 이름/저장소): {repo}", repo=repo))
    from huggingface_hub import HfApi, hf_hub_download

    try:
        info = HfApi().model_info(repo, revision=revision, files_metadata=True)
        files = {f.rfilename: int(f.size) for f in info.siblings or [] if "/" not in f.rfilename and f.size and any(fnmatch.fnmatch(f.rfilename, p) for p in CUSTOM_PATTERNS)}
        if "config.json" not in files or not any(k.endswith((".safetensors", ".npz")) for k in files):
            raise ModelError("unsupported_model", t("추가할 수 없습니다: config.json과 safetensors 가중치가 있는 저장소만 추가할 수 있습니다"))
        with contextlib.ExitStack() as stack:
            import tempfile

            tmp = stack.enter_context(tempfile.TemporaryDirectory(dir=root if root.is_dir() else None))
            cfg = json.loads(Path(hf_hub_download(repo, "config.json", revision=info.sha, local_dir=tmp)).read_text(encoding="utf-8"))
    except ModelError:
        raise
    except Exception as e:  # noqa: BLE001 — 허브 예외를 코드로 바꾼다
        code = classify(e)
        if code == "unknown" and type(e).__name__ in ("RepositoryNotFoundError", "RevisionNotFoundError"):
            code = "not_found"
        raise ModelError(code, t("저장소 정보를 읽지 못했습니다: {repo} ({error})", repo=repo, error=e)) from e
    engine = _engine_of_config(cfg) if isinstance(cfg, dict) else None
    if engine is None:
        raise ModelError("unsupported_engine", t("지원하지 않는 변환 엔진 계열입니다 (model_type: {kind}). Qwen3-ASR·Whisper·SenseVoice 계열만 추가할 수 있습니다", kind=(cfg or {}).get("model_type") if isinstance(cfg, dict) else "?"))
    if missing := _missing_files(engine, files):
        raise ModelError("unsupported_model", t("추가할 수 없습니다: 이 저장소에는 불러오는 데 필요한 파일이 없습니다 ({files})", files=", ".join(missing)))
    card = getattr(info, "card_data", None) or getattr(info, "cardData", None)
    lic = (card.get("license") if hasattr(card, "get") else getattr(card, "license", None)) or ""
    with download_lock(root):
        entries = _read_custom(root)
        old = next((e for e in entries if e.get("repo") == repo), None)
        mid = old["id"] if old else _custom_id(repo, {e.get("id") for e in entries} | {m.id for m in reg.MODELS})
        entry = {"id": mid, "repo": repo, "revision": info.sha, "engine": engine, "files": files, "name": repo, "license": str(lic) if not isinstance(lic, list) else ", ".join(map(str, lic)),
                 "added_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        _write_custom(root, [entry if e is old else e for e in entries] if old else [*entries, entry])
    m = reg._custom_entry(entry)
    assert m is not None
    return m


def forget_custom(model_id: str, root: Path) -> bool:
    """직접 추가 목록에서 뺀다 (파일은 remove가 지운다). 뺐으면 True."""
    with download_lock(root):
        entries = _read_custom(root)
        kept = [e for e in entries if e.get("id") != model_id]
        if len(kept) != len(entries):
            _write_custom(root, kept)
            return True
    return False


# ── 옮기기 ───────────────────────────────────────────────────────────────────

def move(src: Path, dest: Path) -> dict:
    """등록된 모델 폴더만 src에서 dest로 옮긴다 (등록되지 않은 폴더·잠금 파일은 그대로). 같은 볼륨이면 이름만 바꾼다.
    받기 중이면 busy, 목적지에 같은 모델 폴더가 있거나 공간이 모자라면 아무것도 옮기기 전에 거부한다.
    다른 볼륨이면 복사를 끝낸 뒤 원본을 지운다: 지우기가 실패해도 복사본은 두고 "leftover"(남은 옛 폴더 이름)로 알린다.
    → {"moved": [ID], "freed_bytes": 원래 위치의 볼륨에서 비운 바이트 (같은 볼륨이면 0)}"""
    src, dest = src.resolve(), dest.expanduser().resolve()
    if _is_notes_home(dest):
        raise ModelError(code="bad_argument", message=t("노트가 들어 있는 폴더는 모델 폴더로 쓸 수 없습니다: {path}", path=dest))
    if src == dest or dest.is_relative_to(src) or src.is_relative_to(dest):
        raise ModelError(code="bad_argument", message=t("같은 폴더이거나 서로 안에 들어 있어 옮길 수 없습니다: {path}", path=dest))
    found = [m for m in reg.all_models(src) if (src / m.local_dir).is_dir() and not (src / m.local_dir).is_symlink()]
    if not found:
        return {"moved": [], "freed_bytes": 0}
    if clash := [m.id for m in found if (dest / m.local_dir).exists()]:
        raise ModelError(code="exists", message=t("대상 폴더에 같은 모델이 이미 있습니다: {ids}", ids=", ".join(clash)))
    size = sum(reg._dir_bytes(src / m.local_dir) for m in found)
    same_volume = src.stat().st_dev == nearest_existing(dest).stat().st_dev
    if not same_volume and (free := disk_free(dest)) < size * DISK_MARGIN:
        raise ModelError(code="disk_full", message=t("저장 공간이 모자랍니다: 필요 {need}GB, 남은 공간 {free}GB ({path})", need=f"{size * DISK_MARGIN / 1e9:.1f}", free=f"{free / 1e9:.1f}", path=dest))
    moved, leftover = [], []
    with download_lock(src), download_lock(dest):
        for m in found:
            a, b = src / m.local_dir, dest / m.local_dir
            try:
                if same_volume:
                    a.rename(b)
                else:
                    shutil.copytree(a, b, symlinks=True)
            except OSError as e:  # 옮기다 끊김: 반쯤 복사된 것을 치운다 (원본은 그대로)
                if not same_volume:
                    shutil.rmtree(b, ignore_errors=True)
                raise ModelError(code=classify(e), message=t("{name}을(를) 옮기지 못했습니다: {error}", name=m.name, error=e), model=m.id) from e
            if not same_volume:  # 복사가 끝난 뒤의 원본 지우기: 실패해도 복사본은 지우지 않는다
                try:
                    shutil.rmtree(a)
                except OSError as e:
                    leftover.append(m.local_dir)
                    print(t("경고: 옛 폴더를 다 지우지 못해 남겼습니다 ({path}): {error}", path=a, error=e), file=sys.stderr)
            moved.append(m.id)
        if (src / reg.CUSTOM_FILE).is_file():  # 직접 추가 목록도 함께 옮긴다 (목적지에 이미 있으면 합친다)
            merged = {e.get("id"): e for e in _read_custom(dest)} | {e.get("id"): e for e in _read_custom(src)}
            _write_custom(dest, [e for e in merged.values() if e.get("id")])
            (src / reg.CUSTOM_FILE).unlink()
    return {"moved": moved, "freed_bytes": 0 if same_volume else size, **({"leftover": leftover} if leftover else {})}
