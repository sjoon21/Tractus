"""AI Hub 회의 음성으로 하는 로컬 전용 검색 평가. 질의·정답은 사람이 쓴 정답 전사에서 LLM 없이 뽑고,
검색 대상은 Tractus가 만든 실제 ASR 전사다(오인식 포함).

!!! AI Hub 데이터는 반출 금지다. 이 스크립트는 지표만 출력하고 질의·전사 텍스트는 출력하지 않는다.
!!! 결과물(TRACTUS_HOME)은 저장소 밖에 두고, 에이전트 CLI나 원격 API가 읽는 경로에 두지 않는다.

    # 1) 세션 전사 (저장소 밖 홈으로)
    TRACTUS_HOME=/tmp/aihub-home uv run tractus transcribe data/aihub-meeting/원천데이터/…/DGBAH21000196.wav
    # 2) 평가
    uv run python bench/aihub_search_eval.py /tmp/aihub-home
"""

import os
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from aihub_queries import generate, load_sessions, load_transcripts  # noqa: E402
from search_eval import run_variant  # noqa: E402

from tractus.embed import load_embedder  # noqa: E402
from tractus.index import Index  # noqa: E402

LABELS = ROOT / "data" / "aihub-meeting" / "라벨링데이터"


def main():
    home = Path(sys.argv[1]).resolve()
    if ROOT in home.parents or home == ROOT:
        sys.exit("AI Hub 전사 홈을 저장소 안에 두지 마세요")
    sessions = load_sessions(LABELS)
    transcripts = load_transcripts(home / "meetings")
    queries = generate(sessions, transcripts)
    print(f"세션 {len(sessions)}개 중 전사 {len(set(sessions) & set(transcripts))}개, 질의 {len(queries)}개 "
          f"(term {sum(q['type'] == 'term' for q in queries)}, rare_word {sum(q['type'] == 'rare_word' for q in queries)}, "
          f"fragment {sum(q['type'] == 'fragment' for q in queries)})")

    work = Path(tempfile.mkdtemp())  # 원본 홈의 색인을 건드리지 않게 복사본에서 색인
    shutil.copytree(home / "meetings", work / "meetings", ignore=shutil.ignore_patterns("audio.opus"))
    # AI Hub 전사는 원격으로 보내지 않는다: TRACTUS_EMBED=upstage가 켜져 있어도 이 Mac의 임베딩 모델만 쓴다 (CLAUDE.md)
    os.environ["TRACTUS_EMBED"] = "local"
    idx = Index(work, embedder=load_embedder(ROOT / "models"))
    idx.sync()
    types = ["ALL", "term", "rare_word", "fragment"]
    print("| 방식 | " + " | ".join(f"{t} hit@1 / hit@5 / MRR" for t in types) + " |")
    print("| --- | " + " | ".join("---" for _ in types) + " |")
    for mode in ("keyword", "vector", "hybrid"):
        r = run_variant(idx, queries, mode)
        print(f"| {mode} | " + " | ".join(f"{r[t]['hit@1']:.2f} / {r[t]['hit@5']:.2f} / {r[t]['mrr@10']:.2f}" for t in types if t in r) + " |")
    idx.close()
    shutil.rmtree(work)


if __name__ == "__main__":
    main()
