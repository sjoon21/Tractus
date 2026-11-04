"""변환 명령: transcribe(파일·녹음 → 노트)·recording finish(변환 없이 노트로 저장)·live(실시간 자막)·align(단어 시각 채우기)."""

import json
import sys
import time
from pathlib import Path

import typer

from tractus import align as align_core, audio, deferred, models_registry as registry, notes
from tractus.align import align_segments
from tractus.commands import common, engines, pipeline
from tractus.diarize import MAX_SPEAKERS, MODEL_DIR as DIARIZER_DIR
from tractus.i18n import t
from tractus.models_registry import STANDARD_MIN_MEMORY
from tractus.paths import home_dir, models_dir
from tractus.store import is_memo, is_recorded, load_glossary, NOT_CONVERTED

app = typer.Typer()  # 이 영역의 명령. cli.py가 이름 없이 붙여 한 층으로 합친다


@app.command()
def transcribe(
    file: Path = typer.Argument(None, exists=True, dir_okay=False, help="녹음·동영상 파일 (m4a, mp3, wav, webm, mp4, mov … ffmpeg가 읽는 형식)"),
    recording: Path = typer.Option(None, "--recording", exists=True, file_okay=False, help="tractus-rec 녹음 폴더 (마이크·시스템 트랙을 섞어 전사)"),
    title: str = typer.Option(None, "--title", help="노트 제목. 생략하면 파일 이름 (녹음이면 '녹음 HH:MM')"),
    track: engines.Track = typer.Option(None, "--track", help="standard(1.7B) | lite(0.6B). 생략하면 메모리 16GB 이상이면 standard"),
    asr_engine: str = typer.Option(None, "--engine", help="변환 엔진 모델 ID (`tractus models list`의 변환 엔진). --track보다 우선한다. 받아 두지 않았으면 기본 엔진으로 변환한다"),
    language: engines.Language = typer.Option(engines.Language.auto, "--language", help="auto 권장. ko로 고정하면 영어 발화를 번역할 수 있음"),
    term: list[str] = typer.Option([], "--term", "-t", help="이 노트의 용어 (참석자 이름·제품명). 여러 번 지정 가능"),
    keep_tracks: bool = typer.Option(False, "--keep-tracks", help="녹음 원본 트랙을 지우지 않고 노트 폴더의 tracks/로 옮긴다"),
    no_diarize: bool = typer.Option(False, "--no-diarize", help="화자 분리를 하지 않는다 (segment.speaker = null)"),
    max_speakers: int = typer.Option(None, "--max-speakers", min=1, help=f"화자 수 상한. 말한 시간이 많은 N명만 남기고 나머지는 가까운 화자에 붙인다 (nemotron은 {MAX_SPEAKERS}명이 한계)"),
    diarizer: engines.DiarizerEngine = typer.Option(
        engines.DiarizerEngine.auto, "--diarizer",
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
    append = pipeline.append_target(append_to) if append_to else None
    convert = pipeline.into_target(into) if into else None
    try:
        source = pipeline.source_from_note(*convert) if convert else pipeline.source_from_file(file) if file else pipeline.source_from_recording(recording)
    except typer.BadParameter as e:
        common.emit_error(str(e), code="note_audio_missing" if convert else "recording_missing")  # 노트에 녹음 파일이 없으면 마이크 안내가 아니라 그 노트의 문장
        raise
    try:
        pipeline.transcribe_source(source, title, track, language, term, keep_tracks, not no_diarize, max_speakers, not no_align, diarizer, append, convert, asr_engine)
    except audio.FFmpegError as e:
        common.fail_audio(e)
    except typer.BadParameter as e:  # engines.local_model: 변환 엔진(모델) 파일 없음
        common.emit_error(str(e), code="model_missing")
        raise


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
    engine: engines.LiveEngine = typer.Option(engines.LiveEngine.lite, "--engine", help="개발·벤치 전용: lite(0.6B, 기본) | std(1.7B). 앱은 쓰지 않는다 (bench/live_sim.py --engine)"),
) -> None:
    """녹음 중 실시간 자막(미리보기). Qwen3-ASR 0.6B(--engine std는 개발·벤치 전용 1.7B)로 발화마다 전사해 내보내고 아무것도 저장하지 않는다.
    stdin에 `stop` 줄, stdin EOF, SIGTERM이면 마무리하고 종료 코드 0으로 끝난다. 정식 전사는 녹음을 멈춘 뒤 `transcribe --recording`.
    --progress-json 없이 실행하면 확정된 자막을 `\\[mm:ss] 문장` 줄로 stdout에 찍는다."""
    import signal
    import threading

    common.Events.enabled = progress_json

    memory = registry.physical_memory()
    if memory < STANDARD_MIN_MEMORY and not force:
        common.fail(t("실시간 텍스트 변환은 메모리 16GB 이상에서만 켭니다 (이 Mac {gb}GB). 녹음과 함께 약 2GB를 더 써서 녹음 뒤 변환이 느려지거나 메모리가 부족할 수 있습니다. 그래도 쓰려면 --force", gb=f"{memory / 1024**3:.0f}"), code="live_low_memory")
    try:
        vad_dir, asr_dir = engines.local_model(engines.VAD_MODEL), engines.local_model(engines.MODELS[engines.Track.standard if engine is engines.LiveEngine.std else engines.Track.lite])
    except typer.BadParameter as e:
        common.fail(str(e), code="model_missing")

    stop = threading.Event()

    def watch_stdin() -> None:
        for line in sys.stdin:
            if line.strip() == "stop":
                break
        stop.set()  # stop 줄 또는 EOF (부모 앱이 죽어도 고아로 남지 않게)

    threading.Thread(target=watch_stdin, daemon=True).start()
    hotwords = load_glossary(home_dir() / "glossary.md")[::-1]  # 최근에 더한 것부터 (앞의 asr.HOTWORDS_MAX개만 쓴다, v3.92)

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
        aligner = align_core.load_aligner(models_dir())
        if aligner is None:
            common.fail(t("단어 싱크 엔진 파일이 없습니다: {hint}", hint=pipeline.aligner_hint()), code="model_missing")
        try:
            audio.require_ffmpeg()
            common.Events.emit("stage", stage="decode")
            pcm = audio.decode(d / note["audio"]["file"])
        except audio.FFmpegError as e:
            common.fail_audio(e)
        common.Events.emit("stage", stage="align")
        t0 = time.perf_counter()
        with pipeline.align_progress() as progress:
            bar = progress.add_task("", total=len(todo))

            def tick(n: int, total: int) -> None:
                progress.advance(bar)
                common.Events.emit("progress", done=n, total=total)

            segments, *_ = align_segments(aligner, pcm, note["segments"], on_progress=tick, only=todo)
        counts = pipeline.save_words(d, segments, todo)
        common.console.print(t("단어 타이밍: 성공 {aligned}, 추정 {approximate}, 실패 {failed}, 건너뜀 {skipped} ({sec}초)", **counts, sec=f"{time.perf_counter() - t0:.1f}"))  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)
    if progress_json:
        common.Events.emit("done", meeting_id=note["meeting_id"], meeting_dir=str(d), **counts)
    else:
        print(json.dumps(counts))
