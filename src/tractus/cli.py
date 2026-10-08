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
from typing import NoReturn

os.environ.setdefault("TQDM_DISABLE", "1")
warnings.filterwarnings("ignore")

import typer  # noqa: E402
from rich.console import Console  # noqa: E402
from rich.markup import escape  # noqa: E402
from rich.progress import BarColumn, MofNCompleteColumn, Progress, TextColumn, TimeElapsedColumn, TimeRemainingColumn  # noqa: E402

from tractus import audio  # noqa: E402
from tractus import live as live_mod  # noqa: E402
from tractus import voices  # noqa: E402
from tractus import summarize as summ  # noqa: E402
from tractus.env import load_env_all  # noqa: E402
from tractus.llm import LLMError, make_client, resolve_provider  # noqa: E402
from tractus.paths import home_dir, models_dir  # noqa: E402
from tractus.align import MODEL_DIR as ALIGNER_DIR, MODEL_REPO as ALIGNER_REPO, MODEL_REVISION as ALIGNER_REVISION  # noqa: E402
from tractus.align import align_segments, load_aligner  # noqa: E402
from tractus.asr import SR, Transcriber  # noqa: E402
from tractus.diarize import FLUID, MAX_SPEAKERS, NEMOTRON, MODEL_DIR as DIARIZER_DIR, MODEL_REPO as DIARIZER_REPO, MODEL_REVISION as DIARIZER_REVISION  # noqa: E402
from tractus.diarize import fluid_hint, load_diarizer, load_fluid, split_chunks  # noqa: E402
from tractus.export import FORMATS as EXPORT_FORMATS, render_export, write_bytes_atomic  # noqa: E402
from tractus.store import MEMOS_FILE, Job, add_glossary_terms, apply_speaker_edit, apply_suggestions, apply_text_edits, find_job, find_meeting_dir, find_transcribed  # noqa: E402
from tractus.store import IncompleteError, load_glossary, meeting_dir_name, new_ulid, save_transcript, seg_text, speaker_name, write_transcript  # noqa: E402
from tractus.store import _hms  # noqa: E402
from tractus.vad import find_chunks  # noqa: E402

app = typer.Typer(add_completion=False, help="Local-first 노트·녹음 도구")
console = Console(stderr=True, soft_wrap=True)  # 파이프(앱)에서 80칸 줄바꿈 금지: 앱은 stderr 마지막 줄만 보여 준다


class Track(str, Enum):
    standard = "standard"
    lite = "lite"


class DiarizerEngine(str, Enum):
    auto = "auto"
    nemotron = NEMOTRON
    fluid = FLUID


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


def physical_memory() -> int:
    return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")


def recommended_track() -> Track:
    return Track.standard if physical_memory() >= STANDARD_MIN_MEMORY else Track.lite


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


def _emit_error(message: str, code: str | None = None) -> None:
    """오류 이벤트. code가 있으면 앱이 WORDS.md 문장으로 바꾸고 message는 `자세히`에 둔다 (docs/desktop.md §2)."""
    Events.emit("error", message=message, **({"code": code} if code else {}))


def _fail(message: str, code: str | None = None, exit_code: int = 1) -> NoReturn:
    _emit_error(message, code)
    console.print(f"[red]{escape(message)}[/red]")
    raise typer.Exit(exit_code)


def _fail_audio(e: audio.FFmpegError) -> NoReturn:
    """ffmpeg가 없으면 설치 안내(ffmpeg_missing), 그 밖의 ffmpeg 실패는 audio_failed."""
    if isinstance(e, audio.FFmpegMissing):
        _fail(str(e), code="ffmpeg_missing")
    _fail(f"음성 파일을 읽지 못했습니다: {e}", code="audio_failed")


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
        raise typer.BadParameter(f"녹음 파일을 찾지 못했습니다 (recording.json): {e}", param_hint="--recording") from e
    tracks = [p for p in tracks if p.is_file() and p.stat().st_size > 44]  # 44바이트 = 빈 WAV 헤더
    if not tracks:
        raise typer.BadParameter(f"{d}에 녹음된 소리가 없습니다", param_hint="--recording")
    marks = [m for m in rec.get("marks") or [] if isinstance(m, dict) and isinstance(m.get("t"), (int, float))]
    return Source(paths=tracks, name=d.name, title=f"녹음 {started:%H:%M}", recorded=started, marks=marks, recording_dir=d)


def _source_from_file(file: Path) -> Source:
    return Source(paths=[file], name=file.name, title=file.stem, recorded=datetime.fromtimestamp(file.stat().st_mtime).astimezone(), marks=[])


