"""사용자 지정 주소·직접 입력·Claude 온도·오류 매핑·`tractus llm test` (docs/llm-providers.md).
네트워크는 127.0.0.1의 가짜 OpenAI 호환 서버(stdlib)만 쓴다. 키는 가짜(`test-key-123`)다."""

import json
import shutil
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from pydantic import BaseModel, ConfigDict
from typer.testing import CliRunner

from tractus import cli, llm
from tractus.llm import PROVIDERS, LLMError, check_connection, complete_json, make_client, resolve_provider, stream_chat

KEY = "test-key-123"
FIXTURE = Path(__file__).parent / "fixtures" / "sample_meeting.json"
OK = {"id": "x", "object": "chat.completion", "created": 0, "model": "m", "choices": [{"index": 0, "message": {"role": "assistant", "content": "OK"}, "finish_reason": "stop"}]}
JSON_OK = {**OK, "choices": [{"index": 0, "message": {"role": "assistant", "content": '{"items": ["a"]}'}, "finish_reason": "stop"}]}


class Fake:
    """다음 응답을 정해 두고, 받은 요청(경로·헤더·본문)을 쌓는다."""

    def __init__(self):
        self.requests: list[dict] = []
        self.status, self.body, self.delay = 200, OK, 0.0
        self.script: list[tuple[int, dict]] = []  # 앞에서부터 한 요청에 하나씩 (status, body). 비면 status·body
        self.model_ids = ["models/gemini-a", "gemini-b", "models/gemini-a"]
        outer = self

        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                outer.requests.append({"path": self.path, "auth": self.headers.get("authorization"), "body": None})
                status, body = outer.script.pop(0) if outer.script else (outer.status, {"object": "list", "data": [{"id": i, "object": "model"} for i in outer.model_ids]} if outer.status == 200 else outer.body)
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                n = int(self.headers.get("content-length") or 0)
                req = json.loads(self.rfile.read(n) or b"{}")
                outer.requests.append({"path": self.path, "auth": self.headers.get("authorization"), "body": req})
                time.sleep(outer.delay)
                status, body = outer.script.pop(0) if outer.script else (outer.status, outer.body)
                if status == 200 and req.get("stream"):
                    chunk = {"id": "x", "object": "chat.completion.chunk", "created": 0, "model": "m", "choices": [{"index": 0, "delta": {"content": "안녕"}, "finish_reason": None}]}
                    data = f"data: {json.dumps(chunk)}\n\ndata: [DONE]\n\n".encode()
                    self.send_response(200)
                    self.send_header("content-type", "text/event-stream")
                else:
                    data = json.dumps(body).encode()
                    self.send_response(status)
                    self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                try:
                    self.wfile.write(data)
                except OSError:  # 시간 초과로 클라이언트가 먼저 끊었다
                    pass

            def log_message(self, *a):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/v1"

    def fail(self, status: int, message: str = "nope", **extra):
        self.status, self.body = status, {"error": {"message": message, "type": "x", **extra}}


@pytest.fixture
def fake():
    f = Fake()
    yield f
    f.server.shutdown()
    f.server.server_close()


