import { describe, expect, test, vi } from "vitest";
import { OPEN_LABEL, sentToast } from "./obsidian";

describe("Obsidian으로 보내기 알림", () => {
  test("보냈으면 파일 이름(확장자 없이)과 Obsidian에서 열기, 같으면 이미 같다고 말한다", () => {
    const open = vi.fn();
    const t = sentToast({ status: "created", path: "/v/Tractus/프로젝트/2026-10-16 주간 개발.md", audio: null }, open);
    expect(t.text).toBe("Obsidian으로 보냈습니다 — 2026-10-16 주간 개발");
    expect(t.action?.label).toBe(OPEN_LABEL);
    t.action?.run();
    expect(open).toHaveBeenCalledWith("/v/Tractus/프로젝트/2026-10-16 주간 개발.md");
    expect(sentToast({ status: "unchanged", path: "/v/Tractus/a.md", audio: null }, open).text).toBe("이미 보낸 내용과 같습니다 — a");
    expect(sentToast({ status: "updated", path: "/v/Tractus/a.md", audio: null }, open).text).toBe("Obsidian으로 보냈습니다 — a");
  });
});