@app.command()
def transcribe(
    file: Path = typer.Argument(None, exists=True, dir_okay=False, help="녹음·동영상 파일 (m4a, mp3, wav, webm, mp4, mov … ffmpeg가 읽는 형식)"),
    recording: Path = typer.Option(None, "--recording", exists=True, file_okay=False, help="tractus-rec 녹음 폴더 (마이크·시스템 트랙을 섞어 전사)"),
    title: str = typer.Option(None, "--title", help="노트 제목. 생략하면 파일 이름 (녹음이면 '녹음 HH:MM')"),
    track: Track = typer.Option(None, "--track", help="standard(1.7B) | lite(0.6B). 생략하면 메모리 16GB 이상이면 standard"),
    language: Language = typer.Option(Language.auto, "--language", help="auto 권장. ko로 고정하면 영어 발화를 번역할 수 있음"),
    term: list[str] = typer.Option([], "--term", "-t", help="이 노트의 용어 (참석자 이름·제품명). 여러 번 지정 가능"),
    keep_tracks: bool = typer.Option(False, "--keep-tracks", help="녹음 원본 트랙을 지우지 않고 노트 폴더의 tracks/로 옮긴다"),
    no_diarize: bool = typer.Option(False, "--no-diarize", help="화자 분리를 하지 않는다 (segment.speaker = null)"),
    max_speakers: int = typer.Option(None, "--max-speakers", min=1, help=f"화자 수 상한. 말한 시간이 많은 N명만 남기고 나머지는 가까운 화자에 붙인다 (nemotron은 {MAX_SPEAKERS}명이 한계)"),
    diarizer: DiarizerEngine = typer.Option(
        DiarizerEngine.auto, "--diarizer",
        help=f"auto(권장): nemotron으로 돌리고 {MAX_SPEAKERS}명을 모두 쓰면 fluid로 다시 돌린다 | nemotron | fluid(Swift 헬퍼 tractus-diar, 9명 이상)"),
    no_align: bool = typer.Option(False, "--no-align", help="단어 타이밍을 만들지 않는다 (segment.words = null, 나중에 `tractus align`)"),
    progress_json: bool = typer.Option(False, "--progress-json", help="진행 이벤트를 stdout에 JSON Lines로 출력 (데스크톱 앱용)"),
) -> None:
    """녹음을 전사해 노트 폴더(audio.ogg, transcript.json/md/vtt)를 만든다. 중단돼도 같은 명령으로 이어서 진행한다."""
    Events.enabled = progress_json
    if (file is None) == (recording is None):
        raise typer.BadParameter("녹음 파일 또는 --recording 폴더 중 하나만 지정하세요")
    try:
        source = _source_from_file(file) if file else _source_from_recording(recording)
    except typer.BadParameter as e:
        _emit_error(str(e), code="recording_missing")
        raise
    try:
        _transcribe(source, title, track, language, term, keep_tracks, not no_diarize, max_speakers, not no_align, diarizer)
    except audio.FFmpegError as e:
        _fail_audio(e)
    except typer.BadParameter as e:  # local_model: 변환 엔진(모델) 파일 없음
        _emit_error(str(e), code="model_missing")
        raise


def _transcribe(
    source: Source, title: str | None, track: Track | None, language: Language, term: list[str], keep_tracks: bool, diarize: bool, max_speakers: int | None,
    align: bool = True, engine: DiarizerEngine = DiarizerEngine.auto,
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
        console.print(f"이어서 진행합니다: {job.dir.name} ({len(job.done())}/{len(job.chunks)} 청크 완료)")  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)
        pcm = audio.decode(source.paths)
    else:
        job, pcm = _new_job(source, meetings, digest, title, track or recommended_track(), language, term, diarize, max_speakers, engine)

    _run(job, pcm, source, keep_tracks, align)


def _warn(code: str, message: str) -> None:
    Events.emit("warning", code=code, message=message)
    console.print(f"[yellow]{escape(message)}[/yellow]")


def _free_mlx() -> None:
    """내린 모델의 MLX 버퍼를 돌려준다. 다음 모델과 통합 메모리에 함께 올라가지 않게 한다."""
    import gc

    import mlx.core as mx

    gc.collect()
    mx.clear_cache()


def _run_diarizer(engine: str, diarizer, pcm, max_speakers: int | None, fallback: str, code: str = "diarizer_failed") -> tuple[list, dict] | None:
    """→ (turn 목록, diarization). 실패하면 경고(code)하고 None. fallback: 실패 뒤 어떻게 하는지 (경고 문구)."""
    try:
        Events.emit("stage", stage="diarize", engine=engine)
        return diarizer.diarize(pcm, max_speakers), diarizer.info
    except Exception as e:  # noqa: BLE001 — 화자 분리 실패가 전사를 막지 않는다
        _warn(code, f"화자 분리({engine})에 실패해 {fallback}: {e}")
        return None


def _diarize(pcm, max_speakers: int | None, engine: DiarizerEngine = DiarizerEngine.auto) -> tuple[list, dict | None]:
    """노트 전체 화자 분리 → (turn 목록, transcript.json의 diarization). 모델이 없거나 실패하면 화자 없이 진행한다.

    auto: Nemotron을 돌리고 8채널을 모두 썼으면(9명 이상일 수 있음) fluid로 다시 돌린다. --max-speakers가 8 이하면 그대로.
    fluid: 헬퍼·모델이 없거나 실패하면 Nemotron으로 돌린다."""
    models = models_dir()
    if engine is DiarizerEngine.fluid:
        fluid = load_fluid(models)
        if fluid is None:
            _warn("fluid_missing", f"fluid 화자 분리 헬퍼나 모델이 없어 Nemotron으로 화자 분리합니다:\n{fluid_hint(models)}")
        elif res := _run_diarizer(FLUID, fluid, pcm, max_speakers, "Nemotron으로 다시 합니다"):
            return res

    try:
        nemotron = load_diarizer(models)
    except Exception as e:  # noqa: BLE001
        _warn("diarizer_failed", f"화자 분리 모델을 올리지 못해 화자 분리 없이 전사합니다: {e}")
        return [], None
    if nemotron is None:
        path = models / DIARIZER_DIR
        _warn("diarizer_missing", f"화자 분리 모델이 없어 화자 분리 없이 전사합니다: {path}\n  hf download {DIARIZER_REPO} --revision {DIARIZER_REVISION} --local-dir {path}")
        return [], None
    res = _run_diarizer(NEMOTRON, nemotron, pcm, max_speakers, "화자 분리 없이 전사합니다")
    if res is None:
        return [], None
    capped = len({spk for _, _, spk in res[0]}) >= MAX_SPEAKERS and (max_speakers is None or max_speakers > MAX_SPEAKERS)
    if engine is not DiarizerEngine.auto or not capped:
        return res
    nemotron = None
    _free_mlx()  # Nemotron을 내린 뒤 헬퍼(CoreML, 별도 프로세스)를 돌린다
    fluid = load_fluid(models)
    if fluid is None:
        _warn("diarizer_cap", f"화자가 {MAX_SPEAKERS}명을 넘을 수 있지만 fluid 헬퍼나 모델이 없어 {MAX_SPEAKERS}명으로 나눕니다:\n{fluid_hint(models)}")
        return res
    return _run_diarizer(FLUID, fluid, pcm, max_speakers, f"Nemotron 결과({MAX_SPEAKERS}명)를 씁니다", "diarizer_cap_failed") or res


