"""Claude Code 플러그인 (plugins/tractus): MCP 실행기가 tractus·데이터 폴더를 찾는 순서와 매니페스트 모양."""

import json
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "plugins" / "tractus"
LAUNCHER = PLUGIN / "bin" / "tractus-mcp"
# 실행기는 /Applications의 앱을 ~/Applications보다 먼저 본다: 이 Mac에 앱이 깔려 있으면 그것을 찾으므로 그 경우를 시험할 수 없다 (CI 러너에는 없다)
no_system_app = pytest.mark.skipif(Path("/Applications/Tractus.app").exists(), reason="/Applications/Tractus.app이 있는 Mac")


def fake_tractus(path: Path) -> Path:
    """받은 인수와 환경을 stdout에 JSON 한 줄로 찍는 가짜 tractus."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('#!/bin/bash\nprintf \'{"args":"%s","home":"%s","models":"%s"}\\n\' "$*" "$TRACTUS_HOME" "${TRACTUS_MODELS_DIR:-}"\n')
    path.chmod(0o755)
    return path


def launch(home: Path, **env: str) -> subprocess.CompletedProcess:
    base = {"HOME": str(home), "PATH": "/usr/bin:/bin"}  # 이 Mac의 실제 앱·PATH를 보지 않게
    return subprocess.run([str(LAUNCHER)], env={**base, **env}, capture_output=True, text=True, timeout=10)


def test_launcher_uses_tractus_bin_and_default_home(tmp_path):
    bin_ = fake_tractus(tmp_path / "x" / "tractus")
    r = launch(tmp_path, TRACTUS_BIN=str(bin_))
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout) == {"args": "mcp", "home": f"{tmp_path}/Tractus", "models": ""}


def test_launcher_reads_the_app_settings(tmp_path):
    bin_ = fake_tractus(tmp_path / "repo" / ".venv" / "bin" / "tractus")
    conf = tmp_path / "Library" / "Application Support" / "dev.tractus.app" / "settings.json"
    conf.parent.mkdir(parents=True)
    conf.write_text(json.dumps({"tractus_bin": str(bin_), "home": "~/Notes", "models_dir": "~/Models"}))
    out = json.loads(launch(tmp_path).stdout)
    assert out == {"args": "mcp", "home": f"{tmp_path}/Notes", "models": f"{tmp_path}/Models"}
    # 환경변수가 앱 설정보다 이긴다
    out = json.loads(launch(tmp_path, TRACTUS_HOME=str(tmp_path / "Other")).stdout)
    assert out["home"] == str(tmp_path / "Other")


@no_system_app
def test_launcher_finds_the_prebuilt_app_in_home_applications(tmp_path):
    fake_tractus(tmp_path / "Applications" / "Tractus.app" / "Contents" / "Resources" / "runtime" / "bin" / "tractus")
    assert json.loads(launch(tmp_path).stdout)["args"] == "mcp"


@no_system_app
def test_launcher_without_tractus_says_how_to_install_and_keeps_stdout_clean(tmp_path):
    r = launch(tmp_path)
    assert r.returncode == 1 and r.stdout == ""  # MCP의 stdout을 더럽히지 않는다
    assert "releases" in r.stderr and "TRACTUS_BIN" in r.stderr


def test_empty_or_unexpanded_plugin_settings_count_as_unset(tmp_path):
    bin_ = fake_tractus(tmp_path / "x" / "tractus")
    conf = tmp_path / "Library" / "Application Support" / "dev.tractus.app" / "settings.json"
    conf.parent.mkdir(parents=True)
    conf.write_text(json.dumps({"tractus_bin": str(bin_)}))
    out = json.loads(launch(tmp_path, TRACTUS_BIN="", TRACTUS_HOME="${user_config.tractus_home}").stdout)
    assert out["home"] == f"{tmp_path}/Tractus"  # 앱 설정의 tractus_bin을 찾고, 데이터 폴더는 기본값


def test_manifests_point_at_the_launcher_and_name_matches():
    manifest = json.loads((PLUGIN / ".claude-plugin" / "plugin.json").read_text())
    market = json.loads((ROOT / ".claude-plugin" / "marketplace.json").read_text())
    mcp = json.loads((PLUGIN / ".mcp.json").read_text())["mcpServers"]["tractus"]
    entry = next(p for p in market["plugins"] if p["name"] == manifest["name"])
    assert (ROOT / entry["source"]).resolve() == PLUGIN.resolve()
    assert mcp["command"] == "${CLAUDE_PLUGIN_ROOT}/bin/tractus-mcp" and LAUNCHER.stat().st_mode & 0o111
    assert set(manifest["userConfig"]) == {"tractus_bin", "tractus_home"}


def test_both_skills_are_in_the_repo():
    # .gitignore의 meetings/ 규칙이 skills/meetings를 삼킨 적이 있다: CI(깨끗한 체크아웃)에서는 커밋된 파일만 있다
    for name in ("meetings", "recap"):
        text = (PLUGIN / "skills" / name / "SKILL.md").read_text(encoding="utf-8")
        assert text.startswith("---\n") and f"name: {name}" in text and "description:" in text


def test_launcher_starts_the_server_in_the_data_folder_not_the_project(tmp_path):
    # 남의 저장소 폴더에서 띄워도 그 .env를 읽지 않게 데이터 폴더에서 실행한다
    bin_ = tmp_path / "x" / "tractus"
    bin_.parent.mkdir(parents=True)
    bin_.write_text('#!/bin/bash\npwd -P\n')
    bin_.chmod(0o755)
    data = tmp_path / "Notes"
    data.mkdir()
    project = tmp_path / "evil-repo"
    project.mkdir()
    r = subprocess.run([str(LAUNCHER)], cwd=project, env={"HOME": str(tmp_path), "PATH": "/usr/bin:/bin", "TRACTUS_BIN": str(bin_), "TRACTUS_HOME": str(data)}, capture_output=True, text=True, timeout=10)
    assert r.stdout.strip() == str(data.resolve())
