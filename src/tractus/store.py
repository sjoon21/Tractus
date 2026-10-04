"""회의 폴더(§4.1 레이아웃), 진행 상태(이어하기), transcript.json/md/vtt 저장, 화자 편집."""

import copy
import json
import os
import re
import secrets
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from tractus.asr import Segment

SR = 16000
SCHEMA_VERSION = 2  # 2: segment.speaker("S1"…), 최상위 speakers·diarization. 1도 그대로 읽는다
JOB_FILE = ".job.json"
CHUNKS_FILE = ".chunks.jsonl"
_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

__all__ = [
    "Job", "Segment", "apply_speaker_edit", "find_job", "find_meeting_dir", "load_glossary", "meeting_dir_name", "new_ulid",
    "render_markdown", "save_transcript", "speaker_name", "write_transcript",
]


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
    """진행 중인 전사 작업. 청크 경계와 화자를 저장해 두므로 이어하기 때 VAD·화자 분리를 다시 돌리지 않는다."""

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
    chunks: list[tuple[int, int, str | None]] = field(default_factory=list)  # (시작 표본, 끝 표본, 화자 라벨 또는 None)
    audio_file: str = "audio.opus"  # 새 작업은 audio.ogg. 값이 없는 예전 .job.json은 audio.opus
    diarizer: dict | None = None  # transcript.json의 diarization. None이면 화자 분리 안 함

    def __post_init__(self) -> None:
        self.chunks = [(c[0], c[1], c[2] if len(c) > 2 else None) for c in self.chunks]  # 예전 작업의 [s, e]도 받는다

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
    for i, (s, e, speaker) in enumerate(job.chunks):
        seg = done[i]
        if not seg.text:
            continue
        segments.append({
            "id": f"s{len(segments) + 1:04d}",
            "start": round(s / SR, 2),
            "end": round(e / SR, 2),
            "text": seg.text,
            "lang": seg.lang,
            "speaker": speaker,
            "corrected_text": None,
            "words": None,
        })
    transcript = {
        "schema_version": SCHEMA_VERSION,
        "meeting_id": job.meeting_id,
        "title": job.title,
        "created_at": job.created_at,
        "audio": {"file": job.audio_file, "duration_sec": job.duration_sec, "source": job.source, "sha256": job.sha256},
        "asr": {"model": job.model, "track": job.track, "runtime": "mlx-audio", "language": job.language, "hotwords": job.hotwords},
        "speakers": _speakers_map({}, segments),
        "diarization": job.diarizer,
        "segments": segments,
    }
    save_transcript(job.dir, transcript)
    (job.dir / JOB_FILE).unlink()
    (job.dir / CHUNKS_FILE).unlink(missing_ok=True)
    return transcript


def save_transcript(d: Path, t: dict) -> None:
    """transcript.md·vtt를 먼저, transcript.json을 마지막에 원자적으로 쓴다.
    transcript.json이 완료 표시라 중간에 끊겨도 md 없는 "완료"가 생기지 않는다."""
    _write_atomic(d / "transcript.md", render_markdown(t, load_memos(d)))
    _write_atomic(d / "transcript.vtt", render_vtt(t))
    _write_atomic(d / "transcript.json", json.dumps(t, ensure_ascii=False, indent=1))


# ── 화자 ──────────────────────────────────────────────────────────────


def _label_key(label: str) -> tuple[int, str]:
    return (int(label[1:]), label) if label[1:].isdigit() else (1 << 30, label)


def _speakers_map(old: dict, segments: list[dict]) -> dict:
    """세그먼트에 쓰인 라벨만 S1, S2 … 순서로 남긴다. 이름은 old에서 이어받는다."""
    used = {s.get("speaker") for s in segments} - {None}
    return {k: {"name": (old.get(k) or {}).get("name")} for k in sorted(used, key=_label_key)}


def speaker_name(t: dict, label: str | None) -> str | None:
    """표시 이름: 사용자가 정한 이름, 없으면 라벨(S1), 화자를 모르면 None. schema_version 1 전사도 받는다."""
    if not label:
        return None
    return ((t.get("speakers") or {}).get(label) or {}).get("name") or label


def _clean_name(raw: str) -> str | None:
    """화자 이름 정리. md 굵게·VTT <v>·MCP/요약 줄 `[s0012 00:05:31 이름]` 형식을 깨는 문자는 빼고,
    자동 라벨(S2)처럼 보이는 이름은 거부한다 (라벨과 헷갈리고 요약의 owner 정리에서 지워진다). 빈 문자열은 이름 지움."""
    name = " ".join(re.sub(r"[\[\]<>*_`\\]", "", raw).split())
    if raw.strip() and not name:
        raise ValueError(f"이름에 쓸 수 있는 글자가 없습니다: {raw!r}")
    if re.fullmatch(r"S\d+", name, re.IGNORECASE):
        raise ValueError(f"자동 라벨과 같은 형태(S1, S2…)는 이름으로 쓸 수 없습니다: {name}")
    return name or None


