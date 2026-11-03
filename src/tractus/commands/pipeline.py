"""변환 파이프라인: 소리 → 청크(VAD) → 화자 분리 → 변환(ASR) → 단어 시각(정렬) → 목소리 제안 → 저장. 명령(commands/transcribe.py)이 부른다."""

import json
import shutil
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from rich.progress import BarColumn
from rich.progress import MofNCompleteColumn
from rich.progress import Progress
from rich.progress import TextColumn
from rich.progress import TimeElapsedColumn
from rich.progress import TimeRemainingColumn
import typer

from tractus import attach
from tractus import audio
from tractus import deferred
from tractus import models_registry as registry
from tractus import voices
from tractus import asr
from tractus import align as align_core
from tractus import diarize
from tractus import vad
from tractus.align import MODEL_DIR as ALIGNER_DIR
from tractus.align import align_segments
from tractus.align import is_approximate
from tractus.asr import SR
from tractus.asr import note_terms
from tractus.calendar_event import load_event
from tractus.calendar_event import save_event
from tractus.commands import common, engines
from tractus.diarize import FLUID
from tractus.diarize import MAX_SPEAKERS
from tractus.diarize import MODEL_DIR as DIARIZER_DIR
from tractus.diarize import NEMOTRON
from tractus.diarize import fluid_hint
from tractus.diarize import split_chunks
from tractus.i18n import t
from tractus.paths import home_dir
from tractus.paths import models_dir
from tractus.store import CHUNKS_FILE
from tractus.store import IncompleteError
from tractus.store import JOB_FILE
from tractus.store import Job
from tractus.store import MEMOS_FILE
from tractus.store import edit_transcript
from tractus.store import find_job
from tractus.store import find_meeting_dir
from tractus.store import find_transcribed
from tractus.store import load_glossary
from tractus.store import load_memos
from tractus.store import meeting_dir_name
from tractus.store import memo_lines
from tractus.store import new_ulid
from tractus.store import read_transcript
from tractus.store import seg_text
from tractus.store import write_transcript


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


def source_from_recording(d: Path) -> Source:
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


def source_from_file(file: Path) -> Source:
    return Source(paths=[file], name=file.name, title=file.stem, recorded=datetime.fromtimestamp(file.stat().st_mtime).astimezone(), marks=[])


def append_target(ref: str) -> tuple[Path, dict]:
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


def into_target(ref: str) -> tuple[Path, dict]:
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


def source_from_note(d: Path, note: dict) -> Source:
    """"변환 전" 노트의 변환 입력: tracks/의 원본 트랙, 없으면 audio.ogg (경고 tracks_missing). 둘 다 없으면 BadParameter(앱은 code recording_missing)."""
    try:
        paths, marks, lossless = deferred.note_tracks(d, note)
    except deferred.RecordingError as e:
        raise typer.BadParameter(str(e), param_hint="--into") from e
    if not lossless:
        common.warn("tracks_missing", t("녹음 원본 트랙이 없어 보관한 audio.ogg로 변환합니다 (음질이 조금 낮을 수 있습니다)"))
    created = datetime.fromisoformat(note["created_at"]).astimezone() if isinstance(note.get("created_at"), str) else datetime.now().astimezone()
    return Source(paths=paths, name=str((note.get("audio") or {}).get("source") or d.name), title=note["title"], recorded=created, marks=marks)


def transcribe_source(
    source: Source, title: str | None, track: engines.Track | None, language: engines.Language, term: list[str], keep_tracks: bool, diarize: bool, max_speakers: int | None,
    align: bool = True, engine: engines.DiarizerEngine = engines.DiarizerEngine.auto, append: tuple[Path, dict] | None = None, into: tuple[Path, dict] | None = None,
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
    if job and not engines.engine_ready(job.model):  # 이어 할 변환 엔진을 지웠다: 같은 노트 폴더에서 지금 고른 엔진으로 처음부터
        asr = engines.choose_asr(track, asr_engine)
        if registry.usable(asr.id, models_dir()):
            common.warn("asr_engine_changed", t("이어 할 변환 엔진이 없어 {name}(으)로 처음부터 다시 변환합니다", name=asr.name))
            job.model, job.track, job.engine = asr.repo, engines.track_name(asr), asr.engine or "qwen3"
            (job.dir / CHUNKS_FILE).unlink(missing_ok=True)
            job.save()
    if job:
        prev = registry.by_repo(job.model)
        if (asr_engine and (prev is None or prev.id != asr_engine)) or (track and track.value != job.track):
            common.console.print(f"[yellow]{t('진행 중인 작업의 트랙({track})으로 이어서 합니다.', track=job.track)}[/yellow]")
        common.console.print(t("이어서 진행합니다: {name} ({done}/{total} 청크 완료)", name=job.dir.name, done=len(job.done()), total=len(job.chunks)))  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)
        pcm = audio.decode(source.paths)
    else:
        job, pcm = _new_job(source, meetings, digest, title, engines.choose_asr(track, asr_engine), language, term, diarize, max_speakers, engine, append, into)

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


