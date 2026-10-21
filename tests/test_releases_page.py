"""릴리스 노트 파일(docs/releases) 읽기와 release.sh용 글 꺼내기 (scripts/releases_page.py)."""

import importlib.util
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("releases_page", REPO / "scripts" / "releases_page.py")
rp = importlib.util.module_from_spec(spec)
sys.modules["releases_page"] = rp  # dataclass가 모듈을 찾는다
spec.loader.exec_module(rp)

NOTE = """---
version: 1.2.3
date: 2026-10-21
summary: 한 줄 요약.
summary_en: One-line summary.
---
# Tractus v1.2.3

소개 문장. (English below)

## 새로 생긴 것

- 하나

---

## English

- one
"""


def test_every_release_note_in_the_repo_parses():
    files = sorted((REPO / "docs" / "releases").glob("v*.md"))
    assert files
    for f in files:
        r = rp.parse(f)
        assert f.name == f"v{r.version}.md"
        assert r.summary["ko"] and r.summary["en"]


def test_parse_splits_languages_and_drops_the_title(tmp_path):
    p = tmp_path / "v1.2.3.md"
    p.write_text(NOTE, encoding="utf-8")
    r = rp.parse(p)
    assert r.version == "1.2.3" and not r.ko_only
    assert r.body["ko"].startswith("소개 문장.") and "English below" not in r.body["ko"] and "one" not in r.body["ko"]
    assert r.body["en"] == "- one"


def test_korean_only_note_reuses_korean_body(tmp_path):
    p = tmp_path / "v1.0.0.md"
    p.write_text(NOTE.split("\n---\n\n## English")[0].replace("1.2.3", "1.0.0"), encoding="utf-8")
    r = rp.parse(p)
    assert r.ko_only and r.body["en"] == r.body["ko"]


@pytest.mark.parametrize("broken", ["# no front matter\n", NOTE.replace("summary_en: One-line summary.\n", ""), NOTE.replace("1.2.3\n", "1.2\n", 1)])
def test_broken_notes_stop_instead_of_making_empty_pages(tmp_path, broken):
    p = tmp_path / "v1.2.3.md"
    p.write_text(broken, encoding="utf-8")
    with pytest.raises(SystemExit):
        rp.parse(p)


def test_release_texts_give_short_app_notes_and_a_linked_body(tmp_path):
    p = tmp_path / "v1.2.3.md"
    p.write_text(NOTE, encoding="utf-8")
    rp.release_texts(p, tmp_path)
    lines = (tmp_path / "notes.txt").read_text(encoding="utf-8").splitlines()
    assert lines == ["한 줄 요약.", "One-line summary.", "https://sjoon21.github.io/Tractus/ko/releases/v1.2.3/"]  # 앱은 앞 3줄을 보인다
    body = (tmp_path / "body.md").read_text(encoding="utf-8")
    assert body.startswith("> 웹에서 보기") and "releases/v1.2.3/" in body and "version:" not in body