def _suggest_voices(pcm, turns: list[dict]) -> dict:
    """화자 분리 결과를 등록된 목소리와 맞춘 제안 {라벨: {person_id, name, score}}. 등록된 사람이 없으면 조용히 건너뛴다.
    모델이 없거나 실패해도 전사는 계속한다 (onnxruntime CPU라 MLX 메모리와 겹치지 않는다)."""
    try:
        people = voices.usable_people(voices.load_profiles(home_dir()))
        if not people or not turns:
            return {}
        embedder = voices.load_embedder(models_dir())
        if embedder is None:
            _warn("voices_model_missing", f"목소리 모델이 없어 등록된 목소리를 맞춰 보지 않습니다: {voices.model_hint(models_dir())}")
            return {}
        Events.emit("stage", stage="voices")
        return voices.suggest(embedder, pcm, turns, people, sorted({t["speaker"] for t in turns}))
    except Exception as e:  # noqa: BLE001 — 목소리 제안 실패가 전사를 막지 않는다
        _warn("voices_failed", f"등록된 목소리를 맞춰 보지 못했습니다 (`tractus voices match <노트>`로 다시 시도): {e}")
        return {}


def _aligner_hint() -> str:
    path = models_dir() / ALIGNER_DIR
    return f"{path}\n  hf download {ALIGNER_REPO} --revision {ALIGNER_REVISION} --local-dir {path}"


def _align_progress() -> Progress:
    return Progress(TextColumn("단어 타이밍"), BarColumn(), MofNCompleteColumn(), TimeElapsedColumn(), console=console)


def _save_words(d: Path, segments: list[dict], ids: set[str]) -> dict:
    """정렬한 words를 transcript.json에 쓴다. transcript.json이 있으면 앱이 이미 편집할 수 있으므로 정렬하는 동안 고친
    세그먼트·화자를 덮어쓰지 않게, 다시 읽고 표시 텍스트가 그대로인 세그먼트에만 words를 쓴다 (나머지 필드는 다시 읽은 쪽).
    → {"aligned", "failed", "skipped"}"""
    # ponytail: 다시 읽기와 쓰기 사이(수 ms)의 편집은 잃을 수 있다. 잠금이 필요하면 store에 파일 잠금을 둔다
    new = {s["id"]: s for s in segments if s["id"] in ids}
    cur = _read_transcript(d)
    counts = {"aligned": 0, "failed": 0}
    merged = []
    for s in cur["segments"]:
        a = new.get(s["id"])
        if a is not None and seg_text(a) == seg_text(s):
            merged.append({**s, "words": a["words"]})
            counts["aligned" if a["words"] is not None else "failed"] += 1
        else:
            merged.append(s)
    save_transcript(d, {**cur, "segments": merged})
    return {**counts, "skipped": len(merged) - counts["aligned"] - counts["failed"]}


def _align(d: Path, t: dict, pcm) -> None:
    """전사 뒤 단어 타이밍을 채워 다시 저장한다. 모델이 없거나 실패하면 words = null로 두고 경고만 한다 (`tractus align`으로 나중에)."""
    if not t["segments"]:
        return
    try:
        aligner = load_aligner(models_dir())
        if aligner is None:
            _warn("aligner_missing", f"단어 타이밍 모델이 없어 단어 타이밍 없이 저장합니다: {_aligner_hint()}")
            return
        Events.emit("stage", stage="align")
        with _align_progress() as progress:
            bar = progress.add_task("", total=len(t["segments"]))

            def tick(n: int, total: int) -> None:
                progress.advance(bar)
                Events.emit("progress", done=n, total=total)

            segments, _, _ = align_segments(aligner, pcm, t["segments"], on_progress=tick)
    except Exception as e:  # noqa: BLE001 — 단어 타이밍 실패가 전사를 막지 않는다
        _warn("aligner_failed", f"단어 타이밍을 만들지 못했습니다 (`tractus align {t['meeting_id']}`로 다시 시도): {e}")
        return
    failed = _save_words(d, segments, {s["id"] for s in t["segments"]})["failed"]
    if failed:
        console.print(f"[yellow]단어 타이밍을 맞추지 못한 세그먼트 {failed}개 (세그먼트 단위로만 이동)[/yellow]")  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)


