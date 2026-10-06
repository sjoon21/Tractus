"""tractus CLI."""

import json
import os
import shutil
import sys
import time
import warnings
from dataclasses import dataclass
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
from tractus.env import load_env_all  # noqa: E402
from tractus.llm import LLMError, make_client, resolve_provider  # noqa: E402
from tractus.paths import home_dir, models_dir  # noqa: E402
from tractus.asr import SR, Transcriber  # noqa: E402
from tractus.diarize import MAX_SPEAKERS, MODEL_DIR as DIARIZER_DIR, MODEL_REPO as DIARIZER_REPO, MODEL_REVISION as DIARIZER_REVISION  # noqa: E402
from tractus.diarize import load_diarizer, split_chunks  # noqa: E402
from tractus.export import FORMATS as EXPORT_FORMATS, render_export, write_bytes_atomic  # noqa: E402
from tractus.store import MEMOS_FILE, Job, add_glossary_terms, apply_speaker_edit, apply_text_edits, find_job, find_meeting_dir, find_transcribed  # noqa: E402
from tractus.store import load_glossary, meeting_dir_name, new_ulid, save_transcript, seg_text, speaker_name, write_transcript  # noqa: E402
from tractus.store import _hms  # noqa: E402
from tractus.vad import find_chunks  # noqa: E402

app = typer.Typer(add_completion=False, help="Local-first 회의 전사·회의록 도구")
console = Console(stderr=True, soft_wrap=True)  # 파이프(앱)에서 80칸 줄바꿈 금지: 앱은 stderr 마지막 줄만 보여 준다


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
    """현재 폴더와 $TRACTUS_HOME의 .env / .env.local을 읽는다 (셸 환경변수가 우선)."""
    load_env_all()


class Events:
    """`--progress-json`: 데스크톱 앱이 읽는 JSON Lines 진행 이벤트를 stdout에 쓴다 (docs/desktop.md §2).
    사람용 출력(rich)은 원래대로 stderr로 간다."""

    enabled = False

    @classmethod
    def emit(cls, event: str, **data) -> None:
        if cls.enabled:
            sys.stdout.write(json.dumps({"event": event, **data}, ensure_ascii=False) + "\n")
            sys.stdout.flush()


@dataclass(frozen=True)
class Source:
    """전사할 오디오: 파일 하나, 또는 tractus-rec 녹음 폴더(트랙 여러 개를 섞음)."""

    paths: list[Path]
    name: str
    title: str
    recorded: datetime
    marks: list[dict]
    recording_dir: Path | None = None


def _source_from_recording(d: Path) -> Source:
    try:
        rec = json.loads((d / "recording.json").read_text(encoding="utf-8"))
        tracks = [d / name for name in rec["tracks"].values()]
        started = datetime.fromisoformat(rec["started_at"]).astimezone()
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as e:
        raise typer.BadParameter(f"녹음 폴더가 아닙니다 (recording.json): {e}", param_hint="--recording") from e
    tracks = [p for p in tracks if p.is_file() and p.stat().st_size > 44]  # 44바이트 = 빈 WAV 헤더
    if not tracks:
        raise typer.BadParameter(f"{d}에 녹음된 트랙이 없습니다", param_hint="--recording")
    marks = [m for m in rec.get("marks") or [] if isinstance(m, dict) and isinstance(m.get("t"), (int, float))]
    return Source(paths=tracks, name=d.name, title=f"회의 {started:%H:%M}", recorded=started, marks=marks, recording_dir=d)


def _source_from_file(file: Path) -> Source:
    return Source(paths=[file], name=file.name, title=file.stem, recorded=datetime.fromtimestamp(file.stat().st_mtime).astimezone(), marks=[])


