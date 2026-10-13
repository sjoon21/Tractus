"""로컬 검색 인덱스 (ARCHITECTURE.md §4.3): SQLite FTS5(음절 bigram) + sqlite-vec + RRF.

인덱스는 transcript.json 파일들로부터 언제든 다시 만들 수 있는 캐시다. 위치: $TRACTUS_HOME/.tractus/index.sqlite.
바뀐 회의만 다시 색인한다(증분 동기화). 스키마가 바뀌면 통째로 지우고 파일에서 다시 만든다.
"""

import hashlib
import json
import logging
import re
import sqlite3
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from tractus.store import memo_segments, seg_text, speaker_name

log = logging.getLogger("tractus.index")

SCHEMA_VERSION = "3"  # 2: chunks.segments(세그먼트별 텍스트) 추가 — 세그먼트 단위 인용용. 3: segments에 speaker(표시 이름)
TOKENIZER_VERSION = "bigram-v2"  # v2: 영문 접두와 숫자 분리 (v2.4 → v + 2.4)
CHUNK_MIN, CHUNK_MAX = 300, 500  # 자. 30초 세그먼트(200–250자)를 2개 안팎으로 묶는다
POOL = 50  # RRF에 넣을 키워드·벡터 후보 수
RRF_K = 60
# 벡터 쪽 RRF 가중치. 2026-10-02 실측 (hit@1, 가상 30질의 / AI Hub 실제 ASR 139질의):
#   RRF 동일 가중 0.97 / 0.50, 키워드만 0.90 / 0.85, strict 우선 + 벡터 0.3 → 0.97 / 0.80
# 긴 회의가 쌓이면 벡터 후보의 잡음이 키워드로 정확히 찾은 결과를 밀어내므로 가중치를 낮춘다.
VECTOR_WEIGHT = 0.3

# ── 한국어 음절 bigram ────────────────────────────────────────────────
# 리서치 실측(합성 코퍼스): bigram AND 재현율 0.96 / 정밀도 1.00, trigram 0.33, unicode61 원문 0.30.
_RUN = re.compile(r"[가-힣]+|[0-9]+(?:[.,][0-9]+)*|[a-z]+")
# 완화 질의에서 떼어 내는 조사·어미 (긴 것부터). 형태소 분석기 없이 흔한 것만 다룬다.
_JOSA = sorted("에서는 으로는 에게서 까지는 이라는 에서 으로 에게 까지 부터 처럼 보다 라는 이라 하고 은 는 이 가 을 를 의 에 도 만 과 와 로".split(), key=len, reverse=True)


def _hangul(r: str) -> bool:
    return "가" <= r[0] <= "힣"


def _bigrams(run: str) -> list[str]:
    return [run] if len(run) == 1 else [run[i : i + 2] for i in range(len(run) - 1)]


def _words(text: str) -> list[list[str]]:
    """공백 단위 단어별 토큰. 한글은 음절 bigram(공백을 넘지 않음), 영문은 소문자 단어, 숫자는 쉼표 제거."""
    out = []
    for word in unicodedata.normalize("NFKC", text).lower().split():
        toks = []
        for m in _RUN.finditer(word):
            r = m.group()
            toks += _bigrams(r) if _hangul(r) else [r.replace(",", "")]
        if toks:
            out.append(toks)
    return out


def to_index_text(text: str) -> str:
    return " ".join(t for w in _words(text) for t in w)


def to_fts_query(query: str, mode: str = "AND") -> str:
    """질의 단어마다 인접 bigram을 phrase로 묶어 AND. 한 음절 단어는 접두 검색. 토큰이 없으면 빈 문자열."""
    parts = []
    for toks in _words(query):
        if len(toks) == 1 and len(toks[0]) == 1 and not toks[0].isascii():
            parts.append(f'"{toks[0]}"*')
        else:
            parts.append('"' + " ".join(toks) + '"')
    return f" {mode} ".join(parts)


