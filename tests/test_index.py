import hashlib
import json
import shutil
from pathlib import Path

import numpy as np
import pytest

from tractus.index import Index, make_chunks, rrf, to_fts_query, to_index_text

EVAL = Path(__file__).parent / "fixtures" / "eval"


class FakeEmbedder:
    """단어 해시 기반 결정적 임베딩. 같은 단어를 공유하면 가까워진다."""

    model_id = "fake-embedder"
    dim = 64

    def __init__(self):
        self.calls = 0

    def embed(self, texts, is_query=False):
        self.calls += 1
        out = np.zeros((len(texts), self.dim), np.float32)
        for i, t in enumerate(texts):
            for w in to_index_text(t).split():
                out[i, int(hashlib.md5(w.encode()).hexdigest(), 16) % self.dim] += 1
        out /= np.linalg.norm(out, axis=1, keepdims=True) + 1e-9
        return out


@pytest.fixture
def home(tmp_path):
    shutil.copytree(EVAL / "meetings", tmp_path / "meetings")
    return tmp_path


def test_bigrams_do_not_cross_spaces_and_keep_english_words():
    assert to_index_text("예산은 내년예산") == "예산 산은 내년 년예 예산"
    assert to_index_text("DB connection이 끊겨요") == "db connection 이 끊겨 겨요"
    assert to_index_text("3분기 1,200만원") == "3 분기 1200 만원"


def test_fts_query_phrases_and_guards():
    assert to_fts_query("예산 검토") == '"예산" AND "검토"'
    assert to_fts_query("예산검토") == '"예산 산검 검토"'
    assert to_fts_query("??? * ()") == ""
    assert to_fts_query('NEAR( "x') == '"near" AND "x"'  # FTS5 연산자도 phrase로 감싸 문법 오류가 나지 않는다
    assert to_fts_query("회") == '"회"*'


def test_make_chunks_merges_segments_within_bounds():
    segs = [{"id": f"s{i:04d}", "start": i * 30.0, "end": i * 30.0 + 29, "text": "가" * 120} for i in range(1, 8)]
    chunks = make_chunks(segs)
    assert [[s["id"] for s in c["segments"]] for c in chunks][:2] == [["s0001", "s0002", "s0003"], ["s0004", "s0005", "s0006"]]
    assert all(len(c["text"]) <= 500 for c in chunks)
    assert chunks[0]["start"] == 30.0 and chunks[0]["end"] == 119.0


def test_rrf_orders_by_reciprocal_rank():
    order, score = rrf([1, 2, 3], [3, 1])
    assert order == [1, 3, 2]
    assert score[1] == pytest.approx(1 / 61 + 1 / 62)


def test_sync_is_incremental(home):
    emb = FakeEmbedder()
    idx = Index(home, embedder=emb)
    first = idx.sync()
    assert first.added == 5 and first.updated == first.removed == 0
    calls = emb.calls
    assert idx.sync().unchanged == 5 and emb.calls == calls  # 바뀐 것이 없으면 임베딩하지 않는다

    (d,) = [p for p in (home / "meetings").iterdir() if "01M1JFX" in p.name]
    t = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
    t["segments"][0]["text"] = "완전히 새로운 내용으로 교체된 첫 세그먼트 블루베리"
    (d / "transcript.json").write_text(json.dumps(t, ensure_ascii=False), encoding="utf-8")
    assert idx.sync().updated == 1
    assert any("블루베리" in h.text for h in idx.search("블루베리").hits)

    shutil.rmtree(d)
    assert idx.sync().removed == 1
    assert all(h.meeting_id != "01M1JFX480KZE86SXAN94C6Y0E" for h in idx.search("블루베리", limit=50).hits)
    assert idx.stats()["meetings"] == 4


def test_deleted_note_leaves_no_rows_or_vectors_without_loading_the_embedder(home):
    """앱이 노트 폴더를 휴지통으로 옮기면(폴더가 사라짐) 다음 동기화가 그 노트의 청크·키워드 색인·벡터를 모두 지운다.
    지우는 데는 임베더가 필요 없다 (embed=False)."""
    emb = FakeEmbedder()
    idx = Index(home, embedder=emb)
    idx.sync()
    (d,) = [p for p in (home / "meetings").iterdir() if "01M1JFX" in p.name]
    mid = "01M1JFX480KZE86SXAN94C6Y0E"
    count = lambda sql: idx.db.execute(sql, (mid,)).fetchone()[0]  # noqa: E731
    assert count("SELECT count(*) FROM chunks WHERE meeting_id=?") > 0 and count("SELECT count(*) FROM chunks_vec WHERE meeting_id=?") > 0

    trash = home / "fake-trash"
    trash.mkdir()
    shutil.move(str(d), str(trash / d.name))  # 휴지통으로 이동: 원래 자리에서는 사라진다
    calls = emb.calls
    assert idx.sync(embed=False).removed == 1
    assert emb.calls == calls
    assert count("SELECT count(*) FROM chunks WHERE meeting_id=?") == 0
    assert count("SELECT count(*) FROM chunks_vec WHERE meeting_id=?") == 0
    assert idx.db.execute("SELECT count(*) FROM chunks_fts WHERE rowid NOT IN (SELECT chunk_id FROM chunks)").fetchone()[0] == 0
    assert idx.db.execute("SELECT count(*) FROM chunks_vec WHERE chunk_id NOT IN (SELECT chunk_id FROM chunks)").fetchone()[0] == 0
    assert idx.stats()["meetings"] == 4
    assert all(h.meeting_id != mid for h in idx.search("예산", limit=50).hits)


