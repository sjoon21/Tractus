"""노트 정리 명령: `tractus note meta`, `tractus folders …`, `tractus notes list` (docs/desktop.md §2.12).
cli.py가 `register(app, note_app)` 한 번으로 붙인다. cli의 도우미는 부를 때 불러온다 (cli가 이 모듈을 불러오므로)."""

import json
import sys

import typer

from tractus import organize
from tractus.paths import home_dir

META_SHAPE = '{"favorite": true, "tags": ["…"], "folder": "<폴더 ID>"|null}'


def _cli():
    from tractus import cli

    return cli


def _fail(e: ValueError) -> None:
    _cli()._fail(str(e), exit_code=2)


def _out(data: dict) -> None:
    print(json.dumps(data, ensure_ascii=False))


def search_filter(tag: list[str] | None, folder: str | None, favorite: bool) -> set[str] | None:
    """`search`의 --tag·--folder·--favorite → 찾을 노트 ID 집합 (필터가 없으면 None). 없는 폴더·잘못된 태그는 인수 오류."""
    try:
        return organize.matching_ids(home_dir(), favorite, tag or (), folder)
    except ValueError as e:
        raise typer.BadParameter(str(e)) from e


def _folder_arg(ref: str | None) -> str | None:
    """--parent 인수: 폴더 ID·이름, 'none'이나 생략이면 최상위."""
    return None if ref is None else organize.resolve_folder(home_dir(), ref)


def register(app: typer.Typer, note_app: typer.Typer) -> None:
    folders_app = typer.Typer(help="노트 폴더($TRACTUS_HOME/folders.json). 3단계까지, 지워도 노트는 상위로 올라간다 (docs/desktop.md §2.12)")
    notes_app = typer.Typer(help="노트 목록 (즐겨찾기·태그·폴더 필터와 정렬)")
    app.add_typer(folders_app, name="folders")
    app.add_typer(notes_app, name="notes")

    @folders_app.callback()
    def folders_main() -> None:
        """폴더 보기·만들기·이름 바꾸기·옮기기·지우기."""

    @notes_app.callback()
    def notes_main() -> None:
        """노트 목록."""

    @note_app.command("meta")
    def note_meta(meeting: str = typer.Argument(..., help="노트 폴더 경로 또는 meeting_id (일부만 써도 됨)")) -> None:
        """stdin의 {"favorite"?: bool, "tags"?: [..], "folder"?: "<폴더 ID>"|null}로 노트(녹음·메모 모두)의 즐겨찾기·태그·폴더를 바꾼다. 준 키만 바뀐다.
        수정 시각(updated_at)은 올리지 않는다. stdout: 저장된 {"favorite", "tags", "folder"}. 잘못된 입력·없는 폴더·태그 한도 초과는 종료 코드 2 (아무것도 쓰지 않는다)."""
        d = _cli()._note_dir(meeting)
        try:
            req = _cli()._read_json_object(sys.stdin.read(), META_SHAPE)
            meta = organize.set_note_meta(home_dir(), d, req)
        except ValueError as e:
            _fail(e)
        _out(meta)

    @folders_app.command("list")
    def folders_list(as_json: bool = typer.Option(False, "--json", help="JSON으로 stdout에 출력 (데스크톱 앱용)")) -> None:
        """폴더 목록. --json: {"folders": [{id, name, parent, order, created_at}]}"""
        folders = organize.load_folders(home_dir())
        if as_json:
            return _out({"folders": folders})
        for f in folders:
            print(f"{'  ' * (organize.folder_depth(folders, f['id']) - 1)}{f['name']}\t{f['id']}")

    @folders_app.command("create")
    def folders_create(name: str = typer.Option(..., "--name", help="폴더 이름 (40자까지, / 불가)"), parent: str = typer.Option(None, "--parent", help="상위 폴더 ID 또는 이름 (생략하면 최상위)")) -> None:
        """폴더를 만든다. stdout: {"folder": {…}}. 3단계를 넘거나 같은 위치에 같은 이름이 있으면 종료 코드 2."""
        try:
            _out({"folder": organize.create_folder(home_dir(), name, _folder_arg(parent))})
        except ValueError as e:
            _fail(e)

    @folders_app.command("rename")
    def folders_rename(folder: str = typer.Argument(..., help="폴더 ID"), name: str = typer.Option(..., "--name")) -> None:
        """이름만 바꾼다 (그 폴더 노트의 transcript.md를 다시 만든다). stdout: {"folder": {…}}"""
        try:
            _out({"folder": organize.rename_folder(home_dir(), organize.resolve_folder(home_dir(), folder) or "", name)})
        except ValueError as e:
            _fail(e)

    @folders_app.command("move")
    def folders_move(folder: str = typer.Argument(..., help="폴더 ID"), parent: str = typer.Option(..., "--parent", help="새 상위 폴더 ID 또는 이름, none이면 최상위")) -> None:
        """폴더를 옮긴다 (새 위치의 맨 끝). stdout: {"folder": {…}}"""
        try:
            _out({"folder": organize.move_folder(home_dir(), organize.resolve_folder(home_dir(), folder) or "", _folder_arg(parent))})
        except ValueError as e:
            _fail(e)

    @folders_app.command("delete")
    def folders_delete(folder: str = typer.Argument(..., help="폴더 ID")) -> None:
        """폴더를 지운다. 노트는 상위 폴더(없으면 폴더 없음)로, 하위 폴더는 한 단계 위로 올라간다. stdout: {"deleted", "moved_notes", "moved_folders"}"""
        try:
            _out(organize.delete_folder(home_dir(), organize.resolve_folder(home_dir(), folder) or ""))
        except ValueError as e:
            _fail(e)

    @notes_app.command("list")
    def notes_list(
        as_json: bool = typer.Option(False, "--json", help="JSON으로 stdout에 출력"),
        favorite: bool = typer.Option(False, "--favorite", help="즐겨찾기만"),
        tag: list[str] = typer.Option(None, "--tag", help="이 태그가 붙은 노트만 (여러 번 주면 모두 붙은 노트)"),
        folder: str = typer.Option(None, "--folder", help="폴더 ID 또는 이름(하위 폴더 포함), none이면 폴더 없는 노트"),
        sort: str = typer.Option("updated", "--sort", help="created | updated | title | duration"),
        order: str = typer.Option("desc", "--order", help="asc | desc"),
    ) -> None:
        """노트 목록. --json: {"notes": [{meeting_id, title, kind, created_at, updated_at, duration_sec, favorite, tags, folder}]}"""
        try:
            rows = organize.list_notes(home_dir(), favorite, tag or (), folder, sort, order)
        except ValueError as e:
            _fail(e)
        if as_json:
            return _out({"notes": rows})
        for r in rows:
            print("\t".join([("★" if r["favorite"] else "-"), r["updated_at"][:16], r["kind"], r["title"], " ".join(f"#{x}" for x in r["tags"]), r["folder"] or "-"]))


__all__ = ["register", "search_filter"]
