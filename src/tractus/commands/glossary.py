"""용어집(glossary) 명령: 다음 변환부터 자주 쓰는 단어로 들어갈 용어를 보고 더하고 고치고 지운다."""

import json

import typer

from tractus import asr, store
from tractus.commands import common
from tractus.i18n import t
from tractus.paths import home_dir

app = typer.Typer()  # 이 영역의 명령. cli.py가 이름 없이 붙여 한 층으로 합친다


glossary_app = typer.Typer(help="용어집($TRACTUS_HOME/glossary.md). 다음 전사부터 Qwen3-ASR hotwords로 들어간다")
app.add_typer(glossary_app, name="glossary")


def _path():
    return home_dir() / "glossary.md"


@glossary_app.callback()
def glossary_main() -> None:
    """용어집 관리."""


@glossary_app.command("add")
def glossary_add(terms: list[str] = typer.Argument(..., help="추가할 용어 (여러 개). '-'로 시작하면 앞에 -- 를 둔다")) -> None:
    """용어를 `- 용어` 줄로 덧붙인다. 중복·빈 값은 건너뛰고, 글자 수·개수 한도를 넘는 용어는 skipped로 센다. stdout: {"added": N, "skipped": M}"""
    skipped: list[str] = []
    added = store.add_glossary_terms(_path(), terms, skipped)
    print(json.dumps({"added": added, "skipped": len(skipped)}))


@glossary_app.command("list")
def glossary_list(as_json: bool = typer.Option(False, "--json", help="한 줄 JSON")) -> None:
    """용어를 최근에 더한 것부터 낸다. stdout(--json): {"terms": [...], "max": 50}. max는 변환이 한 번에 쓰는 개수(앞의 것이 먼저 남는다)"""
    terms = list(reversed(store.load_glossary(_path())))
    if as_json:
        print(json.dumps({"terms": terms, "max": asr.HOTWORDS_MAX}, ensure_ascii=False))
    else:
        print("\n".join(terms))


@glossary_app.command("remove")
def glossary_remove(terms: list[str] = typer.Argument(..., help="지울 용어 (여러 개). '-'로 시작하면 앞에 -- 를 둔다")) -> None:
    """용어가 적힌 줄을 지운다(없는 용어는 건너뜀). stdout: {"removed": N}"""
    print(json.dumps({"removed": store.remove_glossary_terms(_path(), terms)}))


@glossary_app.command("rename")
def glossary_rename(old: str = typer.Argument(..., help="바꿀 용어"), new: str = typer.Argument(..., help="새 용어")) -> None:
    """용어 하나를 고친다. 새 용어가 이미 있으면 옛 줄만 지운다. stdout: {"changed": bool}"""
    try:
        changed = store.rename_glossary_term(_path(), old, new)
    except ValueError:
        common.fail(t("자주 쓰는 단어는 1~{n}자로 적어 주세요.", n=store.GLOSSARY_TERM_MAX), exit_code=2)
    print(json.dumps({"changed": changed}))
