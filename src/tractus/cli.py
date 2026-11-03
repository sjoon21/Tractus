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
from tractus import voices  # noqa: E402
from tractus import summary_templates as tmpls  # noqa: E402
from tractus.env import load_env_all  # noqa: E402
from tractus.llm import LLMError, check_connection, list_models, make_client, resolve_provider  # noqa: E402
from tractus.paths import home_dir, models_dir  # noqa: E402
from tractus.align import MODEL_DIR as ALIGNER_DIR  # noqa: E402
from tractus.align import align_segments, is_approximate, load_aligner  # noqa: E402
from tractus.asr import SR, Transcriber, note_terms  # noqa: E402
from tractus.diarize import FLUID, FLUID_MIN_CLIP_S, MAX_SPEAKERS, NEMOTRON, MODEL_DIR as DIARIZER_DIR  # noqa: E402
from tractus.diarize import fluid_hint, load_diarizer, load_fluid, split_chunks  # noqa: E402
from tractus.export import FORMATS as EXPORT_FORMATS, PARTS as EXPORT_PARTS, UnsupportedFormat, render_export, write_bytes_atomic  # noqa: E402
from tractus import attach, deferred, notes  # noqa: E402
from tractus.store import MEMOS_FILE, Job, add_glossary_terms, apply_speaker_edit, apply_suggestions, apply_text_edits, find_job, find_meeting_dir, find_transcribed  # noqa: E402
from tractus.store import IncompleteError, load_glossary, meeting_dir_name, new_ulid, save_transcript, seg_text, speaker_name, write_transcript  # noqa: E402
from tractus.store import CHUNKS_FILE, JOB_FILE, edit_transcript, forget_person, note_lock, read_transcript, render_files  # noqa: E402
from tractus.store import NOT_CONVERTED, _hms, is_memo, is_recorded, load_memos, memo_lines, stamp  # noqa: E402
from tractus.vad import find_chunks  # noqa: E402
from tractus.i18n import t  # noqa: E402
from tractus.calendar_event import load_event, save_event  # noqa: E402
from tractus import models_cli, organize_cli  # noqa: E402
from tractus.commands import common  # noqa: E402
from tractus.commands import mcp  # noqa: E402
from tractus.commands import search  # noqa: E402
from tractus.commands import ai  # noqa: E402
from tractus.commands import voiceprint  # noqa: E402
from tractus.commands import speakers  # noqa: E402
from tractus.commands import transcript  # noqa: E402
from tractus.commands import note  # noqa: E402
from tractus.commands import exports  # noqa: E402
from tractus.commands import glossary  # noqa: E402
from tractus.commands import summary  # noqa: E402
from tractus import models_registry as registry  # noqa: E402
from tractus.models_registry import STANDARD_MIN_MEMORY, physical_memory  # noqa: E402,F401  (테스트가 cli.physical_memory를 바꿔 끼운다)

app = typer.Typer(add_completion=False, help="Local-first 노트·녹음 도구")


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
    m = registry.by_repo(repo)
    path = models_dir() / (m.local_dir if m else repo.split("/")[1].lower())
    # 받다 만 모델(config.json만 있고 가중치가 없는 폴더)이 로드 단계에서 트레이스백으로 죽지 않게 레지스트리의 완료 검사를 쓴다
    if not (registry.usable(m.id, models_dir()) if m else (path / "config.json").exists()):
        hint = registry.install_hint(m, models_dir()) if m else f"  hf download {repo} --local-dir {path}"
        raise typer.BadParameter(t("모델이 없습니다: {path}\n{hint}\n(모델 위치는 TRACTUS_MODELS_DIR 환경변수로 바꿀 수 있습니다)", path=path, hint=hint), param_hint=t("모델"))  # words-ok: 앱은 model_missing 코드로 문장을 바꾼다 (원래 문구는 자세히)
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
    common.warn("asr_track_fallback", t("{want} 변환 엔진이 없어 {used} 엔진으로 변환합니다 (받으려면 tractus models download {model})", want=want.value, used=used.value, model="asr-std" if want is Track.standard else "asr-lite"))
    return used


TRACK_MODEL = {Track.standard: "asr-std", Track.lite: "asr-lite"}


def _engine_ready(repo: str) -> bool:
    """작업(.job.json)의 변환 엔진을 지금 쓸 수 있나."""
    m = registry.by_repo(repo)
    return registry.usable(m.id, models_dir()) if m else (models_dir() / repo.split("/")[-1].lower() / "config.json").is_file()


