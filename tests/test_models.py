"""모델 목록·받기·지우기·점검 (docs/desktop.md §2.15). 실제 모델·네트워크 없이 가짜 폴더로 확인한다.
@pytest.mark.network 테스트 하나만 작은 VAD 모델(1.3MB)을 임시 폴더에 실제로 받는다 (`pytest -m network`)."""

import dataclasses
import errno
import hashlib
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest
from typer.testing import CliRunner

from tractus import align, cli, diarize, doctor, embed, voices
from tractus import models_install as inst
from tractus import models_registry as reg

GB = 1024**3


@pytest.fixture
def root(tmp_path, monkeypatch):
    models = tmp_path / "models"
    models.mkdir()
    monkeypatch.chdir(tmp_path)  # 저장소 루트의 .env를 읽지 않게 한다
    monkeypatch.setenv("TRACTUS_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("TRACTUS_MODELS_DIR", str(models))
    monkeypatch.setenv("TRACTUS_DIAR_BIN", str(tmp_path / "no-diar"))
    monkeypatch.setenv("TRACTUS_REC_BIN", str(tmp_path / "no-rec"))
    return models


def fake_install(root: Path, model_id: str) -> None:
    """파일 목록대로 (희소 파일로) 설치된 것처럼 만든다. 크기만 맞으면 설치로 본다."""
    m = reg.get(model_id)
    for rel, size in m.files.items():
        p = root / m.local_dir / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("wb") as f:
            f.truncate(size)


def states(root: Path) -> dict[str, str]:
    return {m.id: reg.inspect(m.id, root).state for m in reg.MODELS}


# ── 목록과 상수 ──────────────────────────────────────────────────────────────

def test_registry_agrees_with_module_constants():
    ids = [m.id for m in reg.MODELS]
    assert len(set(ids)) == len(ids) and all(reg.ID_RE.fullmatch(i) for i in ids)
    for mid, mod in (("diarizer", diarize), ("aligner", align), ("embedding", embed)):
        m = reg.get(mid)
        assert (m.repo, m.revision, m.local_dir) == (mod.MODEL_REPO, mod.MODEL_REVISION, mod.MODEL_DIR)
    v, f = reg.get("voices"), reg.get("fluid")
    assert (v.url, v.sha256, v.local_dir, list(v.files)) == (voices.MODEL_URL, voices.MODEL_SHA256, voices.MODEL_DIR, [voices.MODEL_FILE])
    assert (f.local_dir, f.repo) == (diarize.FLUID_DIR, diarize.FLUID_REPO)
    # cli의 ASR·VAD 저장소와 폴더 이름 규칙(저장소 이름 소문자)이 같다. local_model과 테스트 픽스처가 이 규칙을 쓴다
    assert cli.VAD_MODEL == reg.get("vad").repo and cli.MODELS[cli.Track.standard] == reg.get("asr-std").repo and cli.MODELS[cli.Track.lite] == reg.get("asr-lite").repo
    for m in reg.MODELS:
        if m.id in ("vad", "asr-std", "asr-lite"):
            assert m.local_dir == m.repo.split("/")[1].lower()
        if m.kind == "hf":
            assert m.revision and re.fullmatch(r"[0-9a-f]{40}", m.revision) and m.size_bytes == sum(m.files.values())
    assert diarize.FLUID_FILES[0] and cli.ALIGNER_DIR == reg.get("aligner").local_dir and cli.DIARIZER_DIR == reg.get("diarizer").local_dir


def test_every_model_says_what_it_is_and_agrees_with_download_constants():
    """소개 필드: 이름·만든 곳·내려받는 곳·라이선스는 비어 있으면 안 되고, source·revision은 내려받는 상수와 같다 (docs/desktop.md §2.15)."""
    consts = {"vad": (cli.VAD_MODEL, reg.get("vad").revision), "asr-std": (cli.MODELS[cli.Track.standard], reg.get("asr-std").revision),
              "asr-lite": (cli.MODELS[cli.Track.lite], reg.get("asr-lite").revision),
              "asr-ko-mix": ("voyagar/BuzzASR-korean-mlx-8bit", "b73fdad446cfa19ad50dd919d06d7f96af1726ff"),
              "asr-ko-univa": ("voyagar/Qwen3-ASR-1.7B-ko-mlx-8bit", "8fcc32c42a93394b8c822487e2d595670edae23f"),
              "diarizer": (diarize.MODEL_REPO, diarize.MODEL_REVISION), "aligner": (align.MODEL_REPO, align.MODEL_REVISION),
              "embedding": (embed.MODEL_REPO, embed.MODEL_REVISION), "voices": (voices.MODEL_URL, None), "fluid": (diarize.FLUID_REPO, None)}
    assert set(consts) == {m.id for m in reg.MODELS}
    for m in reg.MODELS:
        row = doctor.model_row(m, Path("/nowhere"))
        for key in ("model_name", "publisher", "source", "license"):
            assert isinstance(row[key], str) and row[key].strip(), (m.id, key)
        assert (row["source"], row["revision"]) == consts[m.id], m.id
        for key in ("converted_by", "languages", "params"):
            assert row[key] is None or row[key].strip(), (m.id, key)
        assert re.fullmatch(r"[0-9a-f]{40}", row["revision"]) if m.kind == "hf" and m.id != "fluid" else row["revision"] is None
    assert reg.get("embedding").converted_by.startswith("mlx-community") and reg.get("asr-std").converted_by.startswith("mlx-community")
    assert reg.get("diarizer").license == "OpenMDW-1.1" and reg.get("voices").source.startswith("https://github.com/k2-fsa/")


def test_levels_and_needed_by():
    assert {m.id: m.level for m in reg.MODELS} == {
        "vad": "required", "asr-std": "required", "asr-lite": "required", "asr-ko-mix": "required", "asr-ko-univa": "required", "diarizer": "recommended",
        "aligner": "optional", "embedding": "optional", "voices": "optional", "fluid": "optional"}
    assert reg.get("asr-lite").needed_by == ("convert", "live")  # 표준 엔진이 있어도 실시간은 0.6B가 필요하다
    assert reg.get("asr-std").needed_by == ("convert",) and reg.get("asr-ko-mix").needed_by == ("convert",) and reg.get("asr-ko-univa").needed_by == ("convert",)  # 실시간은 0.6B만
    assert reg.get("vad").needed_by == ("convert", "live")
    assert reg.get("diarizer").needed_by == ("diarize",) and reg.get("fluid").needed_by == ("diarize-many",)
    known = {m.id for m in reg.MODELS}
    assert all(i in known for c in reg.CAPABILITIES for g in c.models for i in g)


def test_level_note_one_of_marks_exactly_the_either_or_models():
    """`필수 (엔진 중 하나)`: 등록된 변환 엔진에만 붙고, level은 그대로 required다 (옛 소비자 호환). 실시간 텍스트 변환은 가벼운 엔진만 쓴다 (docs/desktop.md §2.8)."""
    either_or = {i for c in reg.CAPABILITIES for g in c.models if len(g) > 1 for i in g}
    assert either_or == {"asr-std", "asr-lite", "asr-ko-mix", "asr-ko-univa"}
    assert {m.id for m in reg.MODELS if m.level_note == reg.ONE_OF} == either_or
    assert all(m.level == "required" for m in reg.MODELS if m.level_note)
    assert all(m.level_note is None for m in reg.MODELS if m.id not in either_or)
    assert "필수" not in reg.get("asr-std").purpose and "따로 필요" in reg.get("asr-lite").purpose and "16GB 이상을 권합니다" in reg.get("asr-std").purpose
    # 엔진 하나만 있어도 텍스트 변환은 준비된다 (둘 다 요구하지 않는다)
    ok = {"vad": "installed", "asr-lite": "installed"}
    conv = next(c for c in reg.capability_status(ok, {"ffmpeg": True}, 16 * 1024**3) if c["id"] == "convert")
    assert conv["ready"] and conv["missing"] == []


def test_hints_come_from_registry(tmp_path):
    for m in reg.MODELS:
        h = reg.install_hint(m.id, tmp_path)
        assert f"tractus models download {m.id}" in h
        if m.kind == "hf":
            assert f"hf download {m.repo} --revision {m.revision} --local-dir {tmp_path / m.local_dir}" in h
    assert reg.by_repo("mlx-community/silero-vad-v6").id == "vad" and reg.by_repo("nope/x") is None
    assert "tractus models download voices" in voices.model_hint(tmp_path) and "tractus models download fluid" in diarize.fluid_hint(tmp_path)


# ── 설치 상태 ────────────────────────────────────────────────────────────────

def test_inspect_states_from_real_files(root):
    assert set(states(root).values()) == {"missing"}
    (root / "silero-vad-v6").mkdir()
    assert reg.inspect("vad", root).state == "missing"  # 빈 폴더

    fake_install(root, "vad")
    st = reg.inspect("vad", root)
    assert (st.state, st.installed, st.installed_bytes) == ("installed", True, reg.get("vad").size_bytes)

    (root / "silero-vad-v6/model.safetensors").unlink()  # 일부만
    st = reg.inspect("vad", root)
    assert (st.state, st.installed_bytes) == ("partial", 463)

    with (root / "silero-vad-v6/model.safetensors").open("wb") as f:  # 크기가 다르면 손상
        f.truncate(10)
    assert reg.inspect("vad", root).state == "corrupt"


def test_incomplete_download_counts_as_partial_with_bytes(root):
    inc = root / "qwen3-asr-0.6b-8bit/.cache/huggingface/download"
    inc.mkdir(parents=True)
    (inc / "abc.def.incomplete").write_bytes(b"x" * 1000)
    st = reg.inspect("asr-lite", root)
    assert (st.state, st.installed_bytes, st.has_incomplete) == ("partial", 1000, True)


def test_usable_accepts_hand_installed_asr_dir_but_not_a_partial_download(root):
    d = root / "qwen3-asr-0.6b-8bit"
    d.mkdir()
    (d / "config.json").write_text("{}")  # 테스트 픽스처·직접 받은 폴더
    assert reg.usable("asr-lite", root) and not reg.inspect("asr-lite", root).installed
    (d / ".cache/huggingface/download").mkdir(parents=True)
    (d / ".cache/huggingface/download/x.incomplete").write_bytes(b"1")
    assert not reg.usable("asr-lite", root)
    assert not reg.usable("asr-std", root)


def test_stale_marker_revision_means_partial(root):
    fake_install(root, "vad")
    marker = root / "silero-vad-v6" / reg.MARKER
    marker.write_text(json.dumps({"id": "vad", "revision": reg.get("vad").revision}))
    assert reg.inspect("vad", root).installed
    marker.write_text(json.dumps({"id": "vad", "revision": "old-revision"}))
    assert reg.inspect("vad", root).state == "partial"  # 다시 받으면 새 리비전으로 채운다
    marker.write_text("{broken")
    assert reg.inspect("vad", root).installed  # 읽지 못하면 파일 크기만 본다


def test_voices_needs_matching_sha256(root, monkeypatch):
    payload = b"onnx-bytes"
    v = dataclasses.replace(reg.get("voices"), files={voices.MODEL_FILE: len(payload)}, size_bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest())
    monkeypatch.setitem(reg._BY_ID, "voices", v)
    d = root / v.local_dir
    d.mkdir()
    (d / voices.MODEL_FILE).write_bytes(payload)
    assert reg.inspect("voices", root).state == "installed"
    (d / voices.MODEL_FILE).write_bytes(b"onnx-BYTES")  # 같은 크기, 다른 내용
    assert reg.inspect("voices", root).state == "corrupt"
    (d / voices.MODEL_FILE).unlink()
    (d / (voices.MODEL_FILE + ".part")).write_bytes(b"onn")
    st = reg.inspect("voices", root)
    assert (st.state, st.installed_bytes) == ("partial", 3)


def test_fluid_needs_models_and_helper(root, tmp_path, monkeypatch):
    d = root / diarize.FLUID_DIR
    for f in diarize.FLUID_FILES:
        (d / f).mkdir(parents=True)
    assert reg.inspect("fluid", root).state == "partial"  # 모델만 있고 도우미 프로그램이 없다
    helper = tmp_path / "tractus-diar"
    helper.write_text("#!/bin/sh\n")
    helper.chmod(0o755)
    monkeypatch.setenv("TRACTUS_DIAR_BIN", str(helper))
    assert reg.inspect("fluid", root).state == "installed"


# ── 프리셋 ───────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("preset,memory,helper,expected", [
    ("required", 16 * GB, False, ["vad", "asr-std"]),
    ("required", 8 * GB, False, ["vad", "asr-lite"]),
    ("standard", 8 * GB, False, ["vad", "asr-std", "diarizer", "aligner", "embedding", "voices"]),
    ("lite", 32 * GB, False, ["vad", "asr-lite", "diarizer"]),
    ("all", 16 * GB, False, ["vad", "asr-std", "asr-lite", "asr-ko-mix", "asr-ko-univa", "diarizer", "aligner", "embedding", "voices"]),
    ("all", 16 * GB, True, [m.id for m in reg.MODELS]),
])
def test_presets(preset, memory, helper, expected):
    assert reg.preset_ids(preset, memory, helper) == expected


