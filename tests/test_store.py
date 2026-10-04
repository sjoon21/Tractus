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
    assert t["schema_version"] == 2 and t["asr"]["language"] == "auto"
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


# ── 화자 (schema_version 2) ─────────────────────────────────────────────


def test_job_chunks_carry_speaker_and_accept_legacy_pairs(tmp_path):
    job = make_job(tmp_path, chunks=[(0, 16000, "S1"), (32000, 48000, None)], diarizer={"model": "m", "revision": "r", "params": {}})
    job.save()
    assert Job.load(job.dir).chunks == [(0, 16000, "S1"), (32000, 48000, None)]
    assert Job.load(job.dir).diarizer["model"] == "m"
    legacy = json.loads((job.dir / ".job.json").read_text(encoding="utf-8"))
    legacy["chunks"] = [[0, 16000], [32000, 48000]]
    del legacy["diarizer"]
    (job.dir / ".job.json").write_text(json.dumps(legacy), encoding="utf-8")
    old = Job.load(job.dir)
    assert old.chunks == [(0, 16000, None), (32000, 48000, None)] and old.diarizer is None


def test_write_transcript_v2_has_speakers_and_named_renders(tmp_path):
    diar = {"model": "mlx-community/Nemotron-3-Diarization", "revision": "59ed2dbf", "params": {"threshold": 0.5}}
    job = make_job(tmp_path, chunks=[(0, 16000 * 30, "S2"), (16000 * 40, 16000 * 75, "S1"), (16000 * 80, 16000 * 81, None)], diarizer=diar)
    job.save()
    for i, text in enumerate(["첫 번째", "두 번째", "세 번째"]):
        job.append(i, Segment(text=text, lang="ko"))
    t = write_transcript(job)
    assert t["schema_version"] == 2 and t["diarization"] == diar
    assert [s["speaker"] for s in t["segments"]] == ["S2", "S1", None]
    assert t["speakers"] == {"S1": {"name": None}, "S2": {"name": None}}
    md = (job.dir / "transcript.md").read_text(encoding="utf-8")
    assert "[00:00:00] **S2**: 첫 번째" in md and "[00:01:20] 세 번째" in md
    vtt = (job.dir / "transcript.vtt").read_text(encoding="utf-8")
    assert "<v S2>첫 번째" in vtt and "\n세 번째" in vtt


def test_write_transcript_without_diarization_has_null_block(tmp_path):
    job = make_job(tmp_path)
    job.save()
    job.append(0, Segment(text="a", lang="ko"))
    job.append(1, Segment(text="b", lang="ko"))
    t = write_transcript(job)
    assert t["speakers"] == {} and t["diarization"] is None and t["segments"][0]["speaker"] is None


def _t():
    return {
        "schema_version": 2, "meeting_id": "X", "title": "회의", "created_at": "c", "audio": {"duration_sec": 60.0}, "asr": {"model": "m"},
        "speakers": {"S1": {"name": None}, "S2": {"name": None}, "S3": {"name": None}},
        "diarization": {"model": "m", "revision": "r", "params": {}},
        "segments": [
            {"id": "s0001", "start": 0.0, "end": 10.0, "text": "가", "speaker": "S1"},
            {"id": "s0002", "start": 10.0, "end": 20.0, "text": "나", "speaker": "S2"},
            {"id": "s0003", "start": 20.0, "end": 30.0, "text": "다", "speaker": "S3"},
        ],
    }


def test_apply_speaker_edit_rename_set_merge_are_pure():
    import pytest

    from tractus.store import apply_speaker_edit, render_vtt

    t = _t()
    r = apply_speaker_edit(t, "rename", "S1", "  김민수 ")
    assert r["speakers"]["S1"] == {"name": "김민수"} and t["speakers"]["S1"]["name"] is None  # 원본은 그대로
    assert "[00:00:00] **김민수**: 가" in render_markdown(r) and "<v 김민수>가" in render_vtt(r)
    assert apply_speaker_edit(r, "rename", "S1", "")["speakers"]["S1"]["name"] is None

    s = apply_speaker_edit(t, "set", "s0003", "S1")
    assert s["segments"][2]["speaker"] == "S1" and "S3" not in s["speakers"]  # 세그먼트가 없는 라벨은 정리
    n = apply_speaker_edit(t, "set", "s0002", "new")
    assert n["segments"][1]["speaker"] == "S4" and list(n["speakers"]) == ["S1", "S3", "S4"]

    m = apply_speaker_edit(apply_speaker_edit(t, "rename", "S3", "이영희"), "merge", "S3", "S1")
    assert [x["speaker"] for x in m["segments"]] == ["S1", "S2", "S1"] and m["speakers"]["S1"]["name"] == "이영희" and "S3" not in m["speakers"]

    for args in (("rename", "S9", "x"), ("set", "s9999", "S1"), ("set", "s0001", "S9"), ("merge", "S1", "S1"), ("merge", "S9", "S1"), ("nope",)):
        with pytest.raises(ValueError):
            apply_speaker_edit(t, *args)


def test_apply_speaker_edit_upgrades_v1_transcript():
    from tractus.store import apply_speaker_edit

    v1 = {"schema_version": 1, "meeting_id": "X", "segments": [{"id": "s0001", "start": 0.0, "end": 1.0, "text": "가", "speaker": None}]}
    r = apply_speaker_edit(v1, "set", "s0001", "new")
    assert r["schema_version"] == 2 and r["speakers"] == {"S1": {"name": None}} and r["diarization"] is None


def test_vtt_voice_tag_strips_markup_from_names():
    from tractus.store import apply_speaker_edit, render_vtt

    r = apply_speaker_edit(_t(), "rename", "S1", "<b>김</b> & 이")
    assert "<v b김/b 이>가" in render_vtt(r)


def test_rename_strips_markup_and_rejects_label_like_names():
    import pytest

    from tractus.store import apply_speaker_edit, render_vtt
    from tractus.summarize import build_prompt

    t = _t()
    r = apply_speaker_edit(t, "rename", "S1", "a**b [s0001] `x`_y")
    assert r["speakers"]["S1"]["name"] == "ab s0001 xy"
    assert "**ab s0001 xy**: 가" in render_markdown(r) and "<v ab s0001 xy>가" in render_vtt(r)
    assert "[s0001 00:00:00 ab s0001 xy] 가" in build_prompt({**r, "title": "x"})
    for bad in ("**", "<>", "S2", "s12", " S1 "):  # 마크업만 있는 이름, 자동 라벨처럼 보이는 이름은 거부
        with pytest.raises(ValueError):
            apply_speaker_edit(t, "rename", "S1", bad)


def test_merge_tolerates_speaker_entries_without_name():
    from tractus.store import apply_speaker_edit

    t = {**_t(), "speakers": {"S1": {}, "S2": None, "S3": {}}}
    m = apply_speaker_edit(t, "merge", "S2", "S1")
    assert m["speakers"]["S1"] == {"name": None} and "S2" not in m["speakers"]