def track_name(m: registry.Model) -> str:
    """작업·transcript의 `track`: 기본 두 엔진은 standard·lite(예전과 같다), 나머지는 모델 ID."""
    return {"asr-std": Track.standard.value, "asr-lite": Track.lite.value}.get(m.id, m.id)


def choose_asr(track: Track | None, engine_id: str | None) -> registry.Model:
    """변환 엔진 고르기 (docs/design/asr-engines.md): `--engine <모델 ID>`(앱 설정 `기본 변환 엔진`) → `--track` → 메모리가 권하는 기본 엔진.
    고른 엔진을 받아 두지 않았으면 경고(asr_engine_missing)하고 기본 엔진으로 변환한다. 변환 엔진이 아닌 ID는 오류."""
    if engine_id:
        m = registry.find(engine_id)
        if m is None or not m.engine:
            raise typer.BadParameter(t("변환 엔진이 아닙니다: {id} ({choices})", id=engine_id, choices=", ".join(registry.asr_ids(models_dir()))), param_hint="--engine")
        if registry.usable(m.id, models_dir()):
            return m
        common.warn("asr_engine_missing", t("고른 변환 엔진({name})이 없어 기본 엔진으로 변환합니다 (받으려면 tractus models download {id})", name=m.name, id=m.id))
    return registry.get(TRACK_MODEL[track or auto_track()])


@app.callback()
def main() -> None:
    """현재 폴더와 $TRACTUS_HOME의 .env / .env.local을 읽는다 (셸 환경변수가 우선)."""
    load_env_all()


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
        raise typer.BadParameter(t("녹음 파일을 찾지 못했습니다 (recording.json): {error}", error=e), param_hint="--recording") from e
    tracks = [p for p in tracks if p.is_file() and p.stat().st_size > 44]  # 44바이트 = 빈 WAV 헤더
    if not tracks:
        raise typer.BadParameter(t("{path}에 녹음된 소리가 없습니다", path=d), param_hint="--recording")
    marks = [m for m in rec.get("marks") or [] if isinstance(m, dict) and isinstance(m.get("t"), (int, float))]
    ev = load_event(d)
    return Source(paths=tracks, name=d.name, title=ev["title"] if ev else t("녹음 {time}", time=f"{started:%H:%M}"), recorded=started, marks=marks, recording_dir=d, event=ev)  # 기본 제목은 만들 때의 화면 언어


def _source_from_file(file: Path) -> Source:
    return Source(paths=[file], name=file.name, title=file.stem, recorded=datetime.fromtimestamp(file.stat().st_mtime).astimezone(), marks=[])