def _strip_josa(run: str) -> str:
    for j in _JOSA:
        if run.endswith(j) and len(run) > len(j):
            return run[: -len(j)]
    return run


def relaxed_query(query: str) -> str:
    """AND로 모자랄 때 보충하는 OR 질의. 단어 끝 조사를 떼고(앱은 → 앱) 어간의 bigram만 쓴다.
    조사 bigram("에서" 등)이나 1–2자리 숫자로 엉뚱한 결과가 걸리지 않게 한다."""
    terms = set()
    for word in unicodedata.normalize("NFKC", query).lower().split():
        for m in _RUN.finditer(word):
            r = m.group()
            if _hangul(r):
                stem = _strip_josa(r)
                terms |= {f'"{stem}"*'} if len(stem) == 1 else {f'"{t}"' for t in _bigrams(stem)}
            elif r[0].isdigit():
                if "." in r or len(r.replace(",", "")) > 2:  # 1–2자리 정수만 버린다 (2.4, 2026, 1,200은 남김)
                    terms.add(f'"{r.replace(",", "")}"')
            elif len(r) > 1:  # 한 글자 영문(v2.4의 v)은 잡음만 늘린다
                terms.add(f'"{r}"')
    return " OR ".join(sorted(terms))


def rrf(*ranked: list[int], k: int = RRF_K) -> tuple[list[int], dict[int, float]]:
    score: dict[int, float] = {}
    for lst in ranked:
        for rank, i in enumerate(lst, 1):
            score[i] = score.get(i, 0.0) + 1.0 / (k + rank)
    return sorted(score, key=lambda i: (-score[i], i)), score


def fuse(keyword: list[int], strict: set[int], vector: dict[int, float] | None, vector_weight: float = VECTOR_WEIGHT) -> tuple[list[int], dict[int, float]]:
    """질의 단어가 모두 들어 있는(strict) 결과를 bm25 순서대로 먼저 놓고, 나머지(일부만 맞은 키워드 + 벡터)는
    가중 RRF로 뒤에 붙인다. 점수는 표시용: strict는 1 이상, 나머지는 RRF 값."""
    first = [c for c in keyword if c in strict]
    score = {c: 1.0 + 1.0 / (RRF_K + r) for r, c in enumerate(first, 1)}
    rest: dict[int, float] = {}
    for r, c in enumerate([c for c in keyword if c not in strict], 1):
        rest[c] = rest.get(c, 0.0) + 1.0 / (RRF_K + r)
    for r, c in enumerate(vector or {}, 1):
        if c not in strict:
            rest[c] = rest.get(c, 0.0) + vector_weight / (RRF_K + r)
    score.update(rest)
    return first + sorted(rest, key=lambda c: (-rest[c], c)), score


def make_chunks(segments: list[dict], speakers: dict | None = None) -> list[dict]:
    """연속 세그먼트를 300자 이상이 될 때까지 묶되 500자를 넘기지 않는다. 교정본이 있으면 교정본을 쓴다.
    세그먼트마다 화자 표시 이름(이름 > 라벨 > None)을 함께 저장한다. 이름을 바꾸면 transcript.json이 바뀌어 다시 색인된다."""
    groups, cur, size = [], [], 0
    for s in segments:
        text = seg_text(s).strip()
        if not text:
            continue
        if cur and size + len(text) > CHUNK_MAX:
            groups.append(cur)
            cur, size = [], 0
        cur.append((s, text))
        size += len(text)
        if size >= CHUNK_MIN:
            groups.append(cur)
            cur, size = [], 0
    if cur:
        groups.append(cur)
    return [
        {
            "start": float(g[0][0]["start"]),
            "end": float(g[-1][0]["end"]),
            "segments": [
                {"id": s["id"], "start": float(s["start"]), "end": float(s["end"]), "text": t, "speaker": speaker_name({"speakers": speakers}, s.get("speaker")),
                 **({"line": s["line"]} if s.get("line") else {}),  # 메모의 줄 번호 (시각이 없다)
                 **({"source": s["source"]} if s.get("source") else {})}  # "memo": 녹음 노트의 사용자 메모 줄
                for s, t in g
            ],
            "text": " ".join(t for _, t in g),
        }
        for g in groups
    ]


