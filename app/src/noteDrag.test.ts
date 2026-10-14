// 포인터로 끌기: DOM 없이 window·document를 흉내 내서 시작 문턱·놓기·취소·click 막기를 본다.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { onNoteDrop, startNoteDrag } from "./noteDrag";

let win: EventTarget;
let overRow: string | null;
let ghosts: { textContent: string; style: Record<string, string>; removed: boolean }[];

beforeEach(() => {
  vi.useFakeTimers();
  win = new EventTarget();
  overRow = null;
  ghosts = [];
  const body = { classList: { add() {}, remove() {} }, append() {} };
  vi.stubGlobal("window", { addEventListener: win.addEventListener.bind(win), removeEventListener: win.removeEventListener.bind(win) });
  vi.stubGlobal("document", {
    body,
    createElement: () => {
      const g = { textContent: "", className: "", style: {} as Record<string, string>, removed: false, remove() { g.removed = true; } };
      ghosts.push(g);
      return g;
    },
    elementFromPoint: () => ({ closest: () => (overRow === null ? null : { getAttribute: () => overRow }) }),
  });
});
afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const fire = (type: string, extra: object = {}) => win.dispatchEvent(Object.assign(new Event(type), { clientX: 0, clientY: 0, ...extra }));
const down = { button: 0, pointerType: "mouse", clientX: 0, clientY: 0 };

test("drops the note on the folder row under the pointer", () => {
  const got: [string, string | null][] = [];
  const off = onNoteDrop((id, t) => got.push([id, t]));
  startNoteDrag(down, "N1", "예산");
  overRow = "F1";
  fire("pointermove", { clientX: 20, clientY: 20 });
  fire("pointerup", { clientX: 20, clientY: 20 });
  expect(got).toEqual([["N1", "F1"]]);
  expect(ghosts[0].textContent).toBe("예산");
  expect(ghosts[0].removed).toBe(true);
  off();
});

test("the 'no folder' row drops to null; a drop outside any folder row does nothing", () => {
  const got: [string, string | null][] = [];
  const off = onNoteDrop((id, t) => got.push([id, t]));
  startNoteDrag(down, "N1", "a");
  overRow = "none";
  fire("pointermove", { clientX: 30 });
  fire("pointerup", { clientX: 30 });
  startNoteDrag(down, "N2", "b");
  overRow = null;
  fire("pointermove", { clientX: 30 });
  fire("pointerup", { clientX: 30 });
  expect(got).toEqual([["N1", null]]);
  off();
});

test("a press that barely moves is a click, not a drag", () => {
  const got: unknown[] = [];
  const off = onNoteDrop((...a) => got.push(a));
  startNoteDrag(down, "N1", "a");
  overRow = "F1";
  fire("pointermove", { clientX: 2, clientY: 1 });
  fire("pointerup", { clientX: 2, clientY: 1 });
  expect(ghosts).toHaveLength(0);
  expect(got).toEqual([]);
  off();
});

test("Escape cancels, and right button or touch never starts", () => {
  const got: unknown[] = [];
  const off = onNoteDrop((...a) => got.push(a));
  startNoteDrag(down, "N1", "a");
  overRow = "F1";
  fire("pointermove", { clientX: 40 });
  fire("keydown", { key: "Escape" });
  fire("pointerup", { clientX: 40 });
  startNoteDrag({ ...down, button: 2 }, "N2", "b");
  startNoteDrag({ ...down, pointerType: "touch" }, "N3", "c");
  fire("pointermove", { clientX: 40 });
  fire("pointerup", { clientX: 40 });
  expect(got).toEqual([]);
  off();
});