def _new_job(
    source: Source, meetings: Path, digest: str, title: str | None, track: Track, language: Language, terms: list[str], diarize: bool, max_speakers: int | None,
    engine: DiarizerEngine = DiarizerEngine.auto,
):
    vad_dir, _ = local_model(VAD_MODEL), local_model(MODELS[track])  # 오래 걸리는 작업 전에 모델부터 확인
    with console.status("오디오 디코딩·VAD·화자 분리 중…"):
        pcm = audio.decode(source.paths)
        Events.emit("stage", stage="vad")
        chunks = find_chunks(pcm, vad_dir)
        turns, diarization = _diarize(pcm, max_speakers, engine) if diarize else ([], None)
        _free_mlx()  # 화자 분리 모델을 내린 뒤 ASR 모델을 올린다
        chunks = split_chunks(chunks, turns)
        suggestions = _suggest_voices(pcm, [{"start": s, "end": e, "speaker": spk} for s, e, spk in turns])

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
        diarizer=diarization, suggestions=suggestions,
    )
    job.save()
    n_spk = len({c[2] for c in chunks} - {None})
    console.print(f"노트 폴더: {d}\n트랙 {track.value} ({MODELS[track]}), 청크 {len(chunks)}개, 화자 {n_spk}명(추정), 용어 {len(hotwords)}개")  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)
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


def _run(job: Job, pcm, source: Source, keep_tracks: bool, align: bool = True) -> None:
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
        console.print()
        _fail("변환을 중단했습니다. 같은 명령으로 다시 실행하면 이어서 진행합니다.", code="interrupted", exit_code=130)

    elapsed = time.perf_counter() - t0
    try:
        t = write_transcript(job)
    except IncompleteError as e:
        _fail(str(e), code="incomplete")
    # ASR 모델을 내린 뒤 색인한다: 1.7B(3.6GB)와 임베딩 모델(1.4GB)이 통합 메모리에 함께 올라가지 않게
    del transcriber
    _free_mlx()
    _finish_recording(source, job.dir, keep_tracks)  # 전사는 저장됐다. 정렬 중에 끊겨도 녹음 폴더가 남지 않게 먼저 정리한다
    if align:
        try:
            _align(job.dir, t, pcm)
        except KeyboardInterrupt:
            console.print()
            _fail(f"단어 싱크를 맞추다가 중단했습니다. 대화 내용은 저장했고, `tractus align {job.meeting_id}`로 나중에 맞출 수 있습니다.", code="align_interrupted", exit_code=130)
        _free_mlx()  # 정렬 모델을 내린 뒤 임베딩 모델을 올린다
    Events.emit("stage", stage="index")
    _sync_index_quietly()
    rtf = f" (RTF {elapsed / job.duration_sec:.3f})" if not done and job.duration_sec else ""  # 이어하기면 일부만 처리해 RTF가 의미 없음
    console.print(
        f"완료: 세그먼트 {len(t['segments'])}개, 반복 출력 보정 {repaired}건, {elapsed / 60:.1f}분{rtf}\n"
        f"{job.dir / 'transcript.md'}"
    )
    Events.emit("done", meeting_id=job.meeting_id, meeting_dir=str(job.dir))


@app.command("live")
def live_cmd(
    recording: Path = typer.Option(..., "--recording", exists=True, file_okay=False, help="녹음 중인 tractus-rec 폴더"),
    force: bool = typer.Option(False, "--force", help="메모리 16GB 미만 기기에서도 실행한다"),
    speakers: bool = typer.Option(False, "--speakers", help="실시간 화자 라벨(S1…, 미리보기 전용). GPU 사용률이 약 두 배가 된다"),
    progress_json: bool = typer.Option(False, "--progress-json", help="자막 이벤트를 stdout에 JSON Lines로 출력 (데스크톱 앱용)"),
) -> None:
    """녹음 중 실시간 자막(미리보기). Qwen3-ASR 0.6B로 발화마다 전사해 내보내고 아무것도 저장하지 않는다.
    stdin에 `stop` 줄, stdin EOF, SIGTERM이면 마무리하고 종료 코드 0으로 끝난다. 정식 전사는 녹음을 멈춘 뒤 `transcribe --recording`."""
    import signal
    import threading

    Events.enabled = progress_json

    memory = physical_memory()
    if memory < STANDARD_MIN_MEMORY and not force:
        _fail(f"실시간 텍스트 변환은 메모리 16GB 이상에서만 켭니다 (이 Mac {memory / 1024**3:.0f}GB). 녹음과 함께 약 2GB를 더 써서 녹음 뒤 변환이 느려지거나 메모리가 부족할 수 있습니다. 그래도 쓰려면 --force", code="live_low_memory")
    try:
        vad_dir, asr_dir = local_model(VAD_MODEL), local_model(MODELS[Track.lite])
    except typer.BadParameter as e:
        _fail(str(e), code="model_missing")

    stop = threading.Event()

    def watch_stdin() -> None:
        for line in sys.stdin:
            if line.strip() == "stop":
                break
        stop.set()  # stop 줄 또는 EOF (부모 앱이 죽어도 고아로 남지 않게)

    threading.Thread(target=watch_stdin, daemon=True).start()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    hotwords = load_glossary(home_dir() / "glossary.md")
    try:
        live_mod.run(recording, Events.emit, _warn, stop, vad_dir, asr_dir, models_dir() / DIARIZER_DIR if speakers else None, hotwords)
    except (live_mod.LiveError, ValueError, OSError) as e:
        _fail(f"실시간 텍스트 변환을 멈췄습니다: {e}", code="live_failed")


