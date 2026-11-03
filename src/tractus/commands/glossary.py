"""용어집(glossary) 명령: 다음 변환부터 자주 쓰는 단어로 들어갈 용어를 더한다."""

import json

import typer

from tractus.paths import home_dir
from tractus.store import add_glossary_terms

app = typer.Typer()  # 이 영역의 명령. cli.py가 이름 없이 붙여 한 층으로 합친다


glossary_app = typer.Typer(help="용어집($TRACTUS_HOME/glossary.md). 다음 전사부터 Qwen3-ASR hotwords로 들어간다")
app.add_typer(glossary_app, name="glossary")


@glossary_app.callback()
def glossary_main() -> None:
    """용어집 관리."""


@glossary_app.command("add")
def glossary_add(terms: list[str] = typer.Argument(..., help="추가할 용어 (여러 개). '-'로 시작하면 앞에 -- 를 둔다")) -> None:
    """용어를 `- 용어` 줄로 덧붙인다. 중복·빈 값은 건너뛴다. stdout: {"added": N}"""
    home_dir().mkdir(parents=True, exist_ok=True)
    print(json.dumps({"added": add_glossary_terms(home_dir() / "glossary.md", terms)}))
