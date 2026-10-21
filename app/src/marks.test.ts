import { describe, expect, test } from "vitest";
import { cleanMarkText, deleteMark, editMark, MEMO_TEXT_MAX } from "./marks";

const MARKS = [
  { t: 30.5, kind: "memo", text: "pool size 50" },
  { t: 95, kind: "bookmark", text: null },
  { t: 120, kind: "memo", text: "릴리스 날짜" },
];

describe("recording memos", () => {
  test("editing changes only that memo's text and leaves the original alone", () => {
    const next = editMark(MARKS, 0, " pool size\n 60 ");
    expect(next[0]).toEqual({ t: 30.5, kind: "memo", text: "pool size 60" });
    expect(next.slice(1)).toEqual(MARKS.slice(1));
    expect(MARKS[0].text).toBe("pool size 50");
  });
  test("an emptied memo is deleted; a bookmark's text is never edited", () => {
    expect(editMark(MARKS, 2, "   ")).toEqual(MARKS.slice(0, 2));
    expect(editMark(MARKS, 1, "글")).toBe(MARKS);
    expect(editMark(MARKS, 9, "x")).toBe(MARKS);
  });
  test("delete removes by position", () => {
    expect(deleteMark(MARKS, 1).map((m) => m.t)).toEqual([30.5, 120]);
  });
  test("text is one line and capped like the core", () => {
    expect(cleanMarkText("a\n\tb")).toBe("a b");
    expect(cleanMarkText("가".repeat(MEMO_TEXT_MAX + 5))).toHaveLength(MEMO_TEXT_MAX);
  });
});