@app.command("align")
def align_cmd(
    meeting: str = typer.Argument(..., help="노트 폴더 경로 또는 meeting_id (일부만 써도 됨)"),
    force: bool = typer.Option(False, "--force", help="이미 단어 타이밍이 있는 세그먼트도 다시 맞춘다"),
    progress_json: bool = typer.Option(False, "--progress-json", help="진행 이벤트를 stdout에 JSON Lines로 출력 (데스크톱 앱용)"),
) -> None:
    """기존 노트의 단어 타이밍(segment.words)을 채운다. 기본은 words가 없는 세그먼트만.
    stdout: {"aligned": N, "failed": M, "skipped": K} (--progress-json이면 같은 값이 done 이벤트에 들어간다)"""
    Events.enabled = progress_json

    try:
        d = resolve_meeting(meeting)
    except typer.BadParameter as e:
        _emit_error(str(e))
        raise
    t = _read_transcript(d)
    todo = {s["id"] for s in t["segments"] if force or s.get("words") is None}
    counts = {"aligned": 0, "failed": 0, "skipped": len(t["segments"])}
    if todo:
        aligner = load_aligner(models_dir())
        if aligner is None:
            _fail(f"단어 싱크 엔진 파일이 없습니다: {_aligner_hint()}", code="model_missing")
        try:
            audio.require_ffmpeg()
            Events.emit("stage", stage="decode")
            pcm = audio.decode(d / t["audio"]["file"])
        except audio.FFmpegError as e:
            _fail_audio(e)
        Events.emit("stage", stage="align")
        t0 = time.perf_counter()
        with _align_progress() as progress:
            bar = progress.add_task("", total=len(todo))

            def tick(n: int, total: int) -> None:
                progress.advance(bar)
                Events.emit("progress", done=n, total=total)

            segments, _, _ = align_segments(aligner, pcm, t["segments"], on_progress=tick, only=todo)
        counts = _save_words(d, segments, todo)
        console.print(f"단어 타이밍: 성공 {counts['aligned']}, 실패 {counts['failed']}, 건너뜀 {counts['skipped']} ({time.perf_counter() - t0:.1f}초)")  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)
    if progress_json:
        Events.emit("done", meeting_id=t["meeting_id"], meeting_dir=str(d), **counts)
    else:
        print(json.dumps(counts))


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
            console.print(f"검색 색인: 추가 {r.added}, 갱신 {r.updated}")  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)
        if r.errors:
            console.print(f"[yellow]색인하지 못한 항목 {len(r.errors)}개 — `tractus index`로 자세히 확인[/yellow]")  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)
    except Exception as e:  # noqa: BLE001 — 색인은 언제든 `tractus index`로 다시 만들 수 있다
        console.print(f"[yellow]검색 색인 갱신 실패 (`tractus index`로 다시 시도):[/yellow] {escape(str(e))}")  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)