def test_resolve_ids_validates_and_dedupes():
    assert reg.resolve_ids(["diarizer", "vad", "vad"], "lite", 16 * GB) == ["vad", "asr-lite", "diarizer"]
    for bad in ("../x", "VAD", "nope", ""):
        with pytest.raises(ValueError):
            reg.resolve_ids([bad], None)
    with pytest.raises(ValueError):
        reg.preset_ids("huge")
    standard_gb = sum(reg.get(i).size_bytes for i in reg.preset_ids("standard")) / GB
    lite_gb = sum(reg.get(i).size_bytes for i in reg.preset_ids("lite")) / GB
    assert 4.2 < standard_gb < 4.4 and 1.0 < lite_gb < 1.2  # docs/setup.md의 합계 (GiB)


# ── 받기 ─────────────────────────────────────────────────────────────────────

def fake_fetch(root, calls=None, fail=None):
    """네트워크 대신 파일 목록대로 만든다."""
    def fetch(m, root_, report, cancel):
        if calls is not None:
            calls.append(m.id)
        if fail:
            raise fail
        fake_install(root_, m.id)
        report(m.size_bytes // 2)
    return fetch


def run_download(root, ids, **kw):
    events = []
    done = inst.download(ids, root, lambda ev, **d: events.append({"event": ev, **d}), threading.Event())
    return done, events


def test_download_skips_installed_writes_marker_last_and_reports(root, monkeypatch):
    calls = []
    monkeypatch.setattr(inst, "_FETCH", {**inst._FETCH, "hf": fake_fetch(root, calls)})
    fake_install(root, "diarizer")
    done, events = run_download(root, ["vad", "diarizer", "embedding"])
    assert done == ["vad", "embedding"] and calls == ["vad", "embedding"]
    kinds = [e["event"] for e in events]
    assert kinds[0] == "stage" and kinds.count("model_done") == 2
    stage = events[0]
    assert stage == {"event": "stage", "stage": "download", "model": "vad", "index": 1, "count": 2, "size_bytes": reg.get("vad").size_bytes}
    progress = [e for e in events if e["event"] == "progress"]
    assert {"model", "file", "bytes_done", "bytes_total", "overall_done", "overall_total"} <= set(progress[0])
    assert progress[-1]["overall_done"] == progress[-1]["overall_total"] == reg.get("vad").size_bytes + reg.get("embedding").size_bytes
    marker = json.loads((root / "silero-vad-v6" / reg.MARKER).read_text())
    assert marker["id"] == "vad" and marker["revision"] == reg.get("vad").revision and marker["files"] == reg.get("vad").files
    assert not (root / "qwen3-embedding-0.6b-8bit" / (reg.MARKER + ".tmp")).exists()


def test_download_refuses_corrupt_and_checks_disk_first(root, monkeypatch):
    calls = []
    monkeypatch.setattr(inst, "_FETCH", {**inst._FETCH, "hf": fake_fetch(root, calls)})
    fake_install(root, "vad")
    with (root / "silero-vad-v6/model.safetensors").open("wb") as f:
        f.truncate(5)
    with pytest.raises(inst.ModelError) as e:
        run_download(root, ["vad"])
    assert e.value.code == "corrupt" and "remove vad" in e.value.message and calls == []

    monkeypatch.setattr(inst, "disk_free", lambda r: reg.get("asr-std").size_bytes)  # 크기 × 1.1이 안 된다
    with pytest.raises(inst.ModelError) as e:
        run_download(root, ["asr-std"])
    assert e.value.code == "disk_full" and calls == []
    monkeypatch.setattr(inst, "disk_free", lambda r: int(reg.get("asr-std").size_bytes * 1.11))
    assert run_download(root, ["asr-std"])[0] == ["asr-std"]


def test_download_counts_resumed_bytes_in_disk_check(root, monkeypatch):
    inc = root / "qwen3-asr-1.7b-8bit/.cache/huggingface/download"
    inc.mkdir(parents=True)
    with (inc / "m.h.incomplete").open("wb") as f:
        f.truncate(reg.get("asr-std").size_bytes - 1000)
    todo, need = inst.plan(["asr-std"], root)
    assert todo == ["asr-std"] and need == 1000


def test_download_lock_allows_one_process_and_blocks_remove(root, monkeypatch):
    fake_install(root, "vad")
    with inst.download_lock(root):
        assert inst.lock_held(root)
        with pytest.raises(inst.ModelError) as e:
            inst.download_lock(root).__enter__()
        assert e.value.code == "busy"
        with pytest.raises(inst.ModelError) as e:
            inst.remove("vad", root)
        assert e.value.code == "busy"
    assert not inst.lock_held(root) and (root / "silero-vad-v6").exists()


def test_remove_deletes_only_the_model_dir(root):
    fake_install(root, "vad")
    fake_install(root, "diarizer")
    r = inst.remove("vad", root)
    assert r == {"id": "vad", "removed": True, "freed_bytes": reg.get("vad").size_bytes}
    assert not (root / "silero-vad-v6").exists() and reg.inspect("diarizer", root).installed
    assert inst.remove("vad", root) == {"id": "vad", "removed": False, "freed_bytes": 0}


def test_remove_refuses_a_plain_file_named_like_a_model_dir(root):
    stray = root / "silero-vad-v6"
    stray.write_text("not a dir")
    with pytest.raises(inst.ModelError) as e:
        inst.remove("vad", root)
    assert e.value.code == "unsafe_path" and stray.exists()


def test_lock_probe_does_not_take_the_lock(root):
    (root / reg.LOCK_NAME).write_text("")
    with inst.download_lock(root):
        pass
    for _ in range(200):  # 확인(lock_held)을 하는 사이에도 받기는 잠금을 잡을 수 있다
        assert not inst.lock_held(root)
        with inst.download_lock(root):
            assert inst.lock_held(root)
    (root / reg.LOCK_NAME).write_text("999999999")  # 죽은 프로세스의 PID (강제 종료로 남은 값)
    assert not inst.lock_held(root)


def test_remove_refuses_symlinks_and_paths_outside_models_dir(root, tmp_path, monkeypatch):
    outside = tmp_path / "precious"
    outside.mkdir()
    (outside / "keep.txt").write_text("x")
    (root / "silero-vad-v6").symlink_to(outside, target_is_directory=True)
    with pytest.raises(inst.ModelError) as e:
        inst.remove("vad", root)
    assert e.value.code == "unsafe_path" and (outside / "keep.txt").exists()

    monkeypatch.setitem(reg._BY_ID, "vad", dataclasses.replace(reg.get("vad"), local_dir="../precious"))
    with pytest.raises(inst.ModelError) as e:
        inst.remove("vad", root)
    assert e.value.code == "unsafe_path" and (outside / "keep.txt").exists()


# ── 오류 코드 ────────────────────────────────────────────────────────────────

class Resp:
    def __init__(self, status):
        self.status_code = status


class HttpErr(Exception):
    def __init__(self, status):
        self.response = Resp(status)


def test_classify_maps_hub_and_os_errors():
    import httpx
    import urllib.error
    from huggingface_hub.errors import LocalEntryNotFoundError, OfflineModeIsEnabled

    assert inst.classify(httpx.ConnectError("down")) == "no_network"
    assert inst.classify(httpx.ReadTimeout("slow")) == "no_network"
    assert inst.classify(OfflineModeIsEnabled("HF_HUB_OFFLINE")) == "no_network"
    assert inst.classify(LocalEntryNotFoundError("cannot reach")) == "no_network"
    assert inst.classify(urllib.error.URLError("dns")) == "no_network"
    assert inst.classify(OSError(errno.ENOSPC, "No space left on device")) == "disk_full"
    assert inst.classify(HttpErr(401)) == "auth" and inst.classify(HttpErr(403)) == "auth"
    for code, want in ((401, "auth"), (403, "auth"), (404, "unknown"), (416, "unknown")):  # urllib.HTTPError는 .code만 가진다
        assert inst.classify(urllib.error.HTTPError("http://x", code, "m", {}, None)) == want
    assert inst.classify(HttpErr(500)) == "unknown" and inst.classify(ValueError("?")) == "unknown"
    assert inst.classify(inst.ModelError("hash_mismatch", "x")) == "hash_mismatch"
    try:  # 원인 사슬 안의 네트워크 오류도 찾는다
        try:
            raise httpx.ConnectError("down")
        except httpx.ConnectError as e:
            raise RuntimeError("wrapped") from e
    except RuntimeError as e:
        assert inst.classify(e) == "no_network"


def test_download_wraps_unexpected_errors_with_code_and_model(root, monkeypatch):
    import httpx

    monkeypatch.setattr(inst, "_FETCH", {**inst._FETCH, "hf": fake_fetch(root, fail=httpx.ConnectError("down"))})
    with pytest.raises(inst.ModelError) as e:
        run_download(root, ["vad"])
    assert (e.value.code, e.value.model) == ("no_network", "vad") and "목소리 구간 감지" in e.value.message


# ── URL(voices)·도우미(fluid) 받기 ────────────────────────────────────────────

PAYLOAD = bytes(range(256)) * 4096  # 1MiB


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        start = int(re.match(r"bytes=(\d+)-", self.headers.get("Range", "bytes=0-")).group(1))
        self.send_response(206 if start else 200)
        self.send_header("Content-Length", str(len(PAYLOAD) - start))
        self.end_headers()
        self.wfile.write(PAYLOAD[start:])

    def log_message(self, *a):
        pass


@pytest.fixture
def server(monkeypatch):
    httpd = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_port}/m.onnx"
    httpd.shutdown()


