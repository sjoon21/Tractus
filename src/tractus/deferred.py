"""녹음과 텍스트 변환을 나눈다 (docs/desktop.md §2.16).

`tractus recording finish <녹음 폴더>`가 녹음을 "변환 전" 노트로 저장하고(변환하지 않는다),
`tractus transcribe --into <노트>`가 나중에 그 노트를 제자리에서 텍스트로 변환한다.

"변환 전" 노트는 평범한 노트 폴더다. transcript.json은 kind 없이(녹음 노트) "state": "recorded"와 빈 segments·speakers, 채워진 audio 블록을 갖고,
asr·diarization은 없거나 null이다. 녹음 트랙(원본 WAV)과 recording.json은 노트의 tracks/에 보관한다(손실 없는 변환용). 변환이 성공하면 state 키와 tracks/가 없어진다.
"""

import json
import shutil
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable

from tractus import audio
from tractus.calendar_event import load_event, save_event
from tractus.i18n import t
from tractus.store import (
    MEMOS_FILE, RECORDED, SCHEMA_VERSION, SR, Job, _clean_stale_job, _write_atomic, build_transcript, is_memo, is_recorded, meeting_dir_name, new_ulid, note_lock,
    read_transcript, save_transcript,
)

MARKER = ".finish.json"  # finish가 끝나기 전의 노트 폴더 표시 (다시 실행하면 이 폴더에서 이어간다)
TRACKS_DIR = "tracks"
EMPTY_WAV = 44  # 바이트: 빈 WAV 헤더
_BUILT = ("schema_version", "audio", "asr", "speakers", "diarization", "segments")  # 변환 결과가 덮어쓰는 키
NOT_RECORDED_CONVERTED = t("이미 텍스트로 변환한 노트입니다.")
NOT_RECORDED_MEMO = t("녹음이 없는 노트라 텍스트로 변환할 수 없습니다.")


class RecordingError(ValueError):
    """녹음 폴더를 읽을 수 없다 (CLI가 code로 알린다)."""

    def __init__(self, message: str, code: str = "recording_missing"):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class RecordingInfo:
    tracks: list[str]  # 트랙 파일 이름 (recording.json의 tracks 순서)
    started: datetime
    marks: list[dict]


def read_recording(path: Path) -> RecordingInfo:
    """recording.json → 트랙 이름·시작 시각·메모/북마크. 읽을 수 없으면 RecordingError."""
    try:
        rec = json.loads(path.read_text(encoding="utf-8"))
        tracks = [str(n) for n in rec["tracks"].values()]
        started = datetime.fromisoformat(rec["started_at"]).astimezone()
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as e:
        raise RecordingError(t("녹음 파일을 찾지 못했습니다 (recording.json): {error}", error=e)) from e
    marks = [m for m in rec.get("marks") or [] if isinstance(m, dict) and isinstance(m.get("t"), (int, float))]
    return RecordingInfo(tracks, started, marks)


def _where(name: str, *dirs: Path) -> Path | None:
    return next((p for d in dirs if (p := d / name).is_file()), None)


def recorded_transcript(meeting_id: str, title: str, created_at: str, duration: float, source: str, digest: str) -> dict:
    """"변환 전" 노트의 transcript.json 내용."""
    return {
        "schema_version": SCHEMA_VERSION, "state": RECORDED, "meeting_id": meeting_id, "title": title, "created_at": created_at,
        "audio": {"file": "audio.ogg", "duration_sec": duration, "source": source, "sha256": digest},
        "speakers": {}, "diarization": None, "segments": [],
    }


def _find_marker(meetings: Path, rec_name: str) -> tuple[Path, dict] | None:
    for p in sorted(meetings.glob(f"*/{MARKER}")):
        try:
            mk = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(mk, dict) and mk.get("recording") == rec_name and isinstance(mk.get("meeting_id"), str):
            return p.parent, mk
    return None


def _cleanup(rec: Path, note: Path) -> None:
    """녹음 폴더에 남은 파일(녹음 헬퍼가 만든 파일, attach.json)을 지우고 폴더와 finish 표시를 없앤다."""
    for p in rec.iterdir() if rec.is_dir() else []:
        if p.is_file():
            p.unlink()
    try:
        rec.rmdir()
    except OSError:
        pass  # 낯선 하위 폴더가 있으면 그대로 둔다
    (note / MARKER).unlink(missing_ok=True)


