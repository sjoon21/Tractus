"""노트 잠금, 단어 시각 복원, 목소리 거절·삭제·등록 롤백, 끝난 노트의 남은 작업 파일, `tractus render`."""

import json
import subprocess
import sys
import threading

import numpy as np
import pytest
from typer.testing import CliRunner

from tractus import cli, store, voices
from tractus.store import Job, apply_speaker_edit, apply_text_edits, edit_transcript, find_job, find_meeting_dir, find_transcribed, note_lock, write_transcript

SR = 16000
PID = "P1"
SUGG = {"person_id": PID, "name": "홍길동", "score": 0.9}


@pytest.fixture
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    (h / "meetings").mkdir(parents=True)
    monkeypatch.chdir(tmp_path)  # 저장소의 .env를 읽지 않게 한다
    monkeypatch.setenv("TRACTUS_HOME", str(h))
    monkeypatch.delenv("TRACTUS_MODELS_DIR", raising=False)
    monkeypatch.setattr(cli, "_sync_index_quietly", lambda embed=True: None)
    return h


def words(text: str, step: float = 0.5) -> list[dict]:
    return [{"text": w, "start": round(i * step, 2), "end": round((i + 1) * step, 2)} for i, w in enumerate(text.split())]


def make_note(home, name="n1", speakers=None, segs=None):
    d = home / "meetings" / f"2026-10-10_{name}_01{name.upper()}"
    d.mkdir()
    segs = segs or [{"id": "s0001", "start": 0.0, "end": 4.0, "text": "예산은 사억입니다", "lang": "ko", "speaker": "S1", "corrected_text": None, "words": words("예산은 사억입니다")}]
    t = {
        "schema_version": 2, "meeting_id": f"M{name}", "title": name, "created_at": "2026-10-10T10:00:00+09:00",
        "audio": {"file": "audio.ogg", "duration_sec": 8.0, "source": "x", "sha256": f"sha-{name}"},
        "asr": {"model": "m", "track": "lite", "runtime": "mlx-audio", "language": "auto", "hotwords": []},
        "speakers": speakers if speakers is not None else {"S1": {"name": None}},
        "diarization": None, "segments": segs,
    }
    store.save_transcript(d, t)
    return d, t


def read(d):
    return json.loads((d / "transcript.json").read_text(encoding="utf-8"))


# ── C4 노트 잠금 ───────────────────────────────────────────────────────

WORKER = """
import sys, time
from pathlib import Path
from tractus.store import apply_text_edits, edit_transcript

d, sid = Path(sys.argv[1]), sys.argv[2]

def fn(t):
    time.sleep(0.15)  # 읽기와 쓰기 사이를 넓혀 잠금이 없으면 반드시 서로 덮어쓰게 한다
    return apply_text_edits(t, [{"id": sid, "text": "고침 " + sid}])

edit_transcript(d, fn)
"""


def test_note_lock_serialises_writers_across_processes(home):
    segs = [{"id": f"s{i:04d}", "start": float(i), "end": i + 1.0, "text": f"원문{i}", "lang": "ko", "speaker": None, "corrected_text": None, "words": None} for i in range(1, 7)]
    d, _ = make_note(home, segs=segs)
    procs = [subprocess.Popen([sys.executable, "-c", WORKER, str(d), s["id"]]) for s in segs]
    assert [p.wait(timeout=60) for p in procs] == [0] * 6
    assert [s["corrected_text"] for s in read(d)["segments"]] == [f"고침 {s['id']}" for s in segs]  # 잃은 수정이 없다
    assert "고침 s0001" in (d / "transcript.md").read_text(encoding="utf-8")


def test_note_lock_blocks_other_threads_but_is_reentrant_in_one(home):
    d, _ = make_note(home)
    entered = threading.Event()
    order = []

    def other():
        with note_lock(d):
            order.append("other")
        entered.set()

    with note_lock(d):
        with note_lock(d):  # 같은 스레드의 중첩은 스스로를 막지 않는다
            th = threading.Thread(target=other)
            th.start()
            assert not entered.wait(0.3)  # 다른 스레드는 기다린다
            order.append("holder")
    th.join(timeout=5)
    assert order == ["holder", "other"]


def test_edit_transcript_writes_nothing_when_fn_raises(home):
    d, before = make_note(home)
    with pytest.raises(ValueError):
        edit_transcript(d, lambda t: apply_text_edits(t, [{"id": "s9999", "text": "x"}]))
    assert read(d) == before