def local_voices(url, sha=None) -> reg.Model:
    return dataclasses.replace(reg.get("voices"), url=url, files={voices.MODEL_FILE: len(PAYLOAD)}, size_bytes=len(PAYLOAD),
                               sha256=sha or hashlib.sha256(PAYLOAD).hexdigest())


def test_url_download_verifies_sha_and_resumes_part(root, server):
    m = local_voices(server)
    seen = []
    rep = inst._Reporter(lambda ev, **d: seen.append(d), m, root / m.local_dir, 0, m.size_bytes)
    part = root / m.local_dir / (voices.MODEL_FILE + ".part")
    part.parent.mkdir(parents=True)
    part.write_bytes(PAYLOAD[:1000])  # 이어받기: Range 요청으로 나머지만
    inst._download_url(m, root, rep, threading.Event())
    assert (root / m.local_dir / voices.MODEL_FILE).read_bytes() == PAYLOAD and not part.exists()
    assert seen and seen[-1]["bytes_done"] == len(PAYLOAD)


def test_url_download_with_a_full_size_part_verifies_instead_of_requesting_a_range(root, server):
    m = local_voices(server)
    part = root / m.local_dir / (voices.MODEL_FILE + ".part")
    part.parent.mkdir(parents=True)
    part.write_bytes(PAYLOAD)  # 마지막 쓰기와 이름 바꾸기 사이에 멈춘 모습: Range 요청은 416
    inst._download_url(m, root, inst._Reporter(lambda ev, **d: None, m, root / m.local_dir, 0, m.size_bytes), threading.Event())
    assert (root / m.local_dir / voices.MODEL_FILE).read_bytes() == PAYLOAD and not part.exists()


