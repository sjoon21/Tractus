"""Upstage solar-embedding-2 임베딩 (TRACTUS_EMBED=upstage). 127.0.0.1의 가짜 임베딩 서버(stdlib)만 쓰고 키는 가짜다."""

import hashlib
import json
import os
import shutil
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import anyio
import numpy as np
import pytest
from mcp import Client, StdioServerParameters

from tractus import embed
from tractus.embed import UPSTAGE_MODEL_ID, UpstageEmbedder, load_embedder
from tractus.index import Index, to_index_text

from test_index import EVAL, FakeEmbedder

KEY = "test-key-123"
DIM = 1024


def vec(text: str) -> list[float]:
    v = np.zeros(DIM)
    for w in to_index_text(text).split():
        v[int(hashlib.md5(w.encode()).hexdigest(), 16) % DIM] += 1
    return (v / (np.linalg.norm(v) + 1e-9)).tolist()


class FakeEmbeddings:
    """POST /v1/embeddings. 받은 요청을 쌓고, `script`(앞에서부터 한 요청에 하나)나 `status`로 실패를 흉내 낸다. 응답은 일부러 index 거꾸로."""

    def __init__(self):
        self.requests: list[dict] = []
        self.script: list[int] = []
        self.status = 200
        self.dim = DIM
        self.echo_text_in_errors = True
        outer = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                req = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
                outer.requests.append({"path": self.path, "auth": self.headers.get("authorization"), "body": req})
                status = outer.script.pop(0) if outer.script else outer.status
                if status == 200:
                    inputs = req["input"]
                    body = {"object": "list", "model": req["model"], "usage": {"prompt_tokens": 1, "total_tokens": 1},
                            "data": [{"object": "embedding", "index": i, "embedding": (vec(t) + [0.0] * 8)[: outer.dim]} for i, t in reversed(list(enumerate(inputs)))]}
                else:
                    echo = " ".join(req["input"])[:100] if outer.echo_text_in_errors else ""
                    body = {"error": {"message": f"boom {echo} {KEY}", "type": "x"}}
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *a):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/v1"

    def models(self) -> list[str]:
        return [r["body"]["model"] for r in self.requests]


@pytest.fixture
def fake():
    f = FakeEmbeddings()
    yield f
    f.server.shutdown()
    f.server.server_close()


