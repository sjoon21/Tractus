"""릴리스 노트 페이지: docs/releases/v*.md → <사이트>/releases/ (영어)·<사이트>/ko/releases/ (한국어).

버전마다 한 페이지(앱의 업데이트 칸이 `releases/v<버전>/`을 연다)와, 최신순 목록 한 페이지를 만든다.
파일 모양: 앞머리(version·date·summary·summary_en) + 한국어 본문 + (선택) `---` 뒤 `## English` 본문.
영어 본문이 없는 옛 버전은 영어 페이지에 한국어 본문을 싣는다. sitemap.xml에 페이지를 더한다.
실행: scripts/site.sh가 부른다 (uv run --no-project --with markdown-it-py python scripts/releases_page.py <사이트>).
release.sh는 `--release-texts`로 앱 업데이트 칸에 보일 짧은 글과 GitHub 릴리스 본문을 꺼낸다(표준 라이브러리만).
"""

from __future__ import annotations

import html
import re
import sys
from dataclasses import dataclass
from pathlib import Path

SITE = "https://sjoon21.github.io/Tractus/"
EN_SPLIT = re.compile(r"\n---\n+## English\n", re.M)

TEXT = {
    "en": {
        "title": "Release notes",
        "lead": "What changed in each version of Tractus. Update from Settings › Updates in the app.",
        "home": "Home", "features": "Features", "bench": "Benchmark", "releases": "Releases", "other": "한국어",
        "all": "← All releases", "download": "Download", "ko_only": "This release note is only in Korean.",
        "github": "GitHub release",
    },
    "ko": {
        "title": "릴리스 노트",
        "lead": "Tractus 버전마다 바뀐 것입니다. 앱의 설정 › 업데이트에서 새 버전으로 바꿉니다.",
        "home": "홈", "features": "기능", "bench": "벤치마크", "releases": "릴리스 노트", "other": "English",
        "all": "← 전체 릴리스", "download": "내려받기", "ko_only": "",
        "github": "GitHub 릴리스",
    },
}


@dataclass(frozen=True)
class Release:
    version: str
    date: str
    summary: dict[str, str]
    body: dict[str, str]  # 언어 → Markdown (제목 줄 뺌)
    ko_only: bool

    @property
    def key(self) -> tuple[int, ...]:
        return tuple(int(x) for x in self.version.split("."))


def parse(path: Path) -> Release:
    """앞머리를 읽고 본문을 한국어·영어로 나눈다. 앞머리 키가 빠지면 멈춘다(조용히 빈 페이지를 내지 않게)"""
    text = path.read_text(encoding="utf-8")
    m = re.match(r"---\n(.*?)\n---\n(.*)", text, re.S)
    if not m:
        raise SystemExit(f"{path}: 앞머리(---)가 없습니다")
    meta = dict(line.split(": ", 1) for line in m.group(1).splitlines() if ": " in line)
    missing = {"version", "date", "summary", "summary_en"} - meta.keys()
    if missing:
        raise SystemExit(f"{path}: 앞머리에 {sorted(missing)}가 없습니다")
    if not re.fullmatch(r"\d+\.\d+\.\d+", meta["version"]):
        raise SystemExit(f"{path}: 버전 모양이 아닙니다: {meta['version']}")
    parts = EN_SPLIT.split(m.group(2), maxsplit=1)
    strip = lambda s: re.sub(r"\A\s*# .*\n", "", s).strip()  # noqa: E731 — 페이지가 제목을 따로 그린다
    ko = strip(parts[0]).replace(" (English below)", "")  # 한국어 페이지에는 영어가 없다
    en = strip(parts[1]) if len(parts) > 1 else ko
    return Release(meta["version"], meta["date"], {"ko": meta["summary"], "en": meta["summary_en"]}, {"ko": ko, "en": en}, len(parts) == 1)


def page(lang: str, depth: int, path: str, title: str, description: str, main: str) -> str:
    """사이트의 다른 페이지(benchmark)와 같은 머리·꼬리. depth = 사이트 뿌리까지 올라갈 단계 수"""
    T = TEXT[lang]
    up = "../" * depth
    root = up if lang == "en" else "../" * (depth - 1)  # 한국어 페이지는 ko/ 아래라 홈이 한 단계 위
    en_url, ko_url = f"{SITE}{path}", f"{SITE}ko/{path}"
    other = f"{up}ko/{path}" if lang == "en" else f"{up}{path}"
    other_lang = "ko" if lang == "en" else "en"
    e = html.escape
    return f"""<!doctype html>
<html lang="{lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)} — Tractus</title>
<meta name="description" content="{e(description)}">
<link rel="canonical" href="{en_url if lang == 'en' else ko_url}">
<link rel="alternate" hreflang="en" href="{en_url}">
<link rel="alternate" hreflang="ko" href="{ko_url}">
<link rel="alternate" hreflang="x-default" href="{en_url}">
<meta property="og:type" content="article">
<meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(description)}">
<meta property="og:url" content="{en_url if lang == 'en' else ko_url}">
<meta property="og:image" content="{SITE}assets/og.png">
<link rel="icon" href="{up}assets/icon.png">
<link rel="stylesheet" href="{up}style.css">
</head>
<body>
<header class="wrap top">
  <a class="brand" href="{root}"><img src="{up}assets/icon.png" alt="" width="28" height="28">Tractus</a>
  <nav aria-label="Main">
    <a href="{root}#features">{T['features']}</a>
    <a href="{root}benchmark/">{T['bench']}</a>
    <a href="{root}releases/" aria-current="page">{T['releases']}</a>
    <a href="https://github.com/sjoon21/Tractus">GitHub</a>
    <a href="{other}" hreflang="{other_lang}" lang="{other_lang}">{T['other']}</a>
  </nav>
</header>
<main class="wrap">
<article class="article releases">
{main}
</article>
</main>
<footer>
  <div class="wrap">
    <span>Tractus · Apache 2.0</span>
    <a href="{root}">{T['home']}</a>
    <a href="https://github.com/sjoon21/Tractus/releases/latest">{T['download']}</a>
    <a href="{other}" hreflang="{other_lang}" lang="{other_lang}">{T['other']}</a>
  </div>
</footer>
</body>
</html>
"""