@app.command()
def transcribe(
    file: Path = typer.Argument(None, exists=True, dir_okay=False, help="회의 녹음·동영상 파일 (m4a, mp3, wav, webm, mp4, mov … ffmpeg가 읽는 형식)"),
    recording: Path = typer.Option(None, "--recording", exists=True, file_okay=False, help="tractus-rec 녹음 폴더 (마이크·시스템 트랙을 섞어 전사)"),
    title: str = typer.Option(None, "--title", help="회의 제목. 생략하면 파일 이름 (녹음이면 '회의 HH:MM')"),
    track: Track = typer.Option(None, "--track", help="standard(1.7B) | lite(0.6B). 생략하면 메모리 16GB 이상이면 standard"),
    language: Language = typer.Option(Language.auto, "--language", help="auto 권장. ko로 고정하면 영어 발화를 번역할 수 있음"),
    term: list[str] = typer.Option([], "--term", "-t", help="이 회의의 용어 (참석자 이름·제품명). 여러 번 지정 가능"),
    keep_tracks: bool = typer.Option(False, "--keep-tracks", help="녹음 원본 트랙을 지우지 않고 회의 폴더의 tracks/로 옮긴다"),
    no_diarize: bool = typer.Option(False, "--no-diarize", help="화자 분리를 하지 않는다 (segment.speaker = null)"),
    max_speakers: int = typer.Option(None, "--max-speakers", min=1, max=MAX_SPEAKERS, help=f"화자 수 상한 (1–{MAX_SPEAKERS}). 말한 시간이 많은 N명만 남기고 나머지는 가까운 화자에 붙인다"),
    progress_json: bool = typer.Option(False, "--progress-json", help="진행 이벤트를 stdout에 JSON Lines로 출력 (데스크톱 앱용)"),
) -> None:
    """녹음을 전사해 회의 폴더(audio.ogg, transcript.json/md/vtt)를 만든다. 중단돼도 같은 명령으로 이어서 진행한다."""
    Events.enabled = progress_json
    if (file is None) == (recording is None):
        raise typer.BadParameter("녹음 파일 또는 --recording 폴더 중 하나만 지정하세요")
    try:
        source = _source_from_file(file) if file else _source_from_recording(recording)
        _transcribe(source, title, track, language, term, keep_tracks, not no_diarize, max_speakers)
    except audio.FFmpegError as e:
        Events.emit("error", message=str(e))
        console.print(f"[red]오디오 처리 실패:[/red] {escape(str(e))}")
        raise typer.Exit(1)
    except typer.BadParameter as e:
        Events.emit("error", message=str(e))
        raise


def _transcribe(
    source: Source, title: str | None, track: Track | None, language: Language, term: list[str], keep_tracks: bool, diarize: bool, max_speakers: int | None
) -> None:
    audio.require_ffmpeg()
    meetings = home_dir() / "meetings"
    meetings.mkdir(parents=True, exist_ok=True)

    Events.emit("stage", stage="decode")  # 큰 파일은 해시 계산에도 몇 초 걸린다. 앱이 바로 진행 표시를 하도록 먼저 알린다
    digest = audio.sha256(source.paths)
    if done_dir := find_transcribed(meetings, digest):
        _warn("duplicate", f"이미 전사된 파일입니다: {done_dir}\n다시 전사하려면 이 폴더를 지우고 실행하세요.")
        Events.emit("done", meeting_id=json.loads((done_dir / "transcript.json").read_text(encoding="utf-8"))["meeting_id"], meeting_dir=str(done_dir))
        raise typer.Exit(0)

    job = find_job(meetings, digest)
    if job:
        if track and track.value != job.track:
            console.print(f"[yellow]진행 중인 작업의 트랙({job.track})으로 이어서 합니다.[/yellow]")
        console.print(f"이어서 진행합니다: {job.dir.name} ({len(job.done())}/{len(job.chunks)} 청크 완료)")
        pcm = audio.decode(source.paths)
    else:
        job, pcm = _new_job(source, meetings, digest, title, track or recommended_track(), language, term, diarize, max_speakers)

    _run(job, pcm, source, keep_tracks)


def _warn(code: str, message: str) -> None:
    Events.emit("warning", code=code, message=message)
    console.print(f"[yellow]{escape(message)}[/yellow]")


