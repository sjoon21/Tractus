"""Obsidian으로 보내기 (docs/design/obsidian-export.md). 가상 회의와 임시 볼트만 쓴다."""

import json
from pathlib import Path

from tractus.store import edit_transcript
from test_enhance import make_recording, reply as enhanced_reply
from test_templates import events, fake, home, make_note, out, run, reply as template_reply  # noqa: F401  (pytest fixture 재사용)


def vault_of(home: Path) -> Path:
    v = home.parent / "vault"
    (v / ".obsidian").mkdir(parents=True, exist_ok=True)
    return v


def send(mid: str, vault: Path, *extra: str) -> dict:
    return out(run("obsidian", mid, "--vault", vault, *extra))


def test_first_send_writes_one_markdown_with_frontmatter_and_folded_transcript(home):
    mid, d = make_recording(home)
    v = vault_of(home)
    r = send(mid, v)
    assert r["status"] == "created" and r["audio"] is None
    p = Path(r["path"])
    assert p.parent == v.resolve() / "Tractus" and p.name.endswith(".md") and p.name.startswith(json.loads((d / "transcript.json").read_text())["created_at"][:10])
    md = p.read_text(encoding="utf-8")
    assert md.startswith(f"---\ntractus_id: {mid}\n") and "duration: 00:07:00" in md
    assert "## 내 메모\n\n예산 다시 확인\n담당자 정하기" in md
    assert "> [!note]- 대화 내용\n> [00:00:00] 네 그럼 주간 개발 회의 시작하겠습니다." in md
    manifest = json.loads((v / "Tractus" / ".tractus.json").read_text(encoding="utf-8"))
    assert manifest["notes"][mid]["path"] == p.name


def test_resend_is_unchanged_then_follows_a_title_change(home):
    mid, _ = make_recording(home)
    v = vault_of(home)
    first = Path(send(mid, v)["path"])
    assert send(mid, v)["status"] == "unchanged"
    assert run("note", "title", mid, input='{"title": "새 제목"}').exit_code == 0
    r = send(mid, v)
    assert r["status"] == "updated" and Path(r["path"]).name.endswith("새 제목.md")
    assert not first.exists()  # 고치지 않은 옛 파일은 옮긴다
    assert [p.name for p in (v / "Tractus").glob("*.md")] == [Path(r["path"]).name]


def test_a_file_edited_in_obsidian_is_not_overwritten_without_force(home):
    mid, _ = make_recording(home)
    v = vault_of(home)
    p = Path(send(mid, v)["path"])
    p.write_text(p.read_text(encoding="utf-8") + "\n내가 Obsidian에서 적은 줄\n", encoding="utf-8")
    r = send(mid, v)
    assert r == {"status": "edited", "path": str(p), "audio": None}
    assert "내가 Obsidian에서 적은 줄" in p.read_text(encoding="utf-8")
    r = send(mid, v, "--force")
    assert r["status"] == "updated" and "내가 Obsidian에서 적은 줄" not in p.read_text(encoding="utf-8")
    assert send(mid, v)["status"] == "unchanged"  # 덮어쓴 뒤에는 다시 우리 파일이다


def test_a_file_moved_in_obsidian_is_found_by_its_id(home):
    mid, _ = make_recording(home)
    v = vault_of(home)
    p = Path(send(mid, v)["path"])
    moved = v / "Tractus" / "보관" / p.name
    moved.parent.mkdir()
    p.rename(moved)
    r = send(mid, v)
    assert r["status"] == "updated" and Path(r["path"]) == p  # 폴더 구조대로 되돌리고 옮긴 사본은 남기지 않는다
    assert not moved.exists()


def test_notes_go_under_their_tractus_folders(home):
    mid, _ = make_recording(home)
    top = out(run("folders", "create", "--name", "프로젝트"))["folder"]
    sub = out(run("folders", "create", "--name", "Atlas: 1차", "--parent", top["id"]))["folder"]
    assert run("note", "meta", mid, input=json.dumps({"folder": sub["id"]})).exit_code == 0
    p = Path(send(mid, vault_of(home))["path"])
    assert p.parent.relative_to(vault_of(home).resolve() / "Tractus").parts == ("프로젝트", "Atlas 1차")  # 파일 이름에 못 쓰는 :는 공백으로
    assert 'folder: "Atlas: 1차"' in p.read_text(encoding="utf-8")