# ── 원문으로 되돌리면 처음 정렬한 단어 시각 ─────────────────────────────


def one_seg(text="예산은 사억입니다"):
    return {"id": "s0001", "start": 0.0, "end": 4.0, "text": text, "lang": "ko", "speaker": None, "corrected_text": None, "words": words(text, 1.0)}


def test_reverting_edit_restores_original_word_times_exactly():
    t = {"segments": [one_seg()]}
    orig = t["segments"][0]["words"]
    edited, n = apply_text_edits(t, [{"id": "s0001", "text": "예산은 오억입니다 확정"}])
    seg = edited["segments"][0]
    assert n == 1 and seg["words_asr"] == orig and any(w.get("approx") for w in seg["words"])
    again, _ = apply_text_edits(edited, [{"id": "s0001", "text": "예산은 육억입니다"}])  # 고친 문장을 또 고쳐도 처음 값을 지키고
    assert again["segments"][0]["words_asr"] == orig
    back, n = apply_text_edits(again, [{"id": "s0001", "text": "예산은   사억입니다"}])  # 공백이 달라도 원문과 같다
    seg = back["segments"][0]
    assert n == 1 and seg["corrected_text"] is None and seg["words"] == orig and not any("approx" in w for w in seg["words"])
    assert "words_asr" not in seg
    assert t["segments"][0]["corrected_text"] is None and "words_asr" not in t["segments"][0]  # 원본은 그대로


def test_edit_without_words_keeps_no_words_asr_and_revert_stays_null():
    s = {**one_seg(), "words": None}
    edited, _ = apply_text_edits({"segments": [s]}, [{"id": "s0001", "text": "다른 문장"}])
    assert "words_asr" not in edited["segments"][0] and edited["segments"][0]["words"] is None
    back, _ = apply_text_edits(edited, [{"id": "s0001", "text": s["text"]}])
    assert back["segments"][0]["words"] is None and "words_asr" not in back["segments"][0]


def test_stale_words_asr_with_other_tokens_falls_back_to_remap():
    s = {**one_seg(), "corrected_text": "다른 문장", "words": words("다른 문장", 1.0), "words_asr": words("전혀 다른 토큰 수 입니다")}
    back, _ = apply_text_edits({"segments": [s]}, [{"id": "s0001", "text": s["text"]}])
    seg = back["segments"][0]
    assert [w["text"] for w in seg["words"]] == s["text"].split() and "words_asr" not in seg


# ── 거절한 목소리 제안 ─────────────────────────────────────────────────


def sugg_note(home, name="n1", dismissed=None):
    sp = {"S1": {"name": None, "suggested": SUGG}, "S2": {"name": None}}
    if dismissed:
        sp["S1"] = {"name": None, "dismissed": dismissed}
    segs = [{"id": "s0001", "start": 0.0, "end": 4.0, "text": "가", "lang": "ko", "speaker": "S1", "corrected_text": None, "words": None},
            {"id": "s0002", "start": 4.0, "end": 8.0, "text": "나", "lang": "ko", "speaker": "S2", "corrected_text": None, "words": None}]
    return make_note(home, name, sp, segs)


def test_dismiss_is_remembered_through_rename_merge_and_set():
    t = {"speakers": {"S1": {"name": None, "suggested": SUGG}, "S2": {"name": None}},
         "segments": [{"id": "s0001", "speaker": "S1"}, {"id": "s0002", "speaker": "S2"}]}
    d1 = apply_speaker_edit(t, "dismiss", "S1")
    assert d1["speakers"]["S1"] == {"name": None, "dismissed": [PID]}
    assert apply_speaker_edit(d1, "dismiss", "S1")["speakers"]["S1"]["dismissed"] == [PID]  # 제안이 없으면 늘지 않는다
    assert apply_speaker_edit(d1, "rename", "S1", "김영희")["speakers"]["S1"] == {"name": "김영희", "dismissed": [PID]}  # 이름을 붙여도 지우지 않는다
    assert apply_speaker_edit(d1, "rename", "S1", "")["speakers"]["S1"] == {"name": None, "dismissed": [PID]}
    merged = apply_speaker_edit(d1, "merge", "S2", "S1")
    assert merged["speakers"] == {"S1": {"name": None, "dismissed": [PID]}}
    assert apply_speaker_edit(d1, "set", "s0002", "S1")["speakers"]["S1"]["dismissed"] == [PID]


