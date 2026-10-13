"""노트 폴더(§4.1 레이아웃), 진행 상태(이어하기), transcript.json/md/vtt 저장, 화자·텍스트 편집, 용어집.

화자 맵 speakers: {"S1": {"name": 사용자가 확정한 이름 | null, "suggested"?: {person_id, name, score}}}.
suggested는 목소리 프로필이 맞춘 **제안**이다(voices.py). 이름이 없는 화자에만 있고, 표시 이름·md·vtt·요약·MCP·내보내기에 쓰지 않는다."""

import copy
import fcntl
import json
import os
import re
import secrets
import threading
import time
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable

from tractus.asr import Segment

SR = 16000
SCHEMA_VERSION = 2  # 2: segment.speaker("S1"…), 최상위 speakers·diarization. 1도 그대로 읽는다
JOB_FILE = ".job.json"
CHUNKS_FILE = ".chunks.jsonl"
_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

__all__ = [
    "Job", "Segment", "add_glossary_terms", "apply_speaker_edit", "apply_suggestions", "apply_text_edits", "edit_transcript", "find_job", "find_meeting_dir",
    "forget_person", "load_glossary", "meeting_dir_name", "new_ulid", "note_lock", "read_transcript", "render_files", "render_markdown", "save_transcript",
    "seg_text", "speaker_display", "speaker_name", "write_transcript",
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


GLOSSARY_HEADER = "# 자주 쓰는 단어\n\n녹음을 텍스트로 변환할 때 이 단어들을 더 정확하게 인식합니다. 한 줄에 하나씩 `- 단어` 형식으로 적습니다.\n\n"


def add_glossary_terms(path: Path, terms: list[str]) -> int:
    """용어를 `- 용어` 줄로 덧붙인다. 앞뒤 공백을 지우고, 빈 값과 이미 있는 용어는 건너뛴다. 파일이 없으면 머리말과 함께 만든다.
    추가한 개수를 돌려준다."""
    have = set(load_glossary(path))
    new = [t for t in dict.fromkeys(" ".join(t.split()) for t in terms) if t and t not in have]
    if new:
        text = path.read_text(encoding="utf-8") if path.exists() else GLOSSARY_HEADER
        if text and not text.endswith("\n"):
            text += "\n"
        _write_atomic(path, text + "".join(f"- {t}\n" for t in new))
    return len(new)


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
    suggestions: dict = field(default_factory=dict)  # 목소리 제안 {라벨: {person_id, name, score}}. 이어하기 때 다시 맞추지 않는다

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
        if (p.parent / "transcript.json").is_file():
            _clean_stale_job(p.parent)  # 끝난 노트에 남은 작업 파일: 이어하기 대상이 아니다
            continue
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
            _clean_stale_job(p.parent)
            return p.parent
    return None


def find_meeting_dir(meetings: Path, ref: str) -> Path:
    """회의 폴더 경로 또는 meeting_id(일부)로 전사된 회의 폴더를 찾는다. 없거나 여러 개면 LookupError."""
    path = Path(ref).expanduser()
    if (path / "transcript.json").is_file():
        _clean_stale_job(path)
        return path
    ref = ref.strip()
    hits = [d for d in sorted(meetings.glob("*")) if ref and ref in d.name and (d / "transcript.json").is_file()] if ref else []
    if not hits:
        raise LookupError(f"‘{ref}’에 해당하는 노트가 없습니다. 삭제되었거나 옮겨졌을 수 있습니다.")
    if len(hits) > 1:
        raise LookupError(f"‘{ref}’에 해당하는 노트가 {len(hits)}개입니다: " + ", ".join(d.name for d in hits[:5]))
    _clean_stale_job(hits[0])
    return hits[0]


def _clean_stale_job(d: Path) -> None:
    """transcript.json이 있으면 그 노트는 끝난 것이다. write_transcript가 transcript.json을 쓴 뒤 작업 파일을 지우기 전에 끊겼다면
    남아 있는 .job.json·.chunks.jsonl을 지운다 (이어하기·삭제 거절·'변환 대기 중' 표시를 막는다)."""
    if (d / "transcript.json").is_file():
        for name in (JOB_FILE, CHUNKS_FILE):
            (d / name).unlink(missing_ok=True)


class IncompleteError(RuntimeError):
    """전사되지 않은 청크가 남아 transcript.json을 쓸 수 없다 (CLI가 code="incomplete"로 알린다)."""


def write_transcript(job: Job) -> dict:
    done = job.done()
    missing = [i for i in range(len(job.chunks)) if i not in done]
    if missing:
        raise IncompleteError(f"변환이 끝나지 않은 구간이 있습니다 ({missing[:10]}). 같은 명령으로 다시 실행하세요")
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
        "speakers": _speakers_map({k: {"name": None, "suggested": v} for k, v in job.suggestions.items()}, segments),
        "diarization": job.diarizer,
        "segments": segments,
    }
    save_transcript(job.dir, transcript)  # transcript.json이 마지막: 이 파일이 생기면 노트는 끝난 것이다
    _clean_stale_job(job.dir)  # 여기서 끊겨도 transcript.json이 이기고, 남은 작업 파일은 다음에 find_*가 지운다
    return transcript


