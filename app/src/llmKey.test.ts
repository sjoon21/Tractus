import { describe, expect, it } from "vitest";
import { keyProblem, keyStatusText, llmErrorView } from "./llmKey";

describe("keyProblem", () => {
  it("accepts a trimmed key of 10 to 200 characters", () => {
    expect(keyProblem("  test-key-123\n")).toBeNull();
    expect(keyProblem("a".repeat(10))).toBeNull();
    expect(keyProblem("a".repeat(200))).toBeNull();
  });
  it("rejects empty, short, long, and whitespace or control characters inside", () => {
    expect(keyProblem("   ")).toBe("API 키를 입력하세요.");
    expect(keyProblem("a".repeat(9))).toMatch(/10자에서 200자/);
    expect(keyProblem("a".repeat(201))).toMatch(/10자에서 200자/);
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
