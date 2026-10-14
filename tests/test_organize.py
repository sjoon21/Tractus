"""노트 정리(즐겨찾기·태그·폴더·정렬)와 `tractus note meta`·`folders`·`notes list`. 모델·네트워크 없이 도는 테스트 (docs/desktop.md §2.12)."""

import json
import threading
from datetime import datetime, timedelta, timezone

import anyio
import pytest
from mcp import Client
from typer.testing import CliRunner

from tractus import cli, notes, organize
from tractus.index import Index
from tractus.mcp_server import build_server
from tractus.store import edit_transcript, read_transcript, render_markdown, save_transcript

from test_edit_export import MID, _transcript
from test_index import FakeEmbedder

KST = timezone(timedelta(hours=9))
T0 = datetime(2026, 10, 1, 9, 0, tzinfo=KST)


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)  # 저장소의 .env.local(진짜 노트 위치)을 읽지 않게 한다
    monkeypatch.setenv("TRACTUS_HOME", str(tmp_path / "home"))
    return tmp_path / "home"


def run(*args, input=None):
    return CliRunner().invoke(cli.app, [*map(str, args)], input=input)


def last(r) -> str:
    return r.output.strip().splitlines()[-1]


def out(r) -> dict:
    assert r.exit_code == 0, r.output
    return json.loads(r.stdout.strip().splitlines()[-1])


def memo(home, title, body="본문", hours=0):
    d, t = notes.create_memo(home / "meetings", title, body, T0 + timedelta(hours=hours))
    return t["meeting_id"], d


def meta(ref, **patch):
    return run("note", "meta", ref, input=json.dumps(patch))


def folder(home, name, parent=None):
    r = run("folders", "create", "--name", name, *(["--parent", parent] if parent else []))
    return out(r)["folder"]["id"]


def recording(home):
    d = home / "meetings" / f"2026-10-02_주간회의_{MID}"
    d.mkdir(parents=True)
    save_transcript(d, _transcript())
    return d


# ── 태그 정리 ─────────────────────────────────────────────────────────


def test_clean_tags_trims_strips_hash_and_dedupes_case_insensitively_keeping_first_form():
    got = organize.clean_tags(["  #아이디어 ", "Idea", "idea", "IDEA", "", "#", "한\n줄", "é"])
    assert got == ["아이디어", "Idea", "한 줄", "é"]  # NFC로 합쳐 저장, 앞의 #·빈 태그는 버림


def test_tag_limits_and_bad_characters():
    assert organize.clean_tags(["가" * 30]) == ["가" * 30]
    with pytest.raises(ValueError, match="30자"):
        organize.clean_tags(["가" * 31])
    with pytest.raises(ValueError, match="쉼표"):
        organize.clean_tags(["a,b"])
    assert organize.clean_tags(["a\x00b\x07"]) == ["ab"]  # 제어 문자는 뺀다
    assert organize.clean_tags(["\u200b", "a\u200bb", "ab", "\ufeffq"]) == ["ab", "q"]  # 보이지 않는 글자는 빼서 눈에 같은 태그가 둘이 되지 않는다
    assert organize.clean_tags(["👩\u200d💻"]) == ["👩\u200d💻"]  # 이모지를 잇는 ZWJ는 남긴다
    assert len(organize.clean_tags([f"t{i}" for i in range(20)])) == 20
    with pytest.raises(ValueError, match="20개"):
        organize.clean_tags([f"t{i}" for i in range(21)])
    assert len(organize.clean_tags([f"t{i}" for i in range(19)] + ["T0", "t0"])) == 19  # 같은 태그는 개수에 한 번만
    with pytest.raises(ValueError):
        organize.clean_tags("not a list")


# ── note meta ────────────────────────────────────────────────────────


def test_meta_partial_updates_keep_other_keys_and_prints_stored_meta(home):
    mid, d = memo(home, "아이디어")
    assert out(meta(mid, favorite=True)) == {"favorite": True, "tags": [], "folder": None}
    assert out(meta(mid, tags=["#회의록", "Q3"])) == {"favorite": True, "tags": ["회의록", "Q3"], "folder": None}
    fid = folder(home, "업무")
    assert out(meta(mid, folder=fid)) == {"favorite": True, "tags": ["회의록", "Q3"], "folder": fid}
    t = read_transcript(d)
    assert (t["favorite"], t["tags"], t["folder"]) == (True, ["회의록", "Q3"], fid)
    assert out(meta(mid, favorite=False, folder=None, tags=[])) == {"favorite": False, "tags": [], "folder": None}
    assert not {"favorite", "tags", "folder"} & set(read_transcript(d))  # 기본값이면 키를 지운다 (옛 노트와 같은 모양)