@app.command()
def transcribe(
    file: Path = typer.Argument(None, exists=True, dir_okay=False, help="녹음·동영상 파일 (m4a, mp3, wav, webm, mp4, mov … ffmpeg가 읽는 형식)"),
    recording: Path = typer.Option(None, "--recording", exists=True, file_okay=False, help="tractus-rec 녹음 폴더 (마이크·시스템 트랙을 섞어 전사)"),
    title: str = typer.Option(None, "--title", help="노트 제목. 생략하면 파일 이름 (녹음이면 '녹음 HH:MM')"),
    track: Track = typer.Option(None, "--track", help="standard(1.7B) | lite(0.6B). 생략하면 메모리 16GB 이상이면 standard"),
    asr_engine: str = typer.Option(None, "--engine", help="변환 엔진 모델 ID (`tractus models list`의 변환 엔진). --track보다 우선한다. 받아 두지 않았으면 기본 엔진으로 변환한다"),
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
    common.Events.enabled = progress_json
    if into:
        if file is not None or recording is not None or append_to:
            raise typer.BadParameter(t("--into는 녹음 파일, --recording, --append-to와 함께 쓸 수 없습니다"), param_hint="--into")
    elif (file is None) == (recording is None):
        raise typer.BadParameter(t("녹음 파일 또는 --recording 폴더 중 하나만 지정하세요"))
    append = _append_target(append_to) if append_to else None
    convert = _into_target(into) if into else None
    try:
        source = _source_from_note(*convert) if convert else _source_from_file(file) if file else _source_from_recording(recording)
    except typer.BadParameter as e:
        common.emit_error(str(e), code="note_audio_missing" if convert else "recording_missing")  # 노트에 녹음 파일이 없으면 마이크 안내가 아니라 그 노트의 문장
        raise
    try:
        _transcribe(source, title, track, language, term, keep_tracks, not no_diarize, max_speakers, not no_align, diarizer, append, convert, asr_engine)
    except audio.FFmpegError as e:
        common.fail_audio(e)
    except typer.BadParameter as e:  # local_model: 변환 엔진(모델) 파일 없음
        common.emit_error(str(e), code="model_missing")
        raise


def _append_target(ref: str) -> tuple[Path, dict]:
    """--append-to 대상: 글만 있는 노트의 (폴더, transcript.json). 없거나 이미 녹음이 있으면 오류 이벤트(code)를 내고 종료 코드 2."""
    try:
        d = find_meeting_dir(home_dir() / "meetings", ref)
        t = read_transcript(d)
        attach.check_target(t)
    except LookupError as e:
        common.emit_error(str(e), code="append_note_missing")
        raise typer.BadParameter(str(e), param_hint="--append-to") from e
    except ValueError as e:  # check_target (WORDS 문장). 깨진 transcript.json(JSONDecodeError)도 ValueError라 같은 문장이 된다
        common.emit_error(str(e), code="append_has_audio")
        raise typer.BadParameter(str(e), param_hint="--append-to") from e
    return d, t


def _into_target(ref: str) -> tuple[Path, dict]:
    """--into 대상: "변환 전" 노트의 (폴더, transcript.json). 없으면 종료 코드 2(code 없음, 회의를 찾지 못한 오류와 같다), 변환 전이 아니면 code not_recorded + 종료 코드 2."""
    try:
        d = find_meeting_dir(home_dir() / "meetings", ref)
        t = read_transcript(d)
    except (LookupError, OSError, ValueError) as e:
        common.emit_error(str(e))
        raise typer.BadParameter(str(e), param_hint="--into") from e
    try:
        deferred.check_recorded(t)
    except ValueError as e:
        common.fail(str(e), code="not_recorded", exit_code=2)
    return d, t


def _source_from_note(d: Path, note: dict) -> Source:
    """"변환 전" 노트의 변환 입력: tracks/의 원본 트랙, 없으면 audio.ogg (경고 tracks_missing). 둘 다 없으면 BadParameter(앱은 code recording_missing)."""
    try:
        paths, marks, lossless = deferred.note_tracks(d, note)
    except deferred.RecordingError as e:
        raise typer.BadParameter(str(e), param_hint="--into") from e
    if not lossless:
        common.warn("tracks_missing", t("녹음 원본 트랙이 없어 보관한 audio.ogg로 변환합니다 (음질이 조금 낮을 수 있습니다)"))
    created = datetime.fromisoformat(note["created_at"]).astimezone() if isinstance(note.get("created_at"), str) else datetime.now().astimezone()
    return Source(paths=paths, name=str((note.get("audio") or {}).get("source") or d.name), title=note["title"], recorded=created, marks=marks)


def _transcribe(
    source: Source, title: str | None, track: Track | None, language: Language, term: list[str], keep_tracks: bool, diarize: bool, max_speakers: int | None,
    align: bool = True, engine: DiarizerEngine = DiarizerEngine.auto, append: tuple[Path, dict] | None = None, into: tuple[Path, dict] | None = None,
    asr_engine: str | None = None,
) -> None:
    audio.require_ffmpeg()
    meetings = home_dir() / "meetings"
    meetings.mkdir(parents=True, exist_ok=True)

    common.Events.emit("stage", stage="decode")  # 큰 파일은 해시 계산에도 몇 초 걸린다. 앱이 바로 진행 표시를 하도록 먼저 알린다
    digest = (into[1]["audio"].get("sha256") if into else None) or audio.sha256(source.paths)  # 변환 전 노트는 저장할 때 잰 원본 트랙의 해시를 그대로 쓴다
    if not into and (done_dir := find_transcribed(meetings, digest)):
        common.warn("duplicate", t("이미 전사된 파일입니다: {path}\n다시 전사하려면 이 폴더를 지우고 실행하세요.", path=done_dir))
        common.Events.emit("done", meeting_id=json.loads((done_dir / "transcript.json").read_text(encoding="utf-8"))["meeting_id"], meeting_dir=str(done_dir))
        raise typer.Exit(0)

    job = find_job(meetings, digest, append[1]["meeting_id"] if append else None, into[1]["meeting_id"] if into else None)
    if job and not _engine_ready(job.model):  # 이어 할 변환 엔진을 지웠다: 같은 노트 폴더에서 지금 고른 엔진으로 처음부터
        asr = choose_asr(track, asr_engine)
        if registry.usable(asr.id, models_dir()):
            common.warn("asr_engine_changed", t("이어 할 변환 엔진이 없어 {name}(으)로 처음부터 다시 변환합니다", name=asr.name))
            job.model, job.track, job.engine = asr.repo, track_name(asr), asr.engine or "qwen3"
            (job.dir / CHUNKS_FILE).unlink(missing_ok=True)
            job.save()
    if job:
        prev = registry.by_repo(job.model)
        if (asr_engine and (prev is None or prev.id != asr_engine)) or (track and track.value != job.track):
            common.console.print(f"[yellow]{t('진행 중인 작업의 트랙({track})으로 이어서 합니다.', track=job.track)}[/yellow]")
        common.console.print(t("이어서 진행합니다: {name} ({done}/{total} 청크 완료)", name=job.dir.name, done=len(job.done()), total=len(job.chunks)))  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)
        pcm = audio.decode(source.paths)
    else:
        job, pcm = _new_job(source, meetings, digest, title, choose_asr(track, asr_engine), language, term, diarize, max_speakers, engine, append, into)

    _run(job, pcm, source, keep_tracks, align)