def _free_mlx() -> None:
    """내린 모델의 MLX 버퍼를 돌려준다. 다음 모델과 통합 메모리에 함께 올라가지 않게 한다."""
    import gc

    import mlx.core as mx

    gc.collect()
    mx.clear_cache()


def _diarize(pcm, max_speakers: int | None) -> tuple[list, dict | None]:
    """회의 전체 화자 분리 → (turn 목록, transcript.json의 diarization). 모델이 없거나 실패하면 화자 없이 진행한다."""
    try:
        diarizer = load_diarizer(models_dir())
        if diarizer is None:
            path = models_dir() / DIARIZER_DIR
            _warn("diarizer_missing", f"화자 분리 모델이 없어 화자 분리 없이 전사합니다: {path}\n  hf download {DIARIZER_REPO} --revision {DIARIZER_REVISION} --local-dir {path}")
            return [], None
        Events.emit("stage", stage="diarize")
        return diarizer.diarize(pcm, max_speakers), diarizer.info
    except Exception as e:  # noqa: BLE001 — 화자 분리 실패가 전사를 막지 않는다
        _warn("diarizer_failed", f"화자 분리에 실패해 화자 분리 없이 전사합니다: {e}")
        return [], None


def _new_job(
    source: Source, meetings: Path, digest: str, title: str | None, track: Track, language: Language, terms: list[str], diarize: bool, max_speakers: int | None
):
    vad_dir, _ = local_model(VAD_MODEL), local_model(MODELS[track])  # 오래 걸리는 작업 전에 모델부터 확인
    with console.status("오디오 디코딩·VAD·화자 분리 중…"):
        pcm = audio.decode(source.paths)
        Events.emit("stage", stage="vad")
        chunks = find_chunks(pcm, vad_dir)
        turns, diarization = _diarize(pcm, max_speakers) if diarize else ([], None)
        _free_mlx()  # 화자 분리 모델을 내린 뒤 ASR 모델을 올린다
        chunks = split_chunks(chunks, turns)

    meeting_id = new_ulid()
    title = title or source.title
    d = meetings / meeting_dir_name(source.recorded.date().isoformat(), title, meeting_id)
    d.mkdir()
    # ponytail: Opus 인코딩 중 강제 종료되면 .job.json 없는 폴더가 남는다. 다음 실행은 새 폴더로 처음부터 진행
    with console.status("원본을 audio.ogg로 보관 중…"):
        Events.emit("stage", stage="encode")
        audio.encode_opus(source.paths, d / "audio.ogg")
    if source.marks:
        (d / MEMOS_FILE).write_text(json.dumps(source.marks, ensure_ascii=False, indent=1), encoding="utf-8")

    hotwords = list(dict.fromkeys(load_glossary(home_dir() / "glossary.md") + terms))
    job = Job(
        dir=d, meeting_id=meeting_id, sha256=digest, source=source.name, title=title,
        created_at=source.recorded.isoformat(timespec="seconds"), duration_sec=round(len(pcm) / SR, 2),
        model=MODELS[track], track=track.value, language=language.value, hotwords=hotwords, chunks=chunks, audio_file="audio.ogg",
        diarizer=diarization,
    )
    job.save()
    n_spk = len({c[2] for c in chunks} - {None})
    console.print(f"회의 폴더: {d}\n트랙 {track.value} ({MODELS[track]}), 청크 {len(chunks)}개, 화자 {n_spk}명(추정), 용어 {len(hotwords)}개")
    return job, pcm


def _finish_recording(source: Source, meeting_dir: Path, keep_tracks: bool) -> None:
    """전사가 끝난 녹음 폴더를 정리한다. 트랙을 보관하면 tracks/로 옮기고, 아니면 지운다."""
    d = source.recording_dir
    if d is None or not (d / "recording.json").is_file():
        return
    if keep_tracks:
        dst = meeting_dir / "tracks"
        dst.mkdir(exist_ok=True)
        for p in [*source.paths, d / "recording.json"]:
            shutil.move(str(p), dst / p.name)
    for p in d.iterdir():  # 녹음 헬퍼가 만든 파일만 있는 폴더다 (트랙, recording.json, 임시 파일)
        if p.is_file():
            p.unlink()
    d.rmdir()