def test_embedding_model_change_rebuilds_vectors(home):
    Index(home, embedder=FakeEmbedder()).sync()

    class Other(FakeEmbedder):
        model_id, dim = "fake-other", 32

    other = Other()
    idx = Index(home, embedder=other)
    idx.sync()
    assert idx.stats()["embedding_model"] == "fake-other" and other.calls >= 1
    assert idx.search("예산").hits


def test_search_hybrid_returns_citable_hits(home):
    idx = Index(home, embedder=FakeEmbedder())
    idx.sync()
    res = idx.search("latency", limit=5)
    assert res.vector_used and res.hits
    h = res.hits[0]
    assert h.meeting_id and h.segment_ids and h.start <= h.end and "latency" in h.text.lower()
    assert set(h.matched) <= {"keyword", "partial", "vector"}
    assert [s["id"] for s in h.segments] == h.segment_ids and all(s["text"] for s in h.segments)


def test_date_filter_limits_meetings(home):
    idx = Index(home, embedder=FakeEmbedder())
    idx.sync()
    res = idx.search("예산", date_from="2026-09-01", date_to="2026-09-30")
    assert res.hits and all("2026-09-01" <= h.date <= "2026-09-30" for h in res.hits)


def test_keyword_only_without_embedder(home):
    idx = Index(home, embedder=None)
    idx.sync()
    res = idx.search("예산")
    assert not res.vector_used and res.hits and all(h.matched in (["keyword"], ["partial"]) for h in res.hits)


def test_unmatched_query_returns_nothing_without_vectors(home):
    idx = Index(home, embedder=None)
    idx.sync()
    assert idx.search("???").hits == []


def test_corrupt_transcript_is_skipped_not_fatal(home):
    bad = home / "meetings" / "2026-01-01_broken_01BROKEN000000000000000000"
    bad.mkdir()
    (bad / "transcript.json").write_text("{", encoding="utf-8")
    idx = Index(home, embedder=None)
    r = idx.sync()
    assert r.added == 5 and r.errors and "broken" in r.errors[0]


def test_fts_operators_in_query_do_not_raise(home):
    idx = Index(home, embedder=None)
    idx.sync()
    for q in ['NEAR(예산', 'a OR b', '"', "예산*", "-latency", "^캐시", "x:y"]:
        idx.search(q)


def test_vectors_backfilled_after_keyword_only_sync(home):
    Index(home, embedder=FakeEmbedder()).sync()
    (d,) = [p for p in (home / "meetings").iterdir() if "01M1JFX" in p.name]
    t = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
    t["segments"][0]["text"] = "임베딩 모델 없이 수정된 세그먼트"
    (d / "transcript.json").write_text(json.dumps(t, ensure_ascii=False), encoding="utf-8")
    Index(home, embedder=None).sync()  # 모델이 없는 프로세스가 동기화
    idx = Index(home, embedder=FakeEmbedder())
    r = idx.sync()
    st = idx.stats()
    assert r.embedded > 0 and st["vectors"] == st["chunks"]


def test_malformed_transcripts_are_isolated(home):
    for name, body in [("arr", "[]"), ("nullstart", json.dumps({"meeting_id": "01NULLSTART000000000000000", "segments": [{"id": "s0001", "start": None, "end": 1, "text": "x"}]})),
                       ("numtext", json.dumps({"meeting_id": "01NUMTEXT00000000000000000", "segments": [{"id": "s0001", "start": 0, "end": 1, "text": 5}]}))]:
        d = home / "meetings" / f"2026-01-01_{name}_01X"
        d.mkdir()
        (d / "transcript.json").write_text(body, encoding="utf-8")
    r = Index(home, embedder=None).sync()
    assert r.added == 5 and len(r.errors) == 3


