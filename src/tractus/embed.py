"""로컬 임베딩: Qwen3-Embedding-0.6B의 MLX 8bit 변환본(mlx-community, Apache-2.0)을 mlx-lm(MIT)으로 실행한다.

mlx-embeddings는 GPL-3이라 쓰지 않는다 (이 변환본을 만들 때 쓰인 도구일 뿐, 실행에는 필요 없다).
2026-10-15에 bf16 공식 가중치(1.2GB)에서 8bit(0.63GB)로 바꿨다. 소유자 결정으로 검색 평가(bench/search_eval.py·aihub_search_eval.py)는 돌리지 않았다
(CLAUDE.md의 평가 규칙 면제, ARCHITECTURE.md 변경 이력). 아래 실측은 bf16 기준이다. Phase 3 리서치 실측(M3):
- bf16, 오른쪽 패딩 + 인과 마스크 + 마지막(EOS) 토큰 풀링 + L2 정규화 → torch fp32 참조와 코사인 ≥ 0.9998
- 왼쪽 패딩은 마스크 없이 틀린 결과(코사인 0.63)를 내므로 쓰지 않는다
- 400자 한국어 기준 약 11 문단/초, 피크 메모리 1.4–1.8 GiB, 질의 1건 약 50ms
"""

import logging
import os
from dataclasses import replace
from pathlib import Path

import numpy as np

log = logging.getLogger("tractus.embed")

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


# ── Upstage solar-embedding-2 (선택: TRACTUS_EMBED=upstage) ───────────────────
# 노트의 문장(색인할 때)과 검색어(검색할 때)가 Upstage로 간다. 키는 UPSTAGE_API_KEY, 주소는 UPSTAGE_BASE_URL(전역 TRACTUS_LLM_BASE_URL은 읽지 않는다:
# 다른 서비스를 가리키는 전역 값이 이 키를 엉뚱한 곳으로 보내지 않게). 2026-10-15 실측: 질의·문서 모델이 따로 있고 둘 다 1024차원(dimensions 인수 없음),
# 입력 하나 4000토큰·요청 하나 100개까지, 호출 0.1–0.2초.
UPSTAGE_MODEL_ID = "upstage/solar-embedding-2/1024"  # 로컬 모델과 다르다: 바꾸면 인덱스가 벡터를 다시 만든다
UPSTAGE_QUERY, UPSTAGE_PASSAGE = "solar-embedding-2-query", "solar-embedding-2-passage"
UPSTAGE_BATCH = 100
UPSTAGE_MAX_CHARS = 3500  # ponytail: 토큰 수는 세지 않고 글자 수로 자른다 (한국어는 글자당 1토큰 안팎이라 4000토큰 한도 안쪽). 청크는 원래 500자 이하
UPSTAGE_TIMEOUT_S = 60


def mode() -> str:
    """`upstage` | `local`. 오타는 로컬로 본다 (원격 전송은 정확히 upstage일 때만)."""
    return "upstage" if os.environ.get("TRACTUS_EMBED", "").strip().lower() == "upstage" else "local"


class UpstageEmbedder:
    """로컬 Embedder와 같은 모양: `.model_id`, `.dim`, `.embed(texts, is_query)`. 실패는 내용 없는 RuntimeError로 올린다
    (인덱스가 키워드 검색으로 물러난다). 429·5xx는 SDK가 지수 백오프로 다시 보낸다 (make_client)."""

    model_id = UPSTAGE_MODEL_ID
    dim = 1024

    def __init__(self, provider):
        self.provider = provider
        self._client = None

    def embed(self, texts: list[str], is_query: bool = False) -> np.ndarray:
        from tractus.llm import host_of, make_client

        self._client = self._client or make_client(self.provider, timeout=UPSTAGE_TIMEOUT_S)
        model = UPSTAGE_QUERY if is_query else UPSTAGE_PASSAGE
        out = np.empty((len(texts), self.dim), np.float32)
        for s in range(0, len(texts), UPSTAGE_BATCH):
            batch = [t[:UPSTAGE_MAX_CHARS] or " " for t in texts[s : s + UPSTAGE_BATCH]]
            try:
                data = sorted(self._client.embeddings.create(model=model, input=batch, encoding_format="float").data, key=lambda d: d.index)
            except Exception as e:  # noqa: BLE001 — 오류 본문에 노트 문장이 들어 있을 수 있어 상태 코드만 남긴다
                status = getattr(e, "status_code", None)
                raise RuntimeError(f"Upstage 임베딩 호출 실패 ({host_of(self.provider.base_url)} {f'HTTP {status}' if status else type(e).__name__})") from None  # words-ok: 코어 로그·건너뜀 줄 (앱은 코드 없는 줄을 자세히로 접는다)
            if len(data) != len(batch) or any(len(d.embedding) != self.dim for d in data):  # 섞인 차원의 벡터를 인덱스에 넣지 않는다
                raise RuntimeError(f"Upstage 임베딩 응답이 맞지 않습니다 (기대: {len(batch)}개 x {self.dim}차원)")  # words-ok: 코어 로그
            out[s : s + len(batch)] = np.asarray([d.embedding for d in data], np.float32)
        return out


def upstage_embedder() -> "UpstageEmbedder | None":
    """키가 없거나 주소가 잘못됐거나 로컬 전용 모드면 None (키워드 검색만, 이유는 stderr 로그)."""
    from tractus import llm

    provider = llm.PROVIDERS["upstage"]
    try:
        if base := os.environ.get("UPSTAGE_BASE_URL", "").strip():
            provider = replace(provider, base_url=llm.normalize_base_url(base, "UPSTAGE_BASE_URL"))
        if llm.local_only() and not llm.is_loopback(provider.base_url):
            raise llm.LLMError("로컬 전용 모드(TRACTUS_LOCAL_ONLY)에서는 Upstage를 쓸 수 없습니다")
    except llm.LLMError as e:
        log.warning("Upstage 검색을 쓰지 않습니다: %s", e)
        return None
    if not os.environ.get(provider.api_key_env or ""):
        log.warning("Upstage 검색을 쓰지 않습니다: %s가 없습니다", provider.api_key_env)
        return None
    return UpstageEmbedder(provider)


def load_embedder(models_dir: Path) -> "LazyEmbedder | UpstageEmbedder | None":
    """TRACTUS_EMBED=upstage면 Upstage, 아니면 로컬. 쓸 수 없으면 None (키워드 검색만 한다)."""
    if mode() == "upstage":
        return upstage_embedder()
    path = models_dir / MODEL_DIR
    if not (path / "model.safetensors").exists():
        return None
    return LazyEmbedder(path)