def finish_recording(rec: Path, meetings: Path, title: str | None, stage: Callable[[str], None]) -> tuple[Path, str]:
    """녹음 폴더 rec를 "변환 전" 노트로 저장한다 → (노트 폴더, meeting_id). 변환하지 않는다.
    순서: 표시(.finish.json) → audio.ogg → memos.json → 트랙·recording.json을 tracks/로 복사 → transcript.json(마지막, 완료 표시) → 녹음 폴더 지우기(원본은 여기서 지운다).
    어디서 끊겨도 녹음 폴더는 온전히 남고(앱의 `변환 대기 중인 녹음`에 보인다), 같은 명령을 다시 실행하면 같은 노트 폴더에서 이어서 끝낸다.
    RecordingError(녹음을 읽을 수 없음), audio.FFmpegError."""
    found = _find_marker(meetings, rec.name)
    if found and (found[0] / "transcript.json").is_file():  # 노트는 이미 완성됐고 녹음 폴더 정리만 남았다
        _cleanup(rec, found[0])
        return found[0], found[1]["meeting_id"]
    dirs = [rec, *([found[0] / TRACKS_DIR] if found else [])]  # 일부 트랙을 이미 옮겼을 수 있다
    info = read_recording(_where("recording.json", *dirs) or rec / "recording.json")
    paths = [p for n in info.tracks if (p := _where(n, *dirs)) and p.stat().st_size > EMPTY_WAV]
    if not paths:
        raise RecordingError(t("{path}에 녹음된 소리가 없습니다", path=rec))
    audio.require_ffmpeg()
    stage("decode")  # 큰 녹음은 해시와 길이 계산에 몇 초 걸린다
    if found:
        d, mk = found
        meeting_id, digest, duration = mk["meeting_id"], mk["sha256"], mk["duration_sec"]
        title = title or mk["title"]
    else:
        digest = audio.sha256(paths)
        duration = round(len(audio.decode(paths)) / SR, 2)  # ponytail: 길이를 재려고 통째로 디코딩한다 (1시간 약 230MB). 더 길면 ffprobe로 바꾼다
        meeting_id = new_ulid()
        title = title or (ev["title"] if (ev := load_event(rec)) else t("녹음 {time}", time=f"{info.started:%H:%M}"))  # 기본 제목은 만들 때의 화면 언어
        d = meetings / meeting_dir_name(info.started.date().isoformat(), title, meeting_id)
        d.mkdir(parents=True)
        _write_atomic(d / MARKER, json.dumps({"recording": rec.name, "meeting_id": meeting_id, "title": title, "sha256": digest, "duration_sec": duration}, ensure_ascii=False))
    if not (d / "audio.ogg").is_file():  # 임시 이름으로 만든 뒤 바꿔서 audio.ogg가 있으면 완성본이다
        stage("encode")
        audio.encode_opus(paths, d / "audio.part.ogg")
        (d / "audio.part.ogg").replace(d / "audio.ogg")
    if info.marks and not (d / MEMOS_FILE).is_file():
        _write_atomic(d / MEMOS_FILE, json.dumps(info.marks, ensure_ascii=False, indent=1))
    if ev := load_event(rec):
        save_event(d, ev)
    tracks = d / TRACKS_DIR
    tracks.mkdir(exist_ok=True)
    for p in [*paths, rec / "recording.json"]:  # 복사다(옮기지 않는다): 원본은 transcript.json 뒤 _cleanup에서 지운다. 끊겨도 녹음 폴더가 온전해 앱 목록에서 사라지지 않고 일부 트랙만 변환되는 일이 없다
        if p.parent == rec and p.is_file():
            part = tracks / f"{p.name}.part"
            shutil.copy2(p, part)
            part.replace(tracks / p.name)
    save_transcript(d, recorded_transcript(meeting_id, title, info.started.isoformat(timespec="seconds"), duration, rec.name, digest))  # transcript.json이 마지막
    _cleanup(rec, d)
    return d, meeting_id


def check_recorded(t: dict) -> None:
    """텍스트로 변환할 수 있는 노트("변환 전")인지. 아니면 ValueError(WORDS 문장)."""
    if not is_recorded(t):
        raise ValueError(NOT_RECORDED_MEMO if is_memo(t) else NOT_RECORDED_CONVERTED)


def note_tracks(d: Path, note: dict) -> tuple[list[Path], list[dict], bool]:
    """"변환 전" 노트 d의 변환 입력 → (오디오 파일들, 녹음 중 메모·북마크 중 memos.json에 아직 없는 것, 트랙을 쓰는가).
    tracks/가 있으면 그 트랙(손실 없음), 없거나 비었으면 audio.ogg 하나(False). 둘 다 없으면 RecordingError."""
    tr = d / TRACKS_DIR
    try:
        info = read_recording(tr / "recording.json")
        names, marks = info.tracks, info.marks
    except RecordingError:
        names, marks = sorted(p.name for p in tr.glob("*.wav")), []
    paths = [p for n in names if (p := tr / n).is_file() and p.stat().st_size > EMPTY_WAV]
    if paths:
        return paths, ([] if (d / MEMOS_FILE).is_file() else marks), True
    ogg = d / str((note.get("audio") or {}).get("file") or "audio.ogg")
    if not ogg.is_file():
        raise RecordingError(t("{name}에 녹음 파일이 없습니다", name=d.name))
    return [ogg], [], False


def finish_convert(job: Job) -> dict:
    """변환 작업(Job.convert)의 마지막 단계. note_lock 안에서 노트를 다시 읽어 변환 결과를 합쳐 쓴다 → 새 전사.
    변환하는 사이 고친 제목·메모·태그·폴더 등 결과에 없는 키는 다시 읽은 쪽을 그대로 둔다. state 키를 지우고 transcript.json을 마지막에 쓴다.
    끝나지 않은 청크가 있으면 store.IncompleteError, 노트가 더는 "변환 전"이 아니면 ValueError."""
    built = build_transcript(job)
    with note_lock(job.dir):
        cur = read_transcript(job.dir)
        check_recorded(cur)  # 변환하는 사이 다른 실행이 먼저 변환했으면 그 결과를 덮어쓰지 않는다
        new = {**cur, **{k: built[k] for k in _BUILT}, "updated_at": datetime.now().astimezone().isoformat(timespec="seconds")}  # 변환은 내용이 바뀐 것이다 (노트 순서: 수정 시각)
        new.pop("state")
        save_transcript(job.dir, new)
    _clean_stale_job(job.dir)
    return new


def drop_tracks(d: Path) -> None:
    """변환이 끝난 노트의 tracks/(원본 WAV와 recording.json)를 지운다."""
    shutil.rmtree(d / TRACKS_DIR, ignore_errors=True)