def test_apply_suggestions_never_suggests_a_dismissed_person():
    t = {"speakers": {"S1": {"name": None, "dismissed": [PID]}, "S2": {"name": None}},
         "segments": [{"id": "s0001", "speaker": "S1"}, {"id": "s0002", "speaker": "S2"}]}
    out = store.apply_suggestions(t, {"S1": SUGG, "S2": SUGG})
    assert out["speakers"] == {"S1": {"name": None, "dismissed": [PID]}, "S2": {"name": None, "suggested": SUGG}}


def unit(*v):
    return np.array(v, np.float32)


def test_match_skips_dismissed_person_but_keeps_margin_against_them(monkeypatch):
    monkeypatch.setattr(voices, "THRESHOLD", 0.5)
    ppl = [{"id": "A", "name": "가", "samples": [{"embedding": unit(1, 0)}]}, {"id": "B", "name": "나", "samples": [{"embedding": unit(0, 1)}]}]
    embs = {"S1": unit(1, 0)}
    assert voices.match(embs, ppl)["S1"]["person_id"] == "A"
    assert voices.match(embs, ppl, {"S1": {"A"}}) == {}  # 거절한 A 대신 B를 억지로 고르지 않는다 (B는 임계값 아래)
    assert voices.match({"S1": unit(1, 0), "S2": unit(0.9, 0.1)}, ppl, {"S1": {"A"}}).get("S1") is None
    assert voices.match(embs, ppl, {"S2": {"A"}})["S1"]["person_id"] == "A"  # 다른 화자의 거절은 상관없다


class SameVoice:
    def embed(self, pcm):
        return np.full(4, 0.5, np.float32)


def register(home, name="홍길동", pid=PID):
    v = [0.5] * 4
    voices.save_profiles(home, {"version": 1, "model": voices.MODEL_ID, "people": [
        {"id": pid, "name": name, "created_at": "x", "consent": True, "samples": [{"embedding": v, "meeting_id": "m", "added_at": "x"}]}]})


def run_voices(*args):
    return CliRunner().invoke(cli.app, ["voices", *map(str, args)])


def test_voices_match_does_not_resuggest_dismissed_person(home, monkeypatch):
    register(home)
    d, _ = sugg_note(home, dismissed=[PID])
    monkeypatch.setattr(cli.voices, "load_embedder", lambda models: SameVoice())
    monkeypatch.setattr(cli, "_meeting_pcm", lambda d, t: np.zeros(8 * SR, np.float32))
    r = run_voices("match", str(d))
    assert r.exit_code == 0, r.output
    sp = read(d)["speakers"]
    assert "suggested" not in sp["S1"] and sp["S1"]["dismissed"] == [PID]  # 거절한 참석자는 그대로
    assert sp["S2"]["suggested"]["person_id"] == PID  # 거절하지 않은 참석자에는 제안한다


# ── voices forget ──────────────────────────────────────────────────────


def test_forget_removes_person_from_all_notes_dismissals_and_unfinished_jobs(home):
    register(home)
    other = {"person_id": "P2", "name": "김영희", "score": 0.8}
    d1, _ = sugg_note(home, "a")
    d2, _ = make_note(home, "b", {"S1": {"name": None, "suggested": other, "dismissed": [PID]}, "S2": {"name": "박민수"}},
                      [{"id": "s0001", "start": 0.0, "end": 4.0, "text": "가", "lang": "ko", "speaker": "S1", "corrected_text": None, "words": None},
                       {"id": "s0002", "start": 4.0, "end": 8.0, "text": "나", "lang": "ko", "speaker": "S2", "corrected_text": None, "words": None}])
    jd = home / "meetings" / "2026-10-10_unfinished_01J"
    jd.mkdir()
    job = Job(dir=jd, meeting_id="J", sha256="jj", source="a.wav", title="미완", created_at="2026-10-10T10:00:00+09:00", duration_sec=4.0, model="m",
              track="lite", language="auto", chunks=[(0, 2 * SR, "S1"), (2 * SR, 4 * SR, "S2")], suggestions={"S1": SUGG, "S2": other})
    job.save()
    r = run_voices("forget", "홍길동")
    assert r.exit_code == 0 and json.loads(r.stdout) == {"forgotten": 1}
    assert "suggested" not in read(d1)["speakers"]["S1"]
    s2 = read(d2)["speakers"]
    assert s2["S1"] == {"name": None, "suggested": other} and s2["S2"] == {"name": "박민수"}  # 거절 기록도 지워지고 다른 사람은 그대로
    assert Job.load(jd).suggestions == {"S2": other}
    job.append(0, store.Segment(text="가", lang="ko"))
    job.append(1, store.Segment(text="나", lang="ko"))
    t = write_transcript(Job.load(jd))  # 이어하기로 끝나도 되살아나지 않는다
    assert PID not in json.dumps(t)