def _free_mlx() -> None:
    """내린 모델의 MLX 버퍼를 돌려준다. 다음 모델과 통합 메모리에 함께 올라가지 않게 한다."""
    import gc

    import mlx.core as mx

    gc.collect()
    mx.clear_cache()


def _run_diarizer(engine: str, diarizer, pcm, max_speakers: int | None, fallback: str, code: str = "diarizer_failed") -> tuple[list, dict] | None:
    """→ (turn 목록, diarization). 실패하면 경고(code)하고 None. fallback: 실패 뒤 어떻게 하는지 (경고 문구)."""
    try:
        common.Events.emit("stage", stage="diarize", engine=engine)
        return diarizer.diarize(pcm, max_speakers), diarizer.info
    except Exception as e:  # noqa: BLE001 — 화자 분리 실패가 전사를 막지 않는다
        common.warn(code, t("화자 분리({engine})에 실패해 {fallback}: {error}", engine=engine, fallback=fallback, error=e))
        return None


def _diarize(pcm, max_speakers: int | None, engine: DiarizerEngine = DiarizerEngine.auto) -> tuple[list, dict | None]:
    """노트 전체 화자 분리 → (turn 목록, transcript.json의 diarization). 모델이 없거나 실패하면 화자 없이 진행한다.

    auto: Nemotron을 돌리고 8채널을 모두 썼으면(9명 이상일 수 있음) fluid로 다시 돌린다. --max-speakers가 8 이하면 그대로.
    fluid: 헬퍼·모델이 없거나 실패하면 Nemotron으로 돌린다. 60초 미만 클립이면 화자가 과하게 쪼개질 수 있다고 경고만 하고 그대로 돌린다."""
    models = models_dir()
    if engine is DiarizerEngine.fluid:
        if len(pcm) / SR < FLUID_MIN_CLIP_S:
            common.warn("fluid_short_clip", t("{sec}초보다 짧은 클립은 fluid 엔진이 화자를 과하게 나눌 수 있습니다. 결과가 이상하면 --diarizer nemotron으로 다시 해 보세요", sec=f"{FLUID_MIN_CLIP_S:.0f}"))
        fluid = load_fluid(models)
        if fluid is None:
            common.warn("fluid_missing", t("fluid 화자 분리 헬퍼나 모델이 없어 Nemotron으로 화자 분리합니다:\n{hint}", hint=fluid_hint(models)))
        elif res := _run_diarizer(FLUID, fluid, pcm, max_speakers, t("Nemotron으로 다시 합니다")):
            return res

    try:
        nemotron = load_diarizer(models)
    except Exception as e:  # noqa: BLE001
        common.warn("diarizer_failed", t("화자 분리 모델을 올리지 못해 화자 분리 없이 전사합니다: {error}", error=e))
        return [], None
    if nemotron is None:
        common.warn("diarizer_missing", t("화자 분리 모델이 없어 화자 분리 없이 전사합니다: {path}\n{hint}", path=models / DIARIZER_DIR, hint=registry.install_hint("diarizer", models)))
        return [], None
    res = _run_diarizer(NEMOTRON, nemotron, pcm, max_speakers, t("화자 분리 없이 전사합니다"))
    if res is None:
        return [], None
    capped = len({spk for _, _, spk in res[0]}) >= MAX_SPEAKERS and (max_speakers is None or max_speakers > MAX_SPEAKERS)
    if engine is not DiarizerEngine.auto or not capped:
        return res
    nemotron = None
    _free_mlx()  # Nemotron을 내린 뒤 헬퍼(CoreML, 별도 프로세스)를 돌린다
    fluid = load_fluid(models)
    if fluid is None:
        common.warn("diarizer_cap", t("화자가 {n}명을 넘을 수 있지만 fluid 헬퍼나 모델이 없어 {n}명으로 나눕니다:\n{hint}", n=MAX_SPEAKERS, hint=fluid_hint(models)))
        return res
    return _run_diarizer(FLUID, fluid, pcm, max_speakers, t("Nemotron 결과({n}명)를 씁니다", n=MAX_SPEAKERS), "diarizer_cap_failed") or res


