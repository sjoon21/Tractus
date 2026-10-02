import json

from tractus.store import (
    Job,
    Segment,
    find_job,
    load_glossary,
    meeting_dir_name,
    new_ulid,
    render_markdown,
    write_transcript,
)


def test_ulid_is_26_chars_and_sortable():
    a, b = new_ulid(1_000), new_ulid(2_000)
    assert len(a) == 26 and a < b


def test_meeting_dir_name_sanitizes_title():
    name = meeting_dir_name("2026-10-02", "주간 회의/기획:최종", "01J9X")
    assert name == "2026-10-02_주간_회의_기획_최종_01J9X"


def test_load_glossary_reads_bullets_only(tmp_path):
    p = tmp_path / "glossary.md"
    p.write_text("# 용어집\n\n- WTO\n* 김철수\n- \n본문 문장은 무시\n  - OECD  \n", encoding="utf-8")
    assert load_glossary(p) == ["WTO", "김철수", "OECD"]
    assert load_glossary(tmp_path / "없음.md") == []


def make_job(tmp_path, **kw):
    base = dict(
        meeting_id="01J9X", sha256="abc", source="회의.m4a", title="회의", created_at="2026-10-02T10:00:00+09:00",
        duration_sec=75.0, model="mlx-community/Qwen3-ASR-1.7B-8bit", track="standard", language="auto",
        hotwords=["WTO"], chunks=[(0, 16000 * 30), (16000 * 40, 16000 * 75)],
    )
    d = tmp_path / "meetings" / "m1"
    d.mkdir(parents=True)
    return Job(dir=d, **{**base, **kw})


def test_job_progress_roundtrip_and_resume(tmp_path):
    job = make_job(tmp_path)
    job.save()
    job.append(0, Segment(text="첫 청크", lang="ko"))
    resumed = find_job(tmp_path / "meetings", "abc")
    assert resumed is not None and resumed.chunks == job.chunks
    assert resumed.done() == {0: Segment(text="첫 청크", lang="ko")}
    assert find_job(tmp_path / "meetings", "other") is None


def test_partial_line_from_crash_is_ignored(tmp_path):
    job = make_job(tmp_path)
    job.save()
    job.append(0, Segment(text="첫 청크", lang="ko"))
    with (job.dir / ".chunks.jsonl").open("a", encoding="utf-8") as f:
        f.write('\n{"i": 1, "text": "잘린')  # append()가 쓰다 끊긴 형태: 줄바꿈 + 잘린 JSON
    assert list(job.done()) == [0]


def test_write_transcript_follows_schema_and_cleans_progress(tmp_path):
    job = make_job(tmp_path)
    job.save()
    job.append(1, Segment(text="두 번째", lang="en"))
    job.append(0, Segment(text="첫 번째", lang="ko"))
    write_transcript(job)
    t = json.loads((job.dir / "transcript.json").read_text(encoding="utf-8"))
    assert t["schema_version"] == 1 and t["asr"]["language"] == "auto"
    assert t["audio"] == {"file": "audio.opus", "duration_sec": 75.0, "source": "회의.m4a", "sha256": "abc"}
    assert [(s["id"], s["start"], s["end"], s["text"]) for s in t["segments"]] == [
        ("s0001", 0.0, 30.0, "첫 번째"),
        ("s0002", 40.0, 75.0, "두 번째"),
    ]
    assert t["segments"][0]["speaker"] is None and t["segments"][0]["words"] is None
    assert not (job.dir / ".job.json").exists() and not (job.dir / ".chunks.jsonl").exists()
    md = (job.dir / "transcript.md").read_text(encoding="utf-8")
    assert "[00:00:00] 첫 번째" in md and "[00:00:40] 두 번째" in md


def test_render_markdown_skips_empty_segments():
    md = render_markdown(
        {"title": "회의", "meeting_id": "X", "created_at": "c", "audio": {"duration_sec": 3725.0}, "asr": {"model": "m"},
         "segments": [{"start": 1.0, "text": ""}, {"start": 3661.0, "text": "끝"}]}
    )
    assert "duration: 01:02:05" in md and "[01:01:01] 끝" in md and "[00:00:01]" not in md


def test_append_after_torn_line_keeps_next_chunk(tmp_path):
    job = make_job(tmp_path)
    job.save()
    job.append(0, Segment(text="첫 청크", lang="ko"))
    with (job.dir / ".chunks.jsonl").open("a", encoding="utf-8") as f:
        f.write('\n{"i": 1, "text": "잘린')  # 전원 차단으로 쓰다 끊긴 기록
    job.append(1, Segment(text="다시 전사", lang="ko"))
    assert job.done() == {0: Segment(text="첫 청크", lang="ko"), 1: Segment(text="다시 전사", lang="ko")}


def test_write_transcript_refuses_missing_chunks(tmp_path):
    import pytest

    job = make_job(tmp_path)
    job.save()
    job.append(0, Segment(text="첫 청크", lang="ko"))
    with pytest.raises(RuntimeError, match="1"):
        write_transcript(job)
    assert (job.dir / ".job.json").exists() and not (job.dir / "transcript.json").exists()


def test_corrupt_files_in_other_meetings_are_skipped(tmp_path):
    from tractus.store import find_transcribed

    bad = tmp_path / "meetings" / "bad"
    bad.mkdir(parents=True)
    (bad / ".job.json").write_text("")
    (bad / "transcript.json").write_text("{")
    job = make_job(tmp_path)
    job.save()
    assert find_job(tmp_path / "meetings", "abc").meeting_id == "01J9X"
    assert find_transcribed(tmp_path / "meetings", "abc") is None