def test_url_download_hash_mismatch_removes_file_and_cancel_keeps_part(root, server):
    bad = local_voices(server, sha="0" * 64)
    rep = inst._Reporter(lambda ev, **d: None, bad, root / bad.local_dir, 0, bad.size_bytes)
    with pytest.raises(inst.ModelError) as e:
        inst._download_url(bad, root, rep, threading.Event())
    assert e.value.code == "hash_mismatch" and not list((root / bad.local_dir).iterdir())

    cancel = threading.Event()
    cancel.set()
    with pytest.raises(inst.Cancelled):
        inst._download_url(local_voices(server), root, rep, cancel)
    assert list((root / bad.local_dir).glob("*.part"))  # 다시 실행하면 이어받는다


def test_helper_download_needs_the_binary(root):
    rep = inst._Reporter(lambda ev, **d: None, reg.get("fluid"), root, 0, 1)
    with pytest.raises(inst.ModelError) as e:
        inst._download_helper(reg.get("fluid"), root, rep, threading.Event())
    assert e.value.code == "helper_missing" and "swift build" in e.value.message


def test_helper_download_runs_binary_and_maps_failure(root, tmp_path, monkeypatch):
    script = tmp_path / "tractus-diar"
    script.write_text('#!/bin/sh\nmkdir -p "$3/Segmentation.mlmodelc" "$3/Embedding.mlmodelc"\necho \'{"event":"downloaded"}\'\n')
    script.chmod(0o755)
    monkeypatch.setenv("TRACTUS_DIAR_BIN", str(script))
    done, _ = run_download(root, ["fluid"])
    assert done == ["fluid"] and reg.inspect("fluid", root).installed
    script.write_text('#!/bin/sh\necho \'{"event":"error","message":"offline: no network"}\'\nexit 1\n')
    shutil_rm = root / diarize.FLUID_DIR
    inst.remove("fluid", root)
    assert not shutil_rm.exists()
    with pytest.raises(inst.ModelError) as e:
        run_download(root, ["fluid"])
    assert e.value.code == "no_network"


