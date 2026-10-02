"""로컬 임베딩: Qwen3-Embedding-0.6B (공식 가중치, Apache-2.0)를 mlx-lm(MIT)으로 실행한다.

mlx-embeddings는 GPL-3이라 쓰지 않는다. Phase 3 리서치 실측(M3):
- bf16, 오른쪽 패딩 + 인과 마스크 + 마지막(EOS) 토큰 풀링 + L2 정규화 → torch fp32 참조와 코사인 ≥ 0.9998
- 왼쪽 패딩은 마스크 없이 틀린 결과(코사인 0.63)를 내므로 쓰지 않는다
- 400자 한국어 기준 약 11 문단/초, 피크 메모리 1.4–1.8 GiB, 질의 1건 약 50ms
"""

import json
from pathlib import Path

import numpy as np

MODEL_REPO = "Qwen/Qwen3-Embedding-0.6B"
MODEL_REVISION = "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3"
DIM = 1024
BATCH_SIZE = 16
MAX_TOKENS = 1024  # 청크는 500자(약 330토큰) 이하
# 모델 카드 기본 지시문. 카드는 영어 지시문을 권장한다(한국어 질의에도 영어 지시문).
QUERY_TASK = "Given a web search query, retrieve relevant passages that answer the query"


MODEL_ID = f"{MODEL_REPO}@{MODEL_REVISION[:8]}/bf16/{DIM}/{QUERY_TASK[:20]}"  # 바뀌면 인덱스가 벡터를 다시 만든다


class Embedder:
    def __init__(self, model_dir: Path):
        import mlx.core as mx
        from mlx_lm.models.qwen3 import ModelArgs, Qwen3Model
        from transformers import AutoTokenizer

        self._mx = mx
        config = json.loads((model_dir / "config.json").read_text())
        model = Qwen3Model(ModelArgs.from_dict(config))
        # 공식 가중치 키에는 "model." 접두사가 없어 mlx_lm.load 대신 Qwen3Model에 직접 싣는다
        model.load_weights([(k, v.astype(mx.bfloat16)) for k, v in mx.load(str(model_dir / "model.safetensors")).items()])
        mx.eval(model.parameters())
        self.model = model
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
    path = models_dir / "qwen3-embedding-0.6b"
    if not (path / "model.safetensors").exists():
        return None
    return LazyEmbedder(path)
