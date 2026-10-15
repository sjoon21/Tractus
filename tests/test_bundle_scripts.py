"""scripts/build_app_bundle.sh·make_dmg.sh의 인수 처리와 DMG 포장을 아주 작은 가짜 앱으로 확인한다 (실제 앱 빌드는 오래 걸려 하지 않는다)."""

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"

pytestmark = pytest.mark.skipif(sys.platform != "darwin", reason="hdiutil·codesign은 macOS에만 있다")


def run(script: str, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([str(SCRIPTS / script), *args], capture_output=True, text=True)


def test_scripts_reject_unknown_options_and_print_usage():
    for script in ("build_app_bundle.sh", "make_dmg.sh"):
        assert run(script, "--help").returncode == 0
        bad = run(script, "--nope")
        assert bad.returncode == 2 and "사용법" in bad.stderr


def test_make_dmg_refuses_a_folder_that_is_not_an_app(tmp_path):
    r = run("make_dmg.sh", str(tmp_path), "--out", str(tmp_path / "out"))
    assert r.returncode == 1 and "Tractus.app 이 아닙니다" in r.stderr


def test_make_dmg_packs_a_signed_app_and_names_the_file_by_version(tmp_path):
    app = tmp_path / "Tractus.app"
    (app / "Contents/MacOS").mkdir(parents=True)
    shutil.copy("/usr/bin/true", app / "Contents/MacOS/true")
    (app / "Contents/Info.plist").write_text(
        '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>true</string>'
        "<key>CFBundleIdentifier</key><string>dev.tractus.test</string></dict></plist>"
    )
    subprocess.run(["codesign", "--force", "--sign", "-", str(app)], check=True, capture_output=True)
    r = run("make_dmg.sh", str(app), "--version", "9.9", "--out", str(tmp_path / "out"))
    assert r.returncode == 0, r.stderr
    assert (tmp_path / "out" / "Tractus-9.9-arm64.dmg").stat().st_size > 0
    # 서명이 깨진 앱은 포장하지 않는다
    (app / "Contents/Info.plist").write_text("changed")
    assert run("make_dmg.sh", str(app), "--out", str(tmp_path / "out2")).returncode == 1
