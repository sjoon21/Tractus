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


def test_suggest_drops_spacing_only_shortened_and_boundary_moves(monkeypatch):
    t = note("이 시장 노드를 찾아요", "그래서 이게 어떤 걸 할 수 있고 못하는지 봐야 해요", "되고 처리해야 됩니다. 아까 대시볼 번호 없는데", "쿠버 네티스 클러스터입니다")
    fake(monkeypatch, [{"id": "s0002", "text": "얘가 지금 뭔가 기능 구현 관점보다는. 그래서 이게 어떤 걸 할 수 있고 못하는지 봐야 해요", "kind": "word"},
                       {"id": "s0003", "text": "아까 대시보드 권한 없는데", "kind": "word"},
                       {"id": "s0004", "text": "쿠버네티스 클러스터입니다", "kind": "term"},
                       {"id": "s0001", "text": "이 시작 노드를 찾아요", "kind": "word"}])
    dropped: dict = {}
    out = polish.suggest(None, None, "m", t, dropped=dropped)
    assert [x["id"] for x in out] == ["s0001"]  # 문장 순서로
    assert dropped == {"edge": 1, "short": 1, "same": 1}


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


def test_long_notes_are_split_into_windows_with_context(monkeypatch):
    texts = [f"문장 {i} " + "가" * 100 for i in range(30)]
    assert windows(note(*texts)["segments"], limit=1000) == [(0, 7), (7, 14), (14, 21), (21, 28), (28, 30)]
    monkeypatch.setattr(polish, "WINDOW_CHARS", 1000)
    seen = fake(monkeypatch, *[[]] * 5)
    assert polish.suggest(None, None, "m", note(*texts)) == []
    assert "고칠 수 있는 문장: s0008–s0014 (앞뒤 문장은 문맥으로만 본다)" in seen[1] and "[s0001 " in seen[1]  # 앞 문장도 문맥으로


def test_write_saves_suggestions_beside_the_note(tmp_path):
    t = note("가")
    path = polish.write(tmp_path, t, [{"id": "s0001", "text": "나"}], "gemini", "m")
    data = json.loads(path.read_text(encoding="utf-8"))
    assert path.name == "polish.json" and data["meeting_id"] == "m1" and data["suggestions"] == [{"id": "s0001", "text": "나"}]


def test_rewrites_marks_multi_word_guesses():
    assert rewrites("김건지 너무 용롱만 초라는 코리를 짜야", "임계치 넘은 목록만 조회하는 쿼리를 짜야")
    assert not rewrites("로고를 보고 인계치를", "로그를 보고 임계치를")
