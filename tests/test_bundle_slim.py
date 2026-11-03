"""미리 만든 앱 줄이기 (scripts/bundle_slim.py): 목록에 없는 하위 패키지만 지우고, 목록에 있는 모듈만 바이트코드를 만든다."""

import importlib.util
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("bundle_slim", REPO / "scripts" / "bundle_slim.py")
slim = importlib.util.module_from_spec(spec)
spec.loader.exec_module(slim)


def pkg(root: Path, dotted: str) -> None:
    d = root.joinpath(*dotted.split("."))
    d.mkdir(parents=True, exist_ok=True)
    (d / "__init__.py").write_text("X = 1\n")


def test_prune_removes_only_unlisted_subpackages_of_prune_roots(tmp_path):
    for m in ("transformers.models.whisper", "transformers.models.albert", "transformers.models.auto", "mlx_audio.tts", "mlx_audio.stt", "rich.markup"):
        pkg(tmp_path, m)
    (tmp_path / "transformers" / "models" / "helper.py").write_text("")
    used = {"transformers", "transformers.models", "transformers.models.whisper.processing_whisper", "transformers.models.auto", "mlx_audio.stt", "tractus.cli"}
    removed = slim.prune(tmp_path, used)
    assert sorted(removed) == ["mlx_audio.tts", "transformers.models.albert"]
    assert (tmp_path / "transformers/models/whisper").is_dir() and (tmp_path / "transformers/models/helper.py").is_file()
    assert (tmp_path / "rich/markup").is_dir()  # PRUNE 밖은 건드리지 않는다


def test_compile_used_makes_bytecode_only_for_listed_modules(tmp_path):
    pkg(tmp_path, "a")
    (tmp_path / "a" / "used.py").write_text("Y = 2\n")
    (tmp_path / "a" / "unused.py").write_text("Z = 3\n")
    assert slim.compile_used(tmp_path, {"a", "a.used", "not.there"}) == 2
    cache = {p.name.split(".")[0] for p in (tmp_path / "a" / "__pycache__").iterdir()}
    assert cache == {"__init__", "used"}


def test_committed_module_list_covers_the_cli():
    names = (REPO / "scripts" / "bundle_modules.txt").read_text(encoding="utf-8").split()
    assert "tractus.cli" in names and "tractus.mcp_server" in names and any(n.startswith("transformers.models.") for n in names)


def test_patch_stt_init_keeps_only_our_families(tmp_path):
    init = tmp_path / slim.STT_INIT
    init.parent.mkdir(parents=True)
    init.write_text("from . import (\n    cohere_asr,\n    qwen3_asr,\n    sensevoice,\n    voxtral,\n    whisper,\n)\n")
    assert slim.patch_stt_init(tmp_path, slim.stt_families()) == ["qwen3_asr", "sensevoice", "whisper"]
    assert init.read_text().splitlines()[-1] == "from . import qwen3_asr, sensevoice, whisper"


def test_patch_stt_init_stops_when_the_file_changed(tmp_path):
    import pytest

    init = tmp_path / slim.STT_INIT
    init.parent.mkdir(parents=True)
    init.write_text("from .registry import load_all\nload_all()\n")
    with pytest.raises(SystemExit):
        slim.patch_stt_init(tmp_path, slim.stt_families())


def test_every_first_party_module_the_cli_imports_is_in_the_bundle_list():
    """미리 만든 앱은 목록에 있는 모듈만 바이트코드를 만든다. 서명된 앱은 실행 중에 쓸 수 없어서, 목록에 없는 tractus 모듈은 실행할 때마다 다시 컴파일된다.
    모듈을 더하거나 옮기면 scripts/bundle_modules.txt에 더한다(전체 추적은 `uv run python scripts/bundle_trace.py`, 첫 파티만이면 이 테스트가 알려 준다)."""
    import json
    import os
    import subprocess
    import sys

    code = "import sys, json; import tractus.cli, tractus.mcp_server; print(json.dumps(sorted(m for m in sys.modules if m == 'tractus' or m.startswith('tractus.'))))"
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True, env={**os.environ, "PYTHONPATH": str(REPO / "src")}).stdout
    imported = set(json.loads(out))
    listed = {line.strip() for line in (REPO / "scripts" / "bundle_modules.txt").read_text().splitlines() if line.strip()}
    assert sorted(imported - listed) == []