def _suggest_voices(pcm, turns: list[dict]) -> dict:
    """화자 분리 결과를 등록된 목소리와 맞춘 제안 {라벨: {person_id, name, score}}. 등록된 사람이 없으면 조용히 건너뛴다.
    모델이 없거나 실패해도 전사는 계속한다 (onnxruntime CPU라 MLX 메모리와 겹치지 않는다)."""
    try:
        people = voices.usable_people(voices.load_profiles(home_dir()))
        if not people or not turns:
            return {}
        embedder = voices.load_embedder(models_dir())
        if embedder is None:
            common.warn("voices_model_missing", t("목소리 모델이 없어 등록된 목소리를 맞춰 보지 않습니다: {hint}", hint=voices.model_hint(models_dir())))
            return {}
        common.Events.emit("stage", stage="voices")
        return voices.suggest(embedder, pcm, turns, people, sorted({x["speaker"] for x in turns}))
    except Exception as e:  # noqa: BLE001 — 목소리 제안 실패가 전사를 막지 않는다
        common.warn("voices_failed", t("등록된 목소리를 맞춰 보지 못했습니다 (`tractus voices match <노트>`로 다시 시도): {error}", error=e))
        return {}


def _aligner_hint() -> str:
    return f"{models_dir() / ALIGNER_DIR}\n{registry.install_hint('aligner', models_dir())}"


def _align_progress() -> Progress:
    return Progress(TextColumn(t("단어 타이밍")), BarColumn(), MofNCompleteColumn(), TimeElapsedColumn(), console=common.console)


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


def _align(d: Path, note: dict, pcm) -> None:
    """전사 뒤 단어 타이밍을 채워 다시 저장한다. 모델이 없거나 실패하면 words = null로 두고 경고만 한다 (`tractus align`으로 나중에)."""
    if not note["segments"]:
        return
    try:
        aligner = load_aligner(models_dir())
        if aligner is None:
            common.warn("aligner_missing", t("단어 타이밍 모델이 없어 단어 타이밍 없이 저장합니다: {hint}", hint=_aligner_hint()))
            return
        common.Events.emit("stage", stage="align")
        with _align_progress() as progress:
            bar = progress.add_task("", total=len(note["segments"]))

            def tick(n: int, total: int) -> None:
                progress.advance(bar)
                common.Events.emit("progress", done=n, total=total)

            segments, *_ = align_segments(aligner, pcm, note["segments"], on_progress=tick)
    except Exception as e:  # noqa: BLE001 — 단어 타이밍 실패가 전사를 막지 않는다
        common.warn("aligner_failed", t("단어 타이밍을 만들지 못했습니다 (`tractus align {meeting}`로 다시 시도): {error}", meeting=note["meeting_id"], error=e))
        return
    counts = _save_words(d, segments, {s["id"] for s in note["segments"]})
    if counts["approximate"]:
        common.console.print(f"[yellow]{t('단어 타이밍을 정확히 맞추지 못해 고르게 나눈 세그먼트 {n}개 (`tractus align --force`로 다시 시도)', n=counts['approximate'])}[/yellow]")  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)