def test_someone_elses_file_with_the_same_name_is_left_alone(home):
    mid, _ = make_recording(home)
    v = vault_of(home)
    p = Path(send(mid, v)["path"])
    p.unlink()
    p.write_text("내 노트\n", encoding="utf-8")  # 같은 이름, 다른 파일 (tractus_id 없음)
    (v / "Tractus" / ".tractus.json").unlink()
    r = send(mid, v)
    assert r["status"] == "created" and Path(r["path"]).name == p.name.replace(".md", " (2).md")
    assert p.read_text(encoding="utf-8") == "내 노트\n"


def test_enhanced_note_and_summary_go_in_with_checkboxes(home, fake):
    mid, _ = make_recording(home)
    fake.replies = [enhanced_reply(blocks=[{"source": "m0001", "heading": "", "items": [{"text": "p95 800ms", "segment_ids": ["s0002"], "owner": None, "due": None}]},
                                           {"source": "m0002", "heading": "", "items": []}]), template_reply()]
    assert run("summarize", mid, "--template", "enhanced").exit_code == 0
    assert run("summarize", mid, "--template", "brief").exit_code == 0
    md = Path(send(mid, vault_of(home), "--summary", "enhanced")["path"]).read_text(encoding="utf-8")
    assert "## 완성된 노트\n\n### 예산 다시 확인\n\n- p95 800ms [00:00:" in md
    assert "### 담당자 정하기\n\n- 대화에서 관련 내용을 찾지 못했습니다" in md
    assert "### 할 일\n\n- [ ] slow query 분석 공유 — 김민수, 수요일" in md
    assert "## 요약 · 핵심 요약\n\n" in md and "- [ ] 견적 정리 — 김철수, 금요일" in md
    assert "## 내 메모" not in md and "provider:" not in md


def test_audio_is_copied_only_when_asked(home):
    mid, d = make_recording(home)
    (d / "audio.opus").write_bytes(b"OggS" + b"0" * 100)
    v = vault_of(home)
    assert send(mid, v)["audio"] is None
    r = send(mid, v, "--audio")
    att = Path(r["audio"])
    assert att == v.resolve() / "Tractus" / "attachments" / f"{mid}.opus" and att.read_bytes() == (d / "audio.opus").read_bytes()
    assert f"![[{mid}.opus]]" in Path(r["path"]).read_text(encoding="utf-8")


def test_only_confirmed_names_are_participants(home):
    mid, d = make_recording(home)
    edit_transcript(d, lambda t: ({**t, "speakers": {"S1": {"name": "김민수"}, "S2": {"name": None, "suggested": "이지은"}}}, None))
    md = Path(send(mid, vault_of(home))["path"]).read_text(encoding="utf-8")
    assert "participants: [김민수]" in md and "이지은" not in md


def test_memo_note_body_is_the_note(home):
    mid, _ = make_note(home)
    md = Path(send(mid, vault_of(home))["path"]).read_text(encoding="utf-8")
    assert "kind" not in md and "duration" not in md and "대화 내용" not in md
    assert md.endswith("# 예산 메모\n\n예산은 동결합니다\n\n견적은 김철수 님이 금요일까지 정리합니다\n")


def test_vault_inside_the_data_folder_is_refused(home):
    mid, _ = make_recording(home)
    r = run("obsidian", mid, "--vault", home)
    assert r.exit_code == 2 and "데이터 폴더" in r.output
    assert not (home / "Tractus").exists()


def test_a_title_change_only_in_letter_case_keeps_the_file(home):
    # APFS는 대소문자를 가리지 않는다: 옛 경로와 새 경로가 같은 파일이면 쓰고 나서 지우면 안 된다
    mid, _ = make_recording(home)
    v = vault_of(home)
    assert run("note", "title", mid, input='{"title": "weekly sync"}').exit_code == 0
    send(mid, v)
    assert run("note", "title", mid, input='{"title": "Weekly Sync"}').exit_code == 0
    r = send(mid, v)
    assert r["status"] == "updated" and Path(r["path"]).is_file()
    assert "title: Weekly Sync" in Path(r["path"]).read_text(encoding="utf-8")


def test_another_note_now_at_the_recorded_path_is_not_taken_for_this_one(home):
    a, _ = make_recording(home)
    v = vault_of(home)
    pa = Path(send(a, v)["path"])
    pa.unlink()  # Obsidian에서 지운 뒤 같은 이름에 다른 파일이 들어왔다
    pa.write_text("---\ntractus_id: SOMEONEELSE\n---\n남의 노트\n", encoding="utf-8")
    r = send(a, v)
    assert r["status"] == "created" and Path(r["path"]) != pa
    assert pa.read_text(encoding="utf-8").endswith("남의 노트\n")
