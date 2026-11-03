"""tractus CLI: 앱을 만들고 명령 모듈(commands/)을 붙인다. 명령 자체는 여기 없다 (commands/__init__.py에 구조 설명)."""

import os
import warnings

os.environ.setdefault("TQDM_DISABLE", "1")
warnings.filterwarnings("ignore")

import typer  # noqa: E402

from tractus import models_cli, organize_cli  # noqa: E402
from tractus.commands import ai, exports, glossary, mcp, note, search, speakers, summary, transcribe, transcript, voiceprint  # noqa: E402
from tractus.env import load_env_all  # noqa: E402

app = typer.Typer(add_completion=False, help="Local-first 노트·녹음 도구")


@app.callback()
def main() -> None:
    """현재 폴더와 $TRACTUS_HOME의 .env / .env.local을 읽는다 (셸 환경변수가 우선)."""
    load_env_all()


# 영역마다 한 모듈. 모듈의 앱은 이름 없이 붙여 한 층으로 합친다 (그룹 이름은 모듈이 정한다).
app.add_typer(transcribe.app)  # transcribe · recording finish · live · align
app.add_typer(ai.app)  # summarize · ask · llm test|models
app.add_typer(search.app)  # index · search
app.add_typer(summary.app)  # templates · summaries · minutes
app.add_typer(note.app)  # note · marks
app.add_typer(transcript.app)  # render · segments · polish
app.add_typer(speakers.app)  # speakers
app.add_typer(voiceprint.app)  # voices
app.add_typer(glossary.app)  # glossary
app.add_typer(exports.app)  # export · obsidian
app.add_typer(mcp.app)  # mcp
models_cli.register(app)  # models list|download|remove, doctor (docs/desktop.md §2.15)
organize_cli.register(app, note.note_app)  # note meta, folders, notes list (docs/desktop.md §2.12)


if __name__ == "__main__":
    app()
