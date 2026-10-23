"""대화 내용 다듬기 제안 (tractus.polish). AI 호출은 가짜다: 실제 AI는 bench/polish_eval.py."""

import json

import pytest

from tractus import polish
from tractus.polish import Edit, Polish, check, moves_edge, rewrites, windows


def seg(i: int, text: str, **kw) -> dict:
    return {"id": f"s{i:04d}", "start": i * 5.0, "end": i * 5.0 + 4, "text": text, "speaker": None, "corrected_text": None, "words": None, **kw}


def note(*texts: str, **seg_kw) -> dict:
    return {"meeting_id": "m1", "title": "온톨로지 회의", "segments": [seg(i + 1, x) for i, x in enumerate(texts)], "asr": {"hotwords": ["온톨로지"]}}


def fake(monkeypatch, *replies: list[dict]):
    """complete_json이 창마다 정해 둔 edits를 돌려주고, 받은 입력을 기록한다."""
    seen = []
    monkeypatch.setattr(polish, "PARALLEL", 1)  # 순서대로 (기록한 입력과 답을 짝짓는다)

    def complete_json(client, provider, model, system, user, schema, validate=None):
        out = Polish(edits=[Edit(**e) for e in replies[len(seen)]])
        seen.append(user)
        if validate:
            validate(out)
        return out

    monkeypatch.setattr(polish, "complete_json", complete_json)
    return seen


def test_suggest_keeps_real_fixes_and_flags_new_numbers(monkeypatch):
    t = note("원술로지 기반으로 자원을 묶어요", "사천 명에 더 안 하기로 했어요", "네 알겠습니다")
    seen = fake(monkeypatch, [{"id": "s0001", "text": "온톨로지 기반으로 자원을 묶어요", "kind": "term"},
                              {"id": "s0002", "text": "4.0에 더 안 하기로 했어요", "kind": "number"}])
    out = polish.suggest(None, None, "m", t)
    assert [(x["id"], x["text"], x["flags"]) for x in out] == [("s0001", "온톨로지 기반으로 자원을 묶어요", []), ("s0002", "4.0에 더 안 하기로 했어요", ["number"])]
    assert out[0]["before"] == "원술로지 기반으로 자원을 묶어요" and out[0]["start"] == 5.0
    assert "온톨로지" in seen[0] and "고칠 수 있는 문장: s0001–s0003" in seen[0]  # 자주 쓰는 단어와 범위를 함께 보낸다


def test_suggest_drops_unchanged_shortened_and_boundary_moves(monkeypatch):
    t = note("이 시장 노드를 찾아요", "그래서 이게 어떤 걸 할 수 있고 못하는지 봐야 해요", "되고 처리해야 됩니다. 아까 대시볼 번호 없는데", "쿠버 네티스 클러스터입니다",
             "오늘 안건은 온톨로지 기반 자원 묶기와 비용 정리 두 가지입니다", "네 알겠습니다")
    fake(monkeypatch, [{"id": "s0002", "text": "얘가 지금 뭔가 기능 구현 관점보다는. 그래서 이게 어떤 걸 할 수 있고 못하는지 봐야 해요", "kind": "word"},
                       {"id": "s0003", "text": "아까 대시보드 권한 없는데", "kind": "word"},
                       {"id": "s0004", "text": "쿠버네티스 클러스터입니다.", "kind": "term"},
                       {"id": "s0005", "text": "오늘 안건은 두 가지입니다.", "kind": "style"},
                       {"id": "s0006", "text": "네 알겠습니다", "kind": "style"},
                       {"id": "s0001", "text": "이 시작 노드를 찾아요.", "kind": "word"}])
    dropped: dict = {}
    out = polish.suggest(None, None, "m", t, dropped=dropped)
    assert [x["id"] for x in out] == ["s0001", "s0004"]  # 문장 순서로. 띄어쓰기·문장부호를 고친 제안은 남는다
    assert dropped == {"edge": 2, "short": 1, "same": 1}


def test_suggest_keeps_filler_removal_and_spacing_fixes_without_rewrite_flag(monkeypatch):
    t = note("어 그 저기 그래서 쿠버 네티스를 써요", "그 그 그러니까 할수있다고 그래서 쓰는거죠")
    fake(monkeypatch, [{"id": "s0001", "text": "그래서 쿠버네티스를 써요.", "kind": "term"},
                       {"id": "s0002", "text": "그러니까 할 수 있다고 그래서 쓰는 거죠.", "kind": "style"}])
    out = polish.suggest(None, None, "m", t)
    assert [(x["id"], x["kind"], x["flags"]) for x in out] == [("s0001", "term", []), ("s0002", "style", [])]