def _run(job: Job, pcm, source: Source, keep_tracks: bool) -> None:
    Events.emit("stage", stage="load_model")
    transcriber = Transcriber.load(local_model(job.model))
    lang = None if job.language == "auto" else job.language
    done = job.done()
    todo = [i for i in range(len(job.chunks)) if i not in done]
    t0, repaired = time.perf_counter(), 0
    columns = [TextColumn("전사"), BarColumn(), MofNCompleteColumn(), TimeElapsedColumn(), TextColumn("남은 시간"), TimeRemainingColumn()]
    try:
        Events.emit("stage", stage="transcribe")
        Events.emit("progress", done=len(done), total=len(job.chunks))
        with Progress(*columns, console=console) as progress:
            bar = progress.add_task("", total=len(job.chunks), completed=len(done))
            for n, i in enumerate(todo, len(done) + 1):
                s, e, _ = job.chunks[i]
                seg = transcriber.transcribe(pcm[s:e], language=lang, hotwords=job.hotwords)
                job.append(i, seg)
                repaired += seg.repaired
                progress.advance(bar)
                Events.emit("progress", done=n, total=len(job.chunks))
    except KeyboardInterrupt:
        console.print("\n중단했습니다. 같은 명령으로 다시 실행하면 이어서 진행합니다.")
        Events.emit("error", message="중단됨 (같은 명령으로 이어서 진행 가능)")
        raise typer.Exit(130)

    elapsed = time.perf_counter() - t0
    t = write_transcript(job)
    # ASR 모델을 내린 뒤 색인한다: 1.7B(3.6GB)와 임베딩 모델(1.4GB)이 통합 메모리에 함께 올라가지 않게
    del transcriber
    _free_mlx()
    _finish_recording(source, job.dir, keep_tracks)
    Events.emit("stage", stage="index")
    _sync_index_quietly()
    rtf = f" (RTF {elapsed / job.duration_sec:.3f})" if not done and job.duration_sec else ""  # 이어하기면 일부만 처리해 RTF가 의미 없음
    console.print(
        f"완료: 세그먼트 {len(t['segments'])}개, 반복 출력 보정 {repaired}건, {elapsed / 60:.1f}분{rtf}\n"
        f"{job.dir / 'transcript.md'}"
    )
    Events.emit("done", meeting_id=job.meeting_id, meeting_dir=str(job.dir))


def resolve_meeting(ref: str) -> Path:
    try:
        return find_meeting_dir(home_dir() / "meetings", ref)
    except LookupError as e:
        raise typer.BadParameter(str(e), param_hint="MEETING") from e


def _open_index():
    from tractus.embed import load_embedder
    from tractus.index import Index

    return Index(home_dir(), embedder=load_embedder(models_dir()))


