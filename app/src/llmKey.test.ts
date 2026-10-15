import { describe, expect, it, vi } from "vitest";
import { PROVIDERS } from "./ask";
import { errorView } from "./lib";
import {
  chatModels,
  baseUrlWarning,
  defaultBaseUrl,
  defaultModel,
  formProblem,
  HTTP_WARNING,
  isLlmChoice,
  isLoopbackUrl,
  keyProblem,
  keyReady,
  keyStatusText,
  pickService,
  readChoice,
  showServicePicker,
  writeChoice,
  EMBED_CONFIRM,
  EMBED_LABEL,
  EMBED_OPTIONS,
  LLM_CHOICES,
  llmErrorView,
  normalizeBaseUrl,
  PRIVACY_NOTE,
  PROVIDER_NOTE,
  testOkText,
  toForm,
  toStored,
} from "./llmKey";

describe("keyProblem", () => {
  it("accepts a trimmed key of 5 to 200 characters", () => {
    expect(keyProblem("  test-key-123\n")).toBeNull();
    expect(keyProblem("a".repeat(5))).toBeNull();
    expect(keyProblem("a".repeat(200))).toBeNull();
  });
  it("rejects empty, short, long, and whitespace or control characters inside", () => {
    expect(keyProblem("   ")).toBe("API 키를 입력하세요.");
    expect(keyProblem("a".repeat(4))).toMatch(/5자에서 200자/);
    expect(keyProblem("a".repeat(201))).toMatch(/5자에서 200자/);
    expect(keyProblem("test key 123")).toMatch(/공백/);
    expect(keyProblem("test-key\n123")).toMatch(/공백/);
    expect(keyProblem("test-\u201ckey-123")).toMatch(/영문·숫자·기호가 아닌/);
    expect(keyProblem("test-키-1234567")).toMatch(/영문·숫자·기호가 아닌/);
    expect(keyProblem("test-key-\u0007123")).toMatch(/공백/);
  });
  it("never echoes the key", () => {
    expect(keyProblem("secret key")).not.toContain("secret");
  });
});

describe("keyStatusText", () => {
  it("says registered, not registered, or checking", () => {
    expect(keyStatusText(true)).toBe("키가 등록되어 있습니다");
    expect(keyStatusText(false)).toBe("등록된 키가 없습니다");
    expect(keyStatusText(null)).toBe("확인 중…");
  });
});

describe("llmErrorView", () => {
  it("maps the missing-config code to the key sentence with a settings action", () => {
    const s = llmErrorView("summarize", "UPSTAGE_API_KEY가 없습니다. .env.local에 넣거나", "llm_config");
    expect(s).toEqual({ text: "AI 키가 없어 요약할 수 없습니다. 설정에서 API 키를 등록하세요.", detail: "UPSTAGE_API_KEY가 없습니다. .env.local에 넣거나", settings: true });
    expect(llmErrorView("ask", "x", "llm_config").text).toBe("AI 키가 없어 답변할 수 없습니다. 설정에서 API 키를 등록하세요.");
  });
  it("keeps the other mappings and offers no settings action", () => {
    expect(llmErrorView("summarize", "x", "llm_local_only")).toMatchObject({ text: "로컬 전용 모드에서는 외부 AI 서비스를 쓸 수 없습니다.", settings: false });
    expect(llmErrorView("ask", "boom", null)).toEqual({ text: "답변을 받지 못했습니다", detail: "boom", settings: false });
  });
});

describe("서비스 표", () => {
  it("lists the five choices with defaults; only custom has no default address", () => {
    expect(LLM_CHOICES).toEqual(["upstage", "openai", "claude", "gemini", "custom"]);
    expect(defaultBaseUrl("claude")).toBe("https://api.anthropic.com/v1");
    expect(defaultBaseUrl("gemini")).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(defaultBaseUrl("custom")).toBe("");
    expect([defaultModel("upstage"), defaultModel("claude"), defaultModel("openai"), defaultModel("gemini"), defaultModel("custom")]).toEqual(["solar-pro4", "claude-sonnet-5-5", "", "gemini-flash-latest", ""]);
    expect(isLlmChoice("claude") && !isLlmChoice("gemma-local") && !isLlmChoice("../x")).toBe(true);
    for (const p of LLM_CHOICES) expect(PROVIDER_NOTE[p].length).toBeGreaterThan(10);
  });
  it("tells Claude users about the compatibility mode and everybody what is sent", () => {
    expect(PROVIDER_NOTE.claude).toContain("Claude는 호환 방식으로 연결됩니다. 일부 기능(엄격 JSON)은 쓰지 않고 검증 후 재요청으로 처리합니다");
    expect(PRIVACY_NOTE).toContain("대화 내용(제목·참석자 이름 포함)이 선택한 AI 서비스로 전송됩니다");
  });
});