# ── doctor ───────────────────────────────────────────────────────────────────

def fake_system(monkeypatch, arch="arm64", mac="15.2", memory=16 * GB, system="Darwin"):
    monkeypatch.setattr(doctor.platform, "machine", lambda: arch)
    monkeypatch.setattr(doctor.platform, "system", lambda: system)
    monkeypatch.setattr(doctor.platform, "mac_ver", lambda: (mac, ("", "", ""), arch))
    monkeypatch.setattr(reg, "physical_memory", lambda: memory)


@pytest.mark.parametrize("kw,problems", [
    ({}, []),
    ({"arch": "x86_64"}, ["not_apple_silicon"]),
    ({"mac": "14.3"}, ["macos_too_old"]),
    ({"mac": "14.4"}, []),
    ({"memory": 4 * GB}, ["memory_low"]),
    ({"system": "Linux", "mac": ""}, ["macos_too_old"]),
])
def test_doctor_system_minimums(root, monkeypatch, kw, problems):
    fake_system(monkeypatch, **kw)
    s = doctor.system(root)
    assert s["problems"] == problems and s["meets_min"] is not bool(problems)


def test_doctor_report_with_nothing_installed_never_fails(root, monkeypatch):
    fake_system(monkeypatch)
    monkeypatch.setattr(doctor.shutil, "which", lambda name: None)
    r = doctor.report(root)
    assert r["tools"]["ffmpeg"] == {"found": False, "path": None, "version": None}
    assert r["tools"]["recorder"]["found"] is False and r["tools"]["diar_helper"]["found"] is False
    caps = {c["id"]: c for c in r["capabilities"]}
    assert caps["convert"]["missing"] == ["vad", "asr-std", "ffmpeg"] and not caps["convert"]["ready"]
    assert caps["convert"]["hint"] == "tractus models download vad; tractus models download asr-std; brew install ffmpeg"
    assert caps["record"]["missing"] == ["recorder"] and "swift build" in caps["record"]["hint"]
    assert caps["live"]["missing"] == ["vad", "asr-lite", "recorder"]
    assert (r["recommended_track"], r["effective_track"]) == ("standard", None)
    assert {m["state"] for m in r["models"]} == {"missing"}


def test_capability_matrix(root, monkeypatch):
    fake_system(monkeypatch, memory=8 * GB)
    tools = {"ffmpeg": True, "recorder": True, "diar_helper": False}
    fake_install(root, "vad")
    fake_install(root, "asr-std")
    caps = {c["id"]: c for c in reg.capability_status(states(root), tools, 8 * GB)}
    assert caps["convert"]["ready"] and caps["record"]["ready"]
    assert caps["live"]["missing"] == ["asr-lite", "memory"]  # 표준 엔진이 있어도 실시간 변환은 0.6B가 필요하다. 16GB 미만이면 memory도
    assert caps["live"]["hint"].endswith("메모리 16GB 이상인 Mac에서만 켤 수 있습니다")
    assert caps["diarize"]["missing"] == ["diarizer"] and caps["voices"]["missing"] == ["voices"]
    states_no_asr = {**states(root), "asr-std": "missing"}
    assert reg.capability_status(states_no_asr, tools, 8 * GB)[1]["missing"] == ["asr-lite"]  # 메모리가 권하는 쪽
    assert reg.capability_status(states_no_asr, tools, 16 * GB)[1]["missing"] == ["asr-std"]
    partial = {**states(root), "vad": "partial"}
    assert not [c for c in reg.capability_status(partial, tools)][1]["ready"]  # 일부만 받은 모델은 준비된 것이 아니다
    lite_only = {**states(root), "asr-std": "missing", "asr-lite": "installed"}
    assert reg.capability_status(lite_only, tools, 16 * GB)[1]["ready"]  # 둘 중 하나면 된다


def test_live_needs_16gb_and_align_voices_need_ffmpeg(root):
    for mid in ("vad", "asr-lite", "aligner"):
        fake_install(root, mid)
    all_tools = {"ffmpeg": True, "recorder": True, "diar_helper": False}
    caps = lambda tools, mem: {c["id"]: c for c in reg.capability_status(states(root), tools, mem)}  # noqa: E731
    assert caps(all_tools, 16 * GB)["live"]["ready"] and not caps(all_tools, 8 * GB)["live"]["ready"]
    assert caps(all_tools, 8 * GB)["live"]["missing"] == ["memory"]
    no_ffmpeg = caps({**all_tools, "ffmpeg": False}, 16 * GB)
    assert no_ffmpeg["align"]["missing"] == ["ffmpeg"] and no_ffmpeg["voices"]["missing"] == ["voices", "ffmpeg"]
    assert caps(all_tools, 16 * GB)["align"]["ready"]


def test_doctor_reports_brew(root, monkeypatch):
    monkeypatch.setattr(doctor.shutil, "which", lambda name: "/opt/homebrew/bin/brew" if name == "brew" else None)
    assert doctor.tools()["brew"] == {"found": True, "path": "/opt/homebrew/bin/brew", "version": None}
    monkeypatch.setattr(doctor.shutil, "which", lambda name: None)
    monkeypatch.setattr(doctor.os, "access", lambda p, mode: False)
    assert doctor.tools()["brew"]["found"] is False


