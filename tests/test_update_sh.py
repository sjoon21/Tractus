"""scripts/update.sh의 git 논리를 임시 저장소(로컬 bare 원격)로 확인한다. install.sh는 받은 인수를 기록만 하는 가짜로 바꾼다."""

import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "update.sh"
STUB_INSTALL = '#!/usr/bin/env bash\necho "$@" >> "$(dirname "$0")/../install.calls"\n'


def git(cwd: Path, *args: str) -> str:
    env = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t", "PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"}
    return subprocess.run(["git", *args], cwd=cwd, env=env, check=True, capture_output=True, text=True).stdout


def commit(repo: Path, name: str, text: str = "x") -> None:
    (repo / name).write_text(text)
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", f"change {name}")


@pytest.fixture
def repos(tmp_path):
    """(user, dev): 같은 원격을 쓰는 두 복제본. user는 update.sh가 든 저장소다."""
    git(tmp_path, "init", "-q", "--bare", "-b", "main", "remote.git")
    dev = tmp_path / "dev"
    git(tmp_path, "clone", "-q", "remote.git", "dev")
    (dev / "scripts").mkdir()
    shutil.copy(SCRIPT, dev / "scripts/update.sh")
    (dev / "scripts/install.sh").write_text(STUB_INSTALL)
    (dev / "scripts/install.sh").chmod(0o755)
    (dev / ".gitignore").write_text("install.calls\n")
    git(dev, "add", "-A")
    git(dev, "update-index", "--chmod=+x", "scripts/update.sh", "scripts/install.sh")
    git(dev, "commit", "-qm", "init")
    git(dev, "push", "-q", "origin", "main")
    git(tmp_path, "clone", "-q", "remote.git", "user")
    return tmp_path / "user", dev


def update(user: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", str(user / "scripts/update.sh"), *args], capture_output=True, text=True)


def push_two(dev: Path) -> None:
    commit(dev, "a.txt")
    commit(dev, "b.txt")
    git(dev, "push", "-q", "origin", "main")


def test_up_to_date_does_nothing_and_check_only_fetches(repos):
    user, dev = repos
    r = update(user)
    assert r.returncode == 0 and "이미 최신" in r.stdout and not (user / "install.calls").exists()
    push_two(dev)
    head = git(user, "rev-parse", "HEAD")
    r = update(user, "--check")
    assert r.returncode == 0 and "받을 커밋 2개" in r.stdout and "change a.txt" in r.stdout and "change b.txt" in r.stdout
    assert git(user, "rev-parse", "HEAD") == head and not (user / "install.calls").exists()  # 확인만: HEAD도 설치도 그대로


def test_update_pulls_shows_log_passes_args_to_install_and_is_idempotent(repos):
    user, dev = repos
    push_two(dev)
    r = update(user, "--models", "lite", "--with-fluid")
    assert r.returncode == 0 and "change a.txt" in r.stdout and (user / "a.txt").exists()
    assert (user / "install.calls").read_text().strip() == "--models lite --with-fluid"
    assert git(user, "rev-parse", "HEAD") == git(dev, "rev-parse", "HEAD")
    again = update(user)
    assert again.returncode == 0 and "이미 최신" in again.stdout and (user / "install.calls").read_text().count("\n") == 1


@pytest.mark.parametrize("breakage", ["dirty", "no_upstream", "detached", "diverged"])
def test_refuses_without_touching_anything(repos, breakage):
    user, dev = repos
    push_two(dev)
    head = git(user, "rev-parse", "HEAD")
    if breakage == "dirty":
        (user / "scripts/install.sh").write_text(STUB_INSTALL + "# edit\n")
    elif breakage == "no_upstream":
        git(user, "branch", "--unset-upstream")
    elif breakage == "detached":
        git(user, "checkout", "-q", "--detach")
    else:
        commit(user, "mine.txt")
        head = git(user, "rev-parse", "HEAD")
    r = update(user)
    assert r.returncode == 1 and r.stderr.strip() and not (user / "install.calls").exists()
    assert git(user, "rev-parse", "HEAD") == head and not (user / "a.txt").exists()


def test_untracked_files_do_not_block(repos):
    user, dev = repos
    (user / "notes.tmp").write_text("scratch")
    push_two(dev)
    assert update(user).returncode == 0 and (user / "a.txt").exists()