@pytest.fixture(autouse=True)
def clean_env(monkeypatch, tmp_path):
    for k in ("TRACTUS_LLM_PROVIDER", "TRACTUS_LLM_MODEL", "TRACTUS_LLM_BASE_URL", "TRACTUS_LOCAL_ONLY", "TRACTUS_LLM_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "UPSTAGE_API_KEY",
              "UPSTAGE_BASE_URL", "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL", "GEMINI_BASE_URL", "UPSTAGE_MODEL", "OPENAI_MODEL", "ANTHROPIC_MODEL", "GEMINI_MODEL", "TRACTUS_EMBED"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.chdir(tmp_path)  # 저장소 루트의 .env / .env.local(진짜 키)을 읽지 않게 한다
    monkeypatch.setenv("TRACTUS_HOME", str(tmp_path / "home"))


class Out(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[str]


# ── 주소 덮어쓰기·직접 입력 ──────────────────────────────────────────────


def test_base_url_env_replaces_provider_default_and_sends_key(fake, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", KEY)
    monkeypatch.setenv("TRACTUS_LLM_BASE_URL", fake.url + "/")  # 끝의 /는 정리된다
    p, m = resolve_provider("openai", "gpt-x")
    assert p.base_url == fake.url and PROVIDERS["openai"].base_url == "https://api.openai.com/v1"  # 표는 그대로
    r = check_connection(p, m)
    assert r["ok"] and r["host"] == f"127.0.0.1:{fake.server.server_port}" and r["model"] == "gpt-x"
    assert fake.requests[0]["path"] == "/v1/chat/completions" and fake.requests[0]["auth"] == f"Bearer {KEY}"


@pytest.mark.parametrize("bad", ["ftp://x.com/v1", "api.openai.com/v1", "http://", "https://:443", "http://a b/v1", "https://u:p@x.com/v1", "http://localhost@evil.com/v1", "http://x.com:99999/v1", "http://evil.com\\@localhost/"])
def test_bad_base_urls_are_rejected_without_echoing_them(monkeypatch, bad):
    monkeypatch.setenv("OPENAI_API_KEY", KEY)
    monkeypatch.setenv("TRACTUS_LLM_BASE_URL", bad)
    with pytest.raises(LLMError) as e:
        resolve_provider("openai", "m")
    assert e.value.code == "llm_config" and not any(x in str(e.value) for x in ("u:p", "evil.com", "x.com", "99999"))


def test_custom_needs_base_url_and_model(monkeypatch):
    monkeypatch.setenv("TRACTUS_LLM_API_KEY", KEY)
    with pytest.raises(LLMError, match="TRACTUS_LLM_BASE_URL"):
        resolve_provider("custom", "m")
    monkeypatch.setenv("TRACTUS_LLM_BASE_URL", "https://gw.example.com/v1")
    with pytest.raises(LLMError, match="AI 모델"):
        resolve_provider("custom", None)
    p, m = resolve_provider("custom", "any-model")
    assert (p.name, p.json_schema, m) == ("custom", False, "any-model")


def test_custom_empty_key_only_for_loopback(monkeypatch):
    monkeypatch.setenv("TRACTUS_LLM_BASE_URL", "http://localhost:11434/v1")
    assert resolve_provider("custom", "llama")[0].base_url == "http://localhost:11434/v1"  # Ollama: 키 없이
    monkeypatch.setenv("TRACTUS_LLM_BASE_URL", "https://gw.example.com/v1")
    with pytest.raises(LLMError, match="TRACTUS_LLM_API_KEY"):
        resolve_provider("custom", "m")
    monkeypatch.setenv("OPENAI_API_KEY", KEY)  # 다른 서비스의 키는 대신하지 못한다
    with pytest.raises(LLMError, match="TRACTUS_LLM_API_KEY"):
        resolve_provider("custom", "m")
    monkeypatch.setenv("TRACTUS_LLM_API_KEY", KEY)
    assert resolve_provider("custom", "m")[0].base_url == "https://gw.example.com/v1"
    # 다른 서비스는 loopback이어도 키가 필요하다
    monkeypatch.setenv("TRACTUS_LLM_BASE_URL", "http://localhost:1/v1")
    monkeypatch.delenv("OPENAI_API_KEY")
    with pytest.raises(LLMError, match="OPENAI_API_KEY"):
        resolve_provider("openai", "m")


def test_empty_key_client_uses_placeholder(monkeypatch):
    p = llm.replace(PROVIDERS["custom"], base_url="http://localhost:1/v1")
    assert make_client(p).api_key == "local"


# ── 온도 ──────────────────────────────────────────────────────────────


def test_claude_and_openai_omit_temperature_others_send_0_2(fake, monkeypatch):
    for name, key_env in (("claude", "ANTHROPIC_API_KEY"), ("upstage", "UPSTAGE_API_KEY"), ("gemini", "GEMINI_API_KEY"), ("openai", "OPENAI_API_KEY")):
        monkeypatch.setenv(key_env, KEY)
    monkeypatch.setenv("TRACTUS_LLM_BASE_URL", fake.url)
    fake.body = JSON_OK
    seen = {}
    for name in ("claude", "upstage", "gemini", "openai"):
        p, m = resolve_provider(name, "m")
        n = len(fake.requests)
        complete_json(make_client(p), p, m, "s", "u", Out)
        list(stream_chat(make_client(p), p, m, [{"role": "user", "content": "q"}]))
        seen[name] = [r["body"] for r in fake.requests[n:]]
    for name in ("claude", "openai"):  # openai: gpt-5·o 계열은 기본값이 아닌 온도를 거절한다
        assert all("temperature" not in b for b in seen[name]) and len(seen[name]) == 2
    for name in ("upstage", "gemini"):
        assert [b["temperature"] for b in seen[name]] == [0.2, 0.2]
    assert "response_format" not in seen["claude"][0] and "response_format" in seen["upstage"][0]  # 엄격 JSON은 표대로


def test_connection_test_request_is_tiny_and_respects_temperature(fake, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", KEY)
    monkeypatch.setenv("TRACTUS_LLM_BASE_URL", fake.url)
    p, m = resolve_provider("claude", None)
    assert m == "claude-sonnet-5-5"
    check_connection(p, m)
    body = fake.requests[0]["body"]
    assert "temperature" not in body and body["max_tokens"] == 256 and len(body["messages"]) == 1  # 너무 작으면 생각하는 AI가 답을 못 낸다


# ── 로컬 전용: 이름이 아니라 호스트 ─────────────────────────────────────


@pytest.mark.parametrize("url", ["http://localhost:11434/v1", "http://127.0.0.1:8080/v1", "http://[::1]:11434/v1", "http://LOCALHOST/v1"])
def test_local_only_allows_loopback_hosts_for_any_provider(monkeypatch, url):
    monkeypatch.setenv("TRACTUS_LOCAL_ONLY", "1")
    monkeypatch.setenv("TRACTUS_LLM_BASE_URL", url)
    assert resolve_provider("custom", "m")[0].name == "custom"  # 키 없이도


@pytest.mark.parametrize(
    "url",
    ["https://api.openai.com/v1", "http://localhost.evil.com/v1", "http://127.0.0.1.evil.com/v1", "http://evil.com/localhost", "http://evil.com/?h=localhost", "http://evil.com#@localhost", "http://localhost@evil.com/v1", "http://evil.com@localhost/v1", "http://localhost.:11434/v1", "http://0.0.0.0:1/v1", "http://[::2]/v1"],
)
def test_local_only_blocks_everything_else_including_tricky_hosts(monkeypatch, url):
    monkeypatch.setenv("TRACTUS_LOCAL_ONLY", "1")
    monkeypatch.setenv("TRACTUS_LLM_BASE_URL", url)
    monkeypatch.setenv("TRACTUS_LLM_API_KEY", KEY)
    with pytest.raises(LLMError) as e:
        resolve_provider("custom", "m")
    assert e.value.code in ("llm_local_only", "llm_config")


def test_local_only_blocks_remote_custom_and_default_remote_hosts(monkeypatch):
    monkeypatch.setenv("TRACTUS_LOCAL_ONLY", "1")
    monkeypatch.setenv("TRACTUS_LLM_BASE_URL", "https://gw.example.com/v1")
    monkeypatch.setenv("TRACTUS_LLM_API_KEY", KEY)
    with pytest.raises(LLMError) as e:
        resolve_provider("custom", "m")
    assert e.value.code == "llm_local_only"
    monkeypatch.delenv("TRACTUS_LLM_BASE_URL")
    monkeypatch.setenv("ANTHROPIC_API_KEY", KEY)
    with pytest.raises(LLMError) as e:
        resolve_provider("claude", None)
    assert e.value.code == "llm_local_only"
    assert resolve_provider("gemma-local", None)[0].local


# ── 오류 매핑 ─────────────────────────────────────────────────────────


def _check(fake, monkeypatch, provider="custom"):
    monkeypatch.setenv("TRACTUS_LLM_API_KEY", KEY)
    monkeypatch.setenv("TRACTUS_LLM_BASE_URL", fake.url)
    p, m = resolve_provider(provider, "m")
    return check_connection(p, m)


@pytest.mark.parametrize(
    "status, extra, code",
    [(401, {}, "llm_auth"), (403, {}, "llm_auth"), (404, {}, "llm_model"), (429, {}, "llm_rate"), (500, {}, "llm_api"), (503, {}, "llm_busy"), (529, {}, "llm_busy"),
     (400, {"code": "model_not_found"}, "llm_model"), (400, {"code": "context_length_exceeded"}, "llm_context"), (400, {}, "llm_api")],
)
def test_http_errors_map_to_codes_without_leaking_the_key(fake, monkeypatch, status, extra, code):
    fake.fail(status, f"bad key {KEY} given", **extra)
    with pytest.raises(LLMError) as e:
        _check(fake, monkeypatch)
    assert e.value.code == code and KEY not in str(e.value) and f"HTTP {status}" in str(e.value)
    assert "127.0.0.1" in str(e.value) and "/v1" not in str(e.value)  # 호스트만, 경로 없음


def test_context_length_by_message_text(fake, monkeypatch):
    fake.fail(400, "This model's maximum context length is 8192 tokens")
    with pytest.raises(LLMError) as e:
        _check(fake, monkeypatch)
    assert e.value.code == "llm_context"


def test_connection_refused_and_timeout_map_to_llm_conn(fake, monkeypatch):
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    monkeypatch.setenv("TRACTUS_LLM_API_KEY", KEY)
    monkeypatch.setenv("TRACTUS_LLM_BASE_URL", f"http://127.0.0.1:{port}/v1")
    p, m = resolve_provider("custom", "m")
    with pytest.raises(LLMError) as e:
        check_connection(p, m)
    assert e.value.code == "llm_conn"
    monkeypatch.setenv("TRACTUS_LLM_BASE_URL", fake.url)
    p, m = resolve_provider("custom", "m")
    fake.delay = 1.0
    monkeypatch.setattr(llm, "TEST_TIMEOUT_S", 0.2)
    with pytest.raises(LLMError, match="오래 걸렸습니다") as e:
        check_connection(p, m)
    assert e.value.code == "llm_conn"


def test_streaming_errors_are_mapped_too(fake, monkeypatch):
    fake.fail(401)
    monkeypatch.setenv("TRACTUS_LLM_API_KEY", KEY)
    monkeypatch.setenv("TRACTUS_LLM_BASE_URL", fake.url)
    p, m = resolve_provider("custom", "m")
    with pytest.raises(LLMError) as e:
        list(stream_chat(make_client(p, max_retries=0), p, m, [{"role": "user", "content": "q"}]))
    assert e.value.code == "llm_auth"


def test_complete_json_maps_sdk_errors(fake, monkeypatch):
    fake.fail(429)
    monkeypatch.setenv("TRACTUS_LLM_API_KEY", KEY)
    monkeypatch.setenv("TRACTUS_LLM_BASE_URL", fake.url)
    p, m = resolve_provider("custom", "m")
    with pytest.raises(LLMError) as e:
        complete_json(make_client(p, max_retries=0), p, m, "s", "u", Out)
    assert e.value.code == "llm_rate"


# ── `tractus llm test` / summarize 오류 코드 ───────────────────────────────


def _run(*args, input=None):
    return CliRunner().invoke(cli.app, list(args), input=input)


def _events(text):
    return [json.loads(line) for line in text.splitlines() if line.startswith("{")]


def test_llm_test_success_prints_one_json_line_without_the_key(fake, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", KEY)
    monkeypatch.setenv("TRACTUS_LLM_BASE_URL", fake.url)
    r = _run("llm", "test", "--provider", "claude", "--model", "claude-x")
    assert r.exit_code == 0, r.output
    (line,) = r.stdout.strip().splitlines()
    out = json.loads(line)
    assert out["ok"] is True and out["provider"] == "claude" and out["model"] == "claude-x" and out["host"].startswith("127.0.0.1") and out["latency_ms"] >= 0
    assert KEY not in r.output and KEY not in r.stderr


def test_llm_test_uses_env_provider_and_model(fake, monkeypatch):
    monkeypatch.setenv("TRACTUS_LLM_PROVIDER", "custom")
    monkeypatch.setenv("TRACTUS_LLM_MODEL", "from-env")
    monkeypatch.setenv("TRACTUS_LLM_BASE_URL", fake.url)  # loopback: 키 없이
    r = _run("llm", "test")
    assert r.exit_code == 0 and json.loads(r.stdout)["model"] == "from-env"
    assert fake.requests[0]["body"]["model"] == "from-env"


@pytest.mark.parametrize("status, code", [(401, "llm_auth"), (404, "llm_model"), (429, "llm_rate"), (500, "llm_api")])
def test_llm_test_failure_emits_error_event_with_code(fake, monkeypatch, status, code):
    fake.fail(status, f"echo {KEY}")
    monkeypatch.setenv("TRACTUS_LLM_API_KEY", KEY)
    monkeypatch.setenv("TRACTUS_LLM_BASE_URL", fake.url)
    r = _run("llm", "test", "--provider", "custom", "--model", "m")
    assert r.exit_code == 1
    (ev,) = _events(r.stdout)
    assert ev["event"] == "error" and ev["code"] == code
    assert KEY not in r.stdout and KEY not in r.stderr


def test_llm_test_config_errors_have_codes(monkeypatch):
    r = _run("llm", "test", "--provider", "openai", "--model", "m")  # 키 없음
    assert r.exit_code == 1 and _events(r.stdout)[0]["code"] == "llm_config"
    monkeypatch.setenv("TRACTUS_LOCAL_ONLY", "1")
    monkeypatch.setenv("OPENAI_API_KEY", KEY)
    r = _run("llm", "test", "--provider", "openai", "--model", "m")
    assert r.exit_code == 1 and _events(r.stdout)[0]["code"] == "llm_local_only" and KEY not in r.output


def test_summarize_and_ask_surface_mapped_codes_and_never_the_key(fake, monkeypatch, tmp_path):
    home = tmp_path / "home"
    d = home / "meetings" / "2026-10-01_샘플_01SAMPLEMEETING00000000000"
    d.mkdir(parents=True)
    shutil.copy(FIXTURE, d / "transcript.json")
    fake.fail(401, f"Incorrect API key provided: {KEY}")
    monkeypatch.setenv("TRACTUS_LLM_API_KEY", KEY)
    monkeypatch.setenv("TRACTUS_LLM_BASE_URL", fake.url)
    monkeypatch.setenv("TRACTUS_LLM_PROVIDER", "custom")
    monkeypatch.setenv("TRACTUS_LLM_MODEL", "m")
    monkeypatch.setattr(llm, "TIMEOUT_S", 5)
    monkeypatch.setattr("tractus.llm.make_client.__defaults__", (5, 0))  # 재시도 없이 (401은 어차피 재시도하지 않는다)
    for args, inp in ((["summarize", "01SAMPLE", "--progress-json"], None), (["ask", "--meeting", "01SAMPLE", "--progress-json"], "예산은?")):
        r = _run(*args, input=inp)
        assert r.exit_code == 1, r.output
        assert _events(r.stdout)[-1]["code"] == "llm_auth"
        assert KEY not in r.stdout and KEY not in r.stderr
    assert not (d / "summary.json").exists() and not (d / "chat.json").exists()


# ── 리뷰 지적: 3xx는 따라가지 않는다, 연결 테스트는 총 시간 제한이 있다 ──────────────


def _raw_server(handler):
    """요청 한 줄을 읽고 handler(conn)에 넘기는 최소 TCP 서버 (stdlib). (주소, 닫기)"""
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(5)

    def serve():
        while True:
            try:
                conn, _ = srv.accept()
            except OSError:
                return
            conn.settimeout(5)
            threading.Thread(target=handler, args=(conn,), daemon=True).start()

    threading.Thread(target=serve, daemon=True).start()
    return f"http://127.0.0.1:{srv.getsockname()[1]}/v1", srv.close


def test_redirects_are_not_followed(fake, monkeypatch):
    monkeypatch.setenv("TRACTUS_LLM_API_KEY", KEY)

    def redirect(conn):
        conn.recv(65536)
        conn.sendall(f"HTTP/1.1 307 Temporary Redirect\r\nlocation: {fake.url}/chat/completions\r\ncontent-length: 0\r\n\r\n".encode())
        conn.close()

    url, close = _raw_server(redirect)
    monkeypatch.setenv("TRACTUS_LLM_BASE_URL", url)
    p, m = resolve_provider("custom", "m")
    with pytest.raises(LLMError) as e:
        check_connection(p, m)
    close()
    assert e.value.code == "llm_api" and "307" in str(e.value) and KEY not in str(e.value)
    assert fake.requests == []  # 넘겨받은 쪽은 아무것도 받지 못했다


def test_connection_test_has_a_total_deadline_even_when_the_server_drips(monkeypatch):
    monkeypatch.setenv("TRACTUS_LLM_API_KEY", KEY)

    def drip(conn):  # 머리말만 보내고 1바이트씩 흘린다: 읽기마다 재는 시간 제한은 끊지 못한다
        conn.recv(65536)
        conn.sendall(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 100000\r\n\r\n")
        try:
            for _ in range(50):
                time.sleep(0.1)
                conn.sendall(b" ")
        except OSError:
            pass

    url, close = _raw_server(drip)
    monkeypatch.setenv("TRACTUS_LLM_BASE_URL", url)
    monkeypatch.setattr(llm, "TEST_TIMEOUT_S", 0.5)
    p, m = resolve_provider("custom", "m")
    t0 = time.perf_counter()
    with pytest.raises(LLMError, match="오래 걸렸습니다") as e:
        check_connection(p, m)
    close()
    assert e.value.code == "llm_conn" and time.perf_counter() - t0 < 2


# ── 서비스별 주소·AI 모델 환경변수 (v3.33) ─────────────────────────────────


def test_per_service_env_overrides_preset_and_global_wins_only_for_the_selected_service(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", KEY)
    assert resolve_provider("gemini", None)[1] == "gemini-flash-latest"  # 표의 기본값
    monkeypatch.setenv("GEMINI_BASE_URL", "https://gw.example.com/g/")
    monkeypatch.setenv("GEMINI_MODEL", "gem-specific")
    p, m = resolve_provider("gemini", None)
    assert (p.base_url, m) == ("https://gw.example.com/g", "gem-specific")
    monkeypatch.setenv("TRACTUS_LLM_BASE_URL", "https://global.example.com/v1")  # 전역 > 서비스별 (서비스를 안 정했을 때)
    monkeypatch.setenv("TRACTUS_LLM_MODEL", "gem-global")
    p, m = resolve_provider("gemini", None)
    assert (p.base_url, m) == ("https://global.example.com/v1", "gem-global")
    assert resolve_provider("gemini", "from-arg")[1] == "from-arg"  # 인수 > 전역
    monkeypatch.setenv("TRACTUS_LLM_PROVIDER", "gemini")  # 이 서비스를 가리키면 그대로
    assert resolve_provider("gemini", None)[0].base_url == "https://global.example.com/v1"
    monkeypatch.setenv("TRACTUS_LLM_PROVIDER", "upstage")  # 다른 서비스를 가리키면 전역 값은 이 서비스에 닿지 않는다 (키가 엉뚱한 주소로 가지 않게)
    p, m = resolve_provider("gemini", None)
    assert (p.base_url, m) == ("https://gw.example.com/g", "gem-specific")


@pytest.mark.parametrize("name, key_env, pre", [("upstage", "UPSTAGE_API_KEY", "UPSTAGE"), ("openai", "OPENAI_API_KEY", "OPENAI"), ("claude", "ANTHROPIC_API_KEY", "ANTHROPIC"), ("gemini", "GEMINI_API_KEY", "GEMINI")])
def test_each_service_reads_its_own_prefix(monkeypatch, name, key_env, pre):
    monkeypatch.setenv(key_env, KEY)
    monkeypatch.setenv(f"{pre}_BASE_URL", "https://x.example.com/v1")
    monkeypatch.setenv(f"{pre}_MODEL", "m-x")
    p, m = resolve_provider(name, None)
    assert (p.base_url, m) == ("https://x.example.com/v1", "m-x")
    monkeypatch.delenv(f"{pre}_BASE_URL")  # 다른 서비스의 변수는 읽지 않는다
    monkeypatch.setenv("OPENAI_BASE_URL" if pre != "OPENAI" else "GEMINI_BASE_URL", "https://other.example.com/v1")
    assert resolve_provider(name, None)[0].base_url == PROVIDERS[name].base_url


def test_custom_always_uses_the_global_vars_and_bad_service_url_is_rejected_by_name(monkeypatch):
    monkeypatch.setenv("TRACTUS_LLM_PROVIDER", "upstage")
    monkeypatch.setenv("TRACTUS_LLM_API_KEY", KEY)
    monkeypatch.setenv("TRACTUS_LLM_BASE_URL", "https://gw.example.com/v1")
    monkeypatch.setenv("TRACTUS_LLM_MODEL", "mm")
    p, m = resolve_provider("custom", None)
    assert (p.base_url, m) == ("https://gw.example.com/v1", "mm")
    monkeypatch.setenv("OPENAI_API_KEY", KEY)
    monkeypatch.setenv("OPENAI_BASE_URL", "ftp://evil.com/v1")
    with pytest.raises(LLMError, match="OPENAI_BASE_URL") as e:
        resolve_provider("openai", "m")
    assert "evil.com" not in str(e.value)


def test_service_base_url_goes_through_the_local_only_check(monkeypatch):
    monkeypatch.setenv("TRACTUS_LOCAL_ONLY", "1")
    monkeypatch.setenv("OPENAI_API_KEY", KEY)
    monkeypatch.setenv("OPENAI_BASE_URL", "http://127.0.0.1:1/v1")
    assert resolve_provider("openai", "m")[0].base_url == "http://127.0.0.1:1/v1"
    monkeypatch.setenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
    with pytest.raises(LLMError) as e:
        resolve_provider("openai", "m")
    assert e.value.code == "llm_local_only"


# ── Gemini: 연결 테스트·바쁨·모델 안내·목록 ──────────────────────────────


def test_empty_reply_with_http_200_counts_as_connected(fake, monkeypatch):
    fake.body = {**OK, "choices": [{"index": 0, "message": {"role": "assistant", "content": None}, "finish_reason": "length"}]}  # 생각에 토큰을 다 쓴 경우
    monkeypatch.setenv("GEMINI_API_KEY", KEY)
    monkeypatch.setenv("TRACTUS_LLM_BASE_URL", fake.url)
    p, m = resolve_provider("gemini", None)
    r = check_connection(p, m)
    assert r["ok"] and r["empty"] is True and m == "gemini-flash-latest"
    fake.body = OK
    assert check_connection(p, m)["empty"] is False


@pytest.mark.parametrize("status, message", [(503, "This model is currently experiencing high demand."), (529, "Overloaded"), (500, "status UNAVAILABLE try later")])
def test_busy_is_its_own_code(fake, monkeypatch, status, message):
    fake.fail(status, message)
    with pytest.raises(LLMError) as e:
        _check(fake, monkeypatch)
    assert e.value.code == "llm_busy" and KEY not in str(e.value)


def test_real_calls_retry_a_transient_503_with_backoff(fake, monkeypatch):
    monkeypatch.setenv("TRACTUS_LLM_API_KEY", KEY)
    monkeypatch.setenv("TRACTUS_LLM_BASE_URL", fake.url)
    p, m = resolve_provider("custom", "m")
    fake.script = [(503, {"error": {"message": "high demand", "status": "UNAVAILABLE"}}), (503, {"error": {"message": "high demand"}}), (200, JSON_OK)]
    assert complete_json(make_client(p), p, m, "s", "u", Out).items == ["a"]  # 기본 재시도로 넘긴다
    assert len(fake.requests) == 3


def test_model_not_found_shows_a_safe_server_hint(fake, monkeypatch):
    long_key = "AQ." + "x" * 40
    fake.fail(404, f"models/gemini-2.5-flash is no longer available to new users. Please use gemini-3.8-flash. key={long_key} {KEY} " + "pad " * 80)
    with pytest.raises(LLMError) as e:
        _check(fake, monkeypatch)
    msg = str(e.value)
    assert e.value.code == "llm_model" and "gemini-3.8-flash" in msg and long_key not in msg and KEY not in msg
    assert len(msg.split("HTTP 404: ", 1)[1]) <= 200


def test_safe_masks_key_like_tokens_but_keeps_long_model_ids():
    from tractus.llm import _safe

    text = "use gemini-3.8-flash-preview-image-generation or models/gemini-flash-lite-latest not Ab3dE5gH7jK9mN1pQ3sT5vX7zB9dF1 nor " + "a" * 30
    out = _safe(text, "")
    assert "gemini-3.8-flash-preview-image-generation" in out and "gemini-flash-lite-latest" in out
    assert "Ab3dE5gH7jK9mN1pQ3sT5vX7zB9dF1" not in out and "a" * 30 not in out  # 섞인 대소문자, 한 덩어리 토큰은 가린다
    assert "SECRETKEY1" not in _safe("x SECRETKEY1 y", "SECRETKEY1")


def test_hint_comes_from_a_list_wrapped_body(fake, monkeypatch):
    fake.status, fake.body = 404, [{"error": {"code": 404, "message": "use gemini-3.8-flash", "status": "NOT_FOUND"}}]
    with pytest.raises(LLMError) as e:
        _check(fake, monkeypatch)
    assert e.value.code == "llm_model" and "use gemini-3.8-flash" in str(e.value)


def test_llm_models_lists_ids_without_prefix_and_maps_errors(fake, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", KEY)
    monkeypatch.setenv("GEMINI_BASE_URL", fake.url)
    r = _run("llm", "models", "--provider", "gemini")  # 모델 이름 없이도 된다
    assert r.exit_code == 0, r.output
    assert json.loads(r.stdout) == {"models": ["gemini-a", "gemini-b"]}  # `models/` 제거, 중복 제거, 순서
    assert fake.requests[-1]["path"] == "/v1/models" and fake.requests[-1]["auth"] == f"Bearer {KEY}"
    assert KEY not in r.output
    fake.fail(401, f"bad {KEY}")
    r = _run("llm", "models", "--provider", "gemini")
    assert r.exit_code == 1 and _events(r.stdout)[-1]["code"] == "llm_auth" and KEY not in r.output
    r = _run("llm", "models", "--provider", "openai")  # 키 없음
    assert r.exit_code == 1 and _events(r.stdout)[-1]["code"] == "llm_config"
