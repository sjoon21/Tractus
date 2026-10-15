"""모델 폴더 위치 규칙(paths.models_dir)과 `tractus models move` (docs/distribution P5). 실제 모델 없이 가짜 폴더로 확인한다."""

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from tractus import cli, paths
from tractus import models_install as inst
from tractus import models_registry as reg

APP = "Library/Application Support/dev.tractus.app/models"


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)  # 저장소 루트의 .env를 읽지 않게
    monkeypatch.setenv("HOME", str(tmp_path / "h"))
    monkeypatch.setenv("TRACTUS_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("TRACTUS_MODELS_DIR", raising=False)
    return tmp_path


def fake_install(root, model_id):
    m = reg.get(model_id)
    for rel, size in m.files.items():
        p = root / m.local_dir / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"x" * min(size, 8))


def test_models_dir_order_env_then_legacy_with_a_registered_model_then_app_folder(env, monkeypatch):
    legacy = env / "home" / "models"
    monkeypatch.undo()  # conftest의 임시 위치를 풀고 실제 규칙(HOME 아래 앱 설정 폴더)을 본다. 아래에서 HOME을 다시 임시로 돌린다
    monkeypatch.chdir(env)
    monkeypatch.setenv("HOME", str(env / "h"))
    monkeypatch.setenv("TRACTUS_HOME", str(env / "home"))
    monkeypatch.delenv("TRACTUS_MODELS_DIR", raising=False)
    assert paths.models_dir() == env / "h" / APP  # 새 설치: 앱 설정 폴더
    (legacy / "not-a-model").mkdir(parents=True)  # 등록되지 않은 폴더만 있으면 옛 위치로 보지 않는다
    assert paths.models_dir() == env / "h" / APP
    fake_install(legacy, "vad")  # 이미 모델이 있는 사용자는 그대로
    assert paths.models_dir() == legacy
    monkeypatch.setenv("TRACTUS_MODELS_DIR", str(env / "custom"))  # 환경변수가 먼저
    assert paths.models_dir() == env / "custom"


def test_move_moves_only_registered_models_and_reports_json(env):
    src, dest = env / "src", env / "dest"
    fake_install(src, "vad")
    fake_install(src, "aligner")
    (src / "stray").mkdir()
    (src / "stray" / "keep.txt").write_text("남겨 둔다")
    out = inst.move(src, dest)
    assert sorted(out["moved"]) == ["aligner", "vad"] and out["freed_bytes"] == 0  # 같은 볼륨: 이름만 바꾼다
    assert reg.inspect("vad", dest).state != "missing" and not (src / reg.get("vad").local_dir).exists()
    assert (src / "stray" / "keep.txt").read_text() == "남겨 둔다" and not (dest / "stray").exists()


def test_move_refuses_when_busy_exists_or_nested(env):
    src, dest = env / "src", env / "dest"
    fake_install(src, "vad")
    with inst.download_lock(src), pytest.raises(inst.ModelError) as busy:
        inst.move(src, dest)
    assert busy.value.code == "busy" and (src / reg.get("vad").local_dir).exists()
    fake_install(dest, "vad")
    with pytest.raises(inst.ModelError) as clash:
        inst.move(src, dest)
    assert clash.value.code == "exists" and (src / reg.get("vad").local_dir).exists()
    with pytest.raises(inst.ModelError) as nested:
        inst.move(src, src / "inner")
    assert nested.value.code == "bad_argument"
    assert inst.move(env / "empty", env / "elsewhere") == {"moved": [], "freed_bytes": 0}  # 옮길 것이 없으면 폴더도 만들지 않는다
    assert not (env / "empty").exists()


def test_cross_volume_move_keeps_the_copy_when_deleting_the_source_fails(env, monkeypatch):
    src, dest = env / "src", env / "dest"
    fake_install(src, "vad")
    old = (src / reg.get("vad").local_dir).resolve()
    monkeypatch.setattr(inst, "nearest_existing", lambda p: type("V", (), {"stat": lambda self: type("S", (), {"st_dev": -1})()})())  # 다른 볼륨인 척
    monkeypatch.setattr(inst, "disk_free", lambda p: 10**12)
    real = inst.shutil.rmtree

    def deny(path, *a, **k):
        if Path(path) == old:
            raise PermissionError("읽기 전용")
        return real(path, *a, **k)

    monkeypatch.setattr(inst.shutil, "rmtree", deny)
    out = inst.move(src, dest)
    assert out["moved"] == ["vad"] and out["leftover"] == [reg.get("vad").local_dir]
    assert reg.inspect("vad", dest).state != "missing" and old.exists()  # 복사본도 원본도 남는다


def test_move_cli_prints_json(env, monkeypatch):
    src = env / "src"
    fake_install(src, "vad")
    monkeypatch.setenv("TRACTUS_MODELS_DIR", str(src))
    r = CliRunner().invoke(cli.app, ["models", "move", str(env / "dest"), "--yes"])
    assert r.exit_code == 0 and json.loads(r.stdout) == {"moved": ["vad"], "freed_bytes": 0}
