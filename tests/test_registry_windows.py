"""등록 목록의 Windows 갈래 (docs/design/asr-onnx.md 4.1–4.4절, 7절). Windows 목록을 바꿔 끼워 Mac에서 돈다.
Mac 목록의 결과가 예전과 같다는 것은 test_models.py의 기존 시험(프리셋·기능 표·models list 키·prune)과 아래 고정 시험이 본다."""

import json
import subprocess
import sys
from pathlib import Path

import pytest
import typer
from typer.testing import CliRunner

from tractus import asr_onnx, cli, doctor, store, vad_onnx
from tractus import models_install as inst
from tractus import models_registry as reg
from tractus.commands import common, engines
from conftest import use_models
from test_attach import append, make_text_note
from test_cli import env, events, fake_asr  # noqa: F401 (fixture)
from test_deferred import convert, saved

GB = 1024**3
LOCKED = {"diarize", "diarize-many", "align", "smart-search", "voices", "live"}


@pytest.fixture
def windows(monkeypatch):
    use_models(monkeypatch, reg._windows_models())


@pytest.fixture
def root(tmp_path, monkeypatch):
    models = tmp_path / "models"
    models.mkdir()
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("TRACTUS_MODELS_DIR", str(models))
    monkeypatch.setenv("TRACTUS_DIAR_BIN", str(tmp_path / "no-diar"))
    monkeypatch.setenv("TRACTUS_REC_BIN", str(tmp_path / "no-rec"))
    return models


def install(root: Path, model_id: str) -> None:
    """파일 목록대로 (희소 파일로) 설치된 것처럼 만든다."""
    m = reg.get(model_id)
    for rel, size in m.files.items():
        p = root / m.local_dir / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("wb") as f:
            f.truncate(size)


# ── 목록 ─────────────────────────────────────────────────────────────────────

def test_windows_list_is_vad_and_one_required_engine():
    w = {m.id: m for m in reg._windows_models()}
    assert list(w) == ["vad", "asr-std"]
    assert all(m.level == "required" and m.level_note is None and m.kind == "hf" for m in w.values())  # 엔진이 하나라 one_of가 아니다
    assert all(m.size_bytes == sum(m.files.values()) and len(m.revision) == 40 for m in w.values())
    assert (w["vad"].repo, w["vad"].revision, w["vad"].files) == ("istupakov/silero-vad-onnx", "b3e3ee3cce4c11ceb63b1a0b229d916069c1ddf6", {vad_onnx.MARKER: 1289603})
    asr = w["asr-std"]
    assert (asr.repo, asr.revision, asr.engine) == ("voyagar/Qwen3-ASR-1.7B-onnx-int8", "550f7a719e1e60fa813c5681193ffa8fb478a924", "qwen3")
    assert asr.size_bytes == 4_382_377_900 and asr_onnx.MARKER in asr.files and "model.safetensors" not in asr.files  # 2.1절 첫 표 (허브 API로 대조)
    assert "0.6B" not in asr.purpose and "실시간" not in asr.purpose and "메모리" in asr.purpose
    assert reg.ONNX_REPOS == {asr.repo}
    assert not {m.local_dir for m in w.values()} & {m.local_dir for m in reg._mac_models()}  # 같은 모델 폴더를 함께 써도 겹치지 않는다


def test_windows_capabilities_lock_mlx_features_with_platform_first(windows):
    assert reg._capabilities(reg.MODELS)[1].models == (("vad",), ("asr-std",))
    for memory in (8 * GB, 32 * GB):
        caps = {c["id"]: c for c in reg.capability_status({m.id: "missing" for m in reg.MODELS}, {}, memory)}
        for cid in LOCKED:  # 받을 수 없으니 memory·도구·모델을 더하지 않는다
            assert caps[cid]["missing"] == ["platform"] and caps[cid]["hint"] == reg.PLATFORM_LOCKED and not caps[cid]["ready"], cid
        assert caps["convert"]["missing"] == ["vad", "asr-std", "ffmpeg"]
        assert caps["record"]["missing"] == ["recorder"]
    assert reg.fix_command("platform") == reg.PLATFORM_LOCKED
    assert reg.get("vad").needed_by == ("convert",) and reg.get("asr-std").needed_by == ("convert",)  # 잠긴 live는 세지 않는다


def test_windows_recommends_the_only_engine(windows, root):
    assert reg.preferred_asr(8 * GB) == reg.preferred_asr(32 * GB) == "asr-std"
    assert reg.preset_ids("required", 8 * GB) == reg.preset_ids("standard") == reg.preset_ids("all", helper=True) == ["vad", "asr-std"]
    with pytest.raises(ValueError):
        reg.preset_ids("lite")
    with pytest.raises(ValueError):
        reg.resolve_ids([], "lite")
    assert reg.pick_asr(root, 8 * GB) is None
    install(root, "asr-std")
    assert reg.pick_asr(root, 8 * GB) == "asr-std" and doctor.effective_track(root, 8 * GB) == "standard"
    assert engines.recommended_track() is engines.Track.standard