def test_doctor_cli_and_models_list_cli_json_shapes(root, monkeypatch):
    fake_install(root, "vad")
    r = CliRunner().invoke(cli.app, ["doctor", "--json"])
    assert r.exit_code == 0
    d = json.loads(r.stdout)
    assert {"system", "tools", "models", "capabilities", "recommended_track", "effective_track"} <= set(d)
    r = CliRunner().invoke(cli.app, ["models", "list", "--json"])
    d = json.loads(r.stdout)
    assert {"models_dir", "disk_free_bytes", "models", "download_active"} <= set(d) and d["download_active"] is False
    by = {m["id"]: m for m in d["models"]}
    assert set(by["vad"]) == {"id", "name", "purpose", "level", "size_bytes", "installed", "installed_bytes", "state", "needed_by", "group", "path", "level_note",
                              "model_name", "publisher", "converted_by", "source", "revision", "license", "languages", "params", "engine", "custom"}
    assert by["asr-std"]["model_name"] == "Qwen3-ASR 1.7B (8bit 양자화)" and by["asr-std"]["source"] == "mlx-community/Qwen3-ASR-1.7B-8bit"
    assert by["vad"]["installed"] is True and by["vad"]["state"] == "installed" and by["asr-lite"]["needed_by"] == ["convert", "live"]
    assert by["asr-std"]["installed"] is False and by["asr-std"]["installed_bytes"] == 0
    assert (by["asr-std"]["level"], by["asr-std"]["level_note"], by["asr-lite"]["level_note"], by["vad"]["level_note"]) == ("required", "one_of", "one_of", None)
    assert {m["id"]: m["level_note"] for m in json.loads(CliRunner().invoke(cli.app, ["doctor", "--json"]).stdout)["models"]}["asr-lite"] == "one_of"
    plain = CliRunner().invoke(cli.app, ["models", "list"])
    assert plain.exit_code == 0 and "silero" not in plain.stdout and "vad" in plain.stdout
    lines = {ln.split()[0]: ln for ln in plain.stdout.splitlines()[1:]}
    assert "필수 (엔진 중 하나)" in lines["asr-std"] and "필수 (엔진 중 하나)" in lines["asr-lite"] and "엔진 중 하나" not in lines["vad"]


# ── CLI 이벤트 ───────────────────────────────────────────────────────────────

def events_of(out: str) -> list[dict]:
    return [json.loads(line) for line in out.splitlines() if line.startswith("{")]


def test_cli_download_events_and_done(root, monkeypatch):
    monkeypatch.setattr(inst, "_FETCH", {**inst._FETCH, "hf": fake_fetch(root)})
    r = CliRunner().invoke(cli.app, ["models", "download", "vad", "--progress-json"])
    assert r.exit_code == 0, r.output
    evs = events_of(r.stdout)
    assert [e["event"] for e in evs][0] == "stage" and evs[-1] == {"event": "done", "models": ["vad"], "already": []}
    r = CliRunner().invoke(cli.app, ["models", "download", "vad", "--progress-json"])
    assert events_of(r.stdout)[-1] == {"event": "done", "models": [], "already": ["vad"]}


def test_cli_download_preset_and_bad_arguments(root, monkeypatch):
    calls = []
    monkeypatch.setattr(inst, "_FETCH", {**inst._FETCH, "hf": fake_fetch(root, calls)})
    r = CliRunner().invoke(cli.app, ["models", "download", "--preset", "lite", "--progress-json"])
    assert r.exit_code == 0 and calls == ["vad", "asr-lite", "diarizer"]
    r = CliRunner().invoke(cli.app, ["models", "download", "--preset", "all", "--progress-json"])
    evs = events_of(r.stdout)
    assert any(e["event"] == "warning" and e["code"] == "fluid_skipped" for e in evs)  # 도우미 프로그램이 없으면 건너뛴다
    assert "fluid" not in calls
    for argv in (["nope"], ["../etc"], [], ["--preset", "huge"]):
        r = CliRunner().invoke(cli.app, ["models", "download", *argv, "--progress-json"])
        err = events_of(r.stdout)[-1]
        assert r.exit_code == 2 and err["event"] == "error" and err["code"] == "bad_argument"


def test_cli_download_error_and_cancel_events(root, monkeypatch):
    import httpx

    monkeypatch.setattr(inst, "_FETCH", {**inst._FETCH, "hf": fake_fetch(root, fail=httpx.ConnectError("down"))})
    r = CliRunner().invoke(cli.app, ["models", "download", "vad", "--progress-json"])
    err = events_of(r.stdout)[-1]
    assert r.exit_code == 1 and err["event"] == "error" and err["code"] == "no_network" and err["model"] == "vad" and "message" in err

    monkeypatch.setattr(inst, "_FETCH", {**inst._FETCH, "hf": fake_fetch(root, fail=inst.Cancelled())})
    r = CliRunner().invoke(cli.app, ["models", "download", "vad", "--progress-json"])
    assert r.exit_code == 130 and events_of(r.stdout)[-1] == {"event": "cancelled"}

    monkeypatch.setattr(inst, "disk_free", lambda r_: 1)
    r = CliRunner().invoke(cli.app, ["models", "download", "asr-std", "--progress-json"])
    assert r.exit_code == 1 and events_of(r.stdout)[-1]["code"] == "disk_full"


def test_cli_remove(root):
    fake_install(root, "vad")
    r = CliRunner().invoke(cli.app, ["models", "remove", "vad", "--yes"])
    assert r.exit_code == 0 and json.loads(r.stdout) == {"id": "vad", "removed": True, "freed_bytes": reg.get("vad").size_bytes}
    assert CliRunner().invoke(cli.app, ["models", "remove", "../x", "--yes"]).exit_code == 2
    fake_install(root, "vad")
    assert CliRunner().invoke(cli.app, ["models", "remove", "vad"], input="n\n").exit_code == 1  # --yes 없이는 확인한다
    assert reg.inspect("vad", root).installed


# ── 변환 엔진 고르기 ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("memory,have,want,fallback", [
    (16 * GB, {"asr-std", "asr-lite"}, "standard", False),
    (16 * GB, {"asr-std"}, "standard", False),
    (16 * GB, {"asr-lite"}, "lite", True),
    (8 * GB, {"asr-lite"}, "lite", False),
    (8 * GB, {"asr-std"}, "standard", True),
    (8 * GB, {"asr-std", "asr-lite"}, "lite", False),
    (16 * GB, set(), "standard", False),  # 둘 다 없으면 권하는 쪽 (local_model이 model_missing으로 알린다)
    (8 * GB, set(), "lite", False),
])
def test_auto_track_prefers_ram_choice_then_falls_back(root, monkeypatch, memory, have, want, fallback):
    for mid in have:
        d = root / reg.get(mid).local_dir
        d.mkdir()
        (d / "config.json").write_text("{}")
    warnings = []
    monkeypatch.setattr(cli, "physical_memory", lambda: memory)
    monkeypatch.setattr(cli, "_warn", lambda code, message: warnings.append((code, message)))
    assert cli.auto_track().value == want
    assert [c for c, _ in warnings] == (["asr_track_fallback"] if fallback else [])
    if fallback:
        assert "tractus models download" in warnings[0][1]


