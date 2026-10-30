import { describe, expect, test } from "vitest";
import { quickMatches } from "./quickMatch";

const n = (title: string) => ({ title });

describe("quickMatches", () => {
  const notes = [n("CMP AI 모니터링 회의"), n("ARD-007 스프린트 회의"), n("회의 17:04"), n("자원 온톨로지 미팅")];
  test("needs every word in the title, case-insensitive", () => {
    expect(quickMatches(notes, "cmp 회의").map((x) => x.title)).toEqual(["CMP AI 모니터링 회의"]);
    expect(quickMatches(notes, "온톨").map((x) => x.title)).toEqual(["자원 온톨로지 미팅"]);
    expect(quickMatches(notes, "없는말")).toEqual([]);
  });
  test("titles that start with the query come first, then the given order", () => {
    expect(quickMatches(notes, "회의").map((x) => x.title)).toEqual(["회의 17:04", "CMP AI 모니터링 회의", "ARD-007 스프린트 회의"]);
  });
  test("empty query and the limit", () => {
    expect(quickMatches(notes, "  ")).toEqual([]);
    expect(quickMatches(notes, "회의", 2)).toHaveLength(2);
  });
});