def write(out: Path, rel: str, text: str) -> None:
    p = out / rel / "index.html"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def build(src: Path, out: Path) -> list[str]:
    """페이지를 쓰고 sitemap에 넣을 경로(영어 기준, 뿌리 기준)를 돌려준다"""
    from markdown_it import MarkdownIt  # 페이지를 만들 때만 (release.sh의 글 꺼내기는 표준 라이브러리로 돈다)

    MD = MarkdownIt("commonmark", {"html": False}).enable("table")
    releases = sorted((parse(p) for p in src.glob("v*.md")), key=lambda r: r.key, reverse=True)
    if not releases:
        raise SystemExit(f"{src}: 릴리스 노트가 없습니다")
    e = html.escape
    paths = ["releases/"]
    for lang in ("en", "ko"):
        T = TEXT[lang]
        base = "" if lang == "en" else "ko/"
        items = "\n".join(
            f'  <li><a href="v{r.version}/"><b>Tractus {r.version}</b></a> <time datetime="{r.date}">{r.date}</time><p>{e(r.summary[lang])}</p></li>'
            for r in releases
        )
        index = f'  <h1>{T["title"]}</h1>\n  <p class="meta">{T["lead"]}</p>\n  <ol class="release-list">\n{items}\n  </ol>'
        write(out, f"{base}releases", page(lang, 1 if lang == "en" else 2, "releases/", T["title"], T["lead"], index))
        for r in releases:
            note = f'  <p class="tldr">{T["ko_only"]}</p>\n' if lang == "en" and r.ko_only else ""
            gh = f"https://github.com/sjoon21/Tractus/releases/tag/v{r.version}"
            main = (
                f'  <p class="meta"><a href="../">{T["all"]}</a></p>\n'
                f'  <h1>Tractus {r.version}</h1>\n'
                f'  <p class="meta"><time datetime="{r.date}">{r.date}</time> · <a href="{gh}">{T["github"]}</a></p>\n'
                f'  <p class="tldr">{e(r.summary[lang])}</p>\n{note}'
                f'{MD.render(r.body[lang])}'
            )
            write(out, f"{base}releases/v{r.version}", page(lang, 2 if lang == "en" else 3, f"releases/v{r.version}/", f"Tractus {r.version}", r.summary[lang], main))
            if lang == "en":
                paths.append(f"releases/v{r.version}/")
    return paths


def add_to_sitemap(out: Path, paths: list[str]) -> None:
    sm = out / "sitemap.xml"
    if not sm.exists():
        return
    urls = "".join(
        f'  <url>\n    <loc>{SITE}{pre}{p}</loc>\n'
        f'    <xhtml:link rel="alternate" hreflang="en" href="{SITE}{p}"/>\n'
        f'    <xhtml:link rel="alternate" hreflang="ko" href="{SITE}ko/{p}"/>\n  </url>\n'
        for p in paths
        for pre in ("", "ko/")
    )
    sm.write_text(sm.read_text(encoding="utf-8").replace("</urlset>", urls + "</urlset>"), encoding="utf-8")


def release_texts(path: Path, out: Path) -> None:
    """release.sh용: notes.txt(latest.json notes: 앱의 업데이트 칸이 앞 3줄을 보인다) + body.md(GitHub 릴리스 본문)"""
    r = parse(path)
    ko_url, en_url = f"{SITE}ko/releases/v{r.version}/", f"{SITE}releases/v{r.version}/"
    (out / "notes.txt").write_text(f"{r.summary['ko']}\n{r.summary['en']}\n{ko_url}\n", encoding="utf-8")
    body = re.match(r"---\n.*?\n---\n(.*)", path.read_text(encoding="utf-8"), re.S).group(1).strip()
    (out / "body.md").write_text(f"> 웹에서 보기 · View on the web: [한국어]({ko_url}) · [English]({en_url})\n\n{body}\n", encoding="utf-8")


if __name__ == "__main__":
    args = sys.argv[1:]
    if len(args) == 3 and args[0] == "--release-texts":
        release_texts(Path(args[1]), Path(args[2]))
    elif len(args) == 1:
        site = Path(args[0])
        repo = Path(__file__).resolve().parent.parent
        add_to_sitemap(site, build(repo / "docs" / "releases", site))
    else:
        raise SystemExit("사용: releases_page.py <사이트 폴더> | --release-texts <docs/releases/vX.Y.Z.md> <출력 폴더>")