def test_auto_track_ignores_a_half_downloaded_model(root, monkeypatch):
    d = root / "qwen3-asr-1.7b-8bit"
    (d / ".cache/huggingface/download").mkdir(parents=True)
    (d / "config.json").write_text("{}")
    (d / ".cache/huggingface/download/m.h.incomplete").write_bytes(b"1")  # 받는 중
    lite = root / "qwen3-asr-0.6b-8bit"
    lite.mkdir()
    (lite / "config.json").write_text("{}")
    monkeypatch.setattr(cli, "physical_memory", lambda: 16 * GB)
    monkeypatch.setattr(cli, "_warn", lambda code, message: None)
    assert cli.auto_track().value == "lite"


def test_local_model_rejects_a_half_downloaded_model(root):
    d = root / "qwen3-asr-0.6b-8bit"
    (d / ".cache/huggingface/download").mkdir(parents=True)
    (d / "config.json").write_text("{}")
    (d / ".cache/huggingface/download/m.h.incomplete").write_bytes(b"1")  # 취소로 남은 모습: 설정만 받고 가중치는 받는 중
    with pytest.raises(Exception) as e:
        cli.local_model(cli.MODELS[cli.Track.lite])
    assert "tractus models download asr-lite" in str(e.value)
    (d / ".cache/huggingface/download/m.h.incomplete").unlink()
    (d / "model.safetensors").write_bytes(b"short")  # 가중치가 있는데 크기가 맞지 않는다
    with pytest.raises(Exception):
        cli.local_model(cli.MODELS[cli.Track.lite])


def test_model_missing_hint_names_the_registry_command(root):
    with pytest.raises(Exception) as e:
        cli.local_model(cli.VAD_MODEL)
    text = str(e.value)
    assert "tractus models download vad" in text and "hf download mlx-community/silero-vad-v6 --revision" in text


# ── 실제 받기 (네트워크) ──────────────────────────────────────────────────────

@pytest.mark.network
def test_real_download_cancel_keeps_partial_and_rerun_resumes(root):
    m = reg.get("vad")
    cancel = threading.Event()
    cancel.set()  # 첫 진행 보고에서 Cancelled (hf_xet이 꺼져 있어야 전송이 멈춘다)
    with pytest.raises(inst.Cancelled):
        inst.download(["vad"], root, lambda ev, **d: None, cancel)
    assert not reg.inspect("vad", root).installed and not (root / m.local_dir / reg.MARKER).exists()
    assert inst.download(["vad"], root, lambda ev, **d: None, threading.Event()) == ["vad"]
    assert reg.inspect("vad", root).installed


@pytest.mark.network
def test_real_download_of_silero_vad_into_tmp(root):
    r = CliRunner().invoke(cli.app, ["models", "download", "vad", "--progress-json"])
    assert r.exit_code == 0, r.output
    evs = events_of(r.stdout)
    assert any(e["event"] == "progress" and e["bytes_total"] == reg.get("vad").size_bytes for e in evs) and evs[-1]["event"] == "done"
    listed = json.loads(CliRunner().invoke(cli.app, ["models", "list", "--json"]).stdout)
    vad = next(m for m in listed["models"] if m["id"] == "vad")
    assert vad["installed"] and vad["state"] == "installed" and vad["installed_bytes"] == reg.get("vad").size_bytes
    assert json.loads((root / "silero-vad-v6" / reg.MARKER).read_text())["revision"] == reg.get("vad").revision


# ── 허브 진행 막대·SIGTERM ───────────────────────────────────────────────────

def test_hub_download_disables_xet_so_cancel_reaches_the_transfer(root, monkeypatch):
    import huggingface_hub
    from huggingface_hub import constants

    monkeypatch.setattr(constants, "HF_HUB_DISABLE_XET", False)
    seen = []
    monkeypatch.setattr(huggingface_hub, "snapshot_download", lambda **kw: seen.append(constants.HF_HUB_DISABLE_XET))
    m = reg.get("vad")
    inst._download_hf(m, root, inst._Reporter(lambda ev, **d: None, m, root / m.local_dir, 0, m.size_bytes), threading.Event())
    assert seen == [True]  # hf_xet은 자기 스레드에서 진행을 알려 Cancelled가 전송을 못 멈춘다


def test_hub_progress_bar_reports_bytes_and_honours_cancel(root, monkeypatch):
    import huggingface_hub

    m = reg.get("vad")
    seen, cancel = [], threading.Event()

    def fake_snapshot(**kw):
        files = kw["tqdm_class"](total=2, desc="Fetching 2 files")
        bytes_bar = kw["tqdm_class"](total=m.size_bytes, desc="Downloading bytes")
        files.update(1)  # 파일 수 막대는 따라가지 않는다
        bytes_bar.update(100)
        cancel.set()
        bytes_bar.update(100)  # 취소되면 허브 스레드 안에서 Cancelled가 올라간다

    monkeypatch.setattr(huggingface_hub, "snapshot_download", fake_snapshot)
    rep = inst._Reporter(lambda ev, **d: seen.append(d), m, root / m.local_dir, 0, m.size_bytes)
    monkeypatch.setenv("TQDM_DISABLE", "1")  # cli가 걸어 두는 값. 막대가 꺼져도 진행을 읽어야 한다
    with pytest.raises(inst.Cancelled):
        inst._download_hf(m, root, rep, cancel)
    assert [s["bytes_done"] for s in seen] == [100]


def test_sigterm_stops_cleanly_with_cancelled_event(tmp_path):
    import signal
    import subprocess
    import sys

    code = (
        "import sys, threading\n"
        "from tractus import cli, models_install as inst\n"
        "def slow(m, root, report, cancel):\n"
        "    print('SLOW', flush=True)\n"
        "    cancel.wait(30)\n"
        "    raise inst.Cancelled()\n"
        "inst._FETCH['hf'] = slow\n"
        "cli.app(['models', 'download', 'vad', '--progress-json'])\n"
    )
    models = tmp_path / "models"
    env = {"PATH": "/usr/bin:/bin", "TRACTUS_HOME": str(tmp_path / "home"), "TRACTUS_MODELS_DIR": str(models), "HOME": str(tmp_path)}
    p = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, cwd=tmp_path)
    for line in p.stdout:  # stage 이벤트와 SLOW가 나오면 받는 중이다
        if line.startswith("SLOW"):
            break
    p.send_signal(signal.SIGTERM)
    out, _ = p.communicate(timeout=20)
    assert p.returncode == 130 and events_of(out)[-1] == {"event": "cancelled"}
    assert not inst.lock_held(models)  # 잠금을 놓았다