@app.command()
def summarize(
    meeting: str = typer.Argument(..., help="노트 폴더 경로 또는 meeting_id (일부만 써도 됨)"),
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
        _emit_error(str(e))
        raise
    transcript = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
    if not transcript["segments"]:
        _fail("인식된 대화가 없어 요약할 수 없습니다", code="no_segments")
    try:
        p, m = resolve_provider(provider, model)
        t0 = time.perf_counter()
        Events.emit("stage", stage="summarize")
        with console.status(f"{p.name}/{m}로 요약 중… (세그먼트 {len(transcript['segments'])}개)"):
            result = summ.summarize(make_client(p), p, m, transcript)
    except LLMError as e:
        if e.code == "llm_invalid":  # 검증 오류 원문(pydantic, s0012 ID)은 stderr에만 남긴다
            console.print(f"[red]{escape(str(e))}[/red]")  # 검증 오류의 [type=…] 같은 대괄호를 rich 마크업으로 해석하지 않게 한다
            _fail("AI 응답이 형식에 맞지 않아 요약하지 못했습니다", code=e.code)
        _fail(str(e), code=e.code)
    except APIError as e:
        _fail(f"AI 서비스 오류: {e}", code="llm_api")
    summ.write_summary(d, result, transcript, p.name, m)
    Events.emit("stage", stage="index")
    _sync_index_quietly()
    Events.emit("done", meeting_id=transcript["meeting_id"], meeting_dir=str(d))
    console.print(
        f"완료: 주제 {len(result.topics)}개, 결정 {len(result.decisions)}개, 할 일 {len(result.action_items)}개 "
        f"({time.perf_counter() - t0:.0f}초)\n{d / 'summary.md'}"
    )


def _save_chat(d: Path, question: str, done: dict) -> None:
    from tractus.ask import save_chat

    try:
        save_chat(d, _read_transcript(d)["meeting_id"], {"question": question, **{k: done[k] for k in ("answer", "citations", "provider", "model")}})
    except (OSError, ValueError) as e:  # ValueError: 깨졌거나 다른 형식의 chat.json (덮어쓰지 않음)
        _warn("chat_save_failed", f"질문 기록을 저장하지 못했습니다: {e}")


@app.command()
def ask(
    meeting: str = typer.Option(None, "--meeting", help="이 노트 전사 전체로 답한다 (meeting_id 일부 또는 폴더). 생략하면 모든 노트에서 검색"),
    date_from: str = typer.Option(None, "--from", help="YYYY-MM-DD (전체 범위 검색에만)", callback=lambda v: _iso_date(v, "--from")),
    date_to: str = typer.Option(None, "--to", help="YYYY-MM-DD (전체 범위 검색에만)", callback=lambda v: _iso_date(v, "--to")),
    provider: str = typer.Option(None, "--provider", help="upstage | openai | claude | gemini | gemma-local. 생략하면 TRACTUS_LLM_PROVIDER"),
    model: str = typer.Option(None, "--model", help="모델 ID. 생략하면 TRACTUS_LLM_MODEL 또는 공급자 기본값"),
    save: bool = typer.Option(False, "--save", help="질문·답을 노트 폴더 chat.json에 덧붙인다 (--meeting과 함께)"),
    progress_json: bool = typer.Option(False, "--progress-json", help="이벤트를 stdout에 JSON Lines로 출력 (데스크톱 앱용)"),
) -> None:
    """노트에 질문한다. stdin: {"question": "…", "history": [{"role", "content"}]} 또는 질문 평문.
    공급자에는 질문, 최근 대화, 근거 세그먼트만 보낸다. 답의 문장마다 [s0012] 인용이 붙는다."""
    from openai import APIError

    from tractus import ask as qa

    Events.enabled = progress_json

    try:
        question, history = qa.parse_request(sys.stdin.read())
    except ValueError as e:
        _fail(str(e))
    if save and not meeting:
        _fail("--save는 --meeting과 함께만 쓸 수 있습니다 (노트 폴더의 chat.json에 저장)")
    try:
        d = resolve_meeting(meeting) if meeting else None
    except typer.BadParameter as e:
        _fail(e.message)

    def search(**kw) -> list[dict]:
        from tractus.embed import load_embedder
        from tractus.index import Index

        idx = Index(home_dir(), embedder=load_embedder(models_dir()))  # 질의 임베딩 때만 모델을 올린다 (LazyEmbedder)
        try:
            idx.sync(embed=False)  # 새 벡터는 만들지 않는다: 노트가 많으면 몇 분 걸린다. 벡터 없는 청크는 키워드로 찾힌다
            return qa.search_sources(idx, question, **kw)
        finally:
            idx.close()

    def get_sources() -> list[dict]:
        if d is None:
            return search(date_from=date_from, date_to=date_to)
        t = _read_transcript(d)
        src = qa.transcript_sources(t)
        return search(meeting_id=t["meeting_id"]) if qa.too_long(src) else src

    try:
        p, m = resolve_provider(provider, model)
        done = None
        for ev in qa.ask(make_client(p), p.name, m, question, history, "global" if d is None else "meeting", get_sources):
            if ev["event"] == "done":
                done = ev
                if save:  # done보다 먼저 저장한다: 앱이 done을 받은 직후 프로세스를 끝내도 기록이 남는다
                    _save_chat(d, question, ev)
            Events.emit(ev["event"], **{k: v for k, v in ev.items() if k != "event"})
    except LLMError as e:
        _fail(str(e), code=e.code)
    except APIError as e:
        _fail(f"AI 서비스 오류: {e}", code="llm_api")
    if not progress_json and done:
        print(done["answer"])
        if done["citations"]:
            print("\n근거:")
        for c in done["citations"]:
            sid = c["segment_id"] if d else f"{c['meeting_id']}#{c['segment_id']}"
            print(f"  [{sid} {_hms(c['start'])}]")


@app.command()
def index(rebuild: bool = typer.Option(False, "--rebuild", help="색인 파일을 지우고 처음부터 다시 만든다")) -> None:
    """노트 폴더를 검색 색인(~/Tractus/.tractus/index.sqlite)에 반영한다. 바뀐 노트만 처리한다."""
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
        f"노트 {st['meetings']}개, 청크 {st['chunks']}개, 벡터 {st['vectors']}개 "
        f"(추가 {r.added}, 갱신 {r.updated}, 삭제 {r.removed}, 임베딩 {r.embedded}, {time.perf_counter() - t0:.1f}초)"
    )
    if not has_embedder:
        console.print("[yellow]임베딩 모델이 없거나 올리지 못해 키워드 검색만 됩니다. README '모델 받기'의 qwen3-embedding-0.6b를 확인하세요.[/yellow]")  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)
    elif st["vectors"] < st["chunks"]:
        console.print(f"[yellow]벡터가 없는 청크 {st['chunks'] - st['vectors']}개가 남았습니다.[/yellow]")  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)
    for err in r.errors:
        console.print(f"[yellow]건너뜀:[/yellow] {escape(err)}")


@app.command()
def search(
    query: str = typer.Argument(..., help="검색어"),
    limit: int = typer.Option(10, "--limit", "-n"),
    date_from: str = typer.Option(None, "--from", help="YYYY-MM-DD", callback=lambda v: _iso_date(v, "--from")),
    date_to: str = typer.Option(None, "--to", help="YYYY-MM-DD", callback=lambda v: _iso_date(v, "--to")),
) -> None:
    """과거 노트를 하이브리드(키워드 + 의미) 검색한다."""
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


speakers_app = typer.Typer(help="노트의 화자 보기·이름 짓기·고치기. transcript.json과 md·vtt를 다시 쓰고 검색 색인을 갱신한다 (오디오는 건드리지 않음)")
app.add_typer(speakers_app, name="speakers")


@speakers_app.callback()
def speakers_main(ctx: typer.Context, meeting: str = typer.Argument(..., help="노트 폴더 경로 또는 meeting_id (일부만 써도 됨)")) -> None:
    ctx.obj = resolve_meeting(meeting)


def _read_transcript(d: Path) -> dict:
    return json.loads((d / "transcript.json").read_text(encoding="utf-8"))