def test_transcribe_drops_suggestions_of_a_person_forgotten_meanwhile(home):
    register(home, pid="P2", name="김영희")
    assert cli._still_registered({"S1": SUGG, "S2": {**SUGG, "person_id": "P2"}}) == {"S2": {**SUGG, "person_id": "P2"}}


# ── voices enroll 롤백, list model_present ─────────────────────────────


def enroll_setup(home, monkeypatch):
    d, _ = make_note(home, segs=[{"id": "s0001", "start": 0.0, "end": 4.0, "text": "가", "lang": "ko", "speaker": "S1", "corrected_text": None, "words": None}])
    monkeypatch.setattr(cli.voices, "load_embedder", lambda models: SameVoice())
    monkeypatch.setattr(cli, "_meeting_pcm", lambda d, t: np.zeros(8 * SR, np.float32))
    return d


def test_enroll_failure_after_profile_write_rolls_the_profile_back(home, monkeypatch):
    d = enroll_setup(home, monkeypatch)
    monkeypatch.setattr(cli, "save_transcript", lambda *a: (_ for _ in ()).throw(OSError("disk full")))
    r = run_voices("enroll", str(d), "S1", "--name", "홍길동", "--consent")
    assert r.exit_code != 0 and isinstance(r.exception, OSError)
    assert not (home / "voices.json").exists()  # 이름은 못 붙였는데 목소리만 등록된 채로 남지 않는다
    assert read(d)["speakers"]["S1"]["name"] is None


def test_enroll_failure_restores_previous_profile_bytes_semantically(home, monkeypatch):
    register(home, "김영희", "P2")
    before = json.loads((home / "voices.json").read_text(encoding="utf-8"))
    d = enroll_setup(home, monkeypatch)
    monkeypatch.setattr(cli, "save_transcript", lambda *a: (_ for _ in ()).throw(OSError("disk full")))
    assert run_voices("enroll", str(d), "S1", "--name", "홍길동", "--consent").exit_code != 0
    assert json.loads((home / "voices.json").read_text(encoding="utf-8")) == before
    assert (home / "voices.json").stat().st_mode & 0o777 == 0o600


def test_enroll_succeeds_and_keeps_edits_made_while_embedding(home, monkeypatch):
    d = enroll_setup(home, monkeypatch)

    class Editing(SameVoice):
        def embed(self, pcm):  # 임베딩하는 동안 앱에서 문장을 고쳤다
            edit_transcript(d, lambda t: apply_text_edits(t, [{"id": "s0001", "text": "고친 문장"}]))
            return super().embed(pcm)

    monkeypatch.setattr(cli.voices, "load_embedder", lambda models: Editing())
    r = run_voices("enroll", str(d), "S1", "--name", "홍길동", "--consent")
    assert r.exit_code == 0, r.output
    t = read(d)
    assert t["speakers"]["S1"]["name"] == "홍길동" and t["segments"][0]["corrected_text"] == "고친 문장"


def test_voices_list_reports_whether_the_voice_model_is_usable(home, monkeypatch):
    assert json.loads(run_voices("list", "--json").stdout)["model_present"] is False
    p = voices.model_path(cli.models_dir())
    p.parent.mkdir(parents=True)
    p.write_bytes(b"not the model")
    assert json.loads(run_voices("list", "--json").stdout)["model_present"] is False  # 다른 파일
    import hashlib

    monkeypatch.setattr(voices, "MODEL_SHA256", hashlib.sha256(b"not the model").hexdigest())
    assert json.loads(run_voices("list", "--json").stdout)["model_present"] is True


# ── 끝난 노트에 남은 작업 파일 ─────────────────────────────────────────


def finished_with_stale_job(home, monkeypatch):
    d = home / "meetings" / "2026-10-10_x_01X"
    d.mkdir()
    job = Job(dir=d, meeting_id="X", sha256="abc", source="a.wav", title="x", created_at="2026-10-10T10:00:00+09:00", duration_sec=2.0, model="m", track="lite",
              language="auto", chunks=[(0, 2 * SR, None)])
    job.save()
    job.append(0, store.Segment(text="가", lang="ko"))
    monkeypatch.setattr(store, "_clean_stale_job", lambda d: (_ for _ in ()).throw(KeyboardInterrupt()))  # transcript.json을 쓴 직후 끊김
    with pytest.raises(KeyboardInterrupt):
        write_transcript(job)
    monkeypatch.undo()
    assert (d / "transcript.json").is_file() and (d / store.JOB_FILE).is_file()  # 두 파일이 함께 남은 상태
    return d


