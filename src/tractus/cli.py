"""tractus CLI."""

import json
import os
import time
import warnings
from datetime import date, datetime
from enum import Enum
from pathlib import Path

os.environ.setdefault("TQDM_DISABLE", "1")
warnings.filterwarnings("ignore")

import typer  # noqa: E402
from rich.console import Console  # noqa: E402
from rich.markup import escape  # noqa: E402
from rich.progress import BarColumn, MofNCompleteColumn, Progress, TextColumn, TimeElapsedColumn, TimeRemainingColumn  # noqa: E402

from tractus import audio  # noqa: E402
from tractus import summarize as summ  # noqa: E402
from tractus.env import load_env  # noqa: E402
from tractus.llm import LLMError, make_client, resolve_provider  # noqa: E402
from tractus.paths import home_dir, models_dir  # noqa: E402
from tractus.asr import SR, Transcriber  # noqa: E402
from tractus.store import Job, find_job, find_meeting_dir, find_transcribed, load_glossary, meeting_dir_name, new_ulid, write_transcript  # noqa: E402
from tractus.store import _hms  # noqa: E402
from tractus.vad import find_chunks  # noqa: E402

app = typer.Typer(add_completion=False, help="Local-first 회의 전사·회의록 도구")
console = Console(stderr=True)


class Track(str, Enum):
    standard = "standard"
    lite = "lite"


class Language(str, Enum):
    auto = "auto"
    ko = "ko"
    en = "en"


# Phase 0 확정 모델 (ARCHITECTURE.md §2.2, §8)
MODELS = {Track.standard: "mlx-community/Qwen3-ASR-1.7B-8bit", Track.lite: "mlx-community/Qwen3-ASR-0.6B-8bit"}
VAD_MODEL = "mlx-community/silero-vad-v6"
STANDARD_MIN_MEMORY = 16 * 1024**3


def local_model(repo: str) -> Path:
    path = models_dir() / repo.split("/")[1].lower()
    if not (path / "config.json").exists():
        raise typer.BadParameter(
            f"모델이 없습니다: {path}\n  hf download {repo} --local-dir {path}\n"
            "(모델 위치는 TRACTUS_MODELS_DIR 환경변수로 바꿀 수 있습니다)",
            param_hint="모델",
        )
    return path


def recommended_track() -> Track:
    memory = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    return Track.standard if memory >= STANDARD_MIN_MEMORY else Track.lite


@app.callback()
def main() -> None:
    """개발 중에는 현재 폴더의 .env / .env.local을 읽는다 (셸 환경변수가 우선)."""
    load_env(Path.cwd())


@app.command()
def transcribe(
    file: Path = typer.Argument(..., exists=True, dir_okay=False, help="회의 녹음 파일 (m4a, mp3, wav, webm …)"),
    title: str = typer.Option(None, "--title", help="회의 제목. 생략하면 파일 이름"),
    track: Track = typer.Option(None, "--track", help="standard(1.7B) | lite(0.6B). 생략하면 메모리 16GB 이상이면 standard"),
    language: Language = typer.Option(Language.auto, "--language", help="auto 권장. ko로 고정하면 영어 발화를 번역할 수 있음"),
    term: list[str] = typer.Option([], "--term", "-t", help="이 회의의 용어 (참석자 이름·제품명). 여러 번 지정 가능"),
) -> None:
    """녹음 파일을 전사해 회의 폴더(audio.opus, transcript.json, transcript.md)를 만든다. 중단돼도 같은 명령으로 이어서 진행한다."""
    try:
        _transcribe(file, title, track, language, term)
    except audio.FFmpegError as e:
        console.print(f"[red]오디오 처리 실패:[/red] {escape(str(e))}")
        raise typer.Exit(1)


def _transcribe(file: Path, title: str | None, track: Track | None, language: Language, term: list[str]) -> None:
    audio.require_ffmpeg()
    meetings = home_dir() / "meetings"
    meetings.mkdir(parents=True, exist_ok=True)

    digest = audio.sha256(file)
    if done_dir := find_transcribed(meetings, digest):
        console.print(f"이미 전사된 파일입니다: {done_dir}\n다시 전사하려면 이 폴더를 지우고 실행하세요.")
        raise typer.Exit(0)

    job = find_job(meetings, digest)
    if job:
        if track and track.value != job.track:
            console.print(f"[yellow]진행 중인 작업의 트랙({job.track})으로 이어서 합니다.[/yellow]")
        console.print(f"이어서 진행합니다: {job.dir.name} ({len(job.done())}/{len(job.chunks)} 청크 완료)")
        pcm = audio.decode(file)
    else:
        job, pcm = _new_job(file, meetings, digest, title, track or recommended_track(), language, term)

    _run(job, pcm)