def test_onnx_folder_with_only_config_is_not_usable(windows, root):
    d = root / reg.get("asr-std").local_dir
    d.mkdir()
    (d / "config.json").write_text("{}")  # 디코더 가중치가 빠진 ONNX 폴더: ORT 세션 오류가 아니라 model_missing이어야 한다
    assert not reg.usable("asr-std", root)
    with pytest.raises(typer.BadParameter):
        engines.local_model(engines.MODELS[engines.Track.standard])
    install(root, "asr-std")
    assert reg.usable("asr-std", root)


def test_custom_engines_are_off_on_windows(windows, root):
    (root / reg.CUSTOM_FILE).write_text(json.dumps({"models": [{"id": "custom-x", "repo": "a/x", "revision": "r", "engine": "whisper", "files": {"config.json": 1}}]}))
    assert reg.custom_models(root) == () and reg.asr_ids(root) == ["asr-std"]
    r = CliRunner().invoke(cli.app, ["models", "add", "mlx-community/whisper-large-v3-turbo"])
    assert r.exit_code == 2 and "Windows 미리보기" in r.output


def test_prune_keeps_the_other_platforms_folders(root, monkeypatch):
    for m in (*reg._mac_models(), *reg._windows_models()):
        if m.kind == "hf":
            (root / m.local_dir).mkdir(exist_ok=True)
            (root / m.local_dir / "config.json").write_text("{}")
    old = root / "qwen3-embedding-0.6b"
    old.mkdir()
    (old / "model.safetensors").write_bytes(b"x")
    assert [u["name"] for u in inst.unregistered(root)] == ["qwen3-embedding-0.6b"]  # Mac 목록
    use_models(monkeypatch, reg._windows_models())
    assert [u["name"] for u in inst.unregistered(root)] == ["qwen3-embedding-0.6b"]  # Windows 목록도 Mac 폴더를 지우지 않는다


def test_windows_models_list_has_the_same_keys(windows, root):
    install(root, "vad")
    d = json.loads(CliRunner().invoke(cli.app, ["models", "list", "--json"]).stdout)
    by = {m["id"]: m for m in d["models"]}
    assert list(by) == ["vad", "asr-std"] and by["vad"]["state"] == "installed" and by["asr-std"]["level_note"] is None
    assert set(by["vad"]) == {"id", "name", "purpose", "level", "size_bytes", "installed", "installed_bytes", "state", "needed_by", "group", "path", "level_note",
                              "model_name", "publisher", "converted_by", "source", "revision", "license", "languages", "params", "engine", "custom"}
    r = CliRunner().invoke(cli.app, ["models", "download", "--preset", "lite", "--progress-json"])
    assert r.exit_code == 2 and events(r.stdout)[-1]["code"] == "bad_argument"


# ── import·CLI ───────────────────────────────────────────────────────────────

def test_cli_imports_with_the_windows_list():
    """Windows 목록에는 asr-lite가 없다: engines가 import 때 KeyError로 죽으면 tractus 명령 전체가 시작하지 못한다 (3.5절)."""
    code = ("import json, tractus.platform_compat as pc; pc.WINDOWS = True\n"
            "import tractus.cli\nfrom tractus.commands import engines\nfrom tractus import models_registry as r\n"
            "print(json.dumps([[m.id for m in r.MODELS], sorted(t.value for t in engines.MODELS), engines.VAD_MODEL, r.CUSTOM_SUPPORTED]))")
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    assert json.loads(out.stdout) == [["vad", "asr-std"], ["standard"], "istupakov/silero-vad-onnx", False]


@pytest.fixture
def win_env(env, monkeypatch):
    """test_cli의 env(가짜 VAD, 실제 FFmpeg)에 Windows 목록과 그 모델 파일을 얹는다."""
    home, wav = env
    use_models(monkeypatch, reg._windows_models())
    for mid in ("vad", "asr-std"):
        install(home / "models", mid)
    return home, wav


def test_transcribe_on_windows_skips_locked_steps_with_one_warning(win_env, fake_asr):
    home, wav = win_env
    r = CliRunner().invoke(cli.app, ["transcribe", str(wav), "--progress-json"])  # 기본값: 화자 분리·단어 싱크를 켠 채
    assert r.exit_code == 0, r.output
    ev = events(r.stdout)
    warnings = [e for e in ev if e["event"] == "warning"]
    assert [w["code"] for w in warnings] == ["platform"] and "참석자 구분과 단어 싱크를" in warnings[0]["message"].replace("을(를)", "를")
    assert not {"diarize", "align", "voices"} & {e["stage"] for e in ev if e["event"] == "stage"}
    (d,) = (home / "meetings").iterdir()
    t = store.read_transcript(d)
    assert t["asr"]["model"] == "voyagar/Qwen3-ASR-1.7B-onnx-int8" and t["asr"]["runtime"] == "onnxruntime" and t["asr"]["track"] == "standard"
    assert t["diarization"] is None and all(s["speaker"] is None and s["words"] is None for s in t["segments"])