def _sync_index_quietly(embed: bool = True) -> None:
    """transcribe·summarize 뒤에 검색 색인을 갱신한다. 실패해도 본 작업 결과는 그대로 둔다.
    embed=False면 임베딩 모델(1.4 GB)을 올리지 않는다. 화자 편집은 청크 본문을 바꾸지 않아 기존 벡터를 그대로 쓴다."""
    from tractus.index import Index

    try:
        with console.status("검색 색인 갱신 중…"):
            idx = _open_index() if embed else Index(home_dir())
            try:
                r = idx.sync(embed=embed)
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
    progress_json: bool = typer.Option(False, "--progress-json", help="진행 이벤트를 stdout에 JSON Lines로 출력 (데스크톱 앱용)"),
) -> None:
    """전사본으로 요약·결정 사항·할 일을 만들어 summary.md와 summary.json에 저장한다. 전사 텍스트만 공급자에 전송한다."""
    from openai import APIError

    Events.enabled = progress_json
    try:
        d = resolve_meeting(meeting)
    except typer.BadParameter as e:
        Events.emit("error", message=str(e))
        raise
    transcript = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
    if not transcript["segments"]:
        Events.emit("error", message="전사된 세그먼트가 없어 요약할 수 없습니다")
        console.print("[red]전사된 세그먼트가 없어 요약할 수 없습니다.[/red]")
        raise typer.Exit(1)
    try:
        p, m = resolve_provider(provider, model)
        t0 = time.perf_counter()
        Events.emit("stage", stage="summarize")
        with console.status(f"{p.name}/{m}로 요약 중… (세그먼트 {len(transcript['segments'])}개)"):
            result = summ.summarize(make_client(p), p, m, transcript)
    except LLMError as e:
        Events.emit("error", message=str(e))
        console.print(f"[red]{escape(str(e))}[/red]")  # 검증 오류의 [type=…] 같은 대괄호를 rich 마크업으로 해석하지 않게 한다
        raise typer.Exit(1)
    except APIError as e:
        Events.emit("error", message=f"API 오류: {e}")
        console.print(f"[red]{provider or os.environ.get('TRACTUS_LLM_PROVIDER')} API 오류:[/red] {escape(str(e))}")
        raise typer.Exit(1)
    summ.write_summary(d, result, transcript, p.name, m)
    Events.emit("stage", stage="index")
    _sync_index_quietly()
    Events.emit("done", meeting_id=transcript["meeting_id"], meeting_dir=str(d))
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
            who = f" {s['speaker']}" if s.get("speaker") else ""
            print(f"  [{h.meeting_id[-6:]}#{s['id']} {_hms(s['start'])}{who}] {seg_text(s)[:120]}")


def _iso_date(value: str | None, name: str) -> str | None:
    if value is None:
        return None
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError as e:
        raise typer.BadParameter(f"{name}는 YYYY-MM-DD 형식이어야 합니다: {value!r}") from e


speakers_app = typer.Typer(help="회의의 화자 보기·이름 짓기·고치기. transcript.json과 md·vtt를 다시 쓰고 검색 색인을 갱신한다 (오디오는 건드리지 않음)")
app.add_typer(speakers_app, name="speakers")


@speakers_app.callback()
def speakers_main(ctx: typer.Context, meeting: str = typer.Argument(..., help="회의 폴더 경로 또는 meeting_id (일부만 써도 됨)")) -> None:
    ctx.obj = resolve_meeting(meeting)


def _read_transcript(d: Path) -> dict:
    return json.loads((d / "transcript.json").read_text(encoding="utf-8"))


@speakers_app.command("list")
def speakers_list(ctx: typer.Context, as_json: bool = typer.Option(False, "--json", help="JSON으로 stdout에 출력 (데스크톱 앱용)")) -> None:
    """화자별 이름·세그먼트 수·발화 시간."""
    t = _read_transcript(ctx.obj)
    rows = [
        {"label": label, "name": (info or {}).get("name"), "display": speaker_name(t, label),
         "segments": sum(1 for s in t["segments"] if s.get("speaker") == label),
         "talk_sec": round(sum(s["end"] - s["start"] for s in t["segments"] if s.get("speaker") == label), 2)}
        for label, info in (t.get("speakers") or {}).items()
    ]
    if as_json:
        print(json.dumps({"meeting_id": t["meeting_id"], "speakers": rows, "diarization": t.get("diarization")}, ensure_ascii=False))
        return
    if not rows:
        print("화자 정보가 없습니다 (화자 분리 없이 전사됨). `tractus speakers <회의> set <세그먼트> new`로 직접 붙일 수 있습니다")
    for r in rows:
        print(f"{r['label']}\t{r['name'] or '-'}\t세그먼트 {r['segments']}개\t{_hms(r['talk_sec'])}")