def _new_job(
    source: Source, meetings: Path, digest: str, title: str | None, asr: registry.Model, language: Language, terms: list[str], diarize: bool, max_speakers: int | None,
    engine: DiarizerEngine = DiarizerEngine.auto, append: tuple[Path, dict] | None = None, into: tuple[Path, dict] | None = None,
):
    vad_dir, _ = local_model(VAD_MODEL), local_model(asr.repo)  # 오래 걸리는 작업 전에 모델부터 확인
    with common.console.status(t("오디오 디코딩·VAD·화자 분리 중…")):
        pcm = audio.decode(source.paths)
        common.Events.emit("stage", stage="vad")
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
        with common.console.status(t("원본을 audio.ogg로 보관 중…")):
            common.Events.emit("stage", stage="encode")
            audio.encode_opus(source.paths, d / "audio.ogg")
    if source.marks:
        (d / MEMOS_FILE).write_text(json.dumps(source.marks, ensure_ascii=False, indent=1), encoding="utf-8")
    if source.event:
        save_event(d, source.event)

    ev = source.event or load_event(d)  # 나중에 변환(--into)은 노트 폴더의 일정을 읽는다
    # 이 노트에 가까운 것부터: 참석자 이름(이 노트의 변환에만) → 명령의 --term → 자주 쓰는 단어 → 노트의 제목·메모에서 고른 낱말. 앞의 asr.HOTWORDS_MAX개만 쓴다
    old = (append or into or (None, {}))[1]
    marks = source.marks or (load_memos(into[0]) if into else [])  # 변환 전 노트는 녹음 중 메모를 memos.json에 두었다
    mine = [str(old.get("body") or "")] + [m["text"] for m in memo_lines(old)] + [str(m.get("text") or "") for m in marks]
    picked = note_terms(title, *mine)  # 기본 제목(녹음 14:05)은 흔한 말·시각이라 남지 않는다
    hotwords = list(dict.fromkeys((ev["attendees"] if ev else []) + terms + load_glossary(home_dir() / "glossary.md") + picked))
    job = Job(
        dir=d, meeting_id=meeting_id, sha256=digest, source=source.name, title=title,
        created_at=created_at, duration_sec=round(len(pcm) / SR, 2),
        model=asr.repo, track=track_name(asr), engine=asr.engine or "qwen3", language=language.value, hotwords=hotwords, chunks=chunks, audio_file="audio.ogg",
        diarizer=diarization, suggestions=suggestions, attach=bool(append), convert=bool(into),
    )
    job.save()
    n_spk = len({c[2] for c in chunks} - {None})
    common.console.print(t("노트 폴더: {path}\n트랙 {track} ({model}), 청크 {chunks}개, 화자 {speakers}명(추정), 용어 {terms}개", path=d, track=track_name(asr), model=asr.repo, chunks=len(chunks), speakers=n_spk, terms=len(hotwords)))  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)
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
            common.fail(str(e), code="not_recorded", exit_code=2)
    if not job.attach:
        return write_transcript(job)
    try:
        t, ok = attach.finish_append(job)
    except ValueError as e:  # 변환하는 사이 다른 실행이 먼저 이 노트에 녹음을 붙였다. 이 작업 파일은 낡은 것이 되어 다음에 지워진다
        common.fail(str(e), code="append_has_audio", exit_code=2)
    if not ok:
        common.warn("append_remap_failed", attach.REMAP_FAILED)
    return t


