"""참석자(화자) 보기·이름 짓기·고치기(speakers) 명령."""

import json
from pathlib import Path

import typer
from rich.markup import escape

from tractus.commands import common
from tractus.i18n import t
from tractus.store import _hms, apply_speaker_edit, edit_transcript, is_memo, is_recorded, NOT_CONVERTED, speaker_name

app = typer.Typer()  # 이 영역의 명령. cli.py가 이름 없이 붙여 한 층으로 합친다


speakers_app = typer.Typer(help="노트의 화자 보기·이름 짓기·고치기. transcript.json과 md·vtt를 다시 쓰고 검색 색인을 갱신한다 (오디오는 건드리지 않음)")
app.add_typer(speakers_app, name="speakers")


@speakers_app.callback()
def speakers_main(ctx: typer.Context, meeting: str = typer.Argument(..., help="노트 폴더 경로 또는 meeting_id (일부만 써도 됨)")) -> None:
    ctx.obj = common.resolve_meeting(meeting)


@speakers_app.command("list")
def speakers_list(ctx: typer.Context, as_json: bool = typer.Option(False, "--json", help="JSON으로 stdout에 출력 (데스크톱 앱용)")) -> None:
    """화자별 이름·세그먼트 수·발화 시간."""
    note = common.read_transcript(ctx.obj)
    rows = [
        {"label": label, "name": (info or {}).get("name"), "display": speaker_name(note, label), "suggested": (info or {}).get("suggested"),
         "segments": sum(1 for s in note["segments"] if s.get("speaker") == label),
         "talk_sec": round(sum(s["end"] - s["start"] for s in note["segments"] if s.get("speaker") == label), 2)}
        for label, info in (note.get("speakers") or {}).items()
    ]
    if as_json:
        print(json.dumps({"meeting_id": note["meeting_id"], "speakers": rows, "diarization": note.get("diarization")}, ensure_ascii=False))
        return
    if not rows:
        print(t("화자 정보가 없습니다 (화자 분리 없이 전사됨). `tractus speakers <노트> set <세그먼트> new`로 직접 붙일 수 있습니다"))
    for r in rows:
        hint = "\t" + t("{name}? (자동 인식 {pct})", name=r["suggested"]["name"], pct=f"{r['suggested']['score']:.0%}") if r["suggested"] else ""
        print(f"{r['label']}\t{r['name'] or '-'}\t{t('세그먼트 {n}개', n=r['segments'])}\t{_hms(r['talk_sec'])}{hint}")


def _edit_speakers(d: Path, op: str, *args: str) -> None:
    note = common.read_transcript(d)
    if is_memo(note):
        common.fail(t("메모에는 참석자를 지정할 수 없습니다."), exit_code=2)
    if is_recorded(note):
        common.fail(NOT_CONVERTED, code="not_converted", exit_code=2)
    try:
        edit_transcript(d, lambda note: (apply_speaker_edit(note, op, *args), None))
    except ValueError as e:
        common.console.print(f"[red]{escape(str(e))}[/red]")
        raise typer.Exit(1)
    common.sync_index_quietly(embed=False)
    common.console.print(t("저장했습니다: {path}", path=d / "transcript.json"))


@speakers_app.command("rename")
def speakers_rename(ctx: typer.Context, label: str = typer.Argument(..., help="S1 등"), name: str = typer.Argument(..., help='이름. ""이면 이름을 지운다')) -> None:
    """화자에 이름을 붙인다."""
    _edit_speakers(ctx.obj, "rename", label, name)


@speakers_app.command("set")
def speakers_set(ctx: typer.Context, segment_id: str = typer.Argument(..., help="s0012 등"), label: str = typer.Argument(..., help="S2 등, 또는 new (새 화자)")) -> None:
    """세그먼트 하나의 화자를 바꾼다."""
    _edit_speakers(ctx.obj, "set", segment_id, label)


@speakers_app.command("merge")
def speakers_merge(ctx: typer.Context, src: str = typer.Argument(..., help="없앨 화자"), dst: str = typer.Argument(..., help="합칠 대상 화자")) -> None:
    """두 화자를 하나로 합친다 (SRC의 세그먼트를 모두 DST로)."""
    _edit_speakers(ctx.obj, "merge", src, dst)


@speakers_app.command("dismiss")
def speakers_dismiss(ctx: typer.Context, label: str = typer.Argument(..., help="S1 등")) -> None:
    """목소리 제안('홍길동?')을 지운다. 제안을 받아들이려면 그 이름으로 rename한다."""
    _edit_speakers(ctx.obj, "dismiss", label)