def _edit_speakers(d: Path, op: str, *args: str) -> None:
    try:
        t = apply_speaker_edit(_read_transcript(d), op, *args)
    except ValueError as e:
        console.print(f"[red]{escape(str(e))}[/red]")
        raise typer.Exit(1)
    save_transcript(d, t)
    _sync_index_quietly(embed=False)
    console.print(f"저장했습니다: {d / 'transcript.json'}")


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


segments_app = typer.Typer(help="회의 전사 텍스트 고치기. 원문(text)은 두고 corrected_text에 쓴 뒤 md·vtt를 다시 쓰고 검색 색인을 갱신한다")
app.add_typer(segments_app, name="segments")


@segments_app.callback()
def segments_main(ctx: typer.Context, meeting: str = typer.Argument(..., help="회의 폴더 경로 또는 meeting_id (일부만 써도 됨)")) -> None:
    ctx.obj = resolve_meeting(meeting)


@segments_app.command("edit")
def segments_edit(ctx: typer.Context) -> None:
    """stdin의 JSON 한 개 {"edits": [{"id": "s0012", "text": "새 문장"}]}로 세그먼트 텍스트를 고친다.
    원문과 같으면 교정을 지운다. 없는 id·빈 텍스트가 하나라도 있으면 아무것도 쓰지 않고 종료 코드 1. stdout: {"changed": N}"""
    d = ctx.obj
    try:
        req = json.loads(sys.stdin.read())
        edits = req.get("edits") if isinstance(req, dict) else None
        if not isinstance(edits, list):
            raise ValueError('입력은 {"edits": [{"id": "s0012", "text": "…"}]} 형식이어야 합니다')
        t, changed = apply_text_edits(_read_transcript(d), edits)
    except ValueError as e:  # json.JSONDecodeError 포함
        console.print(f"[red]{escape(str(e))}[/red]")
        raise typer.Exit(1)
    if changed:
        save_transcript(d, t)
        _sync_index_quietly(embed=False)  # 바뀐 청크는 벡터 없이 키워드로만 찾힌다. 다음 `tractus index`나 전사·요약 때 임베딩
    print(json.dumps({"changed": changed}))


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


ExportFormat = Enum("ExportFormat", {f: f for f in EXPORT_FORMATS}, type=str)


@app.command("export")
def export_cmd(
    meeting: str = typer.Argument(..., help="회의 폴더 경로 또는 meeting_id (일부만 써도 됨)"),
    fmt: ExportFormat = typer.Option(..., "--format", help="txt | md | srt | vtt | csv | docx | bundle(회의 폴더 zip)"),
    out: Path = typer.Option(..., "--out", help="저장할 파일 경로"),
    force: bool = typer.Option(False, "--force", help="--out 파일이 있으면 덮어쓴다"),
) -> None:
    """회의를 파일로 내보낸다. 화자는 표시 이름, 본문은 교정본(corrected_text) 우선. stdout: {"path": "<절대 경로>"}"""
    d = resolve_meeting(meeting)
    if out.exists() and not force:
        console.print(f"[red]이미 있는 파일입니다 (덮어쓰려면 --force):[/red] {escape(str(out))}")
        raise typer.Exit(1)
    try:
        write_bytes_atomic(out, render_export(d, fmt.value))
    except OSError as e:  # 임시 파일(.tmp) 경로 대신 사용자가 고른 경로를 알린다
        console.print(f"[red]내보내기 실패:[/red] {escape(str(out))}: {escape(e.strerror or str(e))}")
        raise typer.Exit(1)
    except ValueError as e:  # 제목 등에 남은 제어 문자를 docx(lxml)가 거부하는 경우
        console.print(f"[red]내보내기 실패:[/red] {escape(str(e))}")
        raise typer.Exit(1)
    print(json.dumps({"path": str(out.resolve())}, ensure_ascii=False))


@app.command()
def mcp() -> None:
    """MCP 서버(stdio)를 실행한다. Claude Code·Codex·agy에 등록해서 쓴다 (README 'MCP 연동')."""
    from tractus.mcp_server import main as serve

    serve()


if __name__ == "__main__":
    app()
