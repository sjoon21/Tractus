"""요약 유형(templates)·노트의 요약들(summaries)·회의록(minutes) 명령. 모두 노트의 요약 파일을 보고 고친다."""

import json
import sys
from pathlib import Path

import typer

from tractus import summary_templates as tmpls
from tractus.commands import common
from tractus.i18n import t
from tractus.paths import home_dir

app = typer.Typer()  # 이 영역의 명령. cli.py가 이름 없이 붙여 한 층으로 합친다


templates_app = typer.Typer(help="요약 유형($TRACTUS_HOME/templates/): 기본 유형(읽기 전용)과 내 유형 만들기·고치기·삭제 (docs/desktop.md §2.13)")
app.add_typer(templates_app, name="templates")


@templates_app.callback()
def templates_main() -> None:
    """요약 유형 관리."""


@templates_app.command("list")
def templates_list(as_json: bool = typer.Option(False, "--json", help='{"templates": [{"id","name","description","prompt","builtin"}]} (기본 유형 → 내 유형 순)')) -> None:
    """요약 유형 목록."""
    items = tmpls.all_templates(home_dir())
    if as_json:
        print(json.dumps({"templates": [t.public() for t in items]}, ensure_ascii=False))
        return
    for t in items:
        print(f"{t.id}\t{t.name}\t{t.description}")


@templates_app.command("save")
def templates_save(
    name: str = typer.Option(..., "--name", help=f"이름 ({tmpls.MAX_NAME}자까지)"),
    description: str = typer.Option("", "--description", help=f"한 줄 설명 ({tmpls.MAX_DESC}자까지)"),
    tid: str = typer.Option(None, "--id", help="고칠 내 유형 ID (생략하면 새로 만든다)"),
) -> None:
    """내 요약 유형을 만들거나 고친다. stdin의 {"prompt": "요약 방법"} (4,000자까지). stdout: {"id","name","description","prompt","builtin":false}
    잘못된 입력은 종료 코드 2 (아무것도 쓰지 않는다)."""
    try:
        req = common.read_json_object(sys.stdin.read(), '{"prompt": "…"}')
        if not isinstance(req.get("prompt"), str):
            raise ValueError(t("입력은 {shape} 형식이어야 합니다", shape='{"prompt": "…"}'))  # words-ok: 앱 계약 오류
        saved = tmpls.save_user_template(home_dir(), name, req["prompt"], description, tid)
    except ValueError as e:
        common.fail(str(e), code="bad_input", exit_code=2)
    print(json.dumps(saved.public(), ensure_ascii=False))


@templates_app.command("delete")
def templates_delete(tid: str = typer.Argument(..., metavar="ID", help="내 유형 ID (기본 유형은 지울 수 없다). 이 유형으로 만든 요약은 그대로 남는다")) -> None:
    """내 요약 유형을 지운다. stdout: {"deleted": "<ID>"}"""
    try:
        tmpls.delete_user_template(home_dir(), tid)
    except ValueError as e:
        common.fail(str(e), code="bad_input", exit_code=2)
    print(json.dumps({"deleted": tid}))


summaries_app = typer.Typer(help="한 노트의 요약들(기본 summary.json + summaries/). 보기·지우기 (docs/desktop.md §2.13)")
app.add_typer(summaries_app, name="summaries")


@summaries_app.callback()
def summaries_main(ctx: typer.Context, meeting: str = typer.Argument(..., help="노트 폴더 경로 또는 meeting_id (일부만 써도 됨)")) -> None:
    ctx.obj = common.note_dir(meeting)


@summaries_app.command("list")
def summaries_list(ctx: typer.Context, as_json: bool = typer.Option(False, "--json", help='{"summaries": [{"key","template","name","title","generated_at","provider","model","custom"}]}')) -> None:
    """요약 목록. key meeting은 기본 요약(summary.json)이다."""
    from tractus import summaries as sums

    items = sums.list_summaries(ctx.obj)
    if as_json:
        print(json.dumps({"summaries": items}, ensure_ascii=False))
        return
    for x in items:
        print(f"{x['key']}\t{x['name']}\t{x['title']}")


@summaries_app.command("delete")
def summaries_delete(ctx: typer.Context, key: str = typer.Argument(..., metavar="KEY", help="지울 요약의 key (meeting이면 summary.json·summary.md)")) -> None:
    """요약 하나를 지운다. stdout: {"deleted": "<KEY>"}. 없으면 종료 코드 2."""
    from tractus import summaries as sums

    try:
        sums.delete_summary(ctx.obj, key)
    except ValueError as e:
        common.fail(str(e), code="bad_input", exit_code=2)
    print(json.dumps({"deleted": key}))


minutes_app = typer.Typer(help="한 노트의 회의록(summaries/minutes.json). 보기·칸 고치기 (docs/design/meeting-minutes.md)")  # words-ok: 회의록은 문서 이름
app.add_typer(minutes_app, name="minutes")


@minutes_app.callback()
def minutes_main(ctx: typer.Context, meeting: str = typer.Argument(..., help="노트 폴더 경로 또는 meeting_id (일부만 써도 됨)")) -> None:
    ctx.obj = common.note_dir(meeting)


def _transcript(d: Path) -> dict:
    return json.loads((d / "transcript.json").read_text(encoding="utf-8"))


@minutes_app.command("show")
def minutes_show(ctx: typer.Context) -> None:
    """stdout: {"minutes", "attendees", "title", "generated_at", "edited_at", "markdown", "short"}. 회의록이 없으면 {"minutes": null}."""  # words-ok: 회의록은 문서 이름
    from tractus import minutes, summaries as sums

    print(json.dumps(minutes.show(sums.read_data(ctx.obj, minutes.KEY), _transcript(ctx.obj)), ensure_ascii=False))


@minutes_app.command("save")
def minutes_save(ctx: typer.Context) -> None:
    """칸을 고친 회의록 저장. stdin {"minutes": {...}} (show의 minutes 모양). 비운 줄은 지운다. stdout은 show와 같다. 형식이 틀리면 종료 코드 2."""  # words-ok: 회의록은 문서 이름
    from tractus import minutes

    try:
        raw = json.loads(sys.stdin.read() or "{}")
        out = minutes.save_edit(ctx.obj, _transcript(ctx.obj), raw.get("minutes") if isinstance(raw, dict) else None)
    except ValueError as e:  # json.JSONDecodeError도 ValueError
        common.fail(str(e) if str(e) in (minutes.BAD_EDIT, minutes.NO_MINUTES) else minutes.BAD_EDIT, code="bad_input", exit_code=2)
    print(json.dumps(out, ensure_ascii=False))