def _new_job(file: Path, meetings: Path, digest: str, title: str | None, track: Track, language: Language, terms: list[str]):
    vad_dir, _ = local_model(VAD_MODEL), local_model(MODELS[track])  # 오래 걸리는 작업 전에 모델부터 확인
    with console.status("오디오 디코딩·VAD 분할 중…"):
        pcm = audio.decode(file)
        chunks = find_chunks(pcm, vad_dir)

    recorded = datetime.fromtimestamp(file.stat().st_mtime).astimezone()
    meeting_id = new_ulid()
    title = title or file.stem
    d = meetings / meeting_dir_name(recorded.date().isoformat(), title, meeting_id)
    d.mkdir()
    # ponytail: Opus 인코딩 중 강제 종료되면 .job.json 없는 폴더가 남는다. 다음 실행은 새 폴더로 처음부터 진행
    with console.status("원본을 audio.opus로 보관 중…"):
        audio.encode_opus(file, d / "audio.opus")

    hotwords = list(dict.fromkeys(load_glossary(home_dir() / "glossary.md") + terms))
    job = Job(
        dir=d, meeting_id=meeting_id, sha256=digest, source=file.name, title=title,
        created_at=recorded.isoformat(timespec="seconds"), duration_sec=round(len(pcm) / SR, 2),
        model=MODELS[track], track=track.value, language=language.value, hotwords=hotwords, chunks=chunks,
    )
    job.save()
    console.print(f"회의 폴더: {d}\n트랙 {track.value} ({MODELS[track]}), 청크 {len(chunks)}개, 용어 {len(hotwords)}개")
    return job, pcm


def _run(job: Job, pcm) -> None:
    transcriber = Transcriber.load(local_model(job.model))
    lang = None if job.language == "auto" else job.language
    done = job.done()
    todo = [i for i in range(len(job.chunks)) if i not in done]
    t0, repaired = time.perf_counter(), 0
    columns = [TextColumn("전사"), BarColumn(), MofNCompleteColumn(), TimeElapsedColumn(), TextColumn("남은 시간"), TimeRemainingColumn()]
    try:
        with Progress(*columns, console=console) as progress:
            bar = progress.add_task("", total=len(job.chunks), completed=len(done))
            for i in todo:
                s, e = job.chunks[i]
                seg = transcriber.transcribe(pcm[s:e], language=lang, hotwords=job.hotwords)
                job.append(i, seg)
                repaired += seg.repaired
                progress.advance(bar)
    except KeyboardInterrupt:
        console.print("\n중단했습니다. 같은 명령으로 다시 실행하면 이어서 진행합니다.")
        raise typer.Exit(130)

    elapsed = time.perf_counter() - t0
    t = write_transcript(job)
    # ASR 모델을 내린 뒤 색인한다: 1.7B(3.6GB)와 임베딩 모델(1.4GB)이 통합 메모리에 함께 올라가지 않게
    del transcriber
    import gc

    import mlx.core as mx

    gc.collect()
    mx.clear_cache()
    _sync_index_quietly()
    rtf = f" (RTF {elapsed / job.duration_sec:.3f})" if not done and job.duration_sec else ""  # 이어하기면 일부만 처리해 RTF가 의미 없음
    console.print(
        f"완료: 세그먼트 {len(t['segments'])}개, 반복 출력 보정 {repaired}건, {elapsed / 60:.1f}분{rtf}\n"
        f"{job.dir / 'transcript.md'}"
    )


def resolve_meeting(ref: str) -> Path:
    try:
        return find_meeting_dir(home_dir() / "meetings", ref)
    except LookupError as e:
        raise typer.BadParameter(str(e), param_hint="MEETING") from e


def _open_index():
    from tractus.embed import load_embedder
    from tractus.index import Index

    return Index(home_dir(), embedder=load_embedder(models_dir()))


def _sync_index_quietly() -> None:
    """transcribe·summarize 뒤에 검색 색인을 갱신한다. 실패해도 본 작업 결과는 그대로 둔다."""
    try:
        with console.status("검색 색인 갱신 중…"):
            idx = _open_index()
            try:
                r = idx.sync()
            finally:
                idx.close()
        if r.added or r.updated:
            console.print(f"검색 색인: 추가 {r.added}, 갱신 {r.updated}")
        if r.errors:
            console.print(f"[yellow]색인하지 못한 항목 {len(r.errors)}개 — `tractus index`로 자세히 확인[/yellow]")
    except Exception as e:  # noqa: BLE001 — 색인은 언제든 `tractus index`로 다시 만들 수 있다
        console.print(f"[yellow]검색 색인 갱신 실패 (`tractus index`로 다시 시도):[/yellow] {escape(str(e))}")