describe("normalizeBaseUrl", () => {
  it("accepts http/https with a host and trims the trailing slash; empty means the default", () => {
    expect(normalizeBaseUrl("  https://gw.example.com/v1/ ")).toEqual({ url: "https://gw.example.com/v1" });
    expect(normalizeBaseUrl("http://localhost:11434/v1")).toEqual({ url: "http://localhost:11434/v1" });
    expect(normalizeBaseUrl("  ")).toEqual({ url: "" });
  });
  it("rejects other schemes, missing hosts, bad ports, spaces and account info without echoing them", () => {
    for (const bad of ["gw.example.com/v1", "ftp://x.com", "https://", "http://x.com:99999", "https://a b.com", "http://evil.com\\@localhost/"]) {
      expect(normalizeBaseUrl(bad), bad).toEqual({ problem: "서비스 주소는 http:// 또는 https://로 시작하는 올바른 주소여야 합니다." });
    }
    for (const bad of ["https://user:secret-pw@x.com/v1", "http://localhost@evil.com/v1"]) {
      const r = normalizeBaseUrl(bad);
      expect("problem" in r && r.problem).toMatch(/사용자 이름이나 비밀번호/);
      expect(JSON.stringify(r)).not.toContain("secret-pw");
    }
  });
});

describe("loopback and warnings", () => {
  it("compares the parsed host exactly", () => {
    for (const ok of ["http://localhost:11434/v1", "http://127.0.0.1", "http://[::1]:8080/v1", "http://LOCALHOST/x"]) expect(isLoopbackUrl(ok), ok).toBe(true);
    for (const bad of ["https://api.openai.com/v1", "http://localhost.evil.com", "http://127.0.0.1.evil.com", "http://evil.com/localhost", "http://[::2]/", "nope"]) expect(isLoopbackUrl(bad), bad).toBe(false);
  });
  it("warns for http only when the host is not this Mac", () => {
    expect(baseUrlWarning("http://localhost:11434/v1")).toBeNull();
    expect(baseUrlWarning("http://127.0.0.1:8080")).toBeNull();
    expect(baseUrlWarning("https://gw.example.com/v1")).toBeNull();
    expect(baseUrlWarning("http://gw.example.com/v1")).toBe(HTTP_WARNING);
    expect(baseUrlWarning("http://192.168.0.5:8000/v1")).toBe(HTTP_WARNING); // 사내망도 경고한다
    expect(baseUrlWarning("")).toBeNull();
  });
});

describe("chatModels", () => {
  it("drops embedding, speech, image and video models but keeps chat ones", () => {
    const ids = ["gemini-3.8-flash", "gemini-flash-latest", "gemini-embedding-001", "gemini-2.5-flash-preview-tts", "imagen-4.0", "veo-3", "aqa", "solar-pro4", "solar-embedding-1-large-query"];
    expect(chatModels(ids)).toEqual(["gemini-3.8-flash", "gemini-flash-latest", "solar-pro4"]);
  });
  it("keeps everything when nothing looks like chat", () => {
    expect(chatModels(["text-embedding-3", "whisper-1"])).toEqual(["text-embedding-3", "whisper-1"]);
  });
});

