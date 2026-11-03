"""노트의 대화 내용 명령: 파일 다시 그리기(render), 문장 고치기(segments), 스마트 교정(polish)."""

import json
import sys
import time
from pathlib import Path

from rich.markup import escape
import typer

from tractus import notes
from tractus.commands import common
from tractus.commands import note
from tractus.i18n import t
from tractus.llm import LLMError
from tractus.llm import make_client
from tractus.llm import resolve_provider
from tractus.paths import home_dir
from tractus.store import NOT_CONVERTED
from tractus.store import apply_text_edits
from tractus.store import edit_transcript
from tractus.store import is_memo
from tractus.store import is_recorded
from tractus.store import load_glossary
from tractus.store import note_lock
from tractus.store import read_transcript
from tractus.store import render_files
from tractus.store import seg_text

app = typer.Typer()  # 이 영역의 명령. cli.py가 이름 없이 붙여 한 층으로 합친다


@app.command("render")
def render_cmd(
    meeting: str = typer.Argument(None, help="노트 폴더 경로 또는 meeting_id (일부만 써도 됨)"),
    all_notes: bool = typer.Option(False, "--all", help="모든 노트"),
) -> None:
    """transcript.json으로 transcript.md·vtt를 다시 만든다 (표시 문구가 바뀐 뒤 기존 노트에 반영). stdout: {"rendered": N}"""
    if (meeting is None) == (not all_notes):
        raise typer.BadParameter(t("노트 하나 또는 --all 중 하나만 지정하세요"))
    dirs = [p.parent for p in sorted((home_dir() / "meetings").glob("*/transcript.json"))] if all_notes else [common.resolve_meeting(meeting)]
    rendered = 0
    for d in dirs:
        try:
            with note_lock(d):
                render_files(d, common.read_transcript(d))
        except (OSError, ValueError, KeyError, TypeError) as e:  # 형식이 깨진 transcript.json은 KeyError로 나온다
            if not all_notes:
                common.fail(t("문서를 다시 만들지 못했습니다: {error}", error=e))
            common.console.print(f"[yellow]{t('건너뜀:')}[/yellow] {escape(d.name)}: {escape(str(e))}")
            continue
        rendered += 1
    print(json.dumps({"rendered": rendered}))


segments_app = typer.Typer(help="노트 전사 텍스트 고치기. 원문(text)은 두고 corrected_text에 쓴 뒤 md·vtt를 다시 쓰고 검색 색인을 갱신한다")
app.add_typer(segments_app, name="segments")


@segments_app.callback()
def segments_main(ctx: typer.Context, meeting: str = typer.Argument(..., help="노트 폴더 경로 또는 meeting_id (일부만 써도 됨)")) -> None:
    ctx.obj = common.resolve_meeting(meeting)


@segments_app.command("edit")
def segments_edit(ctx: typer.Context) -> None:
    """stdin의 JSON 한 개 {"edits": [{"id": "s0012", "text": "새 문장"}]}로 세그먼트 텍스트를 고친다.
    원문과 같으면 교정을 지운다. 없는 id·빈 텍스트가 하나라도 있으면 아무것도 쓰지 않고 종료 코드 1. stdout: {"changed": N}"""
    d = ctx.obj
    note = common.read_transcript(d)
    if is_memo(note):
        common.fail(notes.MEMO_EDIT_HERE, exit_code=2)
    if is_recorded(note):
        common.fail(NOT_CONVERTED, code="not_converted", exit_code=2)
    try:
        req = json.loads(sys.stdin.read())
        edits = req.get("edits") if isinstance(req, dict) else None
        if not isinstance(edits, list):
            raise ValueError(t("입력은 {shape} 형식이어야 합니다", shape='{"edits": [{"id": "s0012", "text": "…"}]}'))  # words-ok: 앱 계약 오류
        changed = edit_transcript(d, lambda note: apply_text_edits(note, edits))
    except ValueError as e:  # json.JSONDecodeError 포함
        common.console.print(f"[red]{escape(str(e))}[/red]")
        raise typer.Exit(1)
    if changed:
        common.sync_index_quietly(embed=False)  # 바뀐 청크는 벡터 없이 키워드로만 찾힌다. 다음 `tractus index`나 전사·요약 때 임베딩
    print(json.dumps({"changed": changed}))


polish_app = typer.Typer(help="AI 다듬기: 잘못 들은 말이 있는 문장의 고친 문장을 제안하고(run), 받거나(accept) 버린다(reject). 제안은 <노트>/polish.json (docs/design/transcript-polish.md)")
app.add_typer(polish_app, name="polish")


@polish_app.callback()
def polish_main(ctx: typer.Context, meeting: str = typer.Argument(..., help="노트 폴더 경로 또는 meeting_id (일부만 써도 됨)")) -> None:
    ctx.obj = common.resolve_meeting(meeting)


def _polish_note(d: Path) -> dict:
    note = common.read_transcript(d)
    if is_memo(note):
        common.fail(t("녹음이 없는 노트는 스마트 교정을 쓸 수 없습니다"), code="no_recording", exit_code=2)
    if is_recorded(note):
        common.fail(NOT_CONVERTED, code="not_converted", exit_code=2)
    return note