def test_transcribe_without_locked_steps_has_no_warning(win_env, fake_asr):
    _, wav = win_env
    r = CliRunner().invoke(cli.app, ["transcribe", str(wav), "--no-diarize", "--no-align", "--progress-json"])
    assert r.exit_code == 0 and not [e for e in events(r.stdout) if e["event"] == "warning"]


def test_track_lite_is_refused_on_windows(win_env, fake_asr):
    _, wav = win_env
    r = CliRunner().invoke(cli.app, ["transcribe", str(wav), "--track", "lite", "--progress-json"])
    assert r.exit_code == 2 and events(r.stdout)[-1]["code"] == "unsupported_platform" and not fake_asr.calls


@pytest.mark.parametrize("args", [["align", "x"], ["voices", "enroll", "x", "S1", "--name", "a", "--consent"], ["voices", "match", "x"],
                                  ["live", "--recording", "."]])
def test_locked_commands_fail_with_platform_code(win_env, args):
    r = CliRunner().invoke(cli.app, args)
    assert r.exit_code == 2 and reg.PLATFORM_LOCKED in r.output


def test_require_registered_emits_the_platform_code(windows, monkeypatch):
    seen = []
    monkeypatch.setattr(common, "emit_error", lambda message, code=None: seen.append(code))
    with pytest.raises(typer.Exit) as e:
        common.require_registered("aligner")
    assert e.value.exit_code == 2 and seen == ["platform"]
    common.require_registered("asr-std")


def test_runtime_follows_the_repo():
    assert store._runtime("voyagar/Qwen3-ASR-1.7B-onnx-int8") == "onnxruntime"
    assert store._runtime("mlx-community/Qwen3-ASR-1.7B-8bit") == "mlx-audio" and store._runtime("custom/x") == "mlx-audio"


@pytest.mark.parametrize("path", ["into", "append"])
def test_runtime_is_written_by_into_and_append_too(win_env, fake_asr, tmp_path, path):
    """새 노트 말고 build_transcript를 부르는 두 경로(deferred.finish_convert, attach.finish_append)도 같은 runtime을 쓴다."""
    home, wav = win_env
    if path == "into":
        d, note = saved(tmp_path)
        r = convert(note["meeting_id"], "--no-diarize", "--no-align")
    else:
        d, note = make_text_note(home)
        r = append(note["meeting_id"], wav, "--no-diarize", "--no-align")
    assert r.exit_code == 0, r.output
    assert store.read_transcript(d)["asr"]["runtime"] == "onnxruntime"


# ── macOS 목록 고정 (0.5.9와 같다) ──────────────────────────────────────────

def test_mac_list_results_are_unchanged(root, monkeypatch):
    use_models(monkeypatch, reg._mac_models())
    assert [m.id for m in reg.MODELS] == ["vad", "asr-std", "asr-lite", "asr-ko-mix", "asr-ko-univa", "diarizer", "aligner", "embedding", "voices", "fluid"]
    assert (reg.preferred_asr(8 * GB), reg.preferred_asr(16 * GB)) == ("asr-lite", "asr-std")
    assert reg.preset_ids("required", 8 * GB) == ["vad", "asr-lite"] and reg.preset_ids("lite") == ["vad", "asr-lite", "diarizer"]
    assert reg.CUSTOM_SUPPORTED and set(engines.TRACK_MODEL) == {engines.Track.standard, engines.Track.lite}
    assert reg.get("asr-lite").needed_by == ("convert", "live") and reg.get("vad").needed_by == ("convert", "live")
    caps = {c["id"]: c for c in reg.capability_status({m.id: "missing" for m in reg.MODELS}, {}, 8 * GB)}
    assert "platform" not in {i for c in caps.values() for i in c["missing"]}
    assert caps["live"]["missing"] == ["vad", "asr-lite", "recorder", "memory"]
    monkeypatch.setattr(reg, "physical_memory", lambda: 8 * GB)
    assert engines.recommended_track() is engines.Track.lite


@pytest.mark.parametrize("args,want", [([], "Speaker detection and word sync aren’t available"), (["--no-align"], "Speaker detection isn’t available"),
                                       (["--no-diarize"], "Word sync isn’t available")])
def test_platform_warning_names_only_the_skipped_steps_in_english(win_env, fake_asr, monkeypatch, args, want):
    """경고는 앱이 고정 문장 없이 그대로 보이므로(WORDS §4.7) 건너뛴 단계만 이름을 들고, 영어는 수에 맞춘다."""
    monkeypatch.setenv("TRACTUS_LANG", "en")
    _, wav = win_env
    r = CliRunner().invoke(cli.app, ["transcribe", str(wav), *args, "--progress-json"])
    (w,) = [e for e in events(r.stdout) if e["event"] == "warning"]
    assert w["code"] == "platform" and w["message"].startswith(want)