describe("formProblem", () => {
  const f = (provider: string, baseUrl = "", model = "") => ({ provider, baseUrl, model });
  it("needs an AI model name only where there is no default", () => {
    expect(formProblem(f("upstage"))).toBeNull();
    expect(formProblem(f("claude", defaultBaseUrl("claude")))).toBeNull();
    expect(formProblem(f("openai"))).toBe("AI 모델 이름을 입력하세요.");
    expect(formProblem(f("gemini", "", "  "))).toBeNull(); // gemini-flash-latest가 기본이다
    expect(formProblem(f("openai", "", "  "))).toBe("AI 모델 이름을 입력하세요.");
    expect(formProblem(f("openai"), false)).toBeNull(); // AI 모델 목록을 불러올 때는 이름이 없어도 된다
    expect(formProblem(f("custom", "", ""), false)).toBe("서비스 주소를 입력하세요."); // 주소는 그래도 필요하다
    expect(formProblem(f("openai", "", "gpt-x"))).toBeNull();
  });
  it("needs an address and a model for the custom service", () => {
    expect(formProblem(f("custom", "", "m"))).toBe("서비스 주소를 입력하세요.");
    expect(formProblem(f("custom", "https://gw.example.com/v1"))).toBe("AI 모델 이름을 입력하세요.");
    expect(formProblem(f("custom", "https://gw.example.com/v1", "m"))).toBeNull();
  });
  it("rejects a bad address, a bad model name and an unknown service", () => {
    expect(formProblem(f("openai", "ftp://x", "m"))).toMatch(/http:\/\/ 또는 https:\/\//);
    expect(formProblem(f("openai", "", "my model"))).toMatch(/공백/);
    expect(formProblem(f("openai", "", "a".repeat(201)))).toMatch(/200자/);
    expect(formProblem(f("nope", "", "m"))).toBe("알 수 없는 AI 서비스입니다: nope");
  });
});

describe("saving and showing the form", () => {
  it("stores empty when the address or model equals the service default", () => {
    expect(toStored({ provider: "claude", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-5-5" })).toEqual({ baseUrl: "", model: "" });
    expect(toStored({ provider: "claude", baseUrl: "https://api.anthropic.com/v1/", model: " claude-x " })).toEqual({ baseUrl: "", model: "claude-x" }); // 끝의 /는 같은 주소
    expect(toStored({ provider: "openai", baseUrl: "https://gw.example.com/v1/", model: "gpt-x" })).toEqual({ baseUrl: "https://gw.example.com/v1", model: "gpt-x" });
    expect(toStored({ provider: "custom", baseUrl: "http://localhost:11434/v1", model: "llama" })).toEqual({ baseUrl: "http://localhost:11434/v1", model: "llama" });
  });
  it("prefills the default address but leaves the model empty so the placeholder shows its default", () => {
    expect(toForm("claude", "", "")).toEqual({ provider: "claude", baseUrl: "https://api.anthropic.com/v1", model: "" });
    expect(toForm("openai", "https://gw.example.com/v1", "gpt-x")).toEqual({ provider: "openai", baseUrl: "https://gw.example.com/v1", model: "gpt-x" });
    expect(toForm("gemini", "", "")).toEqual({ provider: "gemini", baseUrl: PROVIDERS.gemini.url, model: "" });
    expect(toForm("custom", "", "")).toEqual({ provider: "custom", baseUrl: "", model: "" });
  });
  it("round-trips: what is stored comes back as the same form", () => {
    const form = { provider: "claude", baseUrl: "https://api.anthropic.com/v1", model: "" };
    const s = toStored(form);
    expect(toForm("claude", s.baseUrl, s.model)).toEqual(form);
  });
});

describe("keyReady and summaries", () => {
  it("needs a saved key, except for the custom service on this Mac", () => {
    expect(keyReady("claude", "", false)).toBe(false);
    expect(keyReady("claude", "", true)).toBe(true);
    expect(keyReady("custom", "http://localhost:11434/v1", false)).toBe(true);
    expect(keyReady("custom", "https://gw.example.com/v1", false)).toBe(false);
    expect(keyReady("openai", "http://localhost:11434/v1", false)).toBe(false); // 직접 입력만 키 없이
  });
  it("words the test result", () => {
    expect(testOkText({ host: "api.anthropic.com", latency_ms: 412 })).toBe("연결되었습니다 (api.anthropic.com, 412ms)");
    expect(testOkText({ host: null, latency_ms: null })).toBe("연결되었습니다");
    expect(testOkText({ host: "generativelanguage.googleapis.com", latency_ms: 800, empty: true })).toBe("응답을 받았습니다 (generativelanguage.googleapis.com, 800ms)");
  });
});

describe("new error codes", () => {
  const sentences: Record<string, string> = {
    llm_auth: "API 키가 맞지 않거나 사용 권한이 없습니다. 설정에서 키를 확인하세요.",
    llm_rate: "AI 서비스의 사용량 한도를 넘었거나 요청이 몰렸습니다. 잠시 후 다시 시도하세요.",
    llm_model: "AI 모델을 찾을 수 없습니다. 설정에서 AI 모델 이름과 서비스 주소를 확인하거나, ‘AI 모델 목록 불러오기’로 쓸 수 있는 이름을 고르세요.",
    llm_busy: "AI 서비스가 바쁩니다. 잠시 뒤 다시 시도하세요.",
    llm_context: "대화 내용이 너무 길어 AI가 처리하지 못했습니다. 더 큰 AI 모델을 쓰거나 질문 범위를 줄여 보세요.",
    llm_conn: "AI 서비스에 연결하지 못했습니다. 인터넷 연결과 서비스 주소를 확인하세요.",
    llm_api: "AI 서비스에서 오류가 났습니다. 잠시 후 다시 시도하세요.",
  };
  it("maps every code to a sentence and keeps the core text as details", () => {
    for (const [code, text] of Object.entries(sentences)) {
      expect(errorView("api.example.com HTTP 500", code, "x")).toEqual({ text, detail: "api.example.com HTTP 500" });
      expect(llmErrorView("summarize", "d", code).text).toBe(text);
    }
  });
  it("offers 설정 열기 where the fix is in the settings (key, AI model) and not for transient errors", () => {
    for (const code of ["llm_config", "llm_auth", "llm_model"]) expect(llmErrorView("ask", "d", code).settings, code).toBe(true);
    for (const code of ["llm_rate", "llm_busy", "llm_conn", "llm_context", "llm_api", "llm_invalid", "llm_local_only"]) expect(llmErrorView("ask", "d", code).settings, code).toBe(false);
  });
  it("never names a service in the missing-key sentence", () => {
    expect(llmErrorView("summarize", "x", "llm_config").text).not.toMatch(/Upstage|OpenAI|Claude|Gemini/);
    expect(llmErrorView("ask", "x", "llm_auth").text).not.toMatch(/Upstage/);
  });
});

describe("요약·질문마다 서비스 고르기", () => {
  it("uses the remembered service only while it is still registered, otherwise the default", () => {
    expect(pickService(["upstage", "gemini"], "upstage", "gemini")).toBe("gemini");
    expect(pickService(["upstage", "gemini"], "upstage", "claude")).toBe("upstage"); // 키를 지운 서비스
    expect(pickService(["upstage", "gemini"], "upstage", null)).toBe("upstage");
  });
  it("shows the dropdown only for two or more registered services, and not when the environment decides", () => {
    expect(showServicePicker(["upstage"], false)).toBe(false);
    expect(showServicePicker([], false)).toBe(false);
    expect(showServicePicker(["upstage", "gemini"], false)).toBe(true);
    expect(showServicePicker(["upstage", "gemini"], true)).toBe(false);
  });
  it("remembers the choice per feature and survives a missing localStorage", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    writeChoice("summary", "gemini");
    expect([readChoice("summary"), readChoice("ask")]).toEqual(["gemini", null]);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readChoice("summary")).toBeNull();
    expect(() => writeChoice("ask", "claude")).not.toThrow();
    vi.unstubAllGlobals();
  });
});

describe("스마트 검색 방식", () => {
  it("states what is sent before switching to Upstage, in product words", () => {
    expect(EMBED_CONFIRM.body).toContain("노트의 대화 내용(스마트 검색 정보를 만들 때)과 검색어(검색할 때)가 Upstage로 전송됩니다");
    expect(EMBED_CONFIRM.body).toContain("Upstage의 데이터 보관·사용 정책은 확인하지 못했습니다");
    expect(EMBED_LABEL).toBe("스마트 검색 방식");
    expect(EMBED_OPTIONS.local).toContain("이 Mac");
  });
});