def _diarize(pcm, max_speakers: int | None, engine: engines.DiarizerEngine = engines.DiarizerEngine.auto) -> tuple[list, dict | None]:
    """노트 전체 화자 분리 → (turn 목록, transcript.json의 diarization). 모델이 없거나 실패하면 화자 없이 진행한다.

    auto: Nemotron을 돌리고 8채널을 모두 썼으면(9명 이상일 수 있음) fluid로 다시 돌린다. --max-speakers가 8 이하면 그대로.
    fluid: 헬퍼·모델이 없거나 실패하면 Nemotron으로 돌린다. 60초 미만 클립이면 화자가 과하게 쪼개질 수 있다고 경고만 하고 그대로 돌린다."""
    models = models_dir()
    if engine is engines.DiarizerEngine.fluid:
        if len(pcm) / SR < diarize.FLUID_MIN_CLIP_S:
            common.warn("fluid_short_clip", t("{sec}초보다 짧은 클립은 fluid 엔진이 화자를 과하게 나눌 수 있습니다. 결과가 이상하면 --diarizer nemotron으로 다시 해 보세요", sec=f"{diarize.FLUID_MIN_CLIP_S:.0f}"))
        fluid = diarize.load_fluid(models)
        if fluid is None:
            common.warn("fluid_missing", t("fluid 화자 분리 헬퍼나 모델이 없어 Nemotron으로 화자 분리합니다:\n{hint}", hint=fluid_hint(models)))
        elif res := _run_diarizer(FLUID, fluid, pcm, max_speakers, t("Nemotron으로 다시 합니다")):
            return res

    try:
        nemotron = diarize.load_diarizer(models)
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
    if engine is not engines.DiarizerEngine.auto or not capped:
        return res
    nemotron = None
    _free_mlx()  # Nemotron을 내린 뒤 헬퍼(CoreML, 별도 프로세스)를 돌린다
    fluid = diarize.load_fluid(models)
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


def aligner_hint() -> str:
    return f"{models_dir() / ALIGNER_DIR}\n{registry.install_hint('aligner', models_dir())}"


def align_progress() -> Progress:
    return Progress(TextColumn(t("단어 타이밍")), BarColumn(), MofNCompleteColumn(), TimeElapsedColumn(), console=common.console)


def save_words(d: Path, segments: list[dict], ids: set[str]) -> dict:
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
        aligner = align_core.load_aligner(models_dir())
        if aligner is None:
            common.warn("aligner_missing", t("단어 타이밍 모델이 없어 단어 타이밍 없이 저장합니다: {hint}", hint=aligner_hint()))
            return
        common.Events.emit("stage", stage="align")
        with align_progress() as progress:
            bar = progress.add_task("", total=len(note["segments"]))

            def tick(n: int, total: int) -> None:
                progress.advance(bar)
                common.Events.emit("progress", done=n, total=total)

            segments, *_ = align_segments(aligner, pcm, note["segments"], on_progress=tick)
    except Exception as e:  # noqa: BLE001 — 단어 타이밍 실패가 전사를 막지 않는다
        common.warn("aligner_failed", t("단어 타이밍을 만들지 못했습니다 (`tractus align {meeting}`로 다시 시도): {error}", meeting=note["meeting_id"], error=e))
        return
    counts = save_words(d, segments, {s["id"] for s in note["segments"]})
    if counts["approximate"]:
        common.console.print(f"[yellow]{t('단어 타이밍을 정확히 맞추지 못해 고르게 나눈 세그먼트 {n}개 (`tractus align --force`로 다시 시도)', n=counts['approximate'])}[/yellow]")  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)


def _new_job(
    source: Source, meetings: Path, digest: str, title: str | None, asr: registry.Model, language: engines.Language, terms: list[str], diarize: bool, max_speakers: int | None,
    engine: engines.DiarizerEngine = engines.DiarizerEngine.auto, append: tuple[Path, dict] | None = None, into: tuple[Path, dict] | None = None,
):
    vad_dir, _ = engines.local_model(engines.VAD_MODEL), engines.local_model(asr.repo)  # 오래 걸리는 작업 전에 모델부터 확인
    with common.console.status(t("오디오 디코딩·VAD·화자 분리 중…")):
        pcm = audio.decode(source.paths)
        common.Events.emit("stage", stage="vad")
        chunks = vad.find_chunks(pcm, vad_dir)
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
        model=asr.repo, track=engines.track_name(asr), engine=asr.engine or "qwen3", language=language.value, hotwords=hotwords, chunks=chunks, audio_file="audio.ogg",
        diarizer=diarization, suggestions=suggestions, attach=bool(append), convert=bool(into),
    )
    job.save()
    n_spk = len({c[2] for c in chunks} - {None})
    common.console.print(t("노트 폴더: {path}\n트랙 {track} ({model}), 청크 {chunks}개, 화자 {speakers}명(추정), 용어 {terms}개", path=d, track=engines.track_name(asr), model=asr.repo, chunks=len(chunks), speakers=n_spk, terms=len(hotwords)))  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)
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
        transcriber = asr.Transcriber.load(engines.local_model(job.model))
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
