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
from tractus import summaries as sums  # noqa: E402
from tractus import summary_templates as tmpls  # noqa: E402
from tractus.env import load_env_all  # noqa: E402
from tractus.llm import LLMError, check_connection, list_models, make_client, resolve_provider  # noqa: E402
from tractus.paths import home_dir, models_dir  # noqa: E402
from tractus.align import MODEL_DIR as ALIGNER_DIR  # noqa: E402
from tractus.align import align_segments, is_approximate, load_aligner  # noqa: E402
from tractus.asr import SR, Transcriber  # noqa: E402
from tractus.diarize import FLUID, FLUID_MIN_CLIP_S, MAX_SPEAKERS, NEMOTRON, MODEL_DIR as DIARIZER_DIR  # noqa: E402
from tractus.diarize import fluid_hint, load_diarizer, load_fluid, split_chunks  # noqa: E402
from tractus.export import FORMATS as EXPORT_FORMATS, UnsupportedFormat, render_export, write_bytes_atomic  # noqa: E402
from tractus import attach, deferred, enhance, notes, obsidian  # noqa: E402
from tractus.store import MEMOS_FILE, Job, add_glossary_terms, apply_speaker_edit, apply_suggestions, apply_text_edits, find_job, find_meeting_dir, find_transcribed  # noqa: E402
from tractus.store import IncompleteError, load_glossary, meeting_dir_name, new_ulid, save_transcript, seg_text, speaker_name, write_transcript  # noqa: E402
from tractus.store import CHUNKS_FILE, JOB_FILE, edit_transcript, forget_person, note_lock, read_transcript, render_files  # noqa: E402
from tractus.store import NOT_CONVERTED, _hms, is_memo, is_recorded, memo_lines, stamp  # noqa: E402
from tractus.vad import find_chunks  # noqa: E402
from tractus.calendar_event import load_event, save_event  # noqa: E402
from tractus import models_cli, organize_cli  # noqa: E402
from tractus import models_registry as registry  # noqa: E402
from tractus.models_registry import STANDARD_MIN_MEMORY, physical_memory  # noqa: E402,F401  (테스트가 cli.physical_memory를 바꿔 끼운다)

app = typer.Typer(add_completion=False, help="Local-first 노트·녹음 도구")
console = Console(stderr=True, soft_wrap=True)  # 파이프(앱)에서 80칸 줄바꿈 금지: 앱은 stderr 마지막 줄만 보여 준다


class Track(str, Enum):
    standard = "standard"
    lite = "lite"


class LiveEngine(str, Enum):  # `tractus live --engine` (개발·벤치 전용)
    lite = "lite"
    std = "std"


class DiarizerEngine(str, Enum):
    auto = "auto"
    nemotron = NEMOTRON
    fluid = FLUID


class Language(str, Enum):
    auto = "auto"
    ko = "ko"
    en = "en"


# Phase 0 확정 모델 (ARCHITECTURE.md §2.2, §8)
# (저장소·리비전·폴더는 models_registry가 원본이다)
MODELS = {Track.standard: registry.get("asr-std").repo, Track.lite: registry.get("asr-lite").repo}
VAD_MODEL = registry.get("vad").repo


def local_model(repo: str) -> Path:
    path = models_dir() / repo.split("/")[1].lower()
    m = registry.by_repo(repo)
    # 받다 만 모델(config.json만 있고 가중치가 없는 폴더)이 로드 단계에서 트레이스백으로 죽지 않게 레지스트리의 완료 검사를 쓴다
    if not (registry.usable(m.id, models_dir()) if m else (path / "config.json").exists()):
        hint = registry.install_hint(m, models_dir()) if m else f"  hf download {repo} --local-dir {path}"
        raise typer.BadParameter(f"모델이 없습니다: {path}\n{hint}\n(모델 위치는 TRACTUS_MODELS_DIR 환경변수로 바꿀 수 있습니다)", param_hint="모델")  # words-ok: 앱은 model_missing 코드로 문장을 바꾼다 (원래 문구는 자세히)
    return path


def recommended_track() -> Track:
    return Track.standard if physical_memory() >= STANDARD_MIN_MEMORY else Track.lite


def auto_track() -> Track:
    """`--track` 없이 변환할 때의 트랙: 메모리가 권하는 쪽의 모델이 있으면 그것, 없고 다른 쪽이 있으면 그쪽으로 (경고 asr_track_fallback),
    둘 다 없으면 권하는 쪽을 돌려 local_model이 model_missing으로 알린다."""
    want = recommended_track()
    pick = registry.pick_asr(models_dir(), physical_memory())
    if pick is None or registry.get(pick).repo == MODELS[want]:
        return want
    used = Track.lite if want is Track.standard else Track.standard
    _warn("asr_track_fallback", f"{want.value} 변환 엔진이 없어 {used.value} 엔진으로 변환합니다 (받으려면 tractus models download {'asr-std' if want is Track.standard else 'asr-lite'})")
    return used


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
    event: dict | None = None  # 캘린더 일정으로 시작한 녹음 (calendar_event)


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
    ev = load_event(d)
    return Source(paths=tracks, name=d.name, title=ev["title"] if ev else f"녹음 {started:%H:%M}", recorded=started, marks=marks, recording_dir=d, event=ev)


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
    append_to: str = typer.Option(None, "--append-to", help="새 노트를 만드는 대신 글만 있는 노트(폴더 또는 meeting_id)에 이 녹음을 덧붙여 녹음 노트로 바꾼다 (docs/desktop.md §2.11)"),
    into: str = typer.Option(None, "--into", help='녹음은 했지만 아직 변환하지 않은 노트("변환 전", 폴더 또는 meeting_id)를 그 자리에서 텍스트로 변환한다. 파일·--recording·--append-to와 함께 쓰지 않는다 (docs/desktop.md §2.16)'),
) -> None:
    """녹음을 전사해 노트 폴더(audio.ogg, transcript.json/md/vtt)를 만든다. 중단돼도 같은 명령으로 이어서 진행한다."""
    Events.enabled = progress_json
    if into:
        if file is not None or recording is not None or append_to:
            raise typer.BadParameter("--into는 녹음 파일, --recording, --append-to와 함께 쓸 수 없습니다", param_hint="--into")
    elif (file is None) == (recording is None):
        raise typer.BadParameter("녹음 파일 또는 --recording 폴더 중 하나만 지정하세요")
    append = _append_target(append_to) if append_to else None
    convert = _into_target(into) if into else None
    try:
        source = _source_from_note(*convert) if convert else _source_from_file(file) if file else _source_from_recording(recording)
    except typer.BadParameter as e:
        _emit_error(str(e), code="note_audio_missing" if convert else "recording_missing")  # 노트에 녹음 파일이 없으면 마이크 안내가 아니라 그 노트의 문장
        raise
    try:
        _transcribe(source, title, track, language, term, keep_tracks, not no_diarize, max_speakers, not no_align, diarizer, append, convert)
    except audio.FFmpegError as e:
        _fail_audio(e)
    except typer.BadParameter as e:  # local_model: 변환 엔진(모델) 파일 없음
        _emit_error(str(e), code="model_missing")
        raise


def _append_target(ref: str) -> tuple[Path, dict]:
    """--append-to 대상: 글만 있는 노트의 (폴더, transcript.json). 없거나 이미 녹음이 있으면 오류 이벤트(code)를 내고 종료 코드 2."""
    try:
        d = find_meeting_dir(home_dir() / "meetings", ref)
        t = read_transcript(d)
        attach.check_target(t)
    except LookupError as e:
        _emit_error(str(e), code="append_note_missing")
        raise typer.BadParameter(str(e), param_hint="--append-to") from e
    except ValueError as e:  # check_target (WORDS 문장). 깨진 transcript.json(JSONDecodeError)도 ValueError라 같은 문장이 된다
        _emit_error(str(e), code="append_has_audio")
        raise typer.BadParameter(str(e), param_hint="--append-to") from e
    return d, t


