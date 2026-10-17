"""예시 노트 (첫 사용자 온보딩): 녹음·모델·AI 키 없이 바로 열어 보는 가상 회의 하나 (`tractus note sample`).

대화 내용·참석자 이름·내 메모·녹음 중 메모·요약·완성된 노트가 미리 들어 있다. 내용은 가상 회의(tests/fixtures/sample_meeting.json)다.
transcript.json의 `"sample": true`로 가른다: 검색 색인·MCP 목록·전체 AI 질문에 넣지 않는다. 지우는 방법은 다른 노트와 같다(휴지통).
"""

import fcntl
import json
import os
import shutil
from datetime import datetime
from pathlib import Path

from tractus import enhance, summarize
from tractus.notes import derive_lines
from tractus.organize import iter_notes
from tractus.store import MEMOS_FILE, SCHEMA_VERSION, _write_atomic, is_sample, meeting_dir_name, new_ulid, save_transcript

DATA = Path(__file__).with_name("sample_note.json")
SAMPLE_KEY = "sample"
MAKER = "예시"  # 요약·완성된 노트의 provider·model 자리 (AI를 부르지 않았다)
LOCK = ".sample.lock"  # meetings/ 안: 두 번 빨리 눌러 두 프로세스가 돌아도 예시 노트는 하나


def find(home: Path) -> Path | None:
    """이미 있는 예시 노트 폴더 (`"sample"` 글자가 없는 노트는 해석하지 않는다)."""
    return next((d for d, t in iter_notes(home, raw_ok=lambda raw: f'"{SAMPLE_KEY}"' in raw) if is_sample(t)), None)


def build(data: dict, meeting_id: str, created_at: str) -> dict:
    lines, seq = derive_lines(data["memo"], prefix="m")
    segments = [
        {"id": f"s{n:04d}", "start": start, "end": end, "text": text, "lang": "ko", "speaker": spk, "corrected_text": None, "words": None}
        for n, (spk, start, end, text) in enumerate(data["segments"], 1)
    ]
    return {
        "schema_version": SCHEMA_VERSION, "meeting_id": meeting_id, "title": data["title"], "created_at": created_at, SAMPLE_KEY: True,
        "audio": {"file": "audio.ogg", "duration_sec": data["duration_sec"], "source": "sample", "sha256": "sample"},  # 오디오는 없다 (재생 칸이 그렇게 말한다)
        "asr": {"model": "sample", "track": "standard", "runtime": "none", "language": "auto", "hotwords": []},
        "speakers": {k: {"name": v} for k, v in data["speakers"].items()}, "diarization": None,
        "segments": segments, "memo": {"body": data["memo"], "lines": lines, "seq": seq},
    }


def create(home: Path) -> tuple[Path, bool]:
    """예시 노트를 만든다 → (폴더, 새로 만들었는가). 이미 있으면 그것을 돌려준다 (다시 만들지 않는다).
    찾기부터 만들기까지 meetings/.sample.lock 안에서 한다. 만들다 실패하면 반쯤 만든 폴더를 지운다."""
    meetings = home / "meetings"
    meetings.mkdir(parents=True, exist_ok=True)
    fd = os.open(meetings / LOCK, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        if found := find(home):
            return found, False
        return _make(meetings), True
    finally:
        os.close(fd)  # 닫으면 잠금도 풀린다


def _make(meetings: Path) -> Path:
    data = json.loads(DATA.read_text(encoding="utf-8"))
    now = datetime.now().astimezone()
    mid = new_ulid()
    t = build(data, mid, now.isoformat(timespec="seconds"))
    d = meetings / meeting_dir_name(now.date().isoformat(), t["title"], mid)
    d.mkdir()
    try:
        _write_atomic(d / MEMOS_FILE, json.dumps(data["marks"], ensure_ascii=False, indent=1))
        summarize.write_summary(d, summarize.MeetingSummary.model_validate(data["summary"]), t, MAKER, MAKER)
        note = enhance.EnhancedNote.model_validate(data["enhanced"])
        srcs = enhance.sources(t, d)
        enhance.check(note, t, srcs)  # 예시 데이터가 실제 규칙(빠짐없는 메모·근거 ID)을 지키는지
        enhance.write(d, t, {"title": note.title, "sections": enhance.to_sections(note, t, srcs)}, MAKER, MAKER)
        save_transcript(d, t)  # transcript.json이 마지막: 이 파일이 생기면 노트는 끝난 것이다
    except BaseException:
        shutil.rmtree(d, ignore_errors=True)  # transcript.json 없는 반쪽 폴더를 남기지 않는다
        raise
    return d
