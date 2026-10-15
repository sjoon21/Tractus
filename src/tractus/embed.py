"""로컬 임베딩: Qwen3-Embedding-0.6B의 MLX 8bit 변환본(mlx-community, Apache-2.0)을 mlx-lm(MIT)으로 실행한다.

mlx-embeddings는 GPL-3이라 쓰지 않는다 (이 변환본을 만들 때 쓰인 도구일 뿐, 실행에는 필요 없다).
2026-10-15에 bf16 공식 가중치(1.2GB)에서 8bit(0.63GB)로 바꿨다. 소유자 결정으로 검색 평가(bench/search_eval.py·aihub_search_eval.py)는 돌리지 않았다
(CLAUDE.md의 평가 규칙 면제, ARCHITECTURE.md 변경 이력). 아래 실측은 bf16 기준이다. Phase 3 리서치 실측(M3):
- bf16, 오른쪽 패딩 + 인과 마스크 + 마지막(EOS) 토큰 풀링 + L2 정규화 → torch fp32 참조와 코사인 ≥ 0.9998
- 왼쪽 패딩은 마스크 없이 틀린 결과(코사인 0.63)를 내므로 쓰지 않는다
- 400자 한국어 기준 약 11 문단/초, 피크 메모리 1.4–1.8 GiB, 질의 1건 약 50ms
"""

from pathlib import Path

import numpy as np

MODEL_REPO = "mlx-community/Qwen3-Embedding-0.6B-8bit"
MODEL_REVISION = "407ad2329cd30702720aafe83f74a1ba30fdfbca"
MODEL_DIR = "qwen3-embedding-0.6b-8bit"
DIM = 1024
BATCH_SIZE = 16
MAX_TOKENS = 1024  # 청크는 500자(약 330토큰) 이하
# 모델 카드 기본 지시문. 카드는 영어 지시문을 권장한다(한국어 질의에도 영어 지시문).
QUERY_TASK = "Given a web search query, retrieve relevant passages that answer the query"


MODEL_ID = f"{MODEL_REPO}@{MODEL_REVISION[:8]}/8bit/{DIM}/{QUERY_TASK[:20]}"  # 바뀌면 인덱스가 벡터를 다시 만든다


class Embedder:
    def __init__(self, model_dir: Path):
        import mlx.core as mx
        from mlx_lm.utils import load_model
        from transformers import AutoTokenizer

        self._mx = mx
        model, _ = load_model(model_dir)  # config.json의 quantization(8bit, group 64)을 읽어 양자화 층으로 싣는다
        self.model = model.model  # 언어 모델 머리(lm_head) 없이 마지막 은닉 상태를 쓴다
        self.tok = AutoTokenizer.from_pretrained(str(model_dir))
        self.eos = self.tok.pad_token_id  # <|endoftext|>: 토크나이저가 끝에 붙이는 풀링 대상 토큰
        self.model_id = MODEL_ID
        self.dim = DIM

    def _ids(self, texts: list[str]) -> list[list[int]]:
        ids = self.tok(texts, truncation=True, max_length=MAX_TOKENS)["input_ids"]
        # 잘린 입력은 EOS가 빠질 수 있다. 마지막 토큰 풀링이 EOS를 보도록 보장한다.
        return [x if x and x[-1] == self.eos else x[: MAX_TOKENS - 1] + [self.eos] for x in ids]

    def embed(self, texts: list[str], is_query: bool = False) -> np.ndarray:
        mx = self._mx
        if is_query:
            texts = [f"Instruct: {QUERY_TASK}\nQuery:{t}" for t in texts]
        out = np.empty((len(texts), self.dim), np.float32)
        order = sorted(range(len(texts)), key=lambda i: len(texts[i]))  # 길이가 비슷한 것끼리 묶어 패딩을 줄인다
        for s in range(0, len(order), BATCH_SIZE):
            idx = order[s : s + BATCH_SIZE]
            ids = self._ids([texts[i] for i in idx])
            width = max(map(len, ids))
            hidden = self.model(mx.array([x + [self.eos] * (width - len(x)) for x in ids]))  # 오른쪽 패딩: 인과 마스크라 패딩이 앞 토큰에 영향 없음
            v = hidden[mx.arange(len(ids)), mx.array([len(x) - 1 for x in ids])].astype(mx.float32)
            out[idx] = np.array(v / mx.linalg.norm(v, axis=-1, keepdims=True))
        return out


class LazyEmbedder:
    """처음 embed()할 때 모델을 올린다(약 3초, 1.4GB). 바뀐 것이 없는 동기화나 키워드만 쓰는 경우 비용이 없다."""

    model_id = MODEL_ID
    dim = DIM

    def __init__(self, model_dir: Path):
        self.model_dir = model_dir
        self._impl: Embedder | None = None

    def embed(self, texts: list[str], is_query: bool = False) -> np.ndarray:
        if self._impl is None:
            import contextlib
            import sys

            with contextlib.redirect_stdout(sys.stderr):  # MCP stdio에서 stdout은 JSON-RPC 전용
                self._impl = Embedder(self.model_dir)
        return self._impl.embed(texts, is_query)


def load_embedder(models_dir: Path) -> "LazyEmbedder | None":
    """모델 파일이 없으면 None (키워드 검색만 한다)."""
    path = models_dir / MODEL_DIR
    if not (path / "model.safetensors").exists():
        return None
    return LazyEmbedder(path)
