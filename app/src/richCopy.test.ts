import { describe, expect, it } from "vitest";
import { markdownToHtml } from "./richCopy";

const body = (md: string) => markdownToHtml(md).replace('<meta charset="utf-8">', "");

describe("markdownToHtml", () => {
  it("제목·단락·굵게, 줄 끝 공백 두 개는 줄바꿈", () => {
    expect(body("# 제목\n\n일시: 오늘  \n참석: 가, 나\n\n**주요 안건:** 출시")).toBe(
      "<h1>제목</h1><p>일시: 오늘<br>참석: 가, 나</p><p><strong>주요 안건:</strong> 출시</p>",
    );
  });

  it("HTML을 이스케이프한다", () => {
    expect(body('<script>alert("x")</script> & **<b>**')).toBe("<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; <strong>&lt;b&gt;</strong></p>");
  });

  it("중첩 목록 (회의록은 4칸씩 들여 쓴다)", () => {
    expect(body("- **이름표**\n    - 세부\n        - 더 세부\n    - 세부2\n- 다음")).toBe(
      "<ul><li><strong>이름표</strong><ul><li>세부<ul><li>더 세부</li></ul></li><li>세부2</li></ul></li><li>다음</li></ul>",
    );
  });

  it("번호 목록과 체크 목록, 종류가 바뀌면 새 목록", () => {
    expect(body("1. 하나\n2. 둘\n\n- [ ] 할 일 — 가\n- [x] 끝남")).toBe("<ol><li>하나</li><li>둘</li></ol><ul><li>☐ 할 일 — 가</li><li>☑ 끝남</li></ul>");
    expect(body("1. 하나\n- 점")).toBe("<ol><li>하나</li></ol><ul><li>점</li></ul>");
  });

  it("표: 머리줄·구분줄·칸 안 <br>·이스케이프한 세로줄", () => {
    const html = body("| 할 일 | 담당 |\n| --- | --- |\n| A \\| B | • 가<br>• 나 |\n| **굵게** |  |");
    expect(html).toMatch(/^<table [^>]*><thead><tr><th [^>]*>할 일<\/th><th [^>]*>담당<\/th><\/tr><\/thead><tbody>/);
    expect(html).toContain(">A | B</td>");
    expect(html).toContain(">• 가<br>• 나</td>");
    expect(html).toContain("><strong>굵게</strong></td>");
    expect(html).not.toContain("---");
  });

  it("목록 다음 단락은 목록을 닫는다, 맨 앞에 charset", () => {
    const html = markdownToHtml("- a\n문장");
    expect(html.startsWith('<meta charset="utf-8">')).toBe(true);
    expect(html).toContain("<ul><li>a</li></ul><p>문장</p>");
  });
});
