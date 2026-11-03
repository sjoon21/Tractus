"""MCP 서버(mcp) 명령: Claude Code 같은 에이전트가 노트를 읽게 한다."""

import typer

app = typer.Typer()  # 이 영역의 명령. cli.py가 이름 없이 붙여 한 층으로 합친다


@app.command()
def mcp() -> None:
    """MCP 서버(stdio)를 실행한다. Claude Code·Codex·agy에 등록해서 쓴다 (README 'MCP 연동')."""
    from tractus.mcp_server import main as serve

    serve()