def _run(job: Job, pcm, source: Source, keep_tracks: bool, align: bool = True) -> None:
    common.Events.emit("stage", stage="load_model")
    try:
        transcriber = Transcriber.load(local_model(job.model))
    except typer.BadParameter:
        raise
    except Exception as e:  # noqa: BLE001 — 직접 추가한 엔진의 파일이 모자라거나 계열이 맞지 않으면 mlx-audio가 여러 예외를 낸다
        common.fail(t("변환 엔진을 불러오지 못했습니다 ({model}): {error}", model=job.model, error=e), code="model_load_failed")
    lang = None if job.language == "auto" else job.language
    done = job.done()
    todo = [i for i in range(len(job.chunks)) if i not in done]
    t0, repaired = time.perf_counter(), 0
    columns = [TextColumn(t("전사")), BarColumn(), MofNCompleteColumn(), TimeElapsedColumn(), TextColumn(t("남은 시간")), TimeRemainingColumn()]
    try:
        common.Events.emit("stage", stage="transcribe")
        common.Events.emit("progress", done=len(done), total=len(job.chunks))
        with Progress(*columns, console=common.console) as progress:
            bar = progress.add_task("", total=len(job.chunks), completed=len(done))
            for n, i in enumerate(todo, len(done) + 1):
                s, e, _ = job.chunks[i]
                seg = transcriber.transcribe(pcm[s:e], language=lang, hotwords=job.hotwords)
                job.append(i, seg)
                repaired += seg.repaired
                progress.advance(bar)
                common.Events.emit("progress", done=n, total=len(job.chunks))
    except KeyboardInterrupt:
        common.console.print()
        common.fail(t("변환을 중단했습니다. 같은 명령으로 다시 실행하면 이어서 진행합니다."), code="interrupted", exit_code=130)

    elapsed = time.perf_counter() - t0
    job.suggestions = voices.still_registered(home_dir(), job.suggestions)
    try:
        note = _write_result(job)
    except IncompleteError as e:
        common.fail(str(e), code="incomplete")
    # ASR 모델을 내린 뒤 색인한다: 1.7B(3.6GB)와 임베딩 모델(1.4GB)이 통합 메모리에 함께 올라가지 않게
    del transcriber
    _free_mlx()
    _finish_recording(source, job.dir, keep_tracks)  # 전사는 저장됐다. 정렬 중에 끊겨도 녹음 폴더가 남지 않게 먼저 정리한다
    if job.convert and not keep_tracks:
        deferred.drop_tracks(job.dir)  # 변환 전 노트가 보관하던 원본 트랙 (--keep-tracks면 노트의 tracks/에 남긴다)
    if align:
        try:
            _align(job.dir, note, pcm)
        except KeyboardInterrupt:
            common.console.print()
            common.fail(t("단어 싱크를 맞추다가 중단했습니다. 대화 내용은 저장했고, `tractus align {meeting}`로 나중에 맞출 수 있습니다.", meeting=job.meeting_id), code="align_interrupted", exit_code=130)
        _free_mlx()  # 정렬 모델을 내린 뒤 임베딩 모델을 올린다
    common.Events.emit("stage", stage="index")
    common.sync_index_quietly()
    rtf = f" (RTF {elapsed / job.duration_sec:.3f})" if not done and job.duration_sec else ""  # 이어하기면 일부만 처리해 RTF가 의미 없음
    common.console.print(
        t("완료: 세그먼트 {n}개, 반복 출력 보정 {repaired}건, {minutes}분", n=len(note["segments"]), repaired=repaired, minutes=f"{elapsed / 60:.1f}") + f"{rtf}\n"
        f"{job.dir / 'transcript.md'}"
    )
    common.Events.emit("done", meeting_id=job.meeting_id, meeting_dir=str(job.dir))


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
    common.Events.enabled = progress_json
    try:
        name = notes.clean_title(title) if title and title.strip() else None
    except ValueError as e:
        common.fail(str(e), code="bad_input", exit_code=2)
    if not recording.is_dir():
        common.fail(t("녹음 폴더를 찾지 못했습니다: {path}", path=recording), code="recording_missing", exit_code=2)
    meetings = home_dir() / "meetings"
    meetings.mkdir(parents=True, exist_ok=True)
    try:
        d, mid = deferred.finish_recording(recording, meetings, name, lambda stage: common.Events.emit("stage", stage=stage))
    except deferred.RecordingError as e:
        common.fail(str(e), code=e.code, exit_code=2)
    except audio.FFmpegError as e:
        common.fail_audio(e)
    except OSError as e:  # 디스크 부족·권한 등. 녹음 폴더는 그대로 남아 있다 (같은 명령으로 다시 실행하면 이어서 끝낸다)
        common.fail(t("녹음을 저장하지 못했습니다: {error}", error=e), exit_code=1)
    except KeyboardInterrupt:
        common.console.print()
        common.fail(t("저장을 중단했습니다. 같은 명령으로 다시 실행하면 이어서 진행합니다."), code="interrupted", exit_code=130)
    if progress_json:
        common.Events.emit("done", meeting_id=mid, meeting_dir=str(d))
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

    common.Events.enabled = progress_json

    memory = physical_memory()
    if memory < STANDARD_MIN_MEMORY and not force:
        common.fail(t("실시간 텍스트 변환은 메모리 16GB 이상에서만 켭니다 (이 Mac {gb}GB). 녹음과 함께 약 2GB를 더 써서 녹음 뒤 변환이 느려지거나 메모리가 부족할 수 있습니다. 그래도 쓰려면 --force", gb=f"{memory / 1024**3:.0f}"), code="live_low_memory")
    try:
        vad_dir, asr_dir = local_model(VAD_MODEL), local_model(MODELS[Track.standard if engine is LiveEngine.std else Track.lite])
    except typer.BadParameter as e:
        common.fail(str(e), code="model_missing")

    stop = threading.Event()

    def watch_stdin() -> None:
        for line in sys.stdin:
            if line.strip() == "stop":
                break
        stop.set()  # stop 줄 또는 EOF (부모 앱이 죽어도 고아로 남지 않게)

    threading.Thread(target=watch_stdin, daemon=True).start()
    hotwords = load_glossary(home_dir() / "glossary.md")

    def emit(event: str, **data) -> None:
        common.Events.emit(event, **data)
        if not progress_json and event == "live" and data["kind"] == "final" and data["text"]:
            m, s = divmod(int(data["start"]), 60)
            print(f"[{m:02d}:{s:02d}] {data['speaker'] + ': ' if data['speaker'] else ''}{data['text']}", flush=True)  # 터미널에서 실행하면 확정된 자막만 stdout에 찍는다

    # 프로세스 전체 핸들러라 끝나면 되돌린다 (테스트·다른 코드가 같은 프로세스에서 SIGINT를 받을 수 있다)
    previous = {sig: signal.signal(sig, lambda *_: stop.set()) for sig in (signal.SIGTERM, signal.SIGINT)}
    from tractus import live as live_mod  # 모듈을 불러올 때 FIR 계수를 numpy로 만든다: 이 명령에서만

    try:
        live_mod.run(recording, emit, common.warn, stop, vad_dir, asr_dir, models_dir() / DIARIZER_DIR if speakers else None, hotwords)
    except (live_mod.LiveError, ValueError, OSError) as e:
        common.fail(t("실시간 텍스트 변환을 멈췄습니다: {error}", error=e), code="live_failed")
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
    common.Events.enabled = progress_json

    try:
        d = common.resolve_meeting(meeting)
    except typer.BadParameter as e:
        common.emit_error(str(e))
        raise
    note = common.read_transcript(d)
    if is_memo(note):
        common.fail(notes.NO_AUDIO_ALIGN, code="no_audio", exit_code=2)
    if is_recorded(note):
        common.fail(NOT_CONVERTED, code="not_converted", exit_code=2)
    todo = {s["id"] for s in note["segments"] if force or s.get("words") is None}
    counts = {"aligned": 0, "approximate": 0, "failed": 0, "skipped": len(note["segments"])}
    if todo:
        aligner = load_aligner(models_dir())
        if aligner is None:
            common.fail(t("단어 싱크 엔진 파일이 없습니다: {hint}", hint=_aligner_hint()), code="model_missing")
        try:
            audio.require_ffmpeg()
            common.Events.emit("stage", stage="decode")
            pcm = audio.decode(d / note["audio"]["file"])
        except audio.FFmpegError as e:
            common.fail_audio(e)
        common.Events.emit("stage", stage="align")
        t0 = time.perf_counter()
        with _align_progress() as progress:
            bar = progress.add_task("", total=len(todo))

            def tick(n: int, total: int) -> None:
                progress.advance(bar)
                common.Events.emit("progress", done=n, total=total)

            segments, *_ = align_segments(aligner, pcm, note["segments"], on_progress=tick, only=todo)
        counts = _save_words(d, segments, todo)
        common.console.print(t("단어 타이밍: 성공 {aligned}, 추정 {approximate}, 실패 {failed}, 건너뜀 {skipped} ({sec}초)", **counts, sec=f"{time.perf_counter() - t0:.1f}"))  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)
    if progress_json:
        common.Events.emit("done", meeting_id=note["meeting_id"], meeting_dir=str(d), **counts)
    else:
        print(json.dumps(counts))


