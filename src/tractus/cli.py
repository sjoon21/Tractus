"""tractus CLI."""

import json
import os
import time
import warnings
from datetime import datetime
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
from tractus.asr import SR, Transcriber  # noqa: E402
from tractus.store import Job, find_job, find_transcribed, load_glossary, meeting_dir_name, new_ulid, write_transcript  # noqa: E402
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


def home_dir() -> Path:
    return Path(os.environ.get("TRACTUS_HOME", Path.home() / "Tractus")).expanduser()


def models_dir() -> Path:
    return Path(os.environ.get("TRACTUS_MODELS_DIR", home_dir() / "models")).expanduser()


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
    rtf = f" (RTF {elapsed / job.duration_sec:.3f})" if not done and job.duration_sec else ""  # 이어하기면 일부만 처리해 RTF가 의미 없음
    console.print(
        f"완료: 세그먼트 {len(t['segments'])}개, 반복 출력 보정 {repaired}건, {elapsed / 60:.1f}분{rtf}\n"
        f"{job.dir / 'transcript.md'}"
    )


def resolve_meeting(ref: str) -> Path:
    """회의 폴더 경로 또는 meeting_id(일부)로 회의 폴더를 찾는다."""
    path = Path(ref).expanduser()
    if (path / "transcript.json").is_file():
        return path
    hits = [d for d in (home_dir() / "meetings").glob(f"*{ref}*") if (d / "transcript.json").is_file()]
    if len(hits) != 1:
        found = "없습니다" if not hits else f"{len(hits)}개입니다: " + ", ".join(d.name for d in hits[:5])
        raise typer.BadParameter(f"{ref!r}에 맞는 전사된 회의가 {found}", param_hint="MEETING")
    return hits[0]


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
    console.print(
        f"완료: 주제 {len(result.topics)}개, 결정 {len(result.decisions)}개, 할 일 {len(result.action_items)}개 "
        f"({time.perf_counter() - t0:.0f}초)\n{d / 'summary.md'}"
    )


if __name__ == "__main__":
    app()