@pytest.mark.parametrize(
    "patch",
    [{"favorite": "yes"}, {"tags": "a"}, {"tags": [1]}, {"folder": 3}, {"title": "x"}, {"tags": ["a,b"]}, {"tags": ["가" * 31]}, {"folder": "01NOSUCHFOLDER"}],
)
def test_meta_rejects_bad_input_with_exit_2_and_writes_nothing(home, patch):
    mid, d = memo(home, "노트")
    before = (d / "transcript.json").read_bytes()
    r = meta(mid, **patch)
    assert r.exit_code == 2
    assert (d / "transcript.json").read_bytes() == before


def test_meta_unknown_folder_message_and_not_json_input(home):
    mid, _ = memo(home, "노트")
    assert last(meta(mid, folder="01NOSUCH")) == organize.FOLDER_MISSING
    r = run("note", "meta", mid, input="not json")
    assert r.exit_code == 2 and "형식이어야 합니다" in last(r)
    assert run("note", "meta", "없는노트", input="{}").exit_code == 2


def test_meta_works_for_recordings_and_old_notes_open_unchanged(home):
    d = recording(home)
    before = read_transcript(d)
    assert not {"favorite", "tags", "folder", "updated_at"} & set(before)
    assert organize.meta_of(before) == {"favorite": False, "tags": [], "folder": None}
    assert out(meta(MID, tags=["녹음"], favorite=True))["tags"] == ["녹음"]
    after = read_transcript(d)
    assert {k: v for k, v in after.items() if k not in ("favorite", "tags")} == before


def test_meta_changes_do_not_bump_updated_at_but_content_edits_do(home):
    mid, d = memo(home, "노트")
    assert "updated_at" not in read_transcript(d)
    meta(mid, favorite=True, tags=["a"])
    assert "updated_at" not in read_transcript(d)
    assert run("note", "save", mid, input=json.dumps({"body": "새 본문"})).exit_code == 0
    first = read_transcript(d)["updated_at"]
    assert datetime.fromisoformat(first).tzinfo is not None
    meta(mid, tags=["b"])
    assert read_transcript(d)["updated_at"] == first
    assert run("note", "title", mid, input='{"title": "새 제목"}').exit_code == 0
    assert read_transcript(d)["title"] == "새 제목" and "updated_at" in read_transcript(d)


def test_meta_edit_that_changes_content_and_meta_together_bumps(home):
    mid, d = memo(home, "노트")
    edit_transcript(d, lambda t: ({**t, "title": "바뀜", "favorite": True}, None))
    assert "updated_at" in read_transcript(d)