def _into_target(ref: str) -> tuple[Path, dict]:
    """--into 대상: "변환 전" 노트의 (폴더, transcript.json). 없으면 종료 코드 2(code 없음, 회의를 찾지 못한 오류와 같다), 변환 전이 아니면 code not_recorded + 종료 코드 2."""
    try:
        d = find_meeting_dir(home_dir() / "meetings", ref)
        t = read_transcript(d)
    except (LookupError, OSError, ValueError) as e:
        _emit_error(str(e))
        raise typer.BadParameter(str(e), param_hint="--into") from e
    try:
        deferred.check_recorded(t)
    except ValueError as e:
        _fail(str(e), code="not_recorded", exit_code=2)
    return d, t


def _source_from_note(d: Path, t: dict) -> Source:
    """"변환 전" 노트의 변환 입력: tracks/의 원본 트랙, 없으면 audio.ogg (경고 tracks_missing). 둘 다 없으면 BadParameter(앱은 code recording_missing)."""
    try:
        paths, marks, lossless = deferred.note_tracks(d, t)
    except deferred.RecordingError as e:
        raise typer.BadParameter(str(e), param_hint="--into") from e
    if not lossless:
        _warn("tracks_missing", "녹음 원본 트랙이 없어 보관한 audio.ogg로 변환합니다 (음질이 조금 낮을 수 있습니다)")
    created = datetime.fromisoformat(t["created_at"]).astimezone() if isinstance(t.get("created_at"), str) else datetime.now().astimezone()
    return Source(paths=paths, name=str((t.get("audio") or {}).get("source") or d.name), title=t["title"], recorded=created, marks=marks)


def _transcribe(
    source: Source, title: str | None, track: Track | None, language: Language, term: list[str], keep_tracks: bool, diarize: bool, max_speakers: int | None,
    align: bool = True, engine: DiarizerEngine = DiarizerEngine.auto, append: tuple[Path, dict] | None = None, into: tuple[Path, dict] | None = None,
) -> None:
    audio.require_ffmpeg()
    meetings = home_dir() / "meetings"
    meetings.mkdir(parents=True, exist_ok=True)

    Events.emit("stage", stage="decode")  # 큰 파일은 해시 계산에도 몇 초 걸린다. 앱이 바로 진행 표시를 하도록 먼저 알린다
    digest = (into[1]["audio"].get("sha256") if into else None) or audio.sha256(source.paths)  # 변환 전 노트는 저장할 때 잰 원본 트랙의 해시를 그대로 쓴다
    if not into and (done_dir := find_transcribed(meetings, digest)):
        _warn("duplicate", f"이미 전사된 파일입니다: {done_dir}\n다시 전사하려면 이 폴더를 지우고 실행하세요.")
        Events.emit("done", meeting_id=json.loads((done_dir / "transcript.json").read_text(encoding="utf-8"))["meeting_id"], meeting_dir=str(done_dir))
        raise typer.Exit(0)

    job = find_job(meetings, digest, append[1]["meeting_id"] if append else None, into[1]["meeting_id"] if into else None)
    if job:
        if track and track.value != job.track:
            console.print(f"[yellow]진행 중인 작업의 트랙({job.track})으로 이어서 합니다.[/yellow]")
        console.print(f"이어서 진행합니다: {job.dir.name} ({len(job.done())}/{len(job.chunks)} 청크 완료)")  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)
        pcm = audio.decode(source.paths)
    else:
        job, pcm = _new_job(source, meetings, digest, title, track or auto_track(), language, term, diarize, max_speakers, engine, append, into)

    _run(job, pcm, source, keep_tracks, align)