def test_user_corrected_segments_are_context_only(monkeypatch):
    t = note("원술로지", "인시덤 등록")
    t["segments"][1]["corrected_text"] = "인시던트 등록"
    seen = fake(monkeypatch, [{"id": "s0002", "text": "인시던트 등록함", "kind": "term"}])
    with pytest.raises(ValueError, match="s0002"):  # 사람이 고친 문장은 범위 밖이다 (재요청 대상)
        polish.suggest(None, None, "m", t)
    assert "사용자가 이미 고친 문장(고치지 않는다): s0002" in seen[0]


def test_check_rejects_unknown_duplicate_and_empty():
    ok = {"s0001", "s0002"}
    check(Polish(edits=[Edit(id="s0001", text="가", kind="word")]), ok)
    for edits in ([Edit(id="s0009", text="가", kind="word")], [Edit(id="s0001", text="가", kind="word")] * 2, [Edit(id="s0001", text="  ", kind="word")]):
        with pytest.raises(ValueError):
            check(Polish(edits=edits), ok)


def test_moves_edge_tells_fixes_from_boundary_moves():
    assert not moves_edge("I. W. S. 다.", "AWS다.")
    assert not moves_edge("일 개월분에 추가 시간.", "시계열 분해 추가 실험.")
    assert moves_edge("이게 어떤 걸 할 수 있고", "얘가 지금 뭔가 기능 구현 관점보다는. 이게 어떤 걸 할 수 있고")
    assert moves_edge("되고 처리해야 됩니다. 아까 대시볼 번호 없는데", "아까 대시보드 권한 없는데")
    assert not moves_edge("어 그 저기 그래서 이건", "그래서 이건")  # 군말만 지웠다
    assert not moves_edge("저희가 저희가 저희 팀이 할게요", "저희 팀이 할게요.")  # 되풀이만 지웠다


def test_long_notes_are_split_into_windows_with_context(monkeypatch):
    texts = [f"문장 {i} " + "가" * 100 for i in range(30)]
    assert windows(note(*texts)["segments"], limit=1000) == [(0, 7), (7, 14), (14, 21), (21, 28), (28, 30)]
    monkeypatch.setattr(polish, "WINDOW_CHARS", 1000)
    seen = fake(monkeypatch, *[[]] * 5)
    assert polish.suggest(None, None, "m", note(*texts)) == []
    assert "고칠 수 있는 문장: s0008–s0014 (앞뒤 문장은 문맥으로만 본다)" in seen[1] and "[s0001 " in seen[1] and "[s0030 " in seen[1]  # 녹취록 전체가 문맥


def test_very_long_notes_get_only_nearby_context(monkeypatch):
    texts = [f"문장 {i} " + "가" * 100 for i in range(30)]
    monkeypatch.setattr(polish, "WINDOW_CHARS", 1000)
    monkeypatch.setattr(polish, "FULL_CONTEXT_CHARS", 2000)
    monkeypatch.setattr(polish, "CONTEXT_SEGMENTS", 2)
    seen = fake(monkeypatch, *[[]] * 5)
    polish.suggest(None, None, "m", note(*texts))
    assert "[s0006 " in seen[1] and "[s0016 " in seen[1] and "[s0001 " not in seen[1] and "[s0017 " not in seen[1]


def test_write_saves_suggestions_beside_the_note(tmp_path):
    t = note("가")
    path = polish.write(tmp_path, t, [{"id": "s0001", "text": "나"}], "gemini", "m")
    data = json.loads(path.read_text(encoding="utf-8"))
    assert path.name == "polish.json" and data["meeting_id"] == "m1" and data["suggestions"] == [{"id": "s0001", "text": "나"}]


def test_rewrites_marks_multi_word_guesses():
    assert rewrites("김건지 너무 용롱만 초라는 코리를 짜야", "임계치 넘은 목록만 조회하는 쿼리를 짜야")
    assert not rewrites("로고를 보고 인계치를", "로그를 보고 임계치를")
    assert not rewrites("이건 할수있다고 봐요", "이건 할 수 있다고 봐요.")  # 띄어쓰기만


# ── CLI: tractus polish <노트> run|show|accept|reject ───────────────────

from typer.testing import CliRunner  # noqa: E402

from tractus import cli  # noqa: E402
from tractus.store import save_transcript  # noqa: E402

MID = "01K6X3POLISHMEETING0000000"


