import { describe, expect, test } from "vitest";
import { railKey, railLabel, railTabs, validTab } from "./rail";

describe("right panel tabs", () => {
  test("a recording has summary, minutes, ask and memo; a memo note has neither minutes nor memo", () => {
    expect(railTabs(false)).toEqual(["summary", "minutes", "ask", "memo"]);
    expect(railTabs(true)).toEqual(["summary", "ask"]);
  });
  test("a tab that this note does not have falls back to the first", () => {
    expect(validTab(railTabs(true), "memo")).toBe("summary");
    expect(validTab(railTabs(true), "minutes")).toBe("summary");
    expect(validTab(railTabs(false), "memo")).toBe("memo");
  });
  test("arrow keys move and wrap, Home/End jump, other keys are left alone", () => {
    const t = railTabs(false);
    expect(railKey(t, "summary", "ArrowRight")).toBe("minutes");
    expect(railKey(t, "memo", "ArrowRight")).toBe("summary");
    expect(railKey(t, "summary", "ArrowLeft")).toBe("memo");
    expect(railKey(t, "ask", "ArrowLeft")).toBe("minutes");
    expect(railKey(t, "ask", "Home")).toBe("summary");
    expect(railKey(t, "ask", "End")).toBe("memo");
    expect(railKey(t, "ask", "Space")).toBeNull();
    expect(railKey(t, "ask", "ArrowDown")).toBeNull();
  });
  test("with two tabs the arrows toggle", () => {
    const t = railTabs(true);
    expect(railKey(t, "summary", "ArrowRight")).toBe("ask");
    expect(railKey(t, "ask", "ArrowRight")).toBe("summary");
    expect(railKey(t, "summary", "End")).toBe("ask");
  });
  test("the panel name lists the tabs it has", () => {
    expect(railLabel(true)).toBe("요약과 AI 질문");
    expect(railLabel(false)).toBe("요약, 회의록, AI 질문, 메모");
  });
});