@app.command()
def summarize(
    meeting: str = typer.Argument(..., help="회의 폴더 경로 또는 meeting_id (일부만 써도 됨)"),
    provider: str = typer.Option(None, "--provider", help="upstage | openai | claude | gemini | gemma-local. 생략하면 TRACTUS_LLM_PROVIDER"),
    model: str = typer.Option(None, "--model", help="모델 ID. 생략하면 TRACTUS_LLM_MODEL 또는 공급자 기본값"),
) -> None:
    """전사본으로 요약·결정 사항·할 일을 만들어 summary.md와 summary.json에 저장한다. 전사 텍스트만 공급자에 전송한다."""
    from openai import APIError

    d = resolve_meeting(meeting)
    transcript = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
    if not transcript["segments"]:
        console.print("[red]전사된 세그먼트가 없어 요약할 수 없습니다.[/red]")
        raise typer.Exit(1)
    try:
        p, m = resolve_provider(provider, model)
        t0 = time.perf_counter()
        with console.status(f"{p.name}/{m}로 요약 중… (세그먼트 {len(transcript['segments'])}개)"):
            result = summ.summarize(make_client(p), p, m, transcript)
    except LLMError as e:
        console.print(f"[red]{escape(str(e))}[/red]")  # 검증 오류의 [type=…] 같은 대괄호를 rich 마크업으로 해석하지 않게 한다
        raise typer.Exit(1)
    except APIError as e:
        console.print(f"[red]{provider or os.environ.get('TRACTUS_LLM_PROVIDER')} API 오류:[/red] {escape(str(e))}")
        raise typer.Exit(1)
    summ.write_summary(d, result, transcript, p.name, m)
    _sync_index_quietly()
    console.print(
        f"완료: 주제 {len(result.topics)}개, 결정 {len(result.decisions)}개, 할 일 {len(result.action_items)}개 "
        f"({time.perf_counter() - t0:.0f}초)\n{d / 'summary.md'}"
    )


@app.command()
def index(rebuild: bool = typer.Option(False, "--rebuild", help="색인 파일을 지우고 처음부터 다시 만든다")) -> None:
    """회의 폴더를 검색 색인(~/Tractus/.tractus/index.sqlite)에 반영한다. 바뀐 회의만 처리한다."""
    t0 = time.perf_counter()
    with console.status("색인 중… (처음에는 임베딩 모델을 올리느라 몇 초 걸립니다)"):
        idx = _open_index()
        try:
            r = idx.rebuild() if rebuild else idx.sync()  # rebuild는 파일을 지우지 않고 같은 DB를 비운다 (실행 중인 MCP 서버도 같은 DB를 봄)
            st = idx.stats()
            has_embedder = idx.embedder is not None
        finally:
            idx.close()
    console.print(
        f"회의 {st['meetings']}개, 청크 {st['chunks']}개, 벡터 {st['vectors']}개 "
        f"(추가 {r.added}, 갱신 {r.updated}, 삭제 {r.removed}, 임베딩 {r.embedded}, {time.perf_counter() - t0:.1f}초)"
    )
    if not has_embedder:
        console.print("[yellow]임베딩 모델이 없거나 올리지 못해 키워드 검색만 됩니다. README '모델 받기'의 qwen3-embedding-0.6b를 확인하세요.[/yellow]")
    elif st["vectors"] < st["chunks"]:
        console.print(f"[yellow]벡터가 없는 청크 {st['chunks'] - st['vectors']}개가 남았습니다.[/yellow]")
    for err in r.errors:
        console.print(f"[yellow]건너뜀:[/yellow] {escape(err)}")


@app.command()
def search(
    query: str = typer.Argument(..., help="검색어"),
    limit: int = typer.Option(10, "--limit", "-n"),
    date_from: str = typer.Option(None, "--from", help="YYYY-MM-DD", callback=lambda v: _iso_date(v, "--from")),
    date_to: str = typer.Option(None, "--to", help="YYYY-MM-DD", callback=lambda v: _iso_date(v, "--to")),
) -> None:
    """과거 회의를 하이브리드(키워드 + 의미) 검색한다."""
    idx = _open_index()
    try:
        idx.sync()
        res = idx.search(query, limit=limit, date_from=date_from, date_to=date_to)
    finally:
        idx.close()
    if not res.hits:
        console.print("결과 없음")
    for h in res.hits:
        print(f"{h.date} {h.title} ({'+'.join(h.matched)})")
        for s in h.segments:
            print(f"  [{h.meeting_id[-6:]}#{s['id']} {_hms(s['start'])}] {s['text'][:120]}")


def _iso_date(value: str | None, name: str) -> str | None:
    if value is None:
        return None
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError as e:
        raise typer.BadParameter(f"{name}는 YYYY-MM-DD 형식이어야 합니다: {value!r}") from e


@app.command()
def mcp() -> None:
    """MCP 서버(stdio)를 실행한다. Claude Code·Codex·agy에 등록해서 쓴다 (README 'MCP 연동')."""
    from tractus.mcp_server import main as serve

    serve()


if __name__ == "__main__":
    app()