def test_meetings_without_date_found_without_filter(home):
    d = home / "meetings" / "nodate_01NODATE0000000000000000"
    d.mkdir()
    (d / "transcript.json").write_text(json.dumps({"meeting_id": "01NODATE0000000000000000", "title": "날짜 없음",
        "segments": [{"id": "s0001", "start": 0, "end": 5, "text": "블루베리 농장 견학 일정"}]}, ensure_ascii=False), encoding="utf-8")
    idx = Index(home, embedder=None)
    idx.sync()
    assert [h.meeting_id for h in idx.search("블루베리").hits] == ["01NODATE0000000000000000"]
    assert not idx.search("블루베리", date_from="2026-01-01").hits


def test_rebuild_in_place_keeps_db_file(home):
    idx = Index(home, embedder=FakeEmbedder())
    idx.sync()
    ino = idx.path.stat().st_ino
    other = Index(home, embedder=None)  # 다른 프로세스(MCP)가 열어 둔 연결
    r = idx.rebuild()
    assert r.added == 5 and idx.path.stat().st_ino == ino
    assert other.search("latency").hits


def test_relaxed_query_strips_particles_and_small_numbers():
    from tractus.index import relaxed_query

    assert relaxed_query("앱은 출시일에서") == '"시일" OR "앱"* OR "출시"'  # 조사(은, 에서)는 버리고 어간만
    assert relaxed_query("v2.4 버전 3") == '"2.4" OR "버전"'  # 한 글자 영문·1–2자리 숫자 제외


def test_version_numbers_match_without_prefix(home):
    idx = Index(home, embedder=None)
    idx.sync()
    assert any("v2.4" in h.text for h in idx.search("2.4").hits)


def test_fuse_puts_strict_keyword_hits_first_and_downweights_vectors():
    from tractus.index import fuse

    order, score = fuse(keyword=[5, 7, 9], strict={7}, vector={1: 0.1, 9: 0.2, 5: 0.3})
    assert order[0] == 7  # strict 결과가 벡터 1위보다 앞
    assert order.index(5) < order.index(1)  # 일부만 맞은 키워드 1위(5)가 벡터 1위(1)보다 앞 (벡터 가중 0.3)
    assert score[7] > 1 > score[5]


def test_make_chunks_carry_speaker_display_name():
    segs = [{"id": "s0001", "start": 0, "end": 1, "text": "가", "speaker": "S1"}, {"id": "s0002", "start": 1, "end": 2, "text": "나", "speaker": "S2"},
            {"id": "s0003", "start": 2, "end": 3, "text": "다"}]
    (c,) = make_chunks(segs, {"S1": {"name": "김민수"}, "S2": {"name": None}})
    assert [s["speaker"] for s in c["segments"]] == ["김민수", "S2", None]


def test_rename_reindexes_meeting_with_new_speaker(home):
    idx = Index(home)
    idx.sync()
    (d,) = [p for p in (home / "meetings").iterdir() if "01M1JFX" in p.name]
    t = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
    t["segments"][0]["speaker"] = "S1"
    t["speakers"] = {"S1": {"name": "블루베리씨"}}
    (d / "transcript.json").write_text(json.dumps(t, ensure_ascii=False), encoding="utf-8")
    assert idx.sync().updated == 1
    word = t["segments"][0]["text"].split()[0]
    segs = [s for h in idx.search(word, meeting_id=t["meeting_id"]).hits for s in h.segments]
    assert any(s["id"] == "s0001" and s["speaker"] == "블루베리씨" for s in segs)


def test_speaker_edit_reuses_vectors_and_only_embeds_changed_chunks(home):
    emb = FakeEmbedder()
    idx = Index(home, embedder=emb)
    idx.sync()
    vectors = idx.stats()["vectors"]
    (d,) = [p for p in (home / "meetings").iterdir() if "01M1JFX" in p.name]
    t = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
    t["segments"][0]["speaker"] = "S1"
    t["speakers"] = {"S1": {"name": "블루베리씨"}}
    (d / "transcript.json").write_text(json.dumps(t, ensure_ascii=False), encoding="utf-8")
    r = idx.sync()
    assert r.updated == 1 and r.embedded == 0 and idx.stats()["vectors"] == vectors  # 화자만 바뀌면 청크 본문이 같아 다시 임베딩하지 않는다
    assert Index(home).sync(embed=False).unchanged == 5  # 임베딩 모델 없이도 (MCP·화자 편집) 벡터는 남는다

    t["segments"][-1]["text"] = t["segments"][-1]["text"][::-1]  # 길이가 같아 청크 경계는 그대로
    (d / "transcript.json").write_text(json.dumps(t, ensure_ascii=False), encoding="utf-8")
    assert idx.sync().embedded == 1  # 본문이 바뀐 청크만
