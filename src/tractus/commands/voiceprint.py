"""목소리 프로필(voices) 명령: 등록한 사람의 목소리로 새 노트의 화자에 이름을 제안한다."""

import json
from pathlib import Path

from rich.markup import escape
import typer

from tractus import audio
from tractus import voices
from tractus.commands import common
from tractus.commands import note
from tractus.commands import speakers
from tractus.i18n import t
from tractus.paths import home_dir
from tractus.paths import models_dir
from tractus.store import JOB_FILE
from tractus.store import Job
from tractus.store import NOT_CONVERTED
from tractus.store import apply_speaker_edit
from tractus.store import apply_suggestions
from tractus.store import edit_transcript
from tractus.store import forget_person
from tractus.store import is_memo
from tractus.store import is_recorded
from tractus.store import note_lock
from tractus.store import save_transcript

app = typer.Typer()  # 이 영역의 명령. cli.py가 이름 없이 붙여 한 층으로 합친다


voices_app = typer.Typer(help="목소리 프로필($TRACTUS_HOME/voices.json, 권한 0600). 등록한 사람의 목소리로 새 노트 화자에 이름을 제안한다. 이 Mac 밖으로 보내지 않는다")
app.add_typer(voices_app, name="voices")

CONSENT_MESSAGE = t(
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
        common.console.print(f"[red]{t('참석자 목소리 프로필을 읽지 못했습니다:')}[/red] {escape(str(e))}")
        raise typer.Exit(1)


def _voice_embedder():
    try:
        embedder = voices.load_embedder(models_dir())
    except RuntimeError as e:
        common.fail(str(e))
    if embedder is None:
        common.console.print(voices.model_hint(models_dir()), markup=False)  # 받는 방법은 앞 줄에, 앱이 보이는 마지막 줄은 문장으로
        common.fail(t("목소리 인식에 필요한 파일이 없습니다."))
    return embedder


def _meeting_pcm(d: Path, t: dict):
    try:
        audio.require_ffmpeg()
        common.Events.emit("stage", stage="decode")
        return audio.decode(d / t["audio"]["file"])
    except audio.FFmpegError as e:
        common.fail_audio(e)


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
        common.console.print(f"[yellow]{t('목소리 모델이 바뀌어 등록된 목소리를 쓸 수 없습니다. 다시 등록하세요 (`tractus voices enroll`).')}[/yellow]")  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)
    if not rows:
        print(t("등록된 목소리가 없습니다. `tractus voices enroll <노트> S1 --name 이름 --consent`로 등록합니다"))
    for r in rows:
        print(f"{r['name']}\t{t('표본 {n}개', n=r['samples'])}\t{(r['created_at'] or '')[:10]}\t{r['id']}")


@voices_app.command("enroll")
def voices_enroll(
    meeting: str = typer.Argument(..., help="노트 폴더 경로 또는 meeting_id (일부만 써도 됨)"),
    label: str = typer.Argument(..., help="S1 등"),
    name: str = typer.Option(..., "--name", help="이 화자의 이름. 같은 이름이 있으면 그 사람에 표본을 더한다 (최대 5개)"),
    consent: bool = typer.Option(False, "--consent", help="본인이거나 녹음·등록에 동의를 받았음 (필수)"),
) -> None:
    """화자의 목소리를 기억하고 그 이름으로 확정한다(= speakers rename + 등록). stdout: {"person_id", "name", "samples"}"""
    if not consent:
        common.console.print(f"[red]{escape(CONSENT_MESSAGE)}[/red]")
        raise typer.Exit(2)
    d = common.resolve_meeting(meeting)
    note = common.read_transcript(d)
    if is_memo(note):
        common.fail(t("녹음이 없는 노트라 목소리를 등록할 수 없습니다."), exit_code=2)
    if is_recorded(note):
        common.fail(NOT_CONVERTED, code="not_converted", exit_code=2)
    try:
        renamed = apply_speaker_edit(note, "rename", label, name)
    except ValueError as e:
        common.fail(str(e))
    clean = renamed["speakers"][label]["name"]
    if not clean:
        common.fail(t("이름을 입력하세요."))
    embedder = _voice_embedder()
    emb = voices.speaker_embedding(embedder, _meeting_pcm(d, note), note["segments"], label)
    if emb is None:
        common.fail(t("이 참석자가 {sec}초 이상 이어서 말한 부분이 없어 목소리를 등록할 수 없습니다.", sec=f"{voices.MIN_CLIP_S:g}"))
    with note_lock(d):  # 오래 걸리는 임베딩은 잠금 밖에서 하고, 읽기부터 쓰기까지만 잠근다 (그 사이의 편집을 덮어쓰지 않게 다시 읽는다)
        try:
            renamed = apply_speaker_edit(common.read_transcript(d), "rename", label, clean)
        except ValueError as e:
            common.fail(str(e))
        with voices.profiles_lock(home_dir()):  # 다른 노트의 등록·forget과 voices.json을 덮어쓰지 않게
            data = _profiles()
            previous = data if (home_dir() / voices.VOICES_FILE).exists() else None
            data, person = voices.enroll(data, clean, emb, note["meeting_id"])
            voices.save_profiles(home_dir(), data)
            try:
                save_transcript(d, renamed)
            except BaseException:
                voices.restore_profiles(home_dir(), previous)  # 이름은 못 붙였는데 목소리만 등록된 채로 남지 않게
                raise
    common.sync_index_quietly(embed=False)
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
    common.Events.enabled = progress_json
    try:
        d = common.resolve_meeting(meeting)
    except typer.BadParameter as e:
        common.emit_error(str(e))
        raise
    t = common.read_transcript(d)
    if is_recorded(t):
        common.fail(NOT_CONVERTED, code="not_converted", exit_code=2)
    speakers = t.get("speakers") or {}
    confirmed = {(v or {}).get("name") for v in speakers.values()} - {None}
    labels = [k for k, v in speakers.items() if not (v or {}).get("name")]
    people = [p for p in voices.usable_people(_profiles()) if p["name"] not in confirmed]
    dismissed = {k: set((v or {}).get("dismissed") or []) for k, v in speakers.items()}  # 사용자가 '다름'으로 거절한 사람은 다시 제안하지 않는다
    suggestions = {}
    if people and labels:
        embedder = _voice_embedder()
        pcm = _meeting_pcm(d, t)
        common.Events.emit("stage", stage="voices")
        suggestions = voices.suggest(embedder, pcm, t["segments"], people, labels, dismissed)
    suggestions = voices.still_registered(home_dir(), suggestions)  # 계산하는 동안 forget한 사람의 이름을 노트에 남기지 않는다
    edit_transcript(d, lambda cur: (apply_suggestions(cur, suggestions), None))  # 오래 걸린 계산 뒤라 최신 노트를 다시 읽어 합친다
    if progress_json:
        common.Events.emit("done", meeting_id=t["meeting_id"], meeting_dir=str(d), suggested=len(suggestions))
    else:
        print(json.dumps({"suggested": len(suggestions)}))