def _validate(t) -> str:
    """색인 전에 형식을 확인한다. 잘못된 회의 하나가 동기화 전체를 멈추지 않도록 ValueError로 바꾼다."""
    if not isinstance(t, dict) or not isinstance(t.get("meeting_id"), str) or not t["meeting_id"]:
        raise ValueError("transcript.json 형식이 아닙니다 (meeting_id 없음)")
    if not isinstance(t.get("segments"), list):
        raise ValueError("segments가 목록이 아닙니다")
    for s in t["segments"]:
        if not isinstance(s, dict) or not isinstance(s.get("id"), str) or not isinstance(s.get("start"), (int, float)) or not isinstance(s.get("end"), (int, float)):
            raise ValueError(f"세그먼트 형식 오류: {str(s)[:80]}")
        if not isinstance(s.get("text") or "", str) or not isinstance(s.get("corrected_text") or "", str):
            raise ValueError(f"세그먼트 텍스트 형식 오류: {s.get('id')}")
    return t["meeting_id"]


@dataclass(frozen=True)
class Hit:
    meeting_id: str
    title: str
    date: str
    segments: list[dict]  # [{id, start, end, text, speaker, line?, source?}] — 근거 인용은 세그먼트 단위로. line은 메모 줄에만 있다 (start·end는 0).
    # source "memo" = 녹음 노트에 사용자가 적은 메모 줄 (id m0001…). 메모 청크는 ASR 청크와 섞이지 않는다
    start: float
    end: float
    score: float  # 표시용 순위 점수 (strict 키워드 결과는 1 이상)
    matched: list[str]  # keyword(질의 단어가 모두 있음), partial(일부만), vector(의미가 가까움)
    distance: float | None  # 벡터 코사인 거리 (0=동일, 벡터 후보가 아니면 None)

    @property
    def segment_ids(self) -> list[str]:
        return [s["id"] for s in self.segments]

    @property
    def text(self) -> str:
        return " ".join(s["text"] for s in self.segments)

    @property
    def source(self) -> str:
        """"memo"(녹음 노트의 사용자 메모) | "transcript"(대화 내용, 메모 노트의 줄 포함)."""
        return "memo" if self.segments and self.segments[0].get("source") == "memo" else "transcript"


@dataclass(frozen=True)
class SearchResult:
    query: str
    hits: list[Hit]
    vector_used: bool


@dataclass
class SyncReport:
    added: int = 0
    updated: int = 0
    removed: int = 0
    unchanged: int = 0
    embedded: int = 0  # 이번 동기화에서 새로 만든 벡터 수 (빠진 벡터 보충 포함)
    errors: list[str] = field(default_factory=list)


def _stat_sig(path: Path) -> str:
    st = path.stat()
    return f"{st.st_mtime_ns}:{st.st_size}"