def test_transcript_json_wins_over_a_stale_job_file(home, monkeypatch):
    d = finished_with_stale_job(home, monkeypatch)
    meetings = home / "meetings"
    assert find_job(meetings, "abc") is None  # 이어하기 대상이 아니다
    assert not (d / store.JOB_FILE).exists() and not (d / store.CHUNKS_FILE).exists()  # 정리된다


def test_find_transcribed_and_find_meeting_dir_also_clean_the_stale_job(home, monkeypatch):
    d = finished_with_stale_job(home, monkeypatch)
    assert find_transcribed(home / "meetings", "abc") == d
    assert not (d / store.JOB_FILE).exists()
    (d / store.JOB_FILE).write_text("{}")
    assert find_meeting_dir(home / "meetings", "01X") == d
    assert not (d / store.JOB_FILE).exists()


def test_write_transcript_removes_job_files_after_writing(home):
    d = home / "meetings" / "m"
    d.mkdir()
    job = Job(dir=d, meeting_id="X", sha256="abc", source="a.wav", title="x", created_at="2026-10-10T10:00:00+09:00", duration_sec=2.0, model="m", track="lite",
              language="auto", chunks=[(0, 2 * SR, None)])
    job.save()
    job.append(0, store.Segment(text="가", lang="ko"))
    write_transcript(job)
    assert sorted(p.name for p in d.iterdir()) == ["transcript.json", "transcript.md", "transcript.vtt"]


# ── tractus render ─────────────────────────────────────────────────────


def test_render_rebuilds_md_and_vtt_from_transcript_json(home):
    d1, _ = sugg_note(home, "a")
    d2, _ = sugg_note(home, "b")
    for d in (d1, d2):
        (d / "transcript.md").write_text("옛 문구 화자 1", encoding="utf-8")
        (d / "transcript.vtt").write_text("WEBVTT\n\n<v S1>가", encoding="utf-8")
    before = (d1 / "transcript.json").read_text(encoding="utf-8")
    r = CliRunner().invoke(cli.app, ["render", "--all"])
    assert r.exit_code == 0 and json.loads(r.stdout) == {"rendered": 2}
    for d in (d1, d2):
        assert "**참석자 1**: 가" in (d / "transcript.md").read_text(encoding="utf-8")
        assert "<v 참석자 1>가" in (d / "transcript.vtt").read_text(encoding="utf-8")
    assert (d1 / "transcript.json").read_text(encoding="utf-8") == before  # transcript.json은 건드리지 않는다
    (d1 / "transcript.md").write_text("옛 문구", encoding="utf-8")
    (d2 / "transcript.md").write_text("옛 문구", encoding="utf-8")
    assert json.loads(CliRunner().invoke(cli.app, ["render", str(d1)]).stdout) == {"rendered": 1}
    assert "참석자 1" in (d1 / "transcript.md").read_text(encoding="utf-8") and (d2 / "transcript.md").read_text(encoding="utf-8") == "옛 문구"


def test_render_all_skips_unreadable_notes_and_needs_exactly_one_target(home):
    d1, _ = sugg_note(home, "a")
    bad = home / "meetings" / "broken"
    bad.mkdir()
    (bad / "transcript.json").write_text("{깨짐", encoding="utf-8")
    r = CliRunner().invoke(cli.app, ["render", "--all"])
    assert r.exit_code == 0 and json.loads(r.stdout) == {"rendered": 1} and "broken" in r.stderr
    assert CliRunner().invoke(cli.app, ["render"]).exit_code == 2
    assert CliRunner().invoke(cli.app, ["render", "x", "--all"]).exit_code == 2


# ── 영역을 가로지르는 경우: 교정 → 정렬 병합 → 되돌리기 ─────────────────────


