"""회의 폴더(§4.1 레이아웃), 진행 상태(이어하기), transcript.json/md 저장."""

import json
import os
import re
import secrets
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from tractus.asr import Segment

SR = 16000
SCHEMA_VERSION = 1
JOB_FILE = ".job.json"
CHUNKS_FILE = ".chunks.jsonl"
_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

__all__ = ["Job", "Segment", "find_job", "find_meeting_dir", "load_glossary", "meeting_dir_name", "new_ulid", "render_markdown", "write_transcript"]


def new_ulid(ms: int | None = None) -> str:
    """ULID: 48비트 밀리초 시각 + 80비트 난수, Crockford base32 26자. 시간순 정렬된다."""
    n = ((int(time.time() * 1000) if ms is None else ms) << 80) | secrets.randbits(80)
    return "".join(_CROCKFORD[(n >> (5 * i)) & 31] for i in reversed(range(26)))


def meeting_dir_name(date: str, title: str, meeting_id: str) -> str:
    safe = re.sub(r'[\s/\\:*?"<>|]+', "_", title).strip("_")[:40] or "meeting"
    return f"{date}_{safe}_{meeting_id}"


def load_glossary(path: Path) -> list[str]:
    """Markdown 목록 항목(`- 용어`, `* 용어`)만 용어로 읽는다. 파일이 없으면 빈 목록."""
    if not path.exists():
        return []
    terms = []
    for line in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"\s*[-*]\s+(.+)", line)
        if m and m.group(1).strip():
            terms.append(m.group(1).strip())
    return terms


@dataclass
class Job:
    """진행 중인 전사 작업. 청크 경계를 저장해 두므로 이어하기 때 VAD를 다시 돌리지 않는다."""

    dir: Path
    meeting_id: str
    sha256: str
    source: str
    title: str
    created_at: str
    duration_sec: float
    model: str
    track: str
    language: str  # "auto" | "ko" | "en"
    hotwords: list[str] = field(default_factory=list)
    chunks: list[tuple[int, int]] = field(default_factory=list)

    def save(self) -> None:
        data = {k: v for k, v in asdict(self).items() if k != "dir"}
        _write_atomic(self.dir / JOB_FILE, json.dumps(data, ensure_ascii=False, indent=1))

    def append(self, i: int, seg: Segment) -> None:
        with (self.dir / CHUNKS_FILE).open("a", encoding="utf-8") as f:
            # 줄 앞에 줄바꿈을 붙인다. 직전 기록이 줄바꿈 없이 잘렸어도 이번 기록은 별도 줄로 남는다.
            f.write("\n" + json.dumps({"i": i, **asdict(seg)}, ensure_ascii=False))
            f.flush()
            os.fsync(f.fileno())

    def done(self) -> dict[int, Segment]:
        """완료된 청크. 강제 종료로 마지막 줄이 잘렸으면 그 줄은 버린다."""
        path = self.dir / CHUNKS_FILE
        if not path.exists():
            return {}
        out = {}
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            i = d.pop("i")
            out[i] = Segment(**d)
        return out

    @classmethod
    def load(cls, d: Path) -> "Job":
        data = json.loads((d / JOB_FILE).read_text(encoding="utf-8"))
        data["chunks"] = [tuple(c) for c in data["chunks"]]
        return cls(dir=d, **data)


def find_job(meetings: Path, sha256: str) -> Job | None:
    """같은 원본 파일로 시작했다가 끝나지 않은 작업을 찾는다."""
    for p in sorted(meetings.glob(f"*/{JOB_FILE}")):
        try:
            job = Job.load(p.parent)
        except (OSError, ValueError, TypeError, KeyError):
            continue  # 다른 회의 폴더의 손상된 파일 때문에 전체가 막히지 않게 한다
        if job.sha256 == sha256:
            return job
    return None


def find_transcribed(meetings: Path, sha256: str) -> Path | None:
    """같은 원본 파일의 전사가 이미 끝난 회의 폴더."""
    for p in sorted(meetings.glob("*/transcript.json")):
        try:
            found = json.loads(p.read_text(encoding="utf-8"))["audio"].get("sha256") == sha256
        except (OSError, ValueError, TypeError, KeyError):
            continue
        if found:
            return p.parent
    return None


def find_meeting_dir(meetings: Path, ref: str) -> Path:
    """회의 폴더 경로 또는 meeting_id(일부)로 전사된 회의 폴더를 찾는다. 없거나 여러 개면 LookupError."""
    path = Path(ref).expanduser()
    if (path / "transcript.json").is_file():
        return path
    ref = ref.strip()
    hits = [d for d in sorted(meetings.glob("*")) if ref and ref in d.name and (d / "transcript.json").is_file()] if ref else []
    if len(hits) != 1:
        found = "없습니다" if not hits else f"{len(hits)}개입니다: " + ", ".join(d.name for d in hits[:5])
        raise LookupError(f"{ref!r}에 맞는 전사된 회의가 {found}")
    return hits[0]


def write_transcript(job: Job) -> dict:
    done = job.done()
    missing = [i for i in range(len(job.chunks)) if i not in done]
    if missing:
        raise RuntimeError(f"전사되지 않은 청크가 있습니다: {missing[:10]} — 같은 명령으로 다시 실행하세요")
    segments = []
    for i, (s, e) in enumerate(job.chunks):
        seg = done[i]
        if not seg.text:
            continue
        segments.append({
            "id": f"s{len(segments) + 1:04d}",
            "start": round(s / SR, 2),
            "end": round(e / SR, 2),
            "text": seg.text,
            "lang": seg.lang,
            "speaker": None,
            "corrected_text": None,
            "words": None,
        })
    transcript = {
        "schema_version": SCHEMA_VERSION,
        "meeting_id": job.meeting_id,
        "title": job.title,
        "created_at": job.created_at,
        "audio": {"file": "audio.opus", "duration_sec": job.duration_sec, "source": job.source, "sha256": job.sha256},
        "asr": {"model": job.model, "track": job.track, "runtime": "mlx-audio", "language": job.language, "hotwords": job.hotwords},
        "segments": segments,
    }
    # transcript.json이 완료 표시다. md를 먼저 쓰고 json을 마지막에 써야 중간 종료 시 md 없는 "완료"가 생기지 않는다.
    _write_atomic(job.dir / "transcript.md", render_markdown(transcript))
    _write_atomic(job.dir / "transcript.json", json.dumps(transcript, ensure_ascii=False, indent=1))
    (job.dir / JOB_FILE).unlink()
    (job.dir / CHUNKS_FILE).unlink(missing_ok=True)
    return transcript


def _hms(sec: float) -> str:
    sec = int(sec)
    return f"{sec // 3600:02d}:{sec % 3600 // 60:02d}:{sec % 60:02d}"


def render_markdown(t: dict) -> str:
    """사람·에이전트용 전사. frontmatter는 Obsidian 등에서 그대로 읽힌다."""
    head = [
        "---",
        f"meeting_id: {t['meeting_id']}",
        f"title: {t['title']}",
        f"created_at: {t['created_at']}",
        f"duration: {_hms(t['audio']['duration_sec'])}",
        f"asr_model: {t['asr']['model']}",
        "---",
        "",
        f"# {t['title']}",
        "",
    ]
    lines = [f"[{_hms(s['start'])}] {s['text']}" for s in t["segments"] if s["text"]]
    return "\n".join(head + lines) + "\n"


def _write_atomic(path: Path, text: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(path)