def _content_sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Index:
    """embedder: `.model_id`, `.dim`, `.embed(texts, is_query)`를 가진 객체. None이면 키워드 검색만 한다."""

    def __init__(self, home: Path, embedder=None):
        self.home = home
        self.meetings_dir = home / "meetings"
        self.embedder = embedder
        self.path = home / ".tractus" / "index.sqlite"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path, timeout=30, isolation_level=None)  # 트랜잭션은 직접 연다
        self._load_vec()
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self._ensure_schema()

    # ── 스키마 ────────────────────────────────────────────────────────
    def _load_vec(self) -> None:
        import sqlite_vec

        if not hasattr(self.db, "enable_load_extension"):
            raise RuntimeError("이 Python의 sqlite3는 확장 로딩을 지원하지 않습니다. uv가 설치한 Python으로 실행하세요")
        self.db.enable_load_extension(True)
        sqlite_vec.load(self.db)
        self.db.enable_load_extension(False)

    def _meta(self, key: str) -> str | None:
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone() if self._table("meta") else None
        return row[0] if row else None

    def _set_meta(self, key: str, value: str) -> None:
        self.db.execute("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))

    def _table(self, name: str) -> bool:
        return self.db.execute("SELECT 1 FROM sqlite_master WHERE name=?", (name,)).fetchone() is not None

    def _ensure_schema(self) -> None:
        if self._table("meta") and self._meta("schema_version") != SCHEMA_VERSION:
            self._drop_all()  # 캐시이므로 옛 스키마는 버리고 파일에서 다시 만든다
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS meetings(
              meeting_id TEXT PRIMARY KEY, dir TEXT NOT NULL, title TEXT NOT NULL, date TEXT NOT NULL,
              sig TEXT NOT NULL, sha TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS chunks(
              chunk_id INTEGER PRIMARY KEY,
              meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
              ord INTEGER NOT NULL, start REAL NOT NULL, "end" REAL NOT NULL,
              segments TEXT NOT NULL, text TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS chunks_meeting ON chunks(meeting_id);
            CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(body, tokenize='unicode61 remove_diacritics 2', content='', contentless_delete=1);
            """
        )
        if self._meta("schema_version") is None:
            self._set_meta("schema_version", SCHEMA_VERSION)
        if self._meta("tokenizer_version") != TOKENIZER_VERSION:
            self._rebuild_fts()

    def _drop_all(self) -> None:
        self.db.execute("BEGIN IMMEDIATE")
        for name in ("chunks_vec", "chunks_fts", "chunks", "meetings", "meta"):
            self.db.execute(f"DROP TABLE IF EXISTS {name}")
        self.db.execute("COMMIT")

    def _rebuild_fts(self) -> None:
        self.db.execute("BEGIN IMMEDIATE")
        self.db.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('delete-all')")
        for cid, text in self.db.execute("SELECT chunk_id, text FROM chunks").fetchall():
            self.db.execute("INSERT INTO chunks_fts(rowid, body) VALUES(?, ?)", (cid, to_index_text(text)))
        self._set_meta("tokenizer_version", TOKENIZER_VERSION)
        self.db.execute("COMMIT")

    def rebuild(self) -> SyncReport:
        """색인을 비우고 처음부터 만든다. 파일을 지우지 않으므로 열려 있는 다른 연결(MCP 서버)도 같은 DB를 본다."""
        self._drop_all()
        self._ensure_schema()
        return self.sync()

    def _vectors_current(self) -> bool:
        return self.embedder is not None and self._table("chunks_vec") and self._meta("embedding_model") == self.embedder.model_id

    def _embed(self, texts: list[str], report: SyncReport) -> np.ndarray | None:
        """임베딩 실패(모델 파일 손상 등)는 키워드 색인을 막지 않는다. 오류로 기록하고 벡터 없이 진행한다."""
        try:
            return self.embedder.embed(texts)
        except Exception as e:  # noqa: BLE001
            log.warning("임베딩 실패: %s", e)
            report.errors.append(f"임베딩 실패 (키워드 색인만 함): {e}")
            self.embedder = None
            return None

    def _ensure_vectors(self, report: SyncReport) -> None:
        """벡터를 모델과 맞춘다: 모델이 바뀌었으면 벡터 테이블을 새로 만들고, 같으면 빠진 벡터만 채운다.
        (임베딩 모델 없이 색인된 회의도 나중에 모델이 생기면 여기서 벡터를 얻는다.)"""
        emb = self.embedder
        if not self._vectors_current():
            self.db.execute("BEGIN IMMEDIATE")
            self.db.execute("DROP TABLE IF EXISTS chunks_vec")
            self.db.execute(
                f"CREATE VIRTUAL TABLE chunks_vec USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[{emb.dim}] distance_metric=cosine, meeting_id text, meeting_date text)"
            )
            self._set_meta("embedding_model", emb.model_id)
            self._set_meta("embedding_dim", str(emb.dim))
            self.db.execute("COMMIT")
        rows = self.db.execute(
            "SELECT c.chunk_id, c.text, c.meeting_id, m.date FROM chunks c JOIN meetings m USING(meeting_id) "
            "WHERE c.chunk_id NOT IN (SELECT chunk_id FROM chunks_vec)"
        ).fetchall()
        if not rows:
            return
        vectors = self._embed([r[1] for r in rows], report)
        if vectors is None:
            return
        self.db.execute("BEGIN IMMEDIATE")
        stored = 0
        for (cid, text, mid, date), v in zip(rows, vectors):
            # 임베딩하는 동안 다른 연결이 이 청크를 다시 썼으면(같은 chunk_id에 다른 글) 낡은 벡터를 넣지 않는다. 빠진 채로 두면 다음 동기화가 채운다.
            now = self.db.execute("SELECT 1 FROM chunks WHERE chunk_id=? AND text=? AND meeting_id=?", (cid, text, mid)).fetchone()
            if now is None:
                continue
            self.db.execute("INSERT INTO chunks_vec(chunk_id, embedding, meeting_id, meeting_date) VALUES(?, ?, ?, ?)", (cid, v.astype(np.float32).tobytes(), mid, date))
            stored += 1
        self.db.execute("COMMIT")
        report.embedded += stored

    # ── 동기화 ────────────────────────────────────────────────────────
    def sync(self, embed: bool = True) -> SyncReport:
        """파일과 색인을 맞춘다. embed=False면 키워드 색인만 하고 벡터는 다음 embed=True 동기화에서 채운다
        (MCP 서버는 응답이 오래 멈추지 않도록 embed=False로 부른다)."""
        report = SyncReport()
        known = {mid: (d, sig, sha) for mid, d, sig, sha in self.db.execute("SELECT meeting_id, dir, sig, sha FROM meetings")}
        by_dir = {d: (mid, sig) for mid, (d, sig, _) in known.items()}
        seen: set[str] = set()
        for tpath in sorted(self.meetings_dir.glob("*/transcript.json")):
            d = tpath.parent
            try:
                sig = _stat_sig(tpath)
                same = by_dir.get(str(d))
                if same and same[1] == sig and same[0] not in seen:  # 바뀌지 않은 회의는 파일을 읽지도 않는다
                    seen.add(same[0])
                    report.unchanged += 1
                    continue
                transcript = json.loads(tpath.read_text(encoding="utf-8"))
                mid = _validate(transcript)
                if mid in seen:
                    raise ValueError(f"meeting_id {mid}가 다른 폴더와 겹칩니다")
                seen.add(mid)
                old = known.get(mid)
                sha = _content_sha(tpath)
                if old and old[2] == sha:
                    self.db.execute("UPDATE meetings SET sig=?, dir=? WHERE meeting_id=?", (sig, str(d), mid))
                    report.unchanged += 1
                    continue
                self._replace_meeting(d, transcript, sig, sha)
                report.updated += bool(old)
                report.added += not old
            except Exception as e:  # noqa: BLE001 — 회의 하나의 문제로 전체 동기화를 멈추지 않는다
                report.errors.append(f"{d.name}: {e}")
        for mid in set(known) - seen:
            self.db.execute("BEGIN IMMEDIATE")
            self._delete_meeting(mid)
            self.db.execute("COMMIT")
            report.removed += 1
        if embed and self.embedder is not None:
            self._ensure_vectors(report)
        return report

    def _delete_meeting(self, mid: str) -> None:
        has_vec = self._table("chunks_vec")
        for (cid,) in self.db.execute("SELECT chunk_id FROM chunks WHERE meeting_id=?", (mid,)).fetchall():
            self.db.execute("DELETE FROM chunks_fts WHERE rowid=?", (cid,))  # 가상 테이블에는 ON DELETE CASCADE가 닿지 않는다
            if has_vec:
                self.db.execute("DELETE FROM chunks_vec WHERE chunk_id=?", (cid,))
        self.db.execute("DELETE FROM meetings WHERE meeting_id=?", (mid,))

    def _replace_meeting(self, d: Path, t: dict, sig: str, sha: str) -> None:
        """새 벡터는 여기서 만들지 않는다. sync() 끝의 _ensure_vectors가 빠진 벡터를 한 번에 채운다.
        본문이 그대로인 청크는 기존 벡터를 옮겨 쓴다 (화자 편집은 본문을 바꾸지 않아 다시 임베딩할 것이 없다)."""
        chunks = make_chunks(t["segments"], t.get("speakers")) + make_chunks(memo_segments(t))  # 사용자 메모는 따로 묶는다 (ASR 청크와 섞지 않음)
        date = str(t.get("created_at") or "")[:10]
        has_vec = self._table("chunks_vec")
        self.db.execute("BEGIN IMMEDIATE")
        try:
            old_vec = dict(self.db.execute(
                "SELECT c.text, v.embedding FROM chunks c JOIN chunks_vec v ON v.chunk_id = c.chunk_id WHERE c.meeting_id=?", (t["meeting_id"],)
            ).fetchall()) if has_vec else {}
            self._delete_meeting(t["meeting_id"])
            self.db.execute(
                "INSERT INTO meetings(meeting_id, dir, title, date, sig, sha) VALUES(?, ?, ?, ?, ?, ?)",
                (t["meeting_id"], str(d), str(t.get("title") or d.name), date, sig, sha),
            )
            for ord_, c in enumerate(chunks):
                cur = self.db.execute(
                    'INSERT INTO chunks(meeting_id, ord, start, "end", segments, text) VALUES(?, ?, ?, ?, ?, ?)',
                    (t["meeting_id"], ord_, c["start"], c["end"], json.dumps(c["segments"], ensure_ascii=False), c["text"]),
                )
                self.db.execute("INSERT INTO chunks_fts(rowid, body) VALUES(?, ?)", (cur.lastrowid, to_index_text(c["text"])))
                if c["text"] in old_vec:
                    self.db.execute("INSERT INTO chunks_vec(chunk_id, embedding, meeting_id, meeting_date) VALUES(?, ?, ?, ?)",
                                    (cur.lastrowid, old_vec[c["text"]], t["meeting_id"], date))
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    # ── 검색 ──────────────────────────────────────────────────────────
    def _filters(self, date_from: str | None, date_to: str | None, meeting_id: str | None, date_col: str, mid_col: str) -> tuple[str, list]:
        """날짜·회의 조건은 준 것만 건다 (날짜가 없는 회의도 필터 없이는 검색되게)."""
        sql, args = "", []
        if date_from:
            sql, args = sql + f" AND {date_col} >= ?", args + [date_from]
        if date_to:
            sql, args = sql + f" AND {date_col} <= ?", args + [date_to]
        if meeting_id:
            sql, args = sql + f" AND {mid_col} = ?", args + [meeting_id]
        return sql, args

    def _keyword(self, query: str, date_from=None, date_to=None, meeting_id=None) -> tuple[list[int], set[int]]:
        """(순위 목록, 모든 질의 단어가 들어 있는 strict 결과)."""
        strict = to_fts_query(query)
        if not strict:
            return [], set()
        cond, cargs = self._filters(date_from, date_to, meeting_id, "m.date", "c.meeting_id")
        sql = (
            "SELECT f.rowid FROM chunks_fts f JOIN chunks c ON c.chunk_id = f.rowid JOIN meetings m ON m.meeting_id = c.meeting_id "
            f"WHERE chunks_fts MATCH ?{cond} ORDER BY bm25(chunks_fts) LIMIT ?"
        )
        ids = [r[0] for r in self.db.execute(sql, (strict, *cargs, POOL))]
        strict_ids = set(ids)
        if len(ids) < POOL:
            relaxed = relaxed_query(query)
            if relaxed and relaxed != strict:
                ids += [r[0] for r in self.db.execute(sql, (relaxed, *cargs, POOL)) if r[0] not in strict_ids][: POOL - len(ids)]
        return ids, strict_ids

    def _vector(self, query: str, date_from=None, date_to=None, meeting_id=None) -> dict[int, float] | None:
        """chunk_id → 코사인 거리 (가까운 순). 벡터를 쓸 수 없으면 None."""
        if not self._vectors_current():
            return None
        try:
            q = self.embedder.embed([query], is_query=True)[0].astype(np.float32).tobytes()
        except Exception as e:  # noqa: BLE001 — 모델 문제로 키워드 검색까지 막지 않는다
            log.warning("질의 임베딩 실패, 키워드 검색만 함: %s", e)
            self.embedder = None
            return None
        cond, cargs = self._filters(date_from, date_to, meeting_id, "meeting_date", "meeting_id")
        sql = f"SELECT chunk_id, distance FROM chunks_vec WHERE embedding MATCH ? AND k = ?{cond} ORDER BY distance"
        return {r[0]: r[1] for r in self.db.execute(sql, (q, POOL, *cargs))}

    def search(self, query: str, limit: int = 10, date_from: str | None = None, date_to: str | None = None, meeting_id: str | None = None) -> SearchResult:
        kw, strict = self._keyword(query, date_from, date_to, meeting_id)
        vec = self._vector(query, date_from, date_to, meeting_id) if query.strip() else None
        order, score = fuse(kw, strict, vec)
        kw_set = set(kw)
        hits = []
        for cid in order[:limit]:
            row = self.db.execute(
                'SELECT c.meeting_id, m.title, m.date, c.segments, c.start, c."end" FROM chunks c JOIN meetings m USING(meeting_id) WHERE c.chunk_id=?',
                (cid,),
            ).fetchone()
            if row is None:
                continue
            matched = (["keyword"] if cid in strict else ["partial"] if cid in kw_set else []) + (["vector"] if vec and cid in vec else [])
            dist = round(vec[cid], 4) if vec and cid in vec else None
            hits.append(Hit(row[0], row[1], row[2], json.loads(row[3]), row[4], row[5], round(score[cid], 5), matched, dist))
        return SearchResult(query=query, hits=hits, vector_used=vec is not None)

    def meeting_dir(self, meeting_id: str) -> Path | None:
        row = self.db.execute("SELECT dir FROM meetings WHERE meeting_id=?", (meeting_id,)).fetchone()
        return Path(row[0]) if row else None

    def stats(self) -> dict:
        one = lambda sql: self.db.execute(sql).fetchone()[0]  # noqa: E731
        chunks = one("SELECT count(*) FROM chunks")
        has_vec = self._table("chunks_vec")
        # pending = 지금 모델로는 벡터가 없는 청크. 교정으로 본문이 바뀌었거나 모델이 바뀌면 `tractus index`가 채울 때까지 키워드로만 찾힌다
        stale = self.embedder is not None and has_vec and not self._vectors_current()
        pending = chunks if stale or not has_vec else one("SELECT count(*) FROM chunks WHERE chunk_id NOT IN (SELECT chunk_id FROM chunks_vec)")
        return {
            "meetings": one("SELECT count(*) FROM meetings"),
            "chunks": chunks,
            "vectors": one("SELECT count(*) FROM chunks_vec") if has_vec else 0,
            "pending": pending,
            "embedding_model": self._meta("embedding_model"),
            "index_path": str(self.path),
        }

    def close(self) -> None:
        self.db.close()