def _still_registered(suggestions: dict) -> dict:
    """변환하는 동안 `voices forget`으로 등록을 지운 사람의 제안은 버린다 (메모리의 작업이 지운 제안을 되살리지 않게)."""
    if not suggestions:
        return suggestions
    try:
        ids = {p["id"] for p in voices.load_profiles(home_dir())["people"]}
    except (OSError, ValueError):
        return suggestions
    return {k: v for k, v in suggestions.items() if v.get("person_id") in ids}


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
    fluid: 헬퍼·모델이 없거나 실패하면 Nemotron으로 돌린다. 60초 미만 클립이면 화자가 과하게 쪼개질 수 있다고 경고만 하고 그대로 돌린다."""
    models = models_dir()
    if engine is DiarizerEngine.fluid:
        if len(pcm) / SR < FLUID_MIN_CLIP_S:
            _warn("fluid_short_clip", f"{FLUID_MIN_CLIP_S:.0f}초보다 짧은 클립은 fluid 엔진이 화자를 과하게 나눌 수 있습니다. 결과가 이상하면 --diarizer nemotron으로 다시 해 보세요")
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
        _warn("diarizer_missing", f"화자 분리 모델이 없어 화자 분리 없이 전사합니다: {models / DIARIZER_DIR}\n{registry.install_hint('diarizer', models)}")
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
    return f"{models_dir() / ALIGNER_DIR}\n{registry.install_hint('aligner', models_dir())}"


def _align_progress() -> Progress:
    return Progress(TextColumn("단어 타이밍"), BarColumn(), MofNCompleteColumn(), TimeElapsedColumn(), console=console)


def _save_words(d: Path, segments: list[dict], ids: set[str]) -> dict:
    """정렬한 words를 transcript.json에 쓴다. transcript.json이 있으면 앱이 이미 편집할 수 있으므로 정렬하는 동안 고친
    세그먼트·화자를 덮어쓰지 않게, 다시 읽고 표시 텍스트가 그대로인 세그먼트에만 words를 쓴다 (나머지 필드는 다시 읽은 쪽).
    다시 읽기부터 쓰기까지를 note_lock 안에서 해서 그 사이의 앱 편집도 잃지 않는다.
    → {"aligned", "approximate", "failed", "skipped"} (approximate: 모델이 못 맞춰 단어를 고르게 편 세그먼트, failed: 단어가 없는 세그먼트)"""
    new = {s["id"]: s for s in segments if s["id"] in ids}

    def merge(cur: dict) -> tuple[dict, dict]:
        counts = {"aligned": 0, "approximate": 0, "failed": 0}
        merged = []
        for s in cur["segments"]:
            a = new.get(s["id"])
            if a is not None and seg_text(a) == seg_text(s):
                merged.append({**s, "words": a["words"]})
                counts["failed" if a["words"] is None else "approximate" if is_approximate(a["words"]) else "aligned"] += 1
            else:
                merged.append(s)
        return {**cur, "segments": merged}, {**counts, "skipped": len(merged) - sum(counts.values())}

    return edit_transcript(d, merge)


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

            segments, *_ = align_segments(aligner, pcm, t["segments"], on_progress=tick)
    except Exception as e:  # noqa: BLE001 — 단어 타이밍 실패가 전사를 막지 않는다
        _warn("aligner_failed", f"단어 타이밍을 만들지 못했습니다 (`tractus align {t['meeting_id']}`로 다시 시도): {e}")
        return
    counts = _save_words(d, segments, {s["id"] for s in t["segments"]})
    if counts["approximate"]:
        console.print(f"[yellow]단어 타이밍을 정확히 맞추지 못해 고르게 나눈 세그먼트 {counts['approximate']}개 (`tractus align --force`로 다시 시도)[/yellow]")  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)


def _new_job(
    source: Source, meetings: Path, digest: str, title: str | None, track: Track, language: Language, terms: list[str], diarize: bool, max_speakers: int | None,
    engine: DiarizerEngine = DiarizerEngine.auto, append: tuple[Path, dict] | None = None, into: tuple[Path, dict] | None = None,
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

    if append or into:  # 글만 있는 노트(또는 변환 전 노트)의 폴더·제목·id·만든 시각을 그대로 쓴다. 폴더에 transcript.json이 이미 있다
        d, old = append or into
        meeting_id, title, created_at = old["meeting_id"], old["title"], old["created_at"]
        for name in (JOB_FILE, CHUNKS_FILE):  # 다른 파일로 끝내지 못한 이전 작업의 조각이 이번 전사에 섞이지 않게 비운다
            (d / name).unlink(missing_ok=True)
    else:
        meeting_id = new_ulid()
        title = title or source.title
        d = meetings / meeting_dir_name(source.recorded.date().isoformat(), title, meeting_id)
        d.mkdir()
        created_at = source.recorded.isoformat(timespec="seconds")
    # ponytail: Opus 인코딩 중 강제 종료되면 .job.json 없는 폴더가 남는다. 다음 실행은 새 폴더로 처음부터 진행
    if not (into and (d / "audio.ogg").is_file()):  # 변환 전 노트는 저장할 때 이미 audio.ogg를 만들었다 (트랙이 없어 audio.ogg로 변환하는 경우도 다시 만들지 않는다)
        with console.status("원본을 audio.ogg로 보관 중…"):
            Events.emit("stage", stage="encode")
            audio.encode_opus(source.paths, d / "audio.ogg")
    if source.marks:
        (d / MEMOS_FILE).write_text(json.dumps(source.marks, ensure_ascii=False, indent=1), encoding="utf-8")
    if source.event:
        save_event(d, source.event)

    ev = source.event or load_event(d)  # 나중에 변환(--into)은 노트 폴더의 일정을 읽는다
    hotwords = list(dict.fromkeys(load_glossary(home_dir() / "glossary.md") + terms + (ev["attendees"] if ev else [])))  # 참석자 이름은 이 노트의 변환에만
    job = Job(
        dir=d, meeting_id=meeting_id, sha256=digest, source=source.name, title=title,
        created_at=created_at, duration_sec=round(len(pcm) / SR, 2),
        model=MODELS[track], track=track.value, language=language.value, hotwords=hotwords, chunks=chunks, audio_file="audio.ogg",
        diarizer=diarization, suggestions=suggestions, attach=bool(append), convert=bool(into),
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


def _write_result(job: Job) -> dict:
    """새 노트면 transcript.json을 쓰고, 글만 있는 노트에 덧붙이는 작업이면 그 노트를 녹음 노트로 바꾸고 (attach.finish_append),
    변환 전 노트를 변환하는 작업이면 그 노트의 결과를 채운다 (deferred.finish_convert)."""
    if job.convert:
        try:
            return deferred.finish_convert(job)
        except ValueError as e:  # 변환하는 사이 다른 실행이 먼저 이 노트를 변환했다. 이 작업 파일은 낡은 것이 되어 다음에 지워진다
            _fail(str(e), code="not_recorded", exit_code=2)
    if not job.attach:
        return write_transcript(job)
    try:
        t, ok = attach.finish_append(job)
    except ValueError as e:  # 변환하는 사이 다른 실행이 먼저 이 노트에 녹음을 붙였다. 이 작업 파일은 낡은 것이 되어 다음에 지워진다
        _fail(str(e), code="append_has_audio", exit_code=2)
    if not ok:
        _warn("append_remap_failed", attach.REMAP_FAILED)
    return t


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
    job.suggestions = _still_registered(job.suggestions)
    try:
        t = _write_result(job)
    except IncompleteError as e:
        _fail(str(e), code="incomplete")
    # ASR 모델을 내린 뒤 색인한다: 1.7B(3.6GB)와 임베딩 모델(1.4GB)이 통합 메모리에 함께 올라가지 않게
    del transcriber
    _free_mlx()
    _finish_recording(source, job.dir, keep_tracks)  # 전사는 저장됐다. 정렬 중에 끊겨도 녹음 폴더가 남지 않게 먼저 정리한다
    if job.convert and not keep_tracks:
        deferred.drop_tracks(job.dir)  # 변환 전 노트가 보관하던 원본 트랙 (--keep-tracks면 노트의 tracks/에 남긴다)
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


recording_app = typer.Typer(help="tractus-rec 녹음 폴더를 변환하지 않고 노트로 저장 (docs/desktop.md §2.16)")
app.add_typer(recording_app, name="recording")


@recording_app.callback()
def recording_main() -> None:
    """녹음 폴더를 노트로 저장."""


@recording_app.command("finish")
def recording_finish(
    recording: Path = typer.Argument(..., help="tractus-rec 녹음 폴더 (recordings/<ULID>)"),
    title: str = typer.Option(None, "--title", help="노트 제목. 생략하면 '녹음 HH:MM' (녹음을 시작한 이 Mac의 시각)"),
    progress_json: bool = typer.Option(False, "--progress-json", help="진행 이벤트를 stdout에 JSON Lines로 출력 (데스크톱 앱용)"),
) -> None:
    """녹음을 텍스트로 변환하지 않고 "변환 전" 노트로 저장한다: audio.ogg(바로 들을 수 있다), 원본 트랙(tracks/), 녹음 중 메모·북마크(memos.json), transcript.json(state recorded).
    나중에 `tractus transcribe --into <노트>`로 변환한다. 중단돼도 녹음 폴더는 그대로 남고 같은 명령으로 이어서 끝낸다.
    stdout: {"meeting_id": "01K…", "meeting_dir": "<절대 경로>"} (--progress-json이면 done 이벤트)"""
    Events.enabled = progress_json
    try:
        name = notes.clean_title(title) if title and title.strip() else None
    except ValueError as e:
        _fail(str(e), code="bad_input", exit_code=2)
    if not recording.is_dir():
        _fail(f"녹음 폴더를 찾지 못했습니다: {recording}", code="recording_missing", exit_code=2)
    meetings = home_dir() / "meetings"
    meetings.mkdir(parents=True, exist_ok=True)
    try:
        d, mid = deferred.finish_recording(recording, meetings, name, lambda stage: Events.emit("stage", stage=stage))
    except deferred.RecordingError as e:
        _fail(str(e), code=e.code, exit_code=2)
    except audio.FFmpegError as e:
        _fail_audio(e)
    except OSError as e:  # 디스크 부족·권한 등. 녹음 폴더는 그대로 남아 있다 (같은 명령으로 다시 실행하면 이어서 끝낸다)
        _fail(f"녹음을 저장하지 못했습니다: {e}", exit_code=1)
    except KeyboardInterrupt:
        console.print()
        _fail("저장을 중단했습니다. 같은 명령으로 다시 실행하면 이어서 진행합니다.", code="interrupted", exit_code=130)
    if progress_json:
        Events.emit("done", meeting_id=mid, meeting_dir=str(d))
    else:
        print(json.dumps({"meeting_id": mid, "meeting_dir": str(d.resolve())}, ensure_ascii=False))


@app.command("live")
def live_cmd(
    recording: Path = typer.Option(..., "--recording", exists=True, file_okay=False, help="녹음 중인 tractus-rec 폴더"),
    force: bool = typer.Option(False, "--force", help="메모리 16GB 미만 기기에서도 실행한다"),
    speakers: bool = typer.Option(False, "--speakers", help="실시간 화자 라벨(S1…, 미리보기 전용). GPU 사용률이 약 두 배가 된다"),
    progress_json: bool = typer.Option(False, "--progress-json", help="자막 이벤트를 stdout에 JSON Lines로 출력 (데스크톱 앱용)"),
    engine: LiveEngine = typer.Option(LiveEngine.lite, "--engine", help="개발·벤치 전용: lite(0.6B, 기본) | std(1.7B). 앱은 쓰지 않는다 (bench/live_sim.py --engine)"),
) -> None:
    """녹음 중 실시간 자막(미리보기). Qwen3-ASR 0.6B(--engine std는 개발·벤치 전용 1.7B)로 발화마다 전사해 내보내고 아무것도 저장하지 않는다.
    stdin에 `stop` 줄, stdin EOF, SIGTERM이면 마무리하고 종료 코드 0으로 끝난다. 정식 전사는 녹음을 멈춘 뒤 `transcribe --recording`.
    --progress-json 없이 실행하면 확정된 자막을 `\\[mm:ss] 문장` 줄로 stdout에 찍는다."""
    import signal
    import threading

    Events.enabled = progress_json

    memory = physical_memory()
    if memory < STANDARD_MIN_MEMORY and not force:
        _fail(f"실시간 텍스트 변환은 메모리 16GB 이상에서만 켭니다 (이 Mac {memory / 1024**3:.0f}GB). 녹음과 함께 약 2GB를 더 써서 녹음 뒤 변환이 느려지거나 메모리가 부족할 수 있습니다. 그래도 쓰려면 --force", code="live_low_memory")
    try:
        vad_dir, asr_dir = local_model(VAD_MODEL), local_model(MODELS[Track.standard if engine is LiveEngine.std else Track.lite])
    except typer.BadParameter as e:
        _fail(str(e), code="model_missing")

    stop = threading.Event()

    def watch_stdin() -> None:
        for line in sys.stdin:
            if line.strip() == "stop":
                break
        stop.set()  # stop 줄 또는 EOF (부모 앱이 죽어도 고아로 남지 않게)

    threading.Thread(target=watch_stdin, daemon=True).start()
    hotwords = load_glossary(home_dir() / "glossary.md")

    def emit(event: str, **data) -> None:
        Events.emit(event, **data)
        if not progress_json and event == "live" and data["kind"] == "final" and data["text"]:
            m, s = divmod(int(data["start"]), 60)
            print(f"[{m:02d}:{s:02d}] {data['speaker'] + ': ' if data['speaker'] else ''}{data['text']}", flush=True)  # 터미널에서 실행하면 확정된 자막만 stdout에 찍는다

    # 프로세스 전체 핸들러라 끝나면 되돌린다 (테스트·다른 코드가 같은 프로세스에서 SIGINT를 받을 수 있다)
    previous = {sig: signal.signal(sig, lambda *_: stop.set()) for sig in (signal.SIGTERM, signal.SIGINT)}
    try:
        live_mod.run(recording, emit, _warn, stop, vad_dir, asr_dir, models_dir() / DIARIZER_DIR if speakers else None, hotwords)
    except (live_mod.LiveError, ValueError, OSError) as e:
        _fail(f"실시간 텍스트 변환을 멈췄습니다: {e}", code="live_failed")
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


@app.command("align")
def align_cmd(
    meeting: str = typer.Argument(..., help="노트 폴더 경로 또는 meeting_id (일부만 써도 됨)"),
    force: bool = typer.Option(False, "--force", help="이미 단어 타이밍이 있는 세그먼트도 다시 맞춘다"),
    progress_json: bool = typer.Option(False, "--progress-json", help="진행 이벤트를 stdout에 JSON Lines로 출력 (데스크톱 앱용)"),
) -> None:
    """기존 노트의 단어 타이밍(segment.words)을 채운다. 기본은 words가 없는 세그먼트만.
    stdout: {"aligned": N, "approximate": A, "failed": M, "skipped": K} (--progress-json이면 같은 값이 done 이벤트에 들어간다).
    approximate: 모델이 못 맞춰 단어를 세그먼트에 고르게 편 수 (words는 있고 단어마다 approx). failed: 단어가 없는 세그먼트."""
    Events.enabled = progress_json

    try:
        d = resolve_meeting(meeting)
    except typer.BadParameter as e:
        _emit_error(str(e))
        raise
    t = _read_transcript(d)
    if is_memo(t):
        _fail(notes.NO_AUDIO_ALIGN, code="no_audio", exit_code=2)
    if is_recorded(t):
        _fail(NOT_CONVERTED, code="not_converted", exit_code=2)
    todo = {s["id"] for s in t["segments"] if force or s.get("words") is None}
    counts = {"aligned": 0, "approximate": 0, "failed": 0, "skipped": len(t["segments"])}
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

            segments, *_ = align_segments(aligner, pcm, t["segments"], on_progress=tick, only=todo)
        counts = _save_words(d, segments, todo)
        console.print(f"단어 타이밍: 성공 {counts['aligned']}, 추정 {counts['approximate']}, 실패 {counts['failed']}, 건너뜀 {counts['skipped']} ({time.perf_counter() - t0:.1f}초)")  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)
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
    provider: str = typer.Option(None, "--provider", help="upstage | openai | claude | gemini | custom | gemma-local. 생략하면 TRACTUS_LLM_PROVIDER"),
    model: str = typer.Option(None, "--model", help="모델 ID. 생략하면 TRACTUS_LLM_MODEL 또는 공급자 기본값"),
    progress_json: bool = typer.Option(False, "--progress-json", help="진행 이벤트를 stdout에 JSON Lines로 출력 (데스크톱 앱용)"),
    template: str = typer.Option(None, "--template", help="요약 유형 ID (`tractus templates list`). 생략하면 meeting(회의록): summary.json·summary.md. 다른 유형은 summaries/<ID>.json·md"),
    custom: bool = typer.Option(False, "--custom", help='직접 쓴 요약 방법으로 요약한다. stdin의 {"prompt": "…", "save_as"?: "이름", "key"?: "c-…"}. save_as가 있으면 내 요약 유형으로도 저장한다. --template과 함께 쓸 수 없다'),
) -> None:
    """전사본으로 요약을 만든다. 기본(회의록)은 요약·결정 사항·할 일을 summary.md와 summary.json에, 다른 유형·직접 요약은 summaries/ 폴더에 저장한다. 전사 텍스트와 요약 지침만 공급자에 전송한다.
    done 이벤트의 summary_key는 저장한 요약의 key다 (`tractus summaries <노트> list`)."""
    Events.enabled = progress_json
    try:
        d = resolve_meeting(meeting)
    except typer.BadParameter as e:
        _emit_error(str(e))
        raise
    if template == enhance.KEY:  # 노트 완성: 요약 유형 목록에 없는 전용 경로 (docs/design/enhanced-notes.md)
        if custom:
            _fail("요약 유형과 직접 입력은 함께 쓸 수 없습니다.", code="bad_input", exit_code=2)
        return _enhance(d, provider, model)
    try:
        spec = sums.resolve_spec(home_dir(), template, sys.stdin.read() if custom else None)
    except ValueError as e:
        _fail(str(e), code="bad_input", exit_code=2)
    transcript = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
    if is_recorded(transcript):
        _fail(NOT_CONVERTED, code="not_converted", exit_code=2)
    if not transcript["segments"]:
        _fail("메모가 비어 있어 요약할 수 없습니다" if is_memo(transcript) else "인식된 대화가 없어 요약할 수 없습니다", code="no_segments")
    try:
        p, m = resolve_provider(provider, model)
        t0 = time.perf_counter()
        Events.emit("stage", stage="summarize")
        with console.status(f"{p.name}/{m}로 요약 중… (세그먼트 {len(transcript['segments'])}개)"):
            result = summ.summarize(make_client(p), p, m, transcript) if spec.is_default else sums.summarize_generic(make_client(p), p, m, transcript, spec)
    except LLMError as e:
        if e.code == "llm_invalid":  # 검증 오류 원문(pydantic, s0012 ID)은 stderr에만 남긴다
            console.print(f"[red]{escape(str(e))}[/red]")  # 검증 오류의 [type=…] 같은 대괄호를 rich 마크업으로 해석하지 않게 한다
            _fail("AI 응답이 형식에 맞지 않아 요약하지 못했습니다", code=e.code)
        _fail(str(e), code=e.code)
    try:
        if spec.is_default:
            summ.write_summary(d, result, transcript, p.name, m)
        key = sums.DEFAULT_KEY if spec.is_default else sums.write_generic(home_dir(), d, spec, result, transcript, p.name, m)
    except ValueError as e:  # 내 요약 유형으로 저장하지 못함 (50개 한도 등)
        _fail(str(e), code="bad_input", exit_code=2)
    if spec.is_default:  # 유형별 요약(summaries/)은 검색 색인에 들어가지 않는다
        Events.emit("stage", stage="index")
        _sync_index_quietly()
    Events.emit("done", meeting_id=transcript["meeting_id"], meeting_dir=str(d), summary_key=key)
    detail = f"주제 {len(result.topics)}개, 결정 {len(result.decisions)}개, 할 일 {len(result.action_items)}개" if spec.is_default else f"항목 {sum(len(x.items) for x in result.sections)}개"
    console.print(f"완료: {detail} ({time.perf_counter() - t0:.0f}초)\n{sums.paths(d, key)[1]}")


def _enhance(d: Path, provider: str | None, model: str | None) -> None:
    """summarize --template enhanced: 내 메모를 뼈대로 대화 내용의 세부를 붙인 완성된 노트 (summaries/enhanced.json)."""
    transcript = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
    if is_memo(transcript):
        _fail(enhance.NO_RECORDING, code="no_recording", exit_code=2)
    if is_recorded(transcript):
        _fail(NOT_CONVERTED, code="not_converted", exit_code=2)
    if not transcript["segments"]:
        _fail("인식된 대화가 없어 노트를 완성할 수 없습니다", code="no_segments")
    try:
        p, m = resolve_provider(provider, model)
        t0 = time.perf_counter()
        Events.emit("stage", stage="summarize")
        with console.status(f"{p.name}/{m}로 노트 완성 중… (세그먼트 {len(transcript['segments'])}개)"):
            result = enhance.enhance(make_client(p), p, m, transcript, d)
    except LLMError as e:
        if e.code == "llm_invalid":
            console.print(f"[red]{escape(str(e))}[/red]")
            _fail("AI 응답이 형식에 맞지 않아 노트를 완성하지 못했습니다", code=e.code)
        _fail(str(e), code=e.code)
    key = enhance.write(d, transcript, result, p.name, m)
    Events.emit("done", meeting_id=transcript["meeting_id"], meeting_dir=str(d), summary_key=key)
    console.print(f"완료: 블록 {len(result['sections'])}개 ({time.perf_counter() - t0:.0f}초)\n{sums.paths(d, key)[1]}")


def _save_chat(d: Path, question: str, done: dict) -> None:
    from tractus.ask import save_chat

    try:
        save_chat(d, _read_transcript(d)["meeting_id"], {"question": question, **{k: done[k] for k in ("answer", "citations", "provider", "model", "no_evidence")}})
    except (OSError, ValueError) as e:  # ValueError: 깨졌거나 다른 형식의 chat.json (덮어쓰지 않음)
        _warn("chat_save_failed", f"질문 기록을 저장하지 못했습니다: {e}")


@app.command()
def ask(
    meeting: str = typer.Option(None, "--meeting", help="이 노트 전사 전체로 답한다 (meeting_id 일부 또는 폴더). 생략하면 모든 노트에서 검색"),
    date_from: str = typer.Option(None, "--from", help="YYYY-MM-DD (전체 범위 검색에만)", callback=lambda v: _iso_date(v, "--from")),
    date_to: str = typer.Option(None, "--to", help="YYYY-MM-DD (전체 범위 검색에만)", callback=lambda v: _iso_date(v, "--to")),
    provider: str = typer.Option(None, "--provider", help="upstage | openai | claude | gemini | custom | gemma-local. 생략하면 TRACTUS_LLM_PROVIDER"),
    model: str = typer.Option(None, "--model", help="모델 ID. 생략하면 TRACTUS_LLM_MODEL 또는 공급자 기본값"),
    save: bool = typer.Option(False, "--save", help="질문·답을 노트 폴더 chat.json에 덧붙인다 (--meeting과 함께)"),
    progress_json: bool = typer.Option(False, "--progress-json", help="이벤트를 stdout에 JSON Lines로 출력 (데스크톱 앱용)"),
) -> None:
    """노트에 질문한다. stdin: {"question": "…", "history": [{"role", "content"}]} 또는 질문 평문.
    공급자에는 질문, 최근 대화, 근거 세그먼트만 보낸다. 답의 문장마다 [s0012] 인용이 붙는다."""
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
            return qa.search_sources(idx, question, history, **kw)
        finally:
            idx.close()

    def get_sources() -> list[dict]:
        if d is None:
            return search(date_from=date_from, date_to=date_to)
        t = _read_transcript(d)
        src = qa.transcript_sources(t)
        if is_recorded(t) and not src:
            _warn("not_converted", NOT_CONVERTED)  # 변환 전 노트: 대화 내용이 없고 메모도 없으면 LLM을 부르지 않고 '근거 없음'으로 끝난다
        return search(meeting_id=t["meeting_id"]) if qa.too_long(src) else src

    try:
        p, m = resolve_provider(provider, model)
        done = None
        for ev in qa.ask(make_client(p), p.name, m, question, history, "global" if d is None else "meeting", get_sources, policy=p):
            if ev["event"] == "done":
                done = ev
                if save:  # done보다 먼저 저장한다: 앱이 done을 받은 직후 프로세스를 끝내도 기록이 남는다
                    _save_chat(d, question, ev)
            Events.emit(ev["event"], **{k: v for k, v in ev.items() if k != "event"})
    except LLMError as e:
        _fail(str(e), code=e.code)
    if not progress_json and done:
        print(done["answer"])
        if done["citations"]:
            print("\n근거:")
        for c in done["citations"]:
            sid = c["segment_id"] if d else f"{c['meeting_id']}#{c['segment_id']}"
            print(f"  [{sid} {stamp(c)}]")


llm_app = typer.Typer(help="AI 서비스 연결 (요약·질문)")


@llm_app.command("test")
def llm_test(
    provider: str = typer.Option(None, "--provider", help="upstage | openai | claude | gemini | custom | gemma-local. 생략하면 TRACTUS_LLM_PROVIDER"),
    model: str = typer.Option(None, "--model", help="모델 ID. 생략하면 TRACTUS_LLM_MODEL 또는 공급자 기본값"),
) -> None:
    """연결 테스트: 아주 짧은 요청 한 번(30초 제한). 실제 요약·질문과 같은 해석·환경변수를 쓴다.
    성공하면 한 줄 JSON {"ok", "provider", "model", "host", "latency_ms"}, 실패하면 error 이벤트 한 줄 + 종료 코드 1. 키는 출력하지 않는다."""
    Events.enabled = True  # 앱이 stdout의 JSON 한 줄을 읽는다
    try:
        p, m = resolve_provider(provider, model)
        print(json.dumps(check_connection(p, m), ensure_ascii=False))
    except LLMError as e:
        _fail(str(e), code=e.code)


@llm_app.command("models")
def llm_models(
    provider: str = typer.Option(None, "--provider", help="upstage | openai | claude | gemini | custom | gemma-local. 생략하면 TRACTUS_LLM_PROVIDER"),
) -> None:
    """서비스가 알려 주는 AI 모델 ID 목록 (GET <주소>/models). 성공하면 한 줄 JSON {"models": [ID…]}, 실패하면 error 이벤트 한 줄 + 종료 코드 1 (`llm test`와 같은 코드)."""
    Events.enabled = True
    try:
        p, _ = resolve_provider(provider, None, need_model=False)
        print(json.dumps({"models": list_models(p)}, ensure_ascii=False))
    except LLMError as e:
        _fail(str(e), code=e.code)


app.add_typer(llm_app, name="llm")


@app.command()
def index(rebuild: bool = typer.Option(False, "--rebuild", help="색인 파일을 지우고 처음부터 다시 만든다")) -> None:
    """노트 폴더를 검색 색인(~/Tractus/.tractus/index.sqlite)에 반영한다. 바뀐 노트만 처리한다."""
    from tractus import embed

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
    if not has_embedder and embed.mode() == "upstage":
        console.print("[yellow]Upstage 임베딩을 쓸 수 없어 키워드 검색만 됩니다. UPSTAGE_API_KEY와 위의 건너뜀 줄을 확인하세요.[/yellow]")  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)
    elif not has_embedder:
        console.print("[yellow]임베딩 모델이 없거나 올리지 못해 키워드 검색만 됩니다. `tractus models download embedding`으로 받으세요.[/yellow]")  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)
    elif st["pending"]:
        console.print(f"[yellow]벡터가 없는 청크 {st['pending']}개가 남았습니다.[/yellow]")  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)
    for err in r.errors:
        console.print(f"[yellow]건너뜀:[/yellow] {escape(err)}")


@app.command()
def search(
    query: str = typer.Argument(..., help="검색어"),
    limit: int = typer.Option(10, "--limit", "-n"),
    date_from: str = typer.Option(None, "--from", help="YYYY-MM-DD", callback=lambda v: _iso_date(v, "--from")),
    date_to: str = typer.Option(None, "--to", help="YYYY-MM-DD", callback=lambda v: _iso_date(v, "--to")),
    tag: list[str] = typer.Option(None, "--tag", help="이 태그가 붙은 노트에서만 (여러 번 주면 모두 붙은 노트)"),
    folder: str = typer.Option(None, "--folder", help="폴더 ID 또는 이름(하위 폴더 포함), none이면 폴더 없는 노트"),
    favorite: bool = typer.Option(False, "--favorite", help="즐겨찾기한 노트에서만"),
) -> None:
    """과거 노트를 하이브리드(키워드 + 의미) 검색한다."""
    only = organize_cli.search_filter(tag, folder, favorite)
    idx = _open_index()
    try:
        idx.sync()
        res = idx.search(query, limit=limit, date_from=date_from, date_to=date_to, meeting_ids=only)
    finally:
        idx.close()
    if not res.hits:
        console.print("결과 없음")
    for h in res.hits:
        print(f"{h.date} {h.title} ({'+'.join(h.matched)})")
        for s in h.segments:
            who = f" {s['speaker']}" if s.get("speaker") else ""
            print(f"  [{h.meeting_id[-6:]}#{s['id']} {stamp(s)}{who}] {seg_text(s)[:120]}")


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
    t = _read_transcript(d)
    if is_memo(t):
        _fail("메모에는 참석자를 지정할 수 없습니다.", exit_code=2)
    if is_recorded(t):
        _fail(NOT_CONVERTED, code="not_converted", exit_code=2)
    try:
        edit_transcript(d, lambda t: (apply_speaker_edit(t, op, *args), None))
    except ValueError as e:
        console.print(f"[red]{escape(str(e))}[/red]")
        raise typer.Exit(1)
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
    """등록된 사람(이름, 표본 수, 등록일). 벡터는 출력하지 않는다.
    stdout(--json): {"people": [...], "reenroll": bool, "model_present": bool} (model_present: 목소리 인식 파일이 있고 올바르다)"""
    data = _profiles()
    rows = [{"id": p["id"], "name": p["name"], "samples": len(p.get("samples") or []), "created_at": p.get("created_at")} for p in data["people"]]
    reenroll = voices.needs_reenroll(data)
    if as_json:
        print(json.dumps({"people": rows, "reenroll": reenroll, "model_present": voices.model_present(models_dir())}, ensure_ascii=False))
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
    if is_memo(t):
        _fail("녹음이 없는 노트라 목소리를 등록할 수 없습니다.", exit_code=2)
    if is_recorded(t):
        _fail(NOT_CONVERTED, code="not_converted", exit_code=2)
    try:
        renamed = apply_speaker_edit(t, "rename", label, name)
    except ValueError as e:
        _fail(str(e))
    clean = renamed["speakers"][label]["name"]
    if not clean:
        _fail("이름을 입력하세요.")
    embedder = _voice_embedder()
    emb = voices.speaker_embedding(embedder, _meeting_pcm(d, t), t["segments"], label)
    if emb is None:
        _fail(f"이 참석자가 {voices.MIN_CLIP_S:g}초 이상 이어서 말한 부분이 없어 목소리를 등록할 수 없습니다.")
    with note_lock(d):  # 오래 걸리는 임베딩은 잠금 밖에서 하고, 읽기부터 쓰기까지만 잠근다 (그 사이의 편집을 덮어쓰지 않게 다시 읽는다)
        try:
            renamed = apply_speaker_edit(_read_transcript(d), "rename", label, clean)
        except ValueError as e:
            _fail(str(e))
        with voices.profiles_lock(home_dir()):  # 다른 노트의 등록·forget과 voices.json을 덮어쓰지 않게
            data = _profiles()
            previous = data if (home_dir() / voices.VOICES_FILE).exists() else None
            data, person = voices.enroll(data, clean, emb, t["meeting_id"])
            voices.save_profiles(home_dir(), data)
            try:
                save_transcript(d, renamed)
            except BaseException:
                voices.restore_profiles(home_dir(), previous)  # 이름은 못 붙였는데 목소리만 등록된 채로 남지 않게
                raise
    _sync_index_quietly(embed=False)
    print(json.dumps({"person_id": person["id"], "name": person["name"], "samples": len(person["samples"])}, ensure_ascii=False))


@voices_app.command("forget")
def voices_forget(ref: str = typer.Argument(..., help="이름 또는 id")) -> None:
    """등록한 사람을 지운다. 노트에 남은 그 사람의 목소리 제안도 지운다 (확정한 이름은 그대로). stdout: {"forgotten": N}"""
    with voices.profiles_lock(home_dir()):  # 읽고 고쳐 쓰는 동안만 잡는다. 노트 잠금과 함께 쥐지 않는다
        data, gone = voices.forget(_profiles(), ref)
        if gone:
            voices.save_profiles(home_dir(), data)
    if gone:
        ids, meetings = set(gone), home_dir() / "meetings"
        # ponytail: 노트 폴더 전체를 훑는다. 수천 개가 되면 제안이 있는 노트 목록을 따로 둔다
        for p in sorted(meetings.glob("*/transcript.json")):
            try:
                if not any(i in p.read_text(encoding="utf-8") for i in ids):
                    continue  # 이 사람을 가리키는 기록이 없는 노트는 잠금 파일도 만들지 않는다
                edit_transcript(p.parent, lambda t: (forget_person(t, ids), None))
            except (OSError, ValueError):
                continue
        for p in sorted(meetings.glob(f"*/{JOB_FILE}")):  # 변환이 끝나지 않은 작업: 이어하기가 지운 제안을 되살리지 않게
            if (p.parent / "transcript.json").is_file():
                continue
            try:
                job = Job.load(p.parent)
                kept = {k: v for k, v in job.suggestions.items() if v.get("person_id") not in ids}
                if kept != job.suggestions:
                    job.suggestions = kept
                    job.save()
            except (OSError, ValueError, TypeError, KeyError):
                continue
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
    if is_recorded(t):
        _fail(NOT_CONVERTED, code="not_converted", exit_code=2)
    speakers = t.get("speakers") or {}
    confirmed = {(v or {}).get("name") for v in speakers.values()} - {None}
    labels = [k for k, v in speakers.items() if not (v or {}).get("name")]
    people = [p for p in voices.usable_people(_profiles()) if p["name"] not in confirmed]
    dismissed = {k: set((v or {}).get("dismissed") or []) for k, v in speakers.items()}  # 사용자가 '다름'으로 거절한 사람은 다시 제안하지 않는다
    suggestions = {}
    if people and labels:
        embedder = _voice_embedder()
        pcm = _meeting_pcm(d, t)
        Events.emit("stage", stage="voices")
        suggestions = voices.suggest(embedder, pcm, t["segments"], people, labels, dismissed)
    suggestions = _still_registered(suggestions)  # 계산하는 동안 forget한 사람의 이름을 노트에 남기지 않는다
    edit_transcript(d, lambda cur: (apply_suggestions(cur, suggestions), None))  # 오래 걸린 계산 뒤라 최신 노트를 다시 읽어 합친다
    if progress_json:
        Events.emit("done", meeting_id=t["meeting_id"], meeting_dir=str(d), suggested=len(suggestions))
    else:
        print(json.dumps({"suggested": len(suggestions)}))


@app.command("render")
def render_cmd(
    meeting: str = typer.Argument(None, help="노트 폴더 경로 또는 meeting_id (일부만 써도 됨)"),
    all_notes: bool = typer.Option(False, "--all", help="모든 노트"),
) -> None:
    """transcript.json으로 transcript.md·vtt를 다시 만든다 (표시 문구가 바뀐 뒤 기존 노트에 반영). stdout: {"rendered": N}"""
    if (meeting is None) == (not all_notes):
        raise typer.BadParameter("노트 하나 또는 --all 중 하나만 지정하세요")
    dirs = [p.parent for p in sorted((home_dir() / "meetings").glob("*/transcript.json"))] if all_notes else [resolve_meeting(meeting)]
    rendered = 0
    for d in dirs:
        try:
            with note_lock(d):
                render_files(d, _read_transcript(d))
        except (OSError, ValueError, KeyError, TypeError) as e:  # 형식이 깨진 transcript.json은 KeyError로 나온다
            if not all_notes:
                _fail(f"문서를 다시 만들지 못했습니다: {e}")
            console.print(f"[yellow]건너뜀:[/yellow] {escape(d.name)}: {escape(str(e))}")
            continue
        rendered += 1
    print(json.dumps({"rendered": rendered}))


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
    t = _read_transcript(d)
    if is_memo(t):
        _fail(notes.MEMO_EDIT_HERE, exit_code=2)
    if is_recorded(t):
        _fail(NOT_CONVERTED, code="not_converted", exit_code=2)
    try:
        req = json.loads(sys.stdin.read())
        edits = req.get("edits") if isinstance(req, dict) else None
        if not isinstance(edits, list):
            raise ValueError('입력은 {"edits": [{"id": "s0012", "text": "…"}]} 형식이어야 합니다')  # words-ok: 앱 계약 오류
        changed = edit_transcript(d, lambda t: apply_text_edits(t, edits))
    except ValueError as e:  # json.JSONDecodeError 포함
        console.print(f"[red]{escape(str(e))}[/red]")
        raise typer.Exit(1)
    if changed:
        _sync_index_quietly(embed=False)  # 바뀐 청크는 벡터 없이 키워드로만 찾힌다. 다음 `tractus index`나 전사·요약 때 임베딩
    print(json.dumps({"changed": changed}))


note_app = typer.Typer(help="직접 쓰는 메모 노트(오디오 없음)와 노트 제목. transcript.json·md를 쓰고 검색 색인을 갱신한다 (docs/desktop.md §2.10)")
app.add_typer(note_app, name="note")
models_cli.register(app)  # models list|download|remove, doctor (docs/desktop.md §2.15)
organize_cli.register(app, note_app)  # note meta, folders, notes list (docs/desktop.md §2.12)


@note_app.callback()
def note_main() -> None:
    """메모 만들기·저장, 제목 바꾸기."""


def _read_json_object(raw: str, shape: str) -> dict:
    """stdin의 JSON 객체. 비었거나 객체가 아니면 ValueError (shape는 오류 문장에 보여 줄 형식)."""
    try:
        req = json.loads(raw)
    except ValueError:
        req = None
    if not isinstance(req, dict):
        raise ValueError(f"입력은 {shape} 형식이어야 합니다")  # words-ok: 앱 계약 오류
    return req


def _note_dir(meeting: str) -> Path:
    try:
        return resolve_meeting(meeting)
    except typer.BadParameter as e:
        _fail(e.message, exit_code=2)


@note_app.command("new")
def note_new(title: str = typer.Option(None, "--title", help="제목. stdin의 title보다 우선한다. 생략하면 '메모 HH:MM'(이 Mac의 시각)")) -> None:
    """빈 메모(또는 stdin의 {"title"?, "body"?}로 채운 메모)를 만든다. stdout: {"meeting_id": "…", "meeting_dir": "<절대 경로>"}
    잘못된 제목·본문이면 종료 코드 2 (아무것도 만들지 않는다)."""
    raw = "" if sys.stdin.isatty() else sys.stdin.read()
    try:
        req = _read_json_object(raw, '{"title": "…", "body": "…"}') if raw.strip() else {}
        for key in ("title", "body"):
            if not isinstance(req.get(key, ""), str):
                raise ValueError(f'입력은 {{"title": "…", "body": "…"}} 형식이어야 합니다')  # words-ok: 앱 계약 오류
        d, t = notes.create_memo(home_dir() / "meetings", title or req.get("title"), req.get("body", ""))
    except ValueError as e:
        _fail(str(e), exit_code=2)
    _sync_index_quietly(embed=False)
    print(json.dumps({"meeting_id": t["meeting_id"], "meeting_dir": str(d.resolve())}, ensure_ascii=False))


@note_app.command("save")
def note_save(meeting: str = typer.Argument(..., help="노트 폴더 경로 또는 meeting_id (일부만 써도 됨)")) -> None:
    """stdin의 {"body": "…"}로 메모의 내용을 통째로 바꾼다. 메모 노트는 본문, 녹음 노트는 transcript.json의 "memo"(오른쪽 패널 메모)를 쓴다 (비우면 "memo"를 지운다).
    줄이 그대로면 줄 ID를 유지한다. stdout: {"saved": true, "segments": N, "changed": bool, "kind": "memo"|"recording"} (N: 메모의 줄 수)
    잘못된 입력·20만 자·5,000줄 초과는 종료 코드 2 (아무것도 쓰지 않는다)."""
    d = _note_dir(meeting)
    try:
        req = _read_json_object(sys.stdin.read(), '{"body": "…"}')
        if not isinstance(req.get("body"), str):
            raise ValueError('입력은 {"body": "…"} 형식이어야 합니다')  # words-ok: 앱 계약 오류
        body = notes.clean_body(req["body"])

        def fn(t: dict):
            new, changed = notes.apply_body(t, body)
            count = len(new["segments"]) if is_memo(new) else len(memo_lines(new))
            return new, (changed, count, "memo" if is_memo(new) else "recording")

        changed, count, kind = edit_transcript(d, fn)
    except ValueError as e:
        _fail(str(e), exit_code=2)
    if changed:
        _sync_index_quietly(embed=False)  # 바뀐 청크는 벡터 없이 키워드로만 찾힌다. 앱의 조용한 색인이 나중에 임베딩한다
    print(json.dumps({"saved": True, "segments": count, "changed": changed, "kind": kind}))


@note_app.command("title")
def note_title(meeting: str = typer.Argument(..., help="노트 폴더 경로 또는 meeting_id (일부만 써도 됨)")) -> None:
    """stdin의 {"title": "…"}로 노트(녹음·메모 모두) 제목을 바꾼다. 폴더 이름은 그대로 두고 transcript.json·md(·vtt)·요약 파일·검색 색인의 제목을 바꾼다.
    stdout: {"title": "<정리된 제목>"}. 비었거나 120자를 넘으면 종료 코드 2."""
    d = _note_dir(meeting)
    try:
        req = _read_json_object(sys.stdin.read(), '{"title": "…"}')
        if not isinstance(req.get("title"), str):
            raise ValueError('입력은 {"title": "…"} 형식이어야 합니다')  # words-ok: 앱 계약 오류
        title = notes.clean_title(req["title"])
        with note_lock(d):  # transcript.json과 요약 파일을 한 번에 바꾼다
            edit_transcript(d, lambda t: (notes.apply_title(t, title), None))
            notes.retitle_summary(d, title)
    except ValueError as e:
        _fail(str(e), exit_code=2)
    _sync_index_quietly(embed=False)
    print(json.dumps({"title": title}, ensure_ascii=False))


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
    summary: str = typer.Option(None, "--summary", help="md·docx에 넣을 요약의 key (meeting·brief·u-…·c-…). 생략하면 기본 요약, 그것도 없으면 처음 있는 요약"),
) -> None:
    """노트를 파일로 내보낸다. 화자는 표시 이름, 본문은 교정본(corrected_text) 우선. stdout: {"path": "<절대 경로>"}"""
    d = resolve_meeting(meeting)
    if summary and sums.read_data(d, summary) is None:
        _fail(sums.NO_SUCH_SUMMARY, exit_code=2)
    if out.exists() and not force:
        console.print(f"[red]이미 있는 파일입니다 (덮어쓰려면 --force):[/red] {escape(str(out))}")
        raise typer.Exit(1)
    try:
        write_bytes_atomic(out, render_export(d, fmt.value, summary))
    except UnsupportedFormat as e:  # 메모를 srt·vtt로
        _fail(str(e), exit_code=2)
    except OSError as e:  # 임시 파일(.tmp) 경로 대신 사용자가 고른 경로를 알린다
        console.print(f"[red]{escape(str(out))}에 저장할 수 없습니다 ({escape(e.strerror or str(e))})[/red]")
        raise typer.Exit(1)
    except ValueError as e:  # 제목 등에 남은 제어 문자를 docx(lxml)가 거부하는 경우. 원인은 앞 줄, 앱이 보이는 마지막 줄은 문장
        console.print(str(e), markup=False)
        console.print("[red]제목이나 대화 내용에 쓸 수 없는 글자가 있습니다.[/red]")
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
    d = resolve_meeting(meeting)
    if summary and sums.read_data(d, summary) is None:
        _fail(sums.NO_SUCH_SUMMARY, exit_code=2)
    t = read_transcript(d)
    try:
        r = obsidian.send(d, t, home_dir(), vault.expanduser(), summary, with_audio, force)
    except ValueError as e:
        _fail(str(e), code="obsidian_vault", exit_code=2)
    except OSError as e:
        _fail(f"볼트에 쓰지 못했습니다 ({e.strerror or e})", code="obsidian_write")
    print(json.dumps(r, ensure_ascii=False))


templates_app =typer.Typer(help="요약 유형($TRACTUS_HOME/templates/): 기본 유형(읽기 전용)과 내 유형 만들기·고치기·삭제 (docs/desktop.md §2.13)")
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
        req = _read_json_object(sys.stdin.read(), '{"prompt": "…"}')
        if not isinstance(req.get("prompt"), str):
            raise ValueError('입력은 {"prompt": "…"} 형식이어야 합니다')  # words-ok: 앱 계약 오류
        saved = tmpls.save_user_template(home_dir(), name, req["prompt"], description, tid)
    except ValueError as e:
        _fail(str(e), code="bad_input", exit_code=2)
    print(json.dumps(saved.public(), ensure_ascii=False))


@templates_app.command("delete")
def templates_delete(tid: str = typer.Argument(..., metavar="ID", help="내 유형 ID (기본 유형은 지울 수 없다). 이 유형으로 만든 요약은 그대로 남는다")) -> None:
    """내 요약 유형을 지운다. stdout: {"deleted": "<ID>"}"""
    try:
        tmpls.delete_user_template(home_dir(), tid)
    except ValueError as e:
        _fail(str(e), code="bad_input", exit_code=2)
    print(json.dumps({"deleted": tid}))


summaries_app = typer.Typer(help="한 노트의 요약들(기본 summary.json + summaries/). 보기·지우기 (docs/desktop.md §2.13)")
app.add_typer(summaries_app, name="summaries")


@summaries_app.callback()
def summaries_main(ctx: typer.Context, meeting: str = typer.Argument(..., help="노트 폴더 경로 또는 meeting_id (일부만 써도 됨)")) -> None:
    ctx.obj = _note_dir(meeting)


@summaries_app.command("list")
def summaries_list(ctx: typer.Context, as_json: bool = typer.Option(False, "--json", help='{"summaries": [{"key","template","name","title","generated_at","provider","model","custom"}]}')) -> None:
    """요약 목록. key meeting은 기본 요약(summary.json)이다."""
    items = sums.list_summaries(ctx.obj)
    if as_json:
        print(json.dumps({"summaries": items}, ensure_ascii=False))
        return
    for x in items:
        print(f"{x['key']}\t{x['name']}\t{x['title']}")


@summaries_app.command("delete")
def summaries_delete(ctx: typer.Context, key: str = typer.Argument(..., metavar="KEY", help="지울 요약의 key (meeting이면 summary.json·summary.md)")) -> None:
    """요약 하나를 지운다. stdout: {"deleted": "<KEY>"}. 없으면 종료 코드 2."""
    try:
        sums.delete_summary(ctx.obj, key)
    except ValueError as e:
        _fail(str(e), code="bad_input", exit_code=2)
    print(json.dumps({"deleted": key}))


@app.command()
def mcp() -> None:
    """MCP 서버(stdio)를 실행한다. Claude Code·Codex·agy에 등록해서 쓴다 (README 'MCP 연동')."""
    from tractus.mcp_server import main as serve

    serve()


if __name__ == "__main__":
    app()