@pytest.fixture
def home_note(tmp_path, monkeypatch):
    home = tmp_path / "home"
    d = home / "meetings" / f"2026-10-02_온톨로지_{MID}"
    d.mkdir(parents=True)
    t = {"schema_version": 2, "meeting_id": MID, "title": "온톨로지 회의", "created_at": "2026-10-02T14:00:00+09:00",
         "audio": {"file": "audio.ogg", "duration_sec": 20.0, "source": "a.m4a", "sha256": "x"},
         "asr": {"model": "m", "track": "standard", "runtime": "mlx-audio", "language": "auto", "hotwords": []},
         "speakers": {}, "diarization": None,
         "segments": [seg(1, "원술로지 기반으로 묶어요"), seg(2, "인시덤 등록"), seg(3, "네 알겠습니다")]}
    save_transcript(d, t)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("TRACTUS_HOME", str(home))
    monkeypatch.setattr(cli, "_sync_index_quietly", lambda embed=True: None)
    return d


def invoke(*args, input=None):
    return CliRunner().invoke(cli.app, [*map(str, args)], input=input)


def run_with(monkeypatch, d, edits):
    monkeypatch.setattr(cli, "resolve_provider", lambda p, m: (type("P", (), {"name": "gemini"})(), "m"))
    monkeypatch.setattr(cli, "make_client", lambda p: None)
    fake(monkeypatch, edits)
    return invoke("polish", MID, "run", "--progress-json")


def test_run_streams_window_suggestions_and_saves(home_note, monkeypatch):
    r = run_with(monkeypatch, home_note, [{"id": "s0001", "text": "온톨로지 기반으로 묶어요", "kind": "term"},
                                          {"id": "s0002", "text": "인시던트 등록", "kind": "term"}])
    events = [json.loads(x) for x in r.stdout.splitlines() if x.startswith("{")]
    assert r.exit_code == 0, r.output
    prog = [e for e in events if e["event"] == "progress"]
    assert prog[0]["done"] == 1 and prog[0]["total"] == 1 and [s["id"] for s in prog[0]["suggestions"]] == ["s0001", "s0002"]
    assert prog[0]["range"] == ["s0001", "s0003"]
    assert events[-1] == {"event": "done", "meeting_id": MID, "meeting_dir": str(home_note), "suggestions": 2}
    shown = json.loads(invoke("polish", MID, "show").stdout)["suggestions"]
    assert [s["text"] for s in shown] == ["온톨로지 기반으로 묶어요", "인시던트 등록"]


def test_accept_marks_ai_edits_and_reject_clears(home_note, monkeypatch):
    run_with(monkeypatch, home_note, [{"id": "s0001", "text": "온톨로지 기반으로 묶어요", "kind": "term"},
                                      {"id": "s0002", "text": "인시던트 등록", "kind": "term"}])
    r = invoke("polish", MID, "accept", input='{"ids": ["s0001"]}')
    assert json.loads(r.stdout) == {"changed": 1, "remaining": 1}
    t = json.loads((home_note / "transcript.json").read_text(encoding="utf-8"))
    s1 = t["segments"][0]
    assert (s1["text"], s1["corrected_text"], s1["corrected_by"]) == ("원술로지 기반으로 묶어요", "온톨로지 기반으로 묶어요", "ai")
    assert json.loads(invoke("polish", MID, "reject", input='{"ids": ["s0002"]}').stdout) == {"remaining": 0}
    assert not (home_note / "polish.json").exists()
    # 사람이 다시 고치면 AI 표시가 지워진다
    invoke("segments", MID, "edit", input='{"edits": [{"id": "s0001", "text": "온톨로지로 묶어요"}]}')
    assert "corrected_by" not in json.loads((home_note / "transcript.json").read_text(encoding="utf-8"))["segments"][0]


def test_suggestion_goes_stale_when_the_line_is_edited(home_note, monkeypatch):
    run_with(monkeypatch, home_note, [{"id": "s0002", "text": "인시던트 등록", "kind": "term"}])
    invoke("segments", MID, "edit", input='{"edits": [{"id": "s0002", "text": "인시던트 등록함"}]}')
    assert json.loads(invoke("polish", MID, "show").stdout) == {"suggestions": []}
    r = invoke("polish", MID, "accept", input='{"ids": ["s0002"]}')
    assert json.loads(r.stdout) == {"changed": 0, "remaining": 0}  # 낡은 제안은 받지 않는다
    assert json.loads((home_note / "transcript.json").read_text(encoding="utf-8"))["segments"][1]["corrected_text"] == "인시던트 등록함"


def test_bad_input_is_rejected(home_note):
    r = invoke("polish", MID, "accept", input='{"ids": "s0001"}')
    assert r.exit_code == 2