def apply_speaker_edit(t: dict, op: str, *args: str) -> dict:
    """화자 편집. 원본은 건드리지 않고 새 전사를 돌려준다. 잘못된 인자는 ValueError.

    rename LABEL NAME   이름 지정 (빈 문자열이면 이름 지움)
    set SEGMENT LABEL   세그먼트 화자 변경. LABEL이 new면 다음 라벨(S4 등)을 만든다
    merge SRC DST       SRC 화자의 세그먼트를 모두 DST로 옮기고 SRC를 없앤다"""
    t = copy.deepcopy(t)
    speakers = t.get("speakers") or {}
    t.update(schema_version=SCHEMA_VERSION, diarization=t.get("diarization"))

    def known(label: str) -> str:
        if label not in speakers:
            raise ValueError(f"없는 화자입니다: {label} (있는 화자: {', '.join(speakers) or '없음'})")
        return label

    if op == "rename" and len(args) == 2:
        speakers[known(args[0])] = {"name": _clean_name(args[1])}
    elif op == "set" and len(args) == 2:
        seg = next((s for s in t["segments"] if s["id"] == args[0]), None)
        if seg is None:
            raise ValueError(f"없는 세그먼트입니다: {args[0]}")
        if args[1] == "new":
            used = [_label_key(k)[0] for k in [*speakers, *(s.get("speaker") or "" for s in t["segments"])] if k[1:].isdigit()]
            label = f"S{max(used, default=0) + 1}"
            speakers[label] = {"name": None}
        else:
            label = known(args[1])
        seg["speaker"] = label
    elif op == "merge" and len(args) == 2:
        src, dst = known(args[0]), known(args[1])
        if src == dst:
            raise ValueError("같은 화자끼리는 합칠 수 없습니다")
        for seg in t["segments"]:
            if seg.get("speaker") == src:
                seg["speaker"] = dst
        if not (speakers[dst] or {}).get("name"):
            speakers[dst] = {"name": (speakers[src] or {}).get("name")}
    else:
        raise ValueError(f"알 수 없는 화자 편집: {op} {' '.join(args)}")
    t["speakers"] = _speakers_map(speakers, t["segments"])
    return t


def _hms(sec: float) -> str:
    sec = int(sec)
    return f"{sec // 3600:02d}:{sec % 3600 // 60:02d}:{sec % 60:02d}"


MEMOS_FILE = "memos.json"
_MARK_LABEL = {"memo": "메모", "bookmark": "북마크"}


def load_memos(d: Path) -> list[dict]:
    """녹음 중 남긴 메모·북마크 [{t, kind, text}]. 없거나 읽을 수 없으면 빈 목록."""
    try:
        memos = json.loads((d / MEMOS_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return sorted((m for m in memos if isinstance(m, dict) and isinstance(m.get("t"), (int, float))), key=lambda m: m["t"])


def _vtt_time(sec: float) -> str:
    ms = round(sec * 1000)
    return f"{ms // 3_600_000:02d}:{ms // 60_000 % 60:02d}:{ms // 1000 % 60:02d}.{ms % 1000:03d}"


def render_vtt(t: dict) -> str:
    """WebVTT 자막. 큐 ID는 세그먼트 ID, 화자는 <v 이름> (브라우저 <track>, Obsidian Media Extended가 그대로 읽음)."""
    def voice(s: dict) -> str:  # 화자는 <v 이름> 태그. 이름 안의 마크업 문자는 뺀다
        name = speaker_name(t, s.get("speaker"))
        return f"<v {' '.join(re.sub(r'[<>&]', '', name).split())}>" if name else ""

    cues = [
        f"{s['id']}\n{_vtt_time(s['start'])} --> {_vtt_time(s['end'])}\n{voice(s)}{s['text'].replace('-->', '→')}"
        for s in t["segments"] if s["text"]
    ]
    return "WEBVTT\n\n" + "\n\n".join(cues) + "\n"


def render_markdown(t: dict, memos: list[dict] | None = None) -> str:
    """사람·에이전트용 전사. 줄마다 `[HH:MM:SS] **화자**: 텍스트` (화자를 모르면 생략).
    frontmatter는 Obsidian 등에서 그대로 읽힌다. 메모·북마크는 시각 순으로 끼워 넣는다."""
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
    def who(s: dict) -> str:
        name = speaker_name(t, s.get("speaker"))
        return f"**{name}**: " if name else ""

    rows = [(s["start"], 0, f"[{_hms(s['start'])}] {who(s)}{s['text']}") for s in t["segments"] if s["text"]]
    for m in memos or []:
        label = _MARK_LABEL.get(m.get("kind"), "메모")
        text = f" {m['text']}" if m.get("text") else ""
        rows.append((m["t"], 1, f"[{_hms(m['t'])}] ({label}){text}"))
    lines = [r[2] for r in sorted(rows, key=lambda r: (r[0], r[1]))]
    return "\n".join(head + lines) + "\n"


def _write_atomic(path: Path, text: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(path)