@pytest.fixture(autouse=True)
def env(monkeypatch, tmp_path, fake):
    for k in ("TRACTUS_EMBED", "TRACTUS_LOCAL_ONLY", "TRACTUS_LLM_BASE_URL", "TRACTUS_LLM_PROVIDER"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.chdir(tmp_path)  # 저장소의 .env.local(진짜 키)을 읽지 않게
    monkeypatch.setenv("TRACTUS_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("UPSTAGE_API_KEY", KEY)
    monkeypatch.setenv("UPSTAGE_BASE_URL", fake.url)
    monkeypatch.setenv("TRACTUS_EMBED", "upstage")
    monkeypatch.setattr("openai._base_client.INITIAL_RETRY_DELAY", 0.01)  # SDK의 지수 백오프를 줄여 시험을 빠르게 (재시도 횟수는 그대로)


@pytest.fixture
def home(tmp_path):
    shutil.copytree(EVAL / "meetings", tmp_path / "meetings")
    return tmp_path


def make() -> UpstageEmbedder:
    e = load_embedder(None)  # type: ignore[arg-type]  # upstage 모드는 모델 폴더를 보지 않는다
    assert isinstance(e, UpstageEmbedder)
    return e


# ── 임베더 ────────────────────────────────────────────────────────────


def test_batches_of_100_with_passage_and_query_models(fake):
    e = make()
    out = e.embed([f"문장 {i}" for i in range(250)])
    assert out.shape == (250, DIM) and out.dtype == np.float32
    assert [len(r["body"]["input"]) for r in fake.requests] == [100, 100, 50] and set(fake.models()) == {"solar-embedding-2-passage"}
    assert np.allclose(out[7], np.array(vec("문장 7"), np.float32), atol=1e-5)  # 서버가 순서를 뒤집어 줘도 입력 순서대로
    assert fake.requests[0]["auth"] == f"Bearer {KEY}" and fake.requests[0]["path"] == "/v1/embeddings"
    fake.requests.clear()
    e.embed(["검색어"], is_query=True)
    assert fake.models() == ["solar-embedding-2-query"]


def test_long_and_empty_inputs_are_trimmed_not_dropped(fake):
    out = make().embed(["가" * 9000, ""])
    sent = fake.requests[0]["body"]["input"]
    assert out.shape == (2, DIM) and len(sent[0]) == embed.UPSTAGE_MAX_CHARS and sent[1] == " "


def test_model_id_differs_from_local_and_dim_is_1024():
    e = make()
    assert e.model_id == UPSTAGE_MODEL_ID == "upstage/solar-embedding-2/1024" and e.dim == DIM and e.model_id != embed.MODEL_ID


def test_transient_5xx_and_429_are_retried_with_backoff(fake):
    fake.script = [503, 429]
    assert make().embed(["a b c"]).shape == (1, DIM)
    assert len(fake.requests) == 3


@pytest.mark.parametrize("status", [401, 400, 500])
def test_failures_raise_without_text_or_key(fake, status):
    fake.status = status
    fake.script = [status] * 10
    with pytest.raises(RuntimeError) as e:
        make().embed(["노트 속 비밀 문장입니다"])
    assert f"HTTP {status}" in str(e.value) and "비밀 문장" not in str(e.value) and KEY not in str(e.value) and "비밀" not in repr(e.value.__cause__)


def test_dim_mismatch_is_an_error_never_mixed_vectors(fake):
    fake.dim = 512  # 1024가 아닌 차원
    with pytest.raises(RuntimeError, match="맞지 않습니다"):
        make().embed(["a", "b"])


def test_connection_failure_is_a_plain_error(monkeypatch):
    monkeypatch.setenv("UPSTAGE_BASE_URL", "http://127.0.0.1:1/v1")
    with pytest.raises(RuntimeError, match="APIConnectionError"):
        make().embed(["a"])


# ── 선택 규칙 ─────────────────────────────────────────────────────────


def test_selection_rules(monkeypatch, fake, caplog):
    monkeypatch.setenv("TRACTUS_LLM_BASE_URL", "https://other.example.com/v1")  # 전역 주소는 읽지 않는다: Upstage 키가 다른 곳으로 가면 안 된다
    monkeypatch.setenv("TRACTUS_LLM_PROVIDER", "custom")
    assert make().provider.base_url == fake.url
    monkeypatch.delenv("UPSTAGE_BASE_URL")
    assert make().provider.base_url == "https://api.upstage.ai/v1"
    monkeypatch.delenv("UPSTAGE_API_KEY")
    assert load_embedder(None) is None and "UPSTAGE_API_KEY" in caplog.text  # type: ignore[arg-type]
    monkeypatch.setenv("UPSTAGE_API_KEY", KEY)
    monkeypatch.setenv("TRACTUS_LOCAL_ONLY", "1")
    assert load_embedder(None) is None and "로컬 전용" in caplog.text  # type: ignore[arg-type]
    monkeypatch.setenv("UPSTAGE_BASE_URL", "ftp://x")
    monkeypatch.delenv("TRACTUS_LOCAL_ONLY")
    assert load_embedder(None) is None  # type: ignore[arg-type]
    assert KEY not in caplog.text


@pytest.mark.parametrize("value", ["", "local", "LOCAL", "upstag", "1", "true"])
def test_anything_but_upstage_stays_local(monkeypatch, tmp_path, value):
    monkeypatch.setenv("TRACTUS_EMBED", value)
    assert embed.mode() == "local" and load_embedder(tmp_path) is None  # 모델 폴더가 비어 있다 → 키워드만, 원격 전송 없음


def test_env_value_is_case_and_space_insensitive(monkeypatch):
    monkeypatch.setenv("TRACTUS_EMBED", " Upstage ")
    assert embed.mode() == "upstage"


# ── 인덱스 연동 ───────────────────────────────────────────────────────


def test_index_stores_1024d_vectors_and_search_uses_the_query_model(home, fake):
    idx = Index(home, embedder=make())
    r = idx.sync()
    st = idx.stats()
    assert r.embedded == st["chunks"] > 0 and st["pending"] == 0 and st["embedding_model"] == UPSTAGE_MODEL_ID
    fake.requests.clear()
    res = idx.search("latency")
    assert res.vector_used and res.hits and fake.models() == ["solar-embedding-2-query"]
    idx.close()


def test_switching_models_rebuilds_vectors_both_ways(home, fake):
    local = FakeEmbedder()
    idx = Index(home, embedder=local)
    idx.sync()
    chunks = idx.stats()["chunks"]
    idx.close()
    fake.requests.clear()
    idx = Index(home, embedder=make())  # 로컬 → Upstage: 같은 1024차원이 아니어도(여기선 64) 표를 새로 만든다
    r = idx.sync()
    assert r.embedded == chunks and idx.stats()["embedding_model"] == UPSTAGE_MODEL_ID and sum(len(q["body"]["input"]) for q in fake.requests) == chunks
    assert idx.sync().embedded == 0  # 같은 모델이면 다시 만들지 않는다
    idx.close()
    local2 = FakeEmbedder()
    idx = Index(home, embedder=local2)  # Upstage → 로컬
    assert idx.sync().embedded == chunks and idx.stats()["embedding_model"] == local2.model_id
    idx.close()


def test_failure_keeps_vectors_pending_and_search_falls_back_to_keywords(home, fake, caplog):
    fake.status = 500
    fake.script = [500] * 30
    idx = Index(home, embedder=make())
    r = idx.sync()
    st = idx.stats()
    assert r.embedded == 0 and r.errors and st["vectors"] == 0 and st["pending"] == st["chunks"] > 0  # 색인 자체는 끝났다
    assert "비밀" not in caplog.text and KEY not in caplog.text and KEY not in "".join(r.errors) and "HTTP 500" in r.errors[0]
    res = idx.search("예산")
    assert res.hits and not res.vector_used  # 키워드로 찾힌다
    idx.close()
    # 서비스가 돌아오면 다음 동기화가 채운다
    fake.script.clear()
    fake.status = 200
    idx = Index(home, embedder=make())
    assert idx.sync().embedded == st["chunks"] and idx.stats()["pending"] == 0
    idx.close()


def test_a_failure_midway_keeps_the_finished_parts(home, monkeypatch):
    """조각마다 저장한다: 두 번째 조각에서 실패해도 첫 조각의 벡터는 남고, 다음 동기화는 나머지만 임베딩한다 (원격 서비스가 같은 글을 다시 받지 않게)."""
    import tractus.index as index_mod

    monkeypatch.setattr(index_mod, "EMBED_COMMIT_ROWS", 2)

    class Flaky(FakeEmbedder):
        def embed(self, texts, is_query=False):
            if self.calls == 1:
                self.calls += 1
                raise RuntimeError("HTTP 500")
            return super().embed(texts, is_query)

    idx = Index(home, embedder=Flaky())
    r = idx.sync()
    st = idx.stats()
    assert r.embedded == 2 and st["vectors"] == 2 and st["pending"] == st["chunks"] - 2 > 0 and r.errors
    idx.close()
    emb = FakeEmbedder()
    idx = Index(home, embedder=emb)
    assert idx.sync().embedded == st["chunks"] - 2 and idx.stats()["pending"] == 0
    idx.close()


def test_query_embedding_failure_falls_back_to_keywords(home, fake):
    idx = Index(home, embedder=make())
    idx.sync()
    fake.status = 401
    fake.script = [401] * 10
    res = idx.search("예산")
    assert res.hits and not res.vector_used
    idx.close()


def test_stdio_mcp_in_opt_in_mode_uses_the_key_only_for_upstage(home, fake, tmp_path):
    """앱이 UPSTAGE_API_KEY·TRACTUS_EMBED=upstage를 MCP 프로세스에 싣는 유일한 경우: 질의 임베딩이 Upstage의 질의 모델로 가고 stdout은 깨끗하다."""
    Index(home, embedder=make()).sync()
    fake.requests.clear()
    clean = {k: v for k, v in os.environ.items() if not k.endswith("_API_KEY")}  # 다른 서비스의 키는 없다
    env = {**clean, "TRACTUS_HOME": str(home), "TRACTUS_MODELS_DIR": str(tmp_path / "no-models"), "TRACTUS_EMBED": "upstage", "UPSTAGE_API_KEY": KEY, "UPSTAGE_BASE_URL": fake.url}
    params = StdioServerParameters(command=sys.executable, args=["-m", "tractus.mcp_server"], env=env, cwd=str(tmp_path))
    errors = []

    async def go():
        async with Client(params, message_handler=lambda m: errors.append(m) if isinstance(m, Exception) else None) as c:
            return await c.call_tool("search_meetings", {"query": "latency"}), await c.call_tool("status", {})

    search, status = anyio.run(go)
    assert not search.is_error and search.structured_content["vector_used"] and search.structured_content["hits"] and not errors
    assert fake.models() == ["solar-embedding-2-query"] and status.structured_content["vector_search"] is True


def test_mcp_status_hint_names_upstage_when_unusable(home, monkeypatch):
    from tractus.mcp_server import build_server

    monkeypatch.delenv("UPSTAGE_API_KEY")
    emb = load_embedder(None)  # type: ignore[arg-type]
    assert emb is None

    async def go():
        async with Client(build_server(home, emb)) as c:
            return await c.call_tool("status", {})

    hint = anyio.run(go).structured_content["hint"]
    assert "Upstage" in hint and "models download" not in hint