def render_files(d: Path, t: dict) -> None:
    """transcript.json은 그대로 두고 transcript.md·vtt만 t로 다시 만든다."""
    _write_atomic(d / "transcript.md", render_markdown(t, load_memos(d)))
    _write_atomic(d / "transcript.vtt", render_vtt(t))


def save_transcript(d: Path, t: dict) -> None:
    """transcript.md·vtt를 먼저, transcript.json을 마지막에 원자적으로 쓴다.
    transcript.json이 완료 표시라 중간에 끊겨도 md 없는 "완료"가 생기지 않는다.
    이미 있는 transcript.json을 고쳐 쓰는 호출자는 note_lock(또는 edit_transcript) 안에서 읽고 쓴다."""
    render_files(d, t)
    _write_atomic(d / "transcript.json", json.dumps(t, ensure_ascii=False, indent=1))


LOCK_FILE = ".lock"
_held = threading.local()  # 이 스레드가 이미 잡고 있는 노트 폴더 (같은 스레드의 중첩 호출이 스스로를 막지 않게)


@contextmanager
def note_lock(d: Path):
    """노트 폴더의 transcript.json을 읽고 고쳐 쓰는 동안 다른 프로세스·스레드의 같은 작업을 막는다 (<노트>/.lock, fcntl.flock).
    앱 편집·화자 편집·목소리 등록·정렬 병합이 서로의 수정을 덮어쓰지 않게 하려면 읽기부터 쓰기까지를 이 안에서 한다.
    같은 스레드에서 중첩해 불러도 된다. 프로세스가 죽으면 OS가 잠금을 푼다."""
    key = str(d.resolve())
    held = getattr(_held, "dirs", set())
    if key in held:
        yield
        return
    fd = os.open(d / LOCK_FILE, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        _held.dirs = {*held, key}
        try:
            yield
        finally:
            _held.dirs = held
    finally:
        os.close(fd)  # 닫으면 잠금도 풀린다


def read_transcript(d: Path) -> dict:
    return json.loads((d / "transcript.json").read_text(encoding="utf-8"))


def edit_transcript(d: Path, fn: Callable[[dict], tuple[dict, object]]):
    """잠금 안에서 transcript.json을 읽고 fn(t) → (새 전사, 결과)로 고쳐 바뀌었을 때만 저장한다. 결과를 돌려준다.
    fn이 예외를 던지면 아무것도 쓰지 않는다."""
    with note_lock(d):
        t = read_transcript(d)
        new, result = fn(t)
        if new != t:
            save_transcript(d, new)
        return result


# ── 화자 ──────────────────────────────────────────────────────────────


def _label_key(label: str) -> tuple[int, str]:
    return (int(label[1:]), label) if label[1:].isdigit() else (1 << 30, label)


def _speaker_entry(info: dict | None) -> dict:
    """{"name"}, 이름이 없을 때만 목소리 제안 {"suggested"}을 남긴다 (이름을 확정하면 제안은 지운다).
    "dismissed"는 사용자가 '다름'으로 거절한 person_id 목록이다. 이름·제안과 상관없이 이어받아 `voices match`가 같은 사람을 다시 제안하지 않게 한다."""
    info = info or {}
    out = {"name": info.get("name")}
    if info.get("name") is None and info.get("suggested"):
        out["suggested"] = info["suggested"]
    if info.get("dismissed"):
        out["dismissed"] = list(info["dismissed"])
    return out


def _speakers_map(old: dict, segments: list[dict]) -> dict:
    """세그먼트에 쓰인 라벨만 S1, S2 … 순서로 남긴다. 이름·제안은 old에서 이어받는다."""
    used = {s.get("speaker") for s in segments} - {None}
    return {k: _speaker_entry(old.get(k)) for k in sorted(used, key=_label_key)}


def apply_suggestions(t: dict, suggestions: dict) -> dict:
    """이름이 없는 화자의 목소리 제안을 suggestions로 바꾼 새 전사. 이름이 확정된 화자는 건드리지 않고, suggestions에 없는 화자의 옛 제안은 지운다."""
    def fresh(k: str, v: dict | None) -> dict:
        refused = (v or {}).get("dismissed") or []  # 거절한 사람은 다시 제안하지 않는다
        ok = k in suggestions and suggestions[k].get("person_id") not in refused
        return {**{a: b for a, b in (v or {}).items() if a != "suggested"}, **({"suggested": suggestions[k]} if ok else {})}

    speakers = {k: fresh(k, v) for k, v in (t.get("speakers") or {}).items()}
    return {**t, "speakers": _speakers_map(speakers, t["segments"])}


def forget_person(t: dict, gone: set[str]) -> dict:
    """등록을 지운 사람(person_id가 gone)을 가리키는 목소리 제안·거절 기록을 지운 새 전사. 확정한 이름은 그대로 둔다."""
    entries = (t.get("speakers") or {}).values()
    if not any(((v or {}).get("suggested") or {}).get("person_id") in gone or gone & set((v or {}).get("dismissed") or []) for v in entries):
        return t  # 이 사람을 가리키는 기록이 없으면 노트를 다시 쓰지 않는다 (speakers가 없는 옛 노트도 그대로)
    speakers = {}
    for k, v in (t.get("speakers") or {}).items():
        v = v or {}
        sug = v.get("suggested")
        speakers[k] = {**{a: b for a, b in v.items() if a not in ("suggested", "dismissed")},
                       **({"suggested": sug} if sug and sug.get("person_id") not in gone else {}),
                       "dismissed": [p for p in v.get("dismissed") or [] if p not in gone]}
    return {**t, "speakers": _speakers_map(speakers, t["segments"])}


def speaker_name(t: dict, label: str | None) -> str | None:
    """MCP·CLI용 이름: 사용자가 정한 이름, 없으면 라벨(S1), 화자를 모르면 None. schema_version 1 전사도 받는다."""
    if not label:
        return None
    return ((t.get("speakers") or {}).get(label) or {}).get("name") or label


def speaker_display(t: dict, label: str | None) -> str | None:
    """사람이 읽는 문서·프롬프트용 이름 (WORDS.md §2): 정한 이름, 없으면 S3 → '참석자 3', 화자를 모르면 None."""
    name = speaker_name(t, label)
    m = re.fullmatch(r"S(\d+)", name or "")
    return f"참석자 {m.group(1)}" if m and name == label else name


def one_line(s: str) -> str:
    """공백·줄바꿈을 한 칸으로 줄이고 제어 문자(C0·C1)를 뺀다. 제어 문자는 docx(lxml)가 거부하고 md·VTT 줄을 깬다."""
    return re.sub(r"[\x00-\x1f\x7f-\x9f]", "", " ".join(s.split()))


def _clean_name(raw: str) -> str | None:
    """화자 이름 정리. md 굵게·VTT <v>·MCP/요약 줄 `[s0012 00:05:31 이름]` 형식을 깨는 문자는 빼고,
    자동 라벨(S2)처럼 보이는 이름은 거부한다 (라벨과 헷갈리고 요약의 owner 정리에서 지워진다). 빈 문자열은 이름 지움."""
    name = one_line(re.sub(r"[\[\]<>*_`\\]", "", raw))
    if raw.strip() and not name:
        raise ValueError("이름에 쓸 수 있는 글자가 없습니다 ([ ] < > * _ ` \\ 는 쓸 수 없습니다).")
    if re.fullmatch(r"(S|참석자\s*)\d+", name, re.IGNORECASE):
        raise ValueError(f"‘참석자 1’, ‘S1’처럼 자동으로 붙는 이름은 쓸 수 없습니다: {name}")
    return name or None


def apply_speaker_edit(t: dict, op: str, *args: str) -> dict:
    """화자 편집. 원본은 건드리지 않고 새 전사를 돌려준다. 잘못된 인자는 ValueError.

    rename LABEL NAME   이름 지정 (빈 문자열이면 이름 지움). 목소리 제안은 지운다 (앱의 '확정' = 제안된 이름으로 rename)
    dismiss LABEL       목소리 제안 지우기 ('아님'). 그 사람은 이 화자에 다시 제안하지 않는다 (speakers[LABEL].dismissed)
    set SEGMENT LABEL   세그먼트 화자 변경. LABEL이 new면 다음 라벨(S4 등)을 만든다
    merge SRC DST       SRC 화자의 세그먼트를 모두 DST로 옮기고 SRC를 없앤다"""
    t = copy.deepcopy(t)
    speakers = t.get("speakers") or {}
    t.update(schema_version=SCHEMA_VERSION, diarization=t.get("diarization"))

    def known(label: str) -> str:
        if label not in speakers:
            raise ValueError("참석자를 찾지 못했습니다. 노트를 다시 열어 주세요.")
        return label

    if op == "rename" and len(args) == 2:
        label = known(args[0])
        speakers[label] = {**{k: v for k, v in (speakers[label] or {}).items() if k == "dismissed"}, "name": _clean_name(args[1])}
    elif op == "dismiss" and len(args) == 1:
        label = known(args[0])
        cur = speakers[label] or {}
        now = (cur.get("suggested") or {}).get("person_id")
        refused = [*(cur.get("dismissed") or []), *([now] if now else [])]
        speakers[label] = {"name": cur.get("name"), "dismissed": list(dict.fromkeys(refused))}
    elif op == "set" and len(args) == 2:
        seg = next((s for s in t["segments"] if s["id"] == args[0]), None)
        if seg is None:
            raise ValueError("해당 대화를 찾지 못했습니다. 노트를 다시 열어 주세요.")
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
            raise ValueError("같은 참석자끼리는 합칠 수 없습니다.")
        for seg in t["segments"]:
            if seg.get("speaker") == src:
                seg["speaker"] = dst
        s_src, s_dst = speakers[src] or {}, speakers[dst] or {}
        refused = list(dict.fromkeys([*(s_dst.get("dismissed") or []), *(s_src.get("dismissed") or [])]))  # 합친 참석자는 둘의 거절을 모두 이어받는다
        if not s_dst.get("name") and s_src.get("name"):
            speakers[dst] = {"name": s_src["name"], "dismissed": refused}  # SRC의 목소리 제안은 SRC와 함께 사라진다
        else:
            speakers[dst] = {**s_dst, "dismissed": refused}
    else:
        raise ValueError(f"알 수 없는 화자 편집: {op} {' '.join(args)}")  # words-ok: 앱 계약 오류
    t["speakers"] = _speakers_map(speakers, t["segments"])
    return t


# ── 텍스트 편집 ──────────────────────────────────────────────────────


def seg_text(s: dict) -> str:
    """표시 텍스트: 사용자가 고친 corrected_text, 없으면 ASR 원문 text. md·vtt·요약·검색·MCP·내보내기가 모두 이것을 쓴다."""
    c = s.get("corrected_text")
    return c if c is not None else s.get("text") or ""


def apply_text_edits(t: dict, edits: list) -> tuple[dict, int]:
    """세그먼트 텍스트 교정 [{id, text}]. 원문 text는 그대로 두고 corrected_text만 바꾼 새 전사와 바뀐 세그먼트 수를 돌려준다.
    단어 시각(words)이 있으면 바뀐 텍스트에 맞게 옮긴다(align.remap_words, 새 단어는 approx).
    처음 고칠 때 words를 words_asr(선택 키)에 복사해 두고, 원문과 같아지면 words_asr로 words를 정확히 되돌린다.
    원문과 같아지면 교정을 지운다(null). 공백·줄바꿈은 한 칸으로 줄이고 제어 문자는 뺀다(one_line).
    없는 id·빈 텍스트·잘못된 형식이 하나라도 있으면 아무것도 바꾸지 않고 ValueError."""
    t = copy.deepcopy(t)
    by_id = {s["id"]: s for s in t["segments"]}
    plan = []
    for e in edits:
        if not isinstance(e, dict) or not isinstance(e.get("id"), str) or not isinstance(e.get("text"), str):
            raise ValueError(f"편집 형식은 {{\"id\": \"s0012\", \"text\": \"…\"}}입니다: {str(e)[:80]}")  # words-ok: 앱 계약 오류
        if e["id"] not in by_id:
            raise ValueError("해당 대화를 찾지 못했습니다. 노트를 다시 열어 주세요.")
        text = one_line(e["text"])
        if not text:
            raise ValueError("대화 내용을 비워 둘 수 없습니다.")
        plan.append((by_id[e["id"]], text))
    from tractus.align import remap_words  # align이 store를 불러오므로 여기서 불러온다

    changed = set()
    for seg, text in plan:
        new = None if text == one_line(seg["text"]) else text
        if seg.get("corrected_text") != new:
            if seg.get("corrected_text") is None and seg.get("words") is not None:
                seg["words_asr"] = copy.deepcopy(seg["words"])  # 처음 고치기 직전의 정렬 결과. 원문으로 되돌리면 그대로 복원한다
            seg["corrected_text"] = new
            seg["words"] = remap_words(seg.get("words"), seg_text(seg), seg["start"], seg["end"])  # 단어 = 표시 텍스트 공백 토큰 (불변식)
            saved = seg.pop("words_asr", None) if new is None else None
            if saved is not None and [w["text"] for w in saved] == seg_text(seg).split():
                seg["words"] = saved  # 원문으로 돌아왔다: 추정(approx)한 시각 대신 처음 정렬한 단어 시각
            changed.add(seg["id"])
    return t, len(changed)


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
        name = speaker_display(t, s.get("speaker"))
        return f"<v {' '.join(re.sub(r'[<>&]', '', name).split())}>" if name else ""

    cues = [
        f"{s['id']}\n{_vtt_time(s['start'])} --> {_vtt_time(s['end'])}\n{voice(s)}{seg_text(s).replace('-->', '→')}"
        for s in t["segments"] if seg_text(s)
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
        name = speaker_display(t, s.get("speaker"))
        return f"**{name}**: " if name else ""

    rows = [(s["start"], 0, f"[{_hms(s['start'])}] {who(s)}{seg_text(s)}") for s in t["segments"] if seg_text(s)]
    for m in memos or []:
        label = _MARK_LABEL.get(m.get("kind"), "메모")
        text = f" {m['text']}" if m.get("text") else ""
        rows.append((m["t"], 1, f"[{_hms(m['t'])}] ({label}){text}"))
    lines = [r[2] for r in sorted(rows, key=lambda r: (r[0], r[1]))]
    return "\n".join(head + lines) + "\n"


def _write_atomic(path: Path, text: str) -> None:
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")  # 프로세스마다 다른 임시 파일: 동시에 쓰는 두 프로세스가 서로의 임시 파일을 덮지 않게
    with tmp.open("w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(path)