def test_silero_vad_languages_is_none_because_card_lists_only_training_corpus():
    from tractus import models_registry as r
    assert next(m for m in r.MODELS if m.id == "vad").languages is None


# ── 등록되지 않은 폴더 지우기 (D1) ───────────────────────────────────────────

def test_unregistered_lists_only_real_unknown_dirs_and_prune_removes_them(root, tmp_path):
    fake_install(root, "vad")
    old = root / "qwen3-embedding-0.6b"  # 옛 bf16 임베딩 폴더가 이 모양이다
    old.mkdir()
    (old / "model.safetensors").write_bytes(b"x" * 100)
    (root / ".hidden").mkdir()
    (root / "stray.txt").write_text("file")
    (root / reg.LOCK_NAME).write_text("")
    outside = tmp_path / "precious"
    outside.mkdir()
    (outside / "keep.txt").write_text("x")
    (root / "link").symlink_to(outside, target_is_directory=True)
    assert inst.unregistered(root) == [{"name": "qwen3-embedding-0.6b", "bytes": 100}]
    assert doctor.models_list(root)["unregistered"] == [{"name": "qwen3-embedding-0.6b", "bytes": 100}]
    assert inst.prune(root) == {"removed": [{"name": "qwen3-embedding-0.6b", "bytes": 100}], "freed_bytes": 100}
    assert not old.exists() and reg.inspect("vad", root).installed
    assert (root / ".hidden").exists() and (root / "stray.txt").exists() and (root / "link").is_symlink() and (outside / "keep.txt").exists()
    assert inst.prune(root) == {"removed": [], "freed_bytes": 0}


def test_prune_never_deletes_folders_in_a_wrongly_chosen_models_dir(root, tmp_path, monkeypatch):
    """모델 폴더를 문서·노트 폴더로 잘못 골라도 사용자 폴더는 지우지 않는다 (데이터 손실 방지)."""
    for name in ("Photos", "Taxes"):  # 모델이 하나도 없는 곳
        (root / name).mkdir()
        (root / name / "a.txt").write_text("x")
    assert inst.unregistered(root) == [] and inst.prune(root) == {"removed": [], "freed_bytes": 0}
    fake_install(root, "vad")  # 모델이 있어도 모델 모양이 아닌 폴더는 건드리지 않는다
    assert inst.unregistered(root) == [] and (root / "Photos" / "a.txt").exists()
    home = tmp_path / "home"  # 노트 폴더를 모델 폴더로 쓰는 경우
    (home / "meetings" / "m1").mkdir(parents=True)
    (home / "meetings" / "m1" / "transcript.json").write_text("{}")
    fake_install(home, "vad")
    (home / "old").mkdir()
    (home / "old" / "config.json").write_text("{}")
    assert inst.unregistered(home) == [] and inst.prune(home)["removed"] == []
    assert (home / "meetings" / "m1" / "transcript.json").exists() and (home / "old").exists()
    with pytest.raises(inst.ModelError) as e:
        inst.move(root, home)
    assert e.value.code == "bad_argument"


def test_prune_refuses_while_download_lock_is_held(root):
    fake_install(root, "vad")
    (root / "old").mkdir()
    (root / "old" / "config.json").write_text("{}")
    with inst.download_lock(root):
        with pytest.raises(inst.ModelError) as e:
            inst.prune(root)
    assert e.value.code == "busy" and (root / "old").exists()


def test_cli_prune_asks_unless_yes_and_keeps_stdout_json(root):
    fake_install(root, "vad")
    (root / "old").mkdir()
    (root / "old" / "config.json").write_text("{}")
    r = CliRunner().invoke(cli.app, ["models", "prune", "--json"], input="n\n")
    assert r.exit_code == 1 and (root / "old").exists()  # --yes 없이는 확인한다
    r = CliRunner().invoke(cli.app, ["models", "prune", "--json", "--yes"])
    assert r.exit_code == 0 and json.loads(r.stdout) == {"removed": [{"name": "old", "bytes": 2}], "freed_bytes": 2} and not (root / "old").exists()
    assert CliRunner().invoke(cli.app, ["models", "prune", "--yes"]).stdout.strip() == "지울 폴더가 없습니다"


# ── 변환 엔진 고르기: --engine (docs/design/asr-engines.md) ──────────────────


def test_engine_option_picks_an_installed_engine_and_falls_back_with_a_warning(root, monkeypatch):
    for mid in ("asr-std", "asr-lite"):
        d = root / reg.get(mid).local_dir
        d.mkdir()
        (d / "config.json").write_text("{}")
    warnings = []
    monkeypatch.setattr(cli, "physical_memory", lambda: 16 * GB)
    monkeypatch.setattr(cli, "_warn", lambda code, message: warnings.append(code))
    assert cli.choose_asr(None, "asr-lite").id == "asr-lite"
    assert cli.choose_asr(cli.Track.lite, None).id == "asr-lite"
    assert cli.choose_asr(None, None).id == "asr-std" and warnings == []
    import shutil

    shutil.rmtree(root / reg.get("asr-lite").local_dir)
    assert cli.choose_asr(None, "asr-lite").id == "asr-std" and warnings == ["asr_engine_missing"]
    with pytest.raises(Exception, match="변환 엔진이 아닙니다"):
        cli.choose_asr(None, "vad")
    assert (cli.track_name(reg.get("asr-std")), cli.track_name(reg.get("asr-lite"))) == ("standard", "lite")


def test_convert_needs_any_one_transcription_engine(tmp_path):  # 빈 폴더: 개발 Mac의 직접 추가 엔진이 끼지 않게
    assert reg.get("vad").engine is None
    groups = next(c for c in reg.CAPABILITIES if c.id == "convert").models
    assert groups[1] == tuple(reg.asr_ids(tmp_path)) and {"asr-std", "asr-lite"} <= set(groups[1])
    assert all(reg.get(i).engine for i in groups[1])