def test_align_merge_after_edit_keeps_words_asr_so_revert_still_restores_the_original(home):
    d, t = make_note(home)
    orig = t["segments"][0]["words"]
    edit_transcript(d, lambda cur: apply_text_edits(cur, [{"id": "s0001", "text": "예산은 오억입니다"}]))
    cur = read(d)["segments"][0]
    precise = [{"text": w["text"], "start": w["start"], "end": w["end"]} for w in cur["words"]]  # 모델이 고친 문장을 정확히 맞춘 결과
    counts = cli._save_words(d, [{**cur, "words": precise}], {"s0001"})
    assert counts["aligned"] == 1 and counts["skipped"] == 0
    merged = read(d)["segments"][0]
    assert merged["words"] == precise and merged["words_asr"] == orig  # 병합이 words_asr를 건드리지 않는다
    edit_transcript(d, lambda c: apply_text_edits(c, [{"id": "s0001", "text": "예산은 사억입니다"}]))
    back = read(d)["segments"][0]
    assert back["words"] == orig and back["corrected_text"] is None and "words_asr" not in back


def test_align_merge_skips_a_segment_edited_while_aligning_and_leaves_its_words_alone(home):
    d, t = make_note(home)
    stale = {**t["segments"][0], "words": words("예산은 사억입니다", 2.0)}  # 정렬을 시작할 때의 문장으로 맞춘 결과
    edit_transcript(d, lambda cur: apply_text_edits(cur, [{"id": "s0001", "text": "예산은 오억입니다"}]))
    counts = cli._save_words(d, [stale], {"s0001"})
    seg = read(d)["segments"][0]
    assert counts["skipped"] == 1 and counts["aligned"] == 0
    assert [w["text"] for w in seg["words"]] == ["예산은", "오억입니다"] and seg["corrected_text"] == "예산은 오억입니다"


# ── 리뷰 지적 보강 ─────────────────────────────────────────────────────


def test_match_drops_suggestion_of_a_person_forgotten_while_matching(home, monkeypatch):
    register(home)
    d, _ = make_note(home, speakers={"S1": {"name": None}})
    monkeypatch.setattr(cli, "_meeting_pcm", lambda d, t: np.zeros(8 * SR, np.float32))

    class Forgetting(SameVoice):
        def embed(self, pcm):  # 계산하는 동안 다른 프로세스가 등록을 지웠다
            voices.save_profiles(home, {"version": 1, "model": voices.MODEL_ID, "people": []})
            return super().embed(pcm)

    monkeypatch.setattr(cli.voices, "load_embedder", lambda models: Forgetting())
    r = run_voices("match", str(d))
    assert r.exit_code == 0, r.output
    assert "suggested" not in read(d)["speakers"]["S1"] and "홍길동" not in json.dumps(read(d), ensure_ascii=False)


def test_forget_leaves_unrelated_notes_untouched(home):
    register(home)
    d, t = make_note(home, "old")
    old = read(d)
    old.pop("speakers")  # schema_version 1처럼 speakers가 없는 노트
    (d / "transcript.json").write_text(json.dumps(old, ensure_ascii=False), encoding="utf-8")
    before = (d / "transcript.json").read_bytes()
    assert store.forget_person(old, {PID}) is old
    r = run_voices("forget", "홍길동")
    assert json.loads(r.stdout) == {"forgotten": 1}
    assert (d / "transcript.json").read_bytes() == before and not (d / store.LOCK_FILE).exists()


def test_render_all_skips_a_note_with_missing_keys(home):
    sugg_note(home, "a")
    bad = home / "meetings" / "broken"
    bad.mkdir()
    (bad / "transcript.json").write_text(json.dumps({"meeting_id": "x", "segments": []}), encoding="utf-8")
    r = CliRunner().invoke(cli.app, ["render", "--all"])
    assert r.exit_code == 0 and json.loads(r.stdout) == {"rendered": 1} and "broken" in r.stderr


def test_profiles_lock_serialises_voices_json_writers_across_processes(home):
    code = (
        "import sys, time\nfrom pathlib import Path\nfrom tractus import voices\nh = Path(sys.argv[1])\n"
        "with voices.profiles_lock(h):\n    d = voices.load_profiles(h)\n    time.sleep(0.15)\n"
        "    d['people'].append({'id': sys.argv[2], 'name': sys.argv[2], 'samples': []})\n    voices.save_profiles(h, d)\n"
    )
    procs = [subprocess.Popen([sys.executable, "-c", code, str(home), f"P{i}"]) for i in range(5)]
    assert [p.wait(timeout=60) for p in procs] == [0] * 5
    assert sorted(p["id"] for p in voices.load_profiles(home)["people"]) == [f"P{i}" for i in range(5)]


def test_live_help_keeps_the_bracketed_timestamp_example():
    out = CliRunner().invoke(cli.app, ["live", "--help"], terminal_width=200).output
    assert "[mm:ss] 문장" in out
