"""노트 만들기·저장·제목(note)과 녹음 중 메모·북마크 고치기(marks) 명령."""

import json
import sys

import typer

from tractus import notes
from tractus.commands import common
from tractus.i18n import t
from tractus.paths import home_dir
from tractus.store import edit_transcript, is_memo, memo_lines, note_lock, read_transcript

app = typer.Typer()  # 이 영역의 명령. cli.py가 이름 없이 붙여 한 층으로 합친다


note_app = typer.Typer(help="직접 쓰는 메모 노트(오디오 없음)와 노트 제목. transcript.json·md를 쓰고 검색 색인을 갱신한다 (docs/desktop.md §2.10)")
app.add_typer(note_app, name="note")


@note_app.callback()
def note_main() -> None:
    """메모 만들기·저장, 제목 바꾸기."""


@note_app.command("new")
def note_new(title: str = typer.Option(None, "--title", help="제목. stdin의 title보다 우선한다. 생략하면 '메모 HH:MM'(이 Mac의 시각)")) -> None:
    """빈 메모(또는 stdin의 {"title"?, "body"?}로 채운 메모)를 만든다. stdout: {"meeting_id": "…", "meeting_dir": "<절대 경로>"}
    잘못된 제목·본문이면 종료 코드 2 (아무것도 만들지 않는다)."""
    raw = "" if sys.stdin.isatty() else sys.stdin.read()
    try:
        req = common.read_json_object(raw, '{"title": "…", "body": "…"}') if raw.strip() else {}
        for key in ("title", "body"):
            if not isinstance(req.get(key, ""), str):
                raise ValueError(t("입력은 {shape} 형식이어야 합니다", shape='{"title": "…", "body": "…"}'))  # words-ok: 앱 계약 오류
        d, note = notes.create_memo(home_dir() / "meetings", title or req.get("title"), req.get("body", ""))
    except ValueError as e:
        common.fail(str(e), exit_code=2)
    common.sync_index_quietly(embed=False)
    print(json.dumps({"meeting_id": note["meeting_id"], "meeting_dir": str(d.resolve())}, ensure_ascii=False))


@note_app.command("sample")
def note_sample() -> None:
    """예시 노트(첫 사용자 온보딩, 가상 회의)를 만든다. 이미 있으면 그것을 돌려준다. 모델·AI 키 없이 돈다.
    stdout: {"meeting_id": "…", "meeting_dir": "<절대 경로>", "created": bool}. 검색 색인·MCP 목록에는 들어가지 않는다."""
    from tractus import sample_note

    d, created = sample_note.create(home_dir())
    t = read_transcript(d)
    print(json.dumps({"meeting_id": t["meeting_id"], "meeting_dir": str(d.resolve()), "created": created}, ensure_ascii=False))


@note_app.command("save")
def note_save(meeting: str = typer.Argument(..., help="노트 폴더 경로 또는 meeting_id (일부만 써도 됨)")) -> None:
    """stdin의 {"body": "…"}로 메모의 내용을 통째로 바꾼다. 메모 노트는 본문, 녹음 노트는 transcript.json의 "memo"(오른쪽 패널 메모)를 쓴다 (비우면 "memo"를 지운다).
    줄이 그대로면 줄 ID를 유지한다. stdout: {"saved": true, "segments": N, "changed": bool, "kind": "memo"|"recording"} (N: 메모의 줄 수)
    잘못된 입력·20만 자·5,000줄 초과는 종료 코드 2 (아무것도 쓰지 않는다)."""
    d = common.note_dir(meeting)
    try:
        req = common.read_json_object(sys.stdin.read(), '{"body": "…"}')
        if not isinstance(req.get("body"), str):
            raise ValueError(t("입력은 {shape} 형식이어야 합니다", shape='{"body": "…"}'))  # words-ok: 앱 계약 오류
        body = notes.clean_body(req["body"])

        def fn(t: dict):
            new, changed = notes.apply_body(t, body)
            count = len(new["segments"]) if is_memo(new) else len(memo_lines(new))
            return new, (changed, count, "memo" if is_memo(new) else "recording")

        changed, count, kind = edit_transcript(d, fn)
    except ValueError as e:
        common.fail(str(e), exit_code=2)
    if changed:
        common.sync_index_quietly(embed=False)  # 바뀐 청크는 벡터 없이 키워드로만 찾힌다. 앱의 조용한 색인이 나중에 임베딩한다
    print(json.dumps({"saved": True, "segments": count, "changed": changed, "kind": kind}))


@note_app.command("title")
def note_title(meeting: str = typer.Argument(..., help="노트 폴더 경로 또는 meeting_id (일부만 써도 됨)")) -> None:
    """stdin의 {"title": "…"}로 노트(녹음·메모 모두) 제목을 바꾼다. 폴더 이름은 그대로 두고 transcript.json·md(·vtt)·요약 파일·검색 색인의 제목을 바꾼다.
    stdout: {"title": "<정리된 제목>"}. 비었거나 120자를 넘으면 종료 코드 2."""
    d = common.note_dir(meeting)
    try:
        req = common.read_json_object(sys.stdin.read(), '{"title": "…"}')
        if not isinstance(req.get("title"), str):
            raise ValueError(t("입력은 {shape} 형식이어야 합니다", shape='{"title": "…"}'))  # words-ok: 앱 계약 오류
        title = notes.clean_title(req["title"])
        with note_lock(d):  # transcript.json과 요약 파일을 한 번에 바꾼다
            edit_transcript(d, lambda t: (notes.apply_title(t, title), None))
            notes.retitle_summary(d, title)
    except ValueError as e:
        common.fail(str(e), exit_code=2)
    common.sync_index_quietly(embed=False)
    print(json.dumps({"title": title}, ensure_ascii=False))


marks_app = typer.Typer(help="녹음 중 남긴 메모·북마크 (노트 폴더의 memos.json). 고치기·지우기")
app.add_typer(marks_app, name="marks")


@marks_app.callback()
def marks_main(ctx: typer.Context, meeting: str = typer.Argument(..., help="노트 폴더 경로 또는 meeting_id (일부만 써도 됨)")) -> None:
    ctx.obj = common.note_dir(meeting)


@marks_app.command("save")
def marks_save(ctx: typer.Context) -> None:
    """stdin {"marks": [{"t", "kind", "text"}]}: 남은 것만 보낸다 (빠진 항목은 지운다, 메모 글은 고친다, 글을 비우면 지운다).
    새 메모를 끼워 넣거나 시각·종류를 바꾸면 종료 코드 2. stdout: {"marks": [...]} (시각 순)."""
    from tractus.store import save_memos

    try:
        req = common.read_json_object(sys.stdin.read(), '{"marks": […]}')
        out = save_memos(ctx.obj, req.get("marks"))
    except ValueError as e:
        common.fail(str(e), code="bad_input", exit_code=2)
    print(json.dumps({"marks": out}, ensure_ascii=False))