if __name__ == "__main__":
    app()
app.add_typer(summary.app)  # 요약 유형(templates)·노트의 요약들(summaries)·회의록(minutes) 명령. 모두 노트의 요약 파일을 보고 고친다.
models_cli.register(app)  # models list|download|remove, doctor (docs/desktop.md §2.15)
organize_cli.register(app, note.note_app)  # note meta, folders, notes list (docs/desktop.md §2.12)
app.add_typer(glossary.app)  # 용어집(glossary) 명령: 다음 변환부터 자주 쓰는 단어로 들어갈 용어를 더한다.
app.add_typer(exports.app)  # 내보내기(export)와 Obsidian 보내기 명령.
app.add_typer(note.app)  # 노트 만들기·저장·제목(note)과 녹음 중 메모·북마크 고치기(marks) 명령.
app.add_typer(transcript.app)  # 노트의 대화 내용 명령: 파일 다시 그리기(render), 문장 고치기(segments), 스마트 교정(polish).
app.add_typer(speakers.app)  # 참석자(화자) 보기·이름 짓기·고치기(speakers) 명령.
app.add_typer(voiceprint.app)  # 목소리 프로필(voices) 명령: 등록한 사람의 목소리로 새 노트의 화자에 이름을 제안한다.
app.add_typer(ai.app)  # AI 명령: 요약(summarize)·질문(ask)·AI 서비스 연결(llm test|models). 원격 AI 서비스(OpenAI 호환)로 노트 내용을 보낸다.
app.add_typer(search.app)  # 검색 색인(index)과 검색(search) 명령.
app.add_typer(mcp.app)  # MCP 서버(mcp) 명령: Claude Code 같은 에이전트가 노트를 읽게 한다.
