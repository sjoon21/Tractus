import { describe, expect, test } from "vitest";
import { menuKey, NEW_NOTE_ITEMS, openKey } from "./menu";

const n = NEW_NOTE_ITEMS.length;

describe("new note menu", () => {
  test("items: write, record, import (the sidebar keeps its own record button)", () => {
    expect(NEW_NOTE_ITEMS.map((i) => i.action)).toEqual(["write", "record", "import"]);
    expect(NEW_NOTE_ITEMS.map((i) => i.label)).toEqual(["글쓰기", "녹음 시작", "파일 가져오기"]);
    expect(NEW_NOTE_ITEMS[0].hint).toBe("⌘N");
  });
  test("arrows move through the items and wrap", () => {
    expect(menuKey("ArrowDown", n, 0)).toEqual({ type: "focus", index: 1 });
    expect(menuKey("ArrowDown", n, n - 1)).toEqual({ type: "focus", index: 0 });
    expect(menuKey("ArrowUp", n, 1)).toEqual({ type: "focus", index: 0 });
    expect(menuKey("ArrowUp", n, 0)).toEqual({ type: "focus", index: n - 1 });
    expect(menuKey("ArrowDown", n, -1)).toEqual({ type: "focus", index: 0 }); // 초점이 항목 밖이면 처음부터
    expect(menuKey("ArrowUp", n, -1)).toEqual({ type: "focus", index: n - 1 });
  });
  test("Home and End jump", () => {
    expect(menuKey("Home", n, 2)).toEqual({ type: "focus", index: 0 });
    expect(menuKey("End", n, 0)).toEqual({ type: "focus", index: n - 1 });
  });
  test("Esc and Tab close; Enter and Space are left to the button's click", () => {
    expect(menuKey("Escape", n, 1)).toEqual({ type: "close" });
    expect(menuKey("Tab", n, 1)).toEqual({ type: "close" });
    expect(menuKey("Enter", n, 1)).toBeNull();
    expect(menuKey("Space", n, 1)).toBeNull();
    expect(menuKey("KeyA", n, 1)).toBeNull();
  });
  test("an empty menu ignores keys", () => {
    expect(menuKey("ArrowDown", 0, -1)).toBeNull();
  });
  test("on the closed button, down opens at the first item and up at the last", () => {
    expect(openKey("ArrowDown", n)).toBe(0);
    expect(openKey("ArrowUp", n)).toBe(n - 1);
    expect(openKey("Enter", n)).toBeNull();
  });
});
