"""명령 모듈이 함께 쓰는 도구. 명령(Typer 앱)은 여기 없다: 이 모듈은 어떤 명령 모듈도 불러오지 않는다."""

import json
import sys
from datetime import date
from pathlib import Path
from typing import NoReturn

import typer
from rich.console import Console
from rich.markup import escape

from tractus import audio
from tractus.i18n import t
from tractus.paths import home_dir, models_dir
from tractus.store import find_meeting_dir

console = Console(stderr=True, soft_wrap=True)  # 파이프(앱)에서 80칸 줄바꿈 금지: 앱은 stderr 마지막 줄만 보여 준다


class Events:
    """`--progress-json`: 데스크톱 앱이 읽는 JSON Lines 진행 이벤트를 stdout에 쓴다 (docs/desktop.md §2).
    사람용 출력(rich)은 원래대로 stderr로 간다."""

    enabled = False

    @classmethod
    def emit(cls, event: str, **data) -> None:
        if cls.enabled:
            sys.stdout.write(json.dumps({"event": event, **data}, ensure_ascii=False) + "\n")
            sys.stdout.flush()


def emit_error(message: str, code: str | None = None) -> None:
    """오류 이벤트. code가 있으면 앱이 WORDS.md 문장으로 바꾸고 message는 `자세히`에 둔다 (docs/desktop.md §2)."""
    Events.emit("error", message=message, **({"code": code} if code else {}))


def fail(message: str, code: str | None = None, exit_code: int = 1) -> NoReturn:
    emit_error(message, code)
    console.print(f"[red]{escape(message)}[/red]")
    raise typer.Exit(exit_code)


def fail_audio(e: audio.FFmpegError) -> NoReturn:
    """ffmpeg가 없으면 설치 안내(ffmpeg_missing), 그 밖의 ffmpeg 실패는 audio_failed."""
    if isinstance(e, audio.FFmpegMissing):
        fail(str(e), code="ffmpeg_missing")
    fail(t("음성 파일을 읽지 못했습니다: {error}", error=e), code="audio_failed")


def warn(code: str, message: str) -> None:
    """경고 이벤트(앱) + 노란 글씨(터미널). 작업은 계속한다."""
    Events.emit("warning", code=code, message=message)
    console.print(f"[yellow]{escape(message)}[/yellow]")


def resolve_meeting(ref: str) -> Path:
    try:
        return find_meeting_dir(home_dir() / "meetings", ref)
    except LookupError as e:
        raise typer.BadParameter(str(e), param_hint="MEETING") from e


def note_dir(meeting: str) -> Path:
    """노트 폴더 인수 → 폴더. 못 찾으면 인수 오류(종료 코드 2)로 끝낸다."""
    try:
        return resolve_meeting(meeting)
    except typer.BadParameter as e:
        fail(e.message, exit_code=2)


def read_transcript(d: Path) -> dict:
    return json.loads((d / "transcript.json").read_text(encoding="utf-8"))


def read_json_object(raw: str, shape: str) -> dict:
    """stdin의 JSON 객체. 비었거나 객체가 아니면 ValueError (shape는 오류 문장에 보여 줄 형식)."""
    try:
        req = json.loads(raw)
    except ValueError:
        req = None
    if not isinstance(req, dict):
        raise ValueError(t("입력은 {shape} 형식이어야 합니다", shape=shape))  # words-ok: 앱 계약 오류
    return req


def iso_date(value: str | None, name: str) -> str | None:
    if value is None:
        return None
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError as e:
        raise typer.BadParameter(t("{name}는 YYYY-MM-DD 형식이어야 합니다: {value}", name=name, value=repr(value))) from e


def open_index():
    from tractus.embed import load_embedder
    from tractus.index import Index

    return Index(home_dir(), embedder=load_embedder(models_dir()))


def sync_index_quietly(embed: bool = True) -> None:
    """transcribe·summarize 뒤에 검색 색인을 갱신한다. 실패해도 본 작업 결과는 그대로 둔다.
    embed=False면 임베딩 모델(1.4 GB)을 올리지 않는다. 화자 편집은 청크 본문을 바꾸지 않아 기존 벡터를 그대로 쓴다."""
    from tractus.index import Index

    try:
        with console.status(t("검색 색인 갱신 중…")):
            idx = open_index() if embed else Index(home_dir())
            try:
                r = idx.sync(embed=embed)
            finally:
                idx.close()
        if r.added or r.updated:
            console.print(t("검색 색인: 추가 {added}, 갱신 {updated}", added=r.added, updated=r.updated))  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)
        if r.errors:
            console.print(f"[yellow]{t('색인하지 못한 항목 {n}개 — `tractus index`로 자세히 확인', n=len(r.errors))}[/yellow]")  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)
    except Exception as e:  # noqa: BLE001 — 색인은 언제든 `tractus index`로 다시 만들 수 있다
        console.print(f"[yellow]{t('검색 색인 갱신 실패 (`tractus index`로 다시 시도):')}[/yellow] {escape(str(e))}")  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)
