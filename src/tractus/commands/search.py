"""검색 색인(index)과 검색(search) 명령."""

import time

from rich.markup import escape
import typer

from tractus import organize_cli
from tractus.commands import common
from tractus.i18n import t
from tractus.store import seg_text
from tractus.store import stamp

app = typer.Typer()  # 이 영역의 명령. cli.py가 이름 없이 붙여 한 층으로 합친다


@app.command()
def index(rebuild: bool = typer.Option(False, "--rebuild", help="색인 파일을 지우고 처음부터 다시 만든다")) -> None:
    """노트 폴더를 검색 색인(~/Tractus/.tractus/index.sqlite)에 반영한다. 바뀐 노트만 처리한다."""
    from tractus import embed

    t0 = time.perf_counter()
    with common.console.status(t("색인 중… (처음에는 임베딩 모델을 올리느라 몇 초 걸립니다)")):
        idx = common.open_index()
        try:
            r = idx.rebuild() if rebuild else idx.sync()  # rebuild는 파일을 지우지 않고 같은 DB를 비운다 (실행 중인 MCP 서버도 같은 DB를 봄)
            st = idx.stats()
            has_embedder = idx.embedder is not None
        finally:
            idx.close()
    common.console.print(
        t(
            "노트 {notes}개, 청크 {chunks}개, 벡터 {vectors}개 (추가 {added}, 갱신 {updated}, 삭제 {removed}, 임베딩 {embedded}, {sec}초)",
            notes=st["meetings"], chunks=st["chunks"], vectors=st["vectors"], added=r.added, updated=r.updated, removed=r.removed, embedded=r.embedded, sec=f"{time.perf_counter() - t0:.1f}",
        )
    )
    if not has_embedder and embed.mode() == "upstage":
        common.console.print(f"[yellow]{t('Upstage 임베딩을 쓸 수 없어 키워드 검색만 됩니다. UPSTAGE_API_KEY와 위의 건너뜀 줄을 확인하세요.')}[/yellow]")  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)
    elif not has_embedder:
        common.console.print(f"[yellow]{t('임베딩 모델이 없거나 올리지 못해 키워드 검색만 됩니다. `tractus models download embedding`으로 받으세요.')}[/yellow]")  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)
    elif st["pending"]:
        common.console.print(f"[yellow]{t('벡터가 없는 청크 {n}개가 남았습니다.', n=st['pending'])}[/yellow]")  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)
    for err in r.errors:
        common.console.print(f"[yellow]{t('건너뜀:')}[/yellow] {escape(err)}")


@app.command()
def search(
    query: str = typer.Argument(..., help="검색어"),
    limit: int = typer.Option(10, "--limit", "-n"),
    date_from: str = typer.Option(None, "--from", help="YYYY-MM-DD", callback=lambda v: common.iso_date(v, "--from")),
    date_to: str = typer.Option(None, "--to", help="YYYY-MM-DD", callback=lambda v: common.iso_date(v, "--to")),
    tag: list[str] = typer.Option(None, "--tag", help="이 태그가 붙은 노트에서만 (여러 번 주면 모두 붙은 노트)"),
    folder: str = typer.Option(None, "--folder", help="폴더 ID 또는 이름(하위 폴더 포함), none이면 폴더 없는 노트"),
    favorite: bool = typer.Option(False, "--favorite", help="즐겨찾기한 노트에서만"),
) -> None:
    """과거 노트를 하이브리드(키워드 + 의미) 검색한다."""
    only = organize_cli.search_filter(tag, folder, favorite)
    idx = common.open_index()
    try:
        idx.sync()
        res = idx.search(query, limit=limit, date_from=date_from, date_to=date_to, meeting_ids=only)
    finally:
        idx.close()
    if not res.hits:
        common.console.print(t("결과 없음"))
    for h in res.hits:
        print(f"{h.date} {h.title} ({'+'.join(h.matched)})")
        for s in h.segments:
            who = f" {s['speaker']}" if s.get("speaker") else ""
            print(f"  [{h.meeting_id[-6:]}#{s['id']} {stamp(s)}{who}] {seg_text(s)[:120]}")
