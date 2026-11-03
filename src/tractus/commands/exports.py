"""내보내기(export)와 Obsidian 보내기 명령."""

import json
from enum import Enum
from pathlib import Path

import typer
from rich.markup import escape

from tractus.commands import common
from tractus.export import FORMATS as EXPORT_FORMATS, PARTS as EXPORT_PARTS, render_export, UnsupportedFormat, write_bytes_atomic
from tractus.i18n import t
from tractus.paths import home_dir
from tractus.store import read_transcript

app = typer.Typer()  # 이 영역의 명령. cli.py가 이름 없이 붙여 한 층으로 합친다


ExportFormat = Enum("ExportFormat", {f: f for f in EXPORT_FORMATS}, type=str)


@app.command("export")
def export_cmd(
    meeting: str = typer.Argument(..., help="노트 폴더 경로 또는 meeting_id (일부만 써도 됨)"),
    fmt: ExportFormat = typer.Option(..., "--format", help="txt | md | srt | vtt | csv | docx | bundle(노트 폴더 zip)"),
    out: Path = typer.Option(..., "--out", help="저장할 파일 경로"),
    force: bool = typer.Option(False, "--force", help="--out 파일이 있으면 덮어쓴다"),
    summary: list[str] = typer.Option(None, "--summary", help="md·docx에 넣을 요약의 key (meeting·brief·u-…·c-…). 생략하면 기본 요약, 그것도 없으면 처음 있는 요약. --parts와 함께면 여러 번 줄 수 있고(그 순서), 생략하면 요약 없음"),
    parts: str = typer.Option(None, "--parts", help="md·docx에 넣을 내용만 고른다: transcript,memo,marks 중 쉼표로 (빈 값이면 요약만). 주면 순서가 머리 → 요약 → 대화 내용 → 메모 → 녹음 중 메모"),
) -> None:
    """노트를 파일로 내보낸다. 화자는 표시 이름, 본문은 교정본(corrected_text) 우선. stdout: {"path": "<절대 경로>"}"""
    from tractus import summaries as sums

    d = common.resolve_meeting(meeting)
    keys = list(dict.fromkeys(summary or []))
    picked = None if parts is None else {p.strip() for p in parts.split(",") if p.strip()}
    if picked is not None and (bad := sorted(picked - set(EXPORT_PARTS))):
        common.fail(t("넣을 내용은 {parts} 중에서 고릅니다: {bad}", parts=", ".join(EXPORT_PARTS), bad=", ".join(bad)), exit_code=2)
    if picked is None and len(keys) > 1:
        common.fail(t("요약을 여러 개 넣으려면 --parts도 줍니다."), exit_code=2)
    if any(sums.read_data(d, k) is None for k in keys):
        common.fail(sums.NO_SUCH_SUMMARY, exit_code=2)
    if out.exists() and not force:
        common.console.print(f"[red]{t('이미 있는 파일입니다 (덮어쓰려면 --force):')}[/red] {escape(str(out))}")
        raise typer.Exit(1)
    try:
        write_bytes_atomic(out, render_export(d, fmt.value, keys[0] if keys else None) if picked is None else render_export(d, fmt.value, keys=keys, parts=picked))
    except UnsupportedFormat as e:  # 메모를 srt·vtt로, --parts를 md·docx 밖에서
        common.fail(str(e), exit_code=2)
    except OSError as e:  # 임시 파일(.tmp) 경로 대신 사용자가 고른 경로를 알린다
        common.console.print(f"[red]{escape(t('{path}에 저장할 수 없습니다 ({error})', path=out, error=e.strerror or e))}[/red]")
        raise typer.Exit(1)
    except ValueError as e:  # 제목 등에 남은 제어 문자를 docx(lxml)가 거부하는 경우. 원인은 앞 줄, 앱이 보이는 마지막 줄은 문장
        common.console.print(str(e), markup=False)
        common.console.print(f"[red]{t('제목이나 대화 내용에 쓸 수 없는 글자가 있습니다.')}[/red]")
        raise typer.Exit(1)
    print(json.dumps({"path": str(out.resolve())}, ensure_ascii=False))


@app.command("obsidian")
def obsidian_cmd(
    meeting: str = typer.Argument(..., help="노트 폴더 경로 또는 meeting_id (일부만 써도 됨)"),
    vault: Path = typer.Option(..., "--vault", help="Obsidian 볼트 폴더. 노트는 <볼트>/Tractus/<폴더…>/ 아래에 쓴다"),
    summary: str = typer.Option(None, "--summary", help="넣을 요약의 key. 생략하면 기본 요약, 그것도 없으면 처음 있는 요약"),
    with_audio: bool = typer.Option(False, "--audio", help="오디오를 <볼트>/Tractus/attachments/에 복사해 노트에 붙인다"),
    force: bool = typer.Option(False, "--force", help="볼트에서 고친 파일도 덮어쓴다"),
) -> None:
    """노트를 Obsidian 볼트에 Markdown 하나로 보낸다 (docs/design/obsidian-export.md).
    stdout: {"status": "created|updated|unchanged|edited", "path", "audio"}. edited면 쓰지 않았다 (--force로 덮어쓴다)."""
    from tractus import obsidian, summaries as sums

    d = common.resolve_meeting(meeting)
    if summary and sums.read_data(d, summary) is None:
        common.fail(sums.NO_SUCH_SUMMARY, exit_code=2)
    note = read_transcript(d)
    try:
        r = obsidian.send(d, note, home_dir(), vault.expanduser(), summary, with_audio, force)
    except ValueError as e:
        common.fail(str(e), code="obsidian_vault", exit_code=2)
    except OSError as e:
        common.fail(t("볼트에 쓰지 못했습니다 ({error})", error=e.strerror or e), code="obsidian_write")
    print(json.dumps(r, ensure_ascii=False))