@speakers_app.command("list")
def speakers_list(ctx: typer.Context, as_json: bool = typer.Option(False, "--json", help="JSON으로 stdout에 출력 (데스크톱 앱용)")) -> None:
    """화자별 이름·세그먼트 수·발화 시간."""
    t = _read_transcript(ctx.obj)
    rows = [
        {"label": label, "name": (info or {}).get("name"), "display": speaker_name(t, label), "suggested": (info or {}).get("suggested"),
         "segments": sum(1 for s in t["segments"] if s.get("speaker") == label),
         "talk_sec": round(sum(s["end"] - s["start"] for s in t["segments"] if s.get("speaker") == label), 2)}
        for label, info in (t.get("speakers") or {}).items()
    ]
    if as_json:
        print(json.dumps({"meeting_id": t["meeting_id"], "speakers": rows, "diarization": t.get("diarization")}, ensure_ascii=False))
        return
    if not rows:
        print("화자 정보가 없습니다 (화자 분리 없이 전사됨). `tractus speakers <노트> set <세그먼트> new`로 직접 붙일 수 있습니다")
    for r in rows:
        hint = f"\t{r['suggested']['name']}? (자동 인식 {r['suggested']['score']:.0%})" if r["suggested"] else ""
        print(f"{r['label']}\t{r['name'] or '-'}\t세그먼트 {r['segments']}개\t{_hms(r['talk_sec'])}{hint}")


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


@speakers_app.command("dismiss")
def speakers_dismiss(ctx: typer.Context, label: str = typer.Argument(..., help="S1 등")) -> None:
    """목소리 제안('홍길동?')을 지운다. 제안을 받아들이려면 그 이름으로 rename한다."""
    _edit_speakers(ctx.obj, "dismiss", label)


voices_app = typer.Typer(help="목소리 프로필($TRACTUS_HOME/voices.json, 권한 0600). 등록한 사람의 목소리로 새 노트 화자에 이름을 제안한다. 이 Mac 밖으로 보내지 않는다")
app.add_typer(voices_app, name="voices")

CONSENT_MESSAGE = (
    "목소리는 생체정보(개인정보보호법 제23조 민감정보)입니다. 본인이거나 녹음·등록에 동의를 받은 사람만 등록하세요.\n"
    "동의를 받았으면 --consent를 붙여 다시 실행하세요. 등록한 목소리는 이 Mac의 voices.json에만 저장되고 `tractus voices forget`으로 지웁니다."
)


@voices_app.callback()
def voices_main() -> None:
    """목소리 프로필 관리."""


def _profiles() -> dict:
    try:
        return voices.load_profiles(home_dir())
    except ValueError as e:  # 깨진 voices.json은 덮어쓰지 않는다
        console.print(f"[red]참석자 목소리 프로필을 읽지 못했습니다:[/red] {escape(str(e))}")
        raise typer.Exit(1)


def _voice_embedder():
    try:
        embedder = voices.load_embedder(models_dir())
    except RuntimeError as e:
        _fail(str(e))
    if embedder is None:
        console.print(voices.model_hint(models_dir()), markup=False)  # 받는 방법은 앞 줄에, 앱이 보이는 마지막 줄은 문장으로
        _fail("목소리 인식에 필요한 파일이 없습니다.")
    return embedder


def _meeting_pcm(d: Path, t: dict):
    try:
        audio.require_ffmpeg()
        Events.emit("stage", stage="decode")
        return audio.decode(d / t["audio"]["file"])
    except audio.FFmpegError as e:
        _fail_audio(e)


@voices_app.command("list")
def voices_list(as_json: bool = typer.Option(False, "--json", help="JSON으로 stdout에 출력 (데스크톱 앱용)")) -> None:
    """등록된 사람(이름, 표본 수, 등록일). 벡터는 출력하지 않는다. stdout(--json): {"people": [...], "reenroll": bool}"""
    data = _profiles()
    rows = [{"id": p["id"], "name": p["name"], "samples": len(p.get("samples") or []), "created_at": p.get("created_at")} for p in data["people"]]
    reenroll = voices.needs_reenroll(data)
    if as_json:
        print(json.dumps({"people": rows, "reenroll": reenroll}, ensure_ascii=False))
        return
    if reenroll:
        console.print("[yellow]목소리 모델이 바뀌어 등록된 목소리를 쓸 수 없습니다. 다시 등록하세요 (`tractus voices enroll`).[/yellow]")  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)
    if not rows:
        print("등록된 목소리가 없습니다. `tractus voices enroll <노트> S1 --name 이름 --consent`로 등록합니다")
    for r in rows:
        print(f"{r['name']}\t표본 {r['samples']}개\t{(r['created_at'] or '')[:10]}\t{r['id']}")


@voices_app.command("enroll")
def voices_enroll(
    meeting: str = typer.Argument(..., help="노트 폴더 경로 또는 meeting_id (일부만 써도 됨)"),
    label: str = typer.Argument(..., help="S1 등"),
    name: str = typer.Option(..., "--name", help="이 화자의 이름. 같은 이름이 있으면 그 사람에 표본을 더한다 (최대 5개)"),
    consent: bool = typer.Option(False, "--consent", help="본인이거나 녹음·등록에 동의를 받았음 (필수)"),
) -> None:
    """화자의 목소리를 기억하고 그 이름으로 확정한다(= speakers rename + 등록). stdout: {"person_id", "name", "samples"}"""
    if not consent:
        console.print(f"[red]{escape(CONSENT_MESSAGE)}[/red]")
        raise typer.Exit(2)
    d = resolve_meeting(meeting)
    t = _read_transcript(d)
    try:
        renamed = apply_speaker_edit(t, "rename", label, name)
    except ValueError as e:
        _fail(str(e))
    clean = renamed["speakers"][label]["name"]
    if not clean:
        _fail("이름을 입력하세요.")
    data = _profiles()
    embedder = _voice_embedder()
    emb = voices.speaker_embedding(embedder, _meeting_pcm(d, t), t["segments"], label)
    if emb is None:
        _fail(f"이 참석자가 {voices.MIN_CLIP_S:g}초 이상 이어서 말한 부분이 없어 목소리를 등록할 수 없습니다.")
    data, person = voices.enroll(data, clean, emb, t["meeting_id"])
    voices.save_profiles(home_dir(), data)
    save_transcript(d, renamed)
    _sync_index_quietly(embed=False)
    print(json.dumps({"person_id": person["id"], "name": person["name"], "samples": len(person["samples"])}, ensure_ascii=False))


