import { describe, expect, test } from "vitest";
import { railKey, railLabel, railTabs, tabClickPlan, validTab } from "./rail";

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

describe("도크 탭을 눌렀을 때", () => {
  const base = { narrow: false, collapsed: false, current: "summary" as const };
  test("넓은 창에서 열려 있는 탭을 다시 누르면 패널을 접는다", () => {
    expect(tabClickPlan({ ...base, clicked: "summary" })).toEqual({ kind: "fold" });
  });
  test("다른 탭을 누르면 그 탭을 보인다 (접지도 펴지도 않는다)", () => {
    expect(tabClickPlan({ ...base, clicked: "ask" })).toEqual({ kind: "open", expand: false, scroll: false });
  });
  test("접힌 패널에서는 같은 탭을 눌러도 접지 않고 펴서 보인다", () => {
    expect(tabClickPlan({ ...base, collapsed: true, clicked: "summary" })).toEqual({ kind: "open", expand: true, scroll: false });
  });
  test("좁은 창에서는 접지 않고 패널로 스크롤한다", () => {
    expect(tabClickPlan({ ...base, narrow: true, clicked: "summary" })).toEqual({ kind: "open", expand: false, scroll: true });
    expect(tabClickPlan({ ...base, narrow: true, collapsed: true, clicked: "ask" })).toEqual({ kind: "open", expand: true, scroll: true });
  });
});