def test_concurrent_meta_and_content_edits_do_not_lose_each_other(home):
    mid, d = memo(home, "노트", body="시작")
    errors = []

    def tagger(i):
        try:
            for k in range(5):
                organize.set_note_meta(home, d, {"tags": [f"t{i}"], "favorite": k % 2 == 0})
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    def writer():
        try:
            for k in range(5):
                edit_transcript(d, lambda t: (notes.apply_body(t, f"시작\n줄{k}")[0], None))
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=tagger, args=(i,)) for i in range(3)] + [threading.Thread(target=writer)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    t = read_transcript(d)
    assert not errors and t["body"] == "시작\n줄4" and t["tags"][0] in {"t0", "t1", "t2"} and len(t["tags"]) == 1
    json.loads((d / "transcript.json").read_text(encoding="utf-8"))  # 깨지지 않았다


# ── 폴더 ─────────────────────────────────────────────────────────────


def test_folder_create_rename_move_and_listing(home):
    a = folder(home, "업무")
    b = folder(home, "프로젝트", a)
    c = folder(home, "2026", b)
    listed = out(run("folders", "list", "--json"))["folders"]
    assert [(f["name"], f["parent"]) for f in listed] == [("업무", None), ("프로젝트", a), ("2026", b)]
    assert (home / "folders.json").is_file() and json.loads((home / "folders.json").read_text(encoding="utf-8"))["version"] == 1
    assert out(run("folders", "rename", c, "--name", "  2026년 "))["folder"]["name"] == "2026년"
    assert out(run("folders", "move", c, "--parent", "none"))["folder"]["parent"] is None
    assert out(run("folders", "move", c, "--parent", a))["folder"]["parent"] == a
    assert "업무" in run("folders", "list").output


def test_folder_name_rules(home):
    a = folder(home, "업무")
    for bad, msg in [("", organize.FOLDER_EMPTY), ("  \n ", organize.FOLDER_EMPTY), ("a/b", organize.FOLDER_SLASH), ("가" * 41, organize.FOLDER_LONG)]:
        r = run("folders", "create", "--name", bad)
        assert r.exit_code == 2 and last(r) == msg
    assert run("folders", "create", "--name", "가" * 40).exit_code == 0
    for reserved in ("none", " None ", "NONE", "n\u200bone"):  # 인수 none은 폴더 없음이라 이 이름의 폴더는 이름으로 고를 수 없다
        r = run("folders", "create", "--name", reserved)
        assert r.exit_code == 2 and last(r) == organize.FOLDER_RESERVED
    r = run("folders", "create", "--name", " 업무 ")
    assert r.exit_code == 2 and last(r) == organize.FOLDER_DUP  # 같은 위치에서 이름이 겹침
    r = run("folders", "create", "--name", "업무", "--parent", a)
    assert r.exit_code == 0  # 다른 위치라면 같은 이름도 된다
    assert run("folders", "create", "--name", "x", "--parent", "01NOSUCH").exit_code == 2
    assert run("folders", "rename", a, "--name", "업무").exit_code == 0  # 자기 이름으로 바꾸기는 겹침이 아니다
    nfd = chr(0x1100) + chr(0x1161)  # NFD '가'
    assert out(run("folders", "create", "--name", nfd))["folder"]["name"] == "가"
    assert run("folders", "create", "--name", "가").exit_code == 2  # NFC로 합쳐 비교


def test_folder_depth_limit_for_create_and_move_including_subtree(home):
    a = folder(home, "a")
    b = folder(home, "b", a)
    c = folder(home, "c", b)
    r = run("folders", "create", "--name", "d", "--parent", c)
    assert r.exit_code == 2 and last(r) == organize.FOLDER_DEPTH
    x = folder(home, "x")
    y = folder(home, "y", x)
    r = run("folders", "move", x, "--parent", c)  # x(2단계 가지)를 3단계 아래로
    assert r.exit_code == 2 and last(r) == organize.FOLDER_DEPTH
    assert run("folders", "move", y, "--parent", b).exit_code == 0  # 3단계 자리는 가능
    r = run("folders", "move", a, "--parent", c)
    assert r.exit_code == 2 and last(r) == organize.FOLDER_LOOP  # 자기 후손 안으로


def test_folder_move_name_collision_and_missing(home):
    a, b = folder(home, "a"), folder(home, "b")
    folder(home, "same", a)
    s = folder(home, "same", b)
    r = run("folders", "move", s, "--parent", a)
    assert r.exit_code == 2 and last(r) == organize.FOLDER_DUP
    assert run("folders", "move", "01NOSUCH", "--parent", a).exit_code == 2
    assert run("folders", "delete", "01NOSUCH").exit_code == 2


def test_delete_folder_moves_notes_and_child_folders_up_and_never_deletes_notes(home):
    a = folder(home, "업무")
    b = folder(home, "프로젝트", a)
    c = folder(home, "2026", b)
    in_b, db = memo(home, "B 노트")
    in_a, da = memo(home, "A 노트")
    meta(in_b, folder=b, tags=["x"], favorite=True)
    meta(in_a, folder=a)
    assert "folder: 프로젝트" in (db / "transcript.md").read_text(encoding="utf-8")
    r = out(run("folders", "delete", b))
    assert r == {"deleted": b, "moved_notes": 1, "moved_folders": 1}
    listed = {f["id"]: f for f in organize.load_folders(home)}
    assert set(listed) == {a, c} and listed[c]["parent"] == a
    t = read_transcript(db)
    assert t["folder"] == a and t["tags"] == ["x"] and t["favorite"] is True and "updated_at" not in t  # 노트는 상위로, 다른 정리 정보는 그대로
    assert "folder: 업무" in (db / "transcript.md").read_text(encoding="utf-8")  # md도 새 폴더 이름으로
    assert da.is_dir() and db.is_dir()
    out(run("folders", "delete", a))  # 최상위 폴더 삭제 → 노트는 폴더 없음, 하위는 최상위로
    assert "folder" not in read_transcript(db) and "folder" not in read_transcript(da)
    assert [f["parent"] for f in organize.load_folders(home)] == [None]
    assert "folder:" not in (db / "transcript.md").read_text(encoding="utf-8")


def test_delete_folder_renames_children_that_collide_with_the_new_siblings(home):
    a = folder(home, "a")
    folder(home, "문서")
    b = folder(home, "b", a)
    folder(home, "문서", b)
    folder(home, "문서 (2)", b)
    out(run("folders", "delete", a))
    out(run("folders", "delete", b))
    names = [f["name"] for f in organize.load_folders(home) if f["parent"] is None]
    assert sorted(names) == ["문서", "문서 (2)", "문서 (2) (2)"]  # 올라온 폴더는 최상위에서 이름이 겹치지 않게 번호가 붙는다


def test_rename_folder_rerenders_only_that_folders_notes(home):
    a = folder(home, "옛 이름")
    mid, d = memo(home, "노트")
    other, d2 = memo(home, "다른 노트")
    meta(mid, folder=a)
    assert "folder: 옛 이름" in (d / "transcript.md").read_text(encoding="utf-8")
    run("folders", "rename", a, "--name", "새 이름: 2026")
    md = (d / "transcript.md").read_text(encoding="utf-8")
    assert 'folder: "새 이름: 2026"' in md  # YAML 구분 문자가 있으면 따옴표로 감싼다
    assert "folder:" not in (d2 / "transcript.md").read_text(encoding="utf-8")


def test_malformed_folders_file_reads_as_empty_and_is_kept_aside_on_write(home):
    home.mkdir(parents=True)
    (home / "folders.json").write_text("{not json", encoding="utf-8")
    assert organize.load_folders(home) == []
    assert out(run("folders", "list", "--json")) == {"folders": []}
    folder(home, "새 폴더")
    assert (home / "folders.json.corrupt").read_text(encoding="utf-8") == "{not json"
    assert len(organize.load_folders(home)) == 1


def test_folders_file_is_read_leniently(home):
    home.mkdir(parents=True)
    raw = {"version": 1, "folders": [
        {"id": "A", "name": "정상", "parent": None, "order": 1, "created_at": "x"},
        {"id": "B", "name": "고아", "parent": "NOPE"},
        {"id": "C", "name": "고리1", "parent": "D"}, {"id": "D", "name": "고리2", "parent": "C"},
        {"id": "A", "name": "중복"}, {"name": "id 없음"}, "문자열", {"id": "E", "name": "  "},
    ]}
    (home / "folders.json").write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
    got = {f["id"]: f for f in organize.load_folders(home)}
    assert set(got) == {"A", "B", "C", "D"} and got["B"]["parent"] is None
    assert {got["C"]["parent"], got["D"]["parent"]} & {None}  # 고리는 끊긴다
    assert organize.load_folders(home / "없는곳") == []


def test_unknown_folder_id_on_a_note_reads_as_no_folder(home):
    mid, d = memo(home, "노트")
    edit_transcript(d, lambda t: ({**t, "folder": "01GONE"}, None))
    row = out(run("notes", "list", "--json"))["notes"][0]
    assert row["folder"] is None
    assert [r["meeting_id"] for r in out(run("notes", "list", "--json", "--folder", "none"))["notes"]] == [mid]


def test_concurrent_folder_creates_do_not_lose_each_other(home):
    errors = []

    def worker(i):
        try:
            organize.create_folder(home, f"폴더{i}")
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert not errors and len(organize.load_folders(home)) == 8


# ── 목록·정렬·필터 ───────────────────────────────────────────────────


def test_list_sorting_title_korean_casefold_nfc_and_ties(home):
    ids = {name: memo(home, name, hours=i)[0] for i, name in enumerate(["나비", "가방", "다람쥐", "banana", "Apple", "apple pie", "가나", "한"])}
    titles = lambda *a: [r["title"] for r in out(run("notes", "list", "--json", *a))["notes"]]  # noqa: E731
    assert titles("--sort", "title", "--order", "asc") == ["Apple", "apple pie", "banana", "가나", "가방", "나비", "다람쥐", "한"]
    assert titles("--sort", "title", "--order", "desc")[0] == "한"
    assert titles("--sort", "created", "--order", "asc")[0] == "나비" and titles("--sort", "created")[0] == "한"
    assert ids  # 모든 노트가 목록에 있다
    assert len(titles()) == 8


def test_list_sorts_by_updated_with_fallback_to_created_and_by_duration(home):
    old, d_old = memo(home, "옛 노트", hours=0)
    new, _ = memo(home, "새 노트", hours=5)
    rec = recording(home)  # 2026-10-02T14:00 (KST), 길이 3702초
    edit_transcript(d_old, lambda t: ({**t, "body": "수정", "updated_at": (T0 + timedelta(days=30)).isoformat()}, None))
    rows = out(run("notes", "list", "--json", "--sort", "updated"))["notes"]
    assert [r["meeting_id"] for r in rows] == [old, MID, new]  # old만 updated_at이 있다. 나머지는 created_at
    by = {r["meeting_id"]: r for r in rows}
    assert by[new]["updated_at"] == by[new]["created_at"] and by[MID]["kind"] == "recording" and by[new]["kind"] == "memo"
    assert [r["meeting_id"] for r in out(run("notes", "list", "--json", "--sort", "duration"))["notes"]][0] == MID
    assert rec.is_dir()


def test_list_falls_back_to_file_mtime_when_there_is_no_timestamp(home):
    mid, d = memo(home, "시각 없음")
    t = read_transcript(d)
    (d / "transcript.json").write_text(json.dumps({k: v for k, v in t.items() if k != "created_at"}), encoding="utf-8")
    row = out(run("notes", "list", "--json"))["notes"][0]
    assert row["created_at"] == "" and datetime.fromisoformat(row["updated_at"]).year >= 2026


def test_list_filters_favorite_tags_and_folder_with_subfolders(home):
    a = folder(home, "업무")
    b = folder(home, "프로젝트", a)
    n1, _ = memo(home, "하나", hours=1)
    n2, _ = memo(home, "둘", hours=2)
    n3, _ = memo(home, "셋", hours=3)
    meta(n1, favorite=True, tags=["회의", "Q3"], folder=a)
    meta(n2, tags=["q3"], folder=b)
    ids = lambda *a: sorted(r["meeting_id"] for r in out(run("notes", "list", "--json", *a))["notes"])  # noqa: E731
    assert ids("--favorite") == [n1]
    assert ids("--tag", "Q3") == sorted([n1, n2])  # 대소문자 구분 없음
    assert ids("--tag", "q3", "--tag", "#회의") == [n1]  # 여러 태그는 AND
    assert ids("--folder", a) == sorted([n1, n2])  # 하위 폴더 포함
    assert ids("--folder", b) == [n2] and ids("--folder", "프로젝트") == [n2]  # 이름으로도
    assert ids("--folder", "none") == [n3]
    assert ids("--folder", a, "--tag", "회의", "--favorite") == [n1]
    r = run("notes", "list", "--folder", "01NOSUCH")
    assert r.exit_code == 2 and last(r) == organize.FOLDER_MISSING
    assert run("notes", "list", "--sort", "bogus").exit_code == 2
    assert run("notes", "list", "--order", "up").exit_code == 2
    assert "★" in run("notes", "list").output  # 사람용 출력


def test_list_survives_broken_notes_and_missing_keys(home):
    memo(home, "정상")
    bad = home / "meetings" / "2026-10-01_깨짐_X"
    bad.mkdir(parents=True)
    (bad / "transcript.json").write_text("{", encoding="utf-8")
    odd = home / "meetings" / "2026-10-01_이상_Y"
    odd.mkdir()
    (odd / "transcript.json").write_text(json.dumps({"meeting_id": "Y", "title": None, "tags": "str", "favorite": "yes", "folder": 5, "audio": None, "segments": []}), encoding="utf-8")
    rows = out(run("notes", "list", "--json"))["notes"]
    assert sorted(r["title"] for r in rows) == ["", "정상"]
    y = next(r for r in rows if r["meeting_id"] == "Y")
    assert (y["favorite"], y["tags"], y["folder"], y["duration_sec"]) == (False, [], None, 0.0)


# ── 문서(frontmatter) ────────────────────────────────────────────────


def test_markdown_frontmatter_has_tags_favorite_and_folder_only_when_present():
    t = _transcript()
    assert "tags:" not in render_markdown(t) and "favorite:" not in render_markdown(t) and "folder:" not in render_markdown(t)
    md = render_markdown({**t, "tags": ["회의", "Q3 계획", "a: b", "#x"], "favorite": True}, None, "업무")
    head = md.split("---")[1]
    assert 'tags: [회의, Q3 계획, "a: b", "#x"]' in head and "favorite: true" in head and "folder: 업무" in head
    assert md.index("favorite: true") < md.index("\n---\n", 4)  # frontmatter 안이다
    memo_md = render_markdown({"schema_version": 2, "kind": "memo", "meeting_id": "m", "title": "t", "created_at": "c", "tags": ["x"], "segments": [], "audio": {}}, None, "f")
    assert "kind: memo\ntags: [x]\nfolder: f\n---" in memo_md


def test_frontmatter_values_that_yaml_reads_as_other_types_stay_strings():
    yaml = pytest.importorskip("yaml")
    odd = ["yes", "No", "null", "~", "2026", "2026-10-13", "0x1F", "1e3", "=", "<<", "3.14", "회의록", "Q3"]
    md = render_markdown({**_transcript(), "title": "테스트: 노트", "tags": odd}, None, "2026")
    fm = yaml.safe_load(md.split("---")[1])
    assert fm["tags"] == odd and fm["folder"] == "2026" and fm["title"] == "테스트: 노트"


def test_meta_updates_transcript_md_and_render_all_keeps_it(home):
    mid, d = memo(home, "노트")
    meta(mid, tags=["a", "b"], favorite=True)
    md = (d / "transcript.md").read_text(encoding="utf-8")
    assert "tags: [a, b]" in md and "favorite: true" in md
    assert out(run("render", "--all")) == {"rendered": 1}
    assert (d / "transcript.md").read_text(encoding="utf-8") == md


# ── 검색·MCP ─────────────────────────────────────────────────────────


def test_index_search_filters_by_meeting_ids_keyword_and_vector(home):
    n1, _ = memo(home, "하나", "분기 예산 검토")
    n2, _ = memo(home, "둘", "분기 예산 동결")
    idx = Index(home, embedder=FakeEmbedder())
    idx.sync()
    try:
        assert {h.meeting_id for h in idx.search("예산").hits} == {n1, n2}
        only = idx.search("예산", meeting_ids={n2})
        assert [h.meeting_id for h in only.hits] == [n2] and only.vector_used
        assert idx.search("예산", meeting_ids=set()).hits == []
    finally:
        idx.close()


def test_cli_search_filters(home):
    n1, _ = memo(home, "하나", "분기 예산 검토")
    n2, _ = memo(home, "둘", "분기 예산 동결")
    meta(n1, tags=["재무"])
    from tractus import organize_cli

    assert organize_cli.search_filter(["재무"], None, False) == {n1}
    assert organize_cli.search_filter(None, None, False) is None
    import typer

    with pytest.raises(typer.BadParameter):
        organize_cli.search_filter(None, "01NOSUCH", False)
    assert n2


def _call(server, tool, args=None):
    async def go():
        async with Client(server) as c:
            return await c.call_tool(tool, args or {})

    return anyio.run(go)


def test_mcp_list_and_search_carry_and_filter_by_organisation(home):
    n1, _ = memo(home, "하나", "분기 예산 검토")
    n2, _ = memo(home, "둘", "분기 예산 동결", hours=1)
    a = folder(home, "재무")
    b = folder(home, "예산", a)
    meta(n1, favorite=True, tags=["Q3"], folder=b)
    server = build_server(home, FakeEmbedder())

    listed = _call(server, "list_meetings").structured_content["meetings"]
    by = {m["meeting_id"]: m for m in listed}
    assert by[n1]["favorite"] and by[n1]["tags"] == ["Q3"] and by[n1]["folder"] == "예산" and by[n1]["folder_id"] == b
    assert by[n2]["favorite"] is False and by[n2]["tags"] == [] and by[n2]["folder"] is None

    ids = lambda r: sorted(m["meeting_id"] for m in r.structured_content["meetings"])  # noqa: E731
    assert ids(_call(server, "list_meetings", {"tag": "q3"})) == [n1]
    assert ids(_call(server, "list_meetings", {"folder": "재무"})) == [n1]  # 이름, 하위 폴더 포함
    assert ids(_call(server, "list_meetings", {"folder": "none"})) == [n2]
    assert ids(_call(server, "list_meetings", {"favorite": True})) == [n1]
    bad = _call(server, "list_meetings", {"folder": "없는폴더"})
    assert bad.is_error and organize.FOLDER_MISSING in bad.content[0].text

    hits = _call(server, "search_meetings", {"query": "예산"}).structured_content["hits"]
    assert {h["meeting_id"] for h in hits} == {n1, n2}
    only = _call(server, "search_meetings", {"query": "예산", "tag": "Q3"}).structured_content["hits"]
    assert {h["meeting_id"] for h in only} == {n1}
    only = _call(server, "search_meetings", {"query": "예산", "folder": "none"}).structured_content["hits"]
    assert {h["meeting_id"] for h in only} == {n2}