@voices_app.command("forget")
def voices_forget(ref: str = typer.Argument(..., help="이름 또는 id")) -> None:
    """등록한 사람을 지운다. 노트에 남은 그 사람의 목소리 제안도 지운다 (확정한 이름은 그대로). stdout: {"forgotten": N}"""
    data, gone = voices.forget(_profiles(), ref)
    if gone:
        voices.save_profiles(home_dir(), data)
        for p in sorted((home_dir() / "meetings").glob("*/transcript.json")):
            # ponytail: 노트 폴더 전체를 훑는다. 수천 개가 되면 제안이 있는 노트 목록을 따로 둔다
            try:
                t = _read_transcript(p.parent)
            except (OSError, ValueError):
                continue
            keep = {k: v["suggested"] for k, v in (t.get("speakers") or {}).items() if (v or {}).get("suggested") and v["suggested"].get("person_id") not in gone}
            new = apply_suggestions(t, keep)
            if new["speakers"] != t["speakers"]:
                save_transcript(p.parent, new)
    print(json.dumps({"forgotten": len(gone)}))


@voices_app.command("match")
def voices_match(
    meeting: str = typer.Argument(..., help="노트 폴더 경로 또는 meeting_id (일부만 써도 됨)"),
    progress_json: bool = typer.Option(False, "--progress-json", help="진행 이벤트를 stdout에 JSON Lines로 출력 (데스크톱 앱용)"),
) -> None:
    """기존 노트의 목소리 제안을 다시 계산한다. 이름을 확정한 화자와 그 이름의 사람은 건너뛴다.
    stdout: {"suggested": N} (--progress-json이면 같은 값이 done 이벤트에 들어간다)"""
    Events.enabled = progress_json
    try:
        d = resolve_meeting(meeting)
    except typer.BadParameter as e:
        _emit_error(str(e))
        raise
    t = _read_transcript(d)
    speakers = t.get("speakers") or {}
    confirmed = {(v or {}).get("name") for v in speakers.values()} - {None}
    labels = [k for k, v in speakers.items() if not (v or {}).get("name")]
    people = [p for p in voices.usable_people(_profiles()) if p["name"] not in confirmed]
    suggestions = {}
    if people and labels:
        embedder = _voice_embedder()
        pcm = _meeting_pcm(d, t)
        Events.emit("stage", stage="voices")
        suggestions = voices.suggest(embedder, pcm, t["segments"], people, labels)
    new = apply_suggestions(t, suggestions)
    if new["speakers"] != speakers:
        save_transcript(d, new)
    if progress_json:
        Events.emit("done", meeting_id=t["meeting_id"], meeting_dir=str(d), suggested=len(suggestions))
    else:
        print(json.dumps({"suggested": len(suggestions)}))


segments_app = typer.Typer(help="노트 전사 텍스트 고치기. 원문(text)은 두고 corrected_text에 쓴 뒤 md·vtt를 다시 쓰고 검색 색인을 갱신한다")
app.add_typer(segments_app, name="segments")


@segments_app.callback()
def segments_main(ctx: typer.Context, meeting: str = typer.Argument(..., help="노트 폴더 경로 또는 meeting_id (일부만 써도 됨)")) -> None:
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
            raise ValueError('입력은 {"edits": [{"id": "s0012", "text": "…"}]} 형식이어야 합니다')  # words-ok: 앱 계약 오류
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
    meeting: str = typer.Argument(..., help="노트 폴더 경로 또는 meeting_id (일부만 써도 됨)"),
    fmt: ExportFormat = typer.Option(..., "--format", help="txt | md | srt | vtt | csv | docx | bundle(노트 폴더 zip)"),
    out: Path = typer.Option(..., "--out", help="저장할 파일 경로"),
    force: bool = typer.Option(False, "--force", help="--out 파일이 있으면 덮어쓴다"),
) -> None:
    """노트를 파일로 내보낸다. 화자는 표시 이름, 본문은 교정본(corrected_text) 우선. stdout: {"path": "<절대 경로>"}"""
    d = resolve_meeting(meeting)
    if out.exists() and not force:
        console.print(f"[red]이미 있는 파일입니다 (덮어쓰려면 --force):[/red] {escape(str(out))}")
        raise typer.Exit(1)
    try:
        write_bytes_atomic(out, render_export(d, fmt.value))
    except OSError as e:  # 임시 파일(.tmp) 경로 대신 사용자가 고른 경로를 알린다
        console.print(f"[red]{escape(str(out))}에 저장할 수 없습니다 ({escape(e.strerror or str(e))})[/red]")
        raise typer.Exit(1)
    except ValueError as e:  # 제목 등에 남은 제어 문자를 docx(lxml)가 거부하는 경우. 원인은 앞 줄, 앱이 보이는 마지막 줄은 문장
        console.print(str(e), markup=False)
        console.print("[red]제목이나 대화 내용에 쓸 수 없는 글자가 있습니다.[/red]")
        raise typer.Exit(1)
    print(json.dumps({"path": str(out.resolve())}, ensure_ascii=False))


@app.command()
def mcp() -> None:
    """MCP 서버(stdio)를 실행한다. Claude Code·Codex·agy에 등록해서 쓴다 (README 'MCP 연동')."""
    from tractus.mcp_server import main as serve

    serve()


if __name__ == "__main__":
    app()