def _polish_ids() -> set[str]:
    try:
        req = json.loads(sys.stdin.read())
        ids = req.get("ids") if isinstance(req, dict) else None
        if not (isinstance(ids, list) and all(isinstance(i, str) for i in ids)):
            raise ValueError
    except ValueError:
        common.fail(t("입력은 {shape} 형식이어야 합니다", shape='{"ids": ["s0012"]}'), code="bad_input", exit_code=2)  # words-ok: 앱 계약 오류
    return set(ids)


@polish_app.command("run")
def polish_run(
    ctx: typer.Context,
    provider: str = typer.Option(None, "--provider", help="upstage | openai | claude | gemini | custom | gemma-local. 생략하면 TRACTUS_LLM_PROVIDER"),
    model: str = typer.Option(None, "--model", help="모델 ID. 생략하면 TRACTUS_LLM_MODEL 또는 공급자 기본값"),
    progress_json: bool = typer.Option(False, "--progress-json", help="진행 이벤트를 stdout에 JSON Lines로 출력 (데스크톱 앱용). 창이 끝날 때마다 progress에 그 창의 suggestions와 range([첫 ID, 끝 ID])를 싣는다"),
) -> None:
    """대화 내용 전체를 범위마다 AI에 보내 제안을 만든다. 대화 내용·제목·메모·자주 쓰는 단어·확인한 참석자 이름만 공급자에 전송한다.
    지난 제안은 새 제안으로 바뀐다. done 이벤트: {"suggestions": N}"""
    from tractus import polish

    common.Events.enabled = progress_json
    d = ctx.obj
    note = _polish_note(d)
    if not note["segments"]:
        common.fail(t("인식된 대화가 없어 교정할 수 없습니다"), code="no_segments")
    try:
        p, m = resolve_provider(provider, model)
        t0 = time.perf_counter()
        common.Events.emit("stage", stage="polish")
        report = lambda done, total, got, span: common.Events.emit("progress", done=done, total=total, suggestions=got, range=list(span))  # noqa: E731
        with common.console.status(t("{provider}/{model}로 교정하는 중… (대화 {n}개)", provider=p.name, model=m, n=len(note["segments"]))):
            found = polish.suggest(make_client(p), p, m, note, load_glossary(home_dir() / "glossary.md"), on_window=report)
    except LLMError as e:
        if e.code == "llm_invalid":
            common.console.print(f"[red]{escape(str(e))}[/red]")
            common.fail(t("AI 응답이 형식에 맞지 않아 교정하지 못했습니다"), code=e.code)
        common.fail(str(e), code=e.code)
    with note_lock(d):
        latest = read_transcript(d)  # AI를 기다리는 동안 고친 문장의 제안은 쓰지 않는다
        now = {s["id"]: seg_text(s) for s in latest["segments"]}
        found = [x for x in found if now.get(x["id"]) == x["before"]]
        polish.write(d, latest, found, p.name, m)
    common.Events.emit("done", meeting_id=note["meeting_id"], meeting_dir=str(d), suggestions=len(found))
    common.console.print(t("완료: 제안 {n}개 ({sec}초)", n=len(found), sec=f"{time.perf_counter() - t0:.0f}"))


@polish_app.command("show")
def polish_show(ctx: typer.Context) -> None:
    """아직 정하지 않은 제안 중 지금도 맞는 것. stdout: {"suggestions": [{id, start, before, text, kind, flags}]}"""
    from tractus import polish

    d = ctx.obj
    print(json.dumps({"suggestions": polish.pending(d, common.read_transcript(d))}, ensure_ascii=False))


@polish_app.command("accept")
def polish_accept(ctx: typer.Context) -> None:
    """stdin {"ids": [...]}의 제안을 받는다: 고친 문장으로 바꾸고(원문은 남는다, corrected_by "ai") 제안에서 뺀다. stdout: {"changed": N, "remaining": M}"""
    from tractus import polish

    d = ctx.obj
    note = _polish_note(d)
    ids = _polish_ids()
    edits = [{"id": x["id"], "text": x["text"], "by": "ai"} for x in polish.pending(d, note) if x["id"] in ids]
    try:
        changed = edit_transcript(d, lambda n: apply_text_edits(n, edits)) if edits else 0
    except ValueError as e:
        common.fail(str(e), code="bad_input")
    with note_lock(d):
        remaining = polish.resolve(d, read_transcript(d), ids)
    if changed:
        common.sync_index_quietly(embed=False)
    print(json.dumps({"changed": changed, "remaining": remaining}))


@polish_app.command("reject")
def polish_reject(ctx: typer.Context) -> None:
    """stdin {"ids": [...]}의 제안을 버린다. stdout: {"remaining": M}"""
    from tractus import polish

    d = ctx.obj
    _polish_note(d)
    ids = _polish_ids()
    with note_lock(d):
        remaining = polish.resolve(d, read_transcript(d), ids)
    print(json.dumps({"remaining": remaining}))
