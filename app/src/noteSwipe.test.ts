// 밀어서 삭제: 쌓기 문턱·세로 무시·한 줄만 열림·바깥 누르기/Esc/스크롤로 닫힘. document는 EventTarget으로 흉내 낸다.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setSwiped, SWIPE_GAP_MS, SWIPE_PX, swipedId, swipeStep, swipeWheel } from "./noteSwipe";

describe("swipeStep", () => {
  const zero = { acc: 0, at: 0 };
  test("가로로 문턱만큼 왼쪽으로 밀면 연다 (여러 이벤트를 쌓는다)", () => {
    let s = zero;
    let act = null;
    for (let i = 1; i <= 4; i++) ({ s, act } = swipeStep(s, SWIPE_PX / 4 - 0.01, 1, i * 10));
    expect(act).toBeNull();
    expect(swipeStep(s, 1, 0, 50).act).toBe("open");
  });

  test("오른쪽으로 밀면 닫는다", () => {
    expect(swipeStep(zero, -SWIPE_PX, 0, 10).act).toBe("close");
  });

  test("세로가 더 큰 움직임(목록 스크롤)은 쌓은 값을 버린다", () => {
    const half = swipeStep(zero, SWIPE_PX - 5, 0, 10).s;
    const v = swipeStep(half, 8, 30, 20);
    expect(v).toEqual({ s: { acc: 0, at: 20 }, act: null });
    expect(swipeStep(v.s, 10, 0, 30).act).toBeNull();
  });

  test("한동안 쉬면 새 밀기로 센다", () => {
    const half = swipeStep(zero, SWIPE_PX - 5, 0, 10).s;
    expect(swipeStep(half, 10, 0, 20).act).toBe("open");
    expect(swipeStep(half, 10, 0, 10 + SWIPE_GAP_MS + 1).act).toBeNull();
  });
});

describe("열린 줄", () => {
  let doc: EventTarget;
  let now = 0;
  beforeEach(() => {
    doc = Object.assign(new EventTarget(), { querySelector: () => null as unknown });
    vi.stubGlobal("document", doc);
    vi.stubGlobal("performance", { now: () => now });
  });
  afterEach(() => {
    setSwiped(null);
    vi.unstubAllGlobals();
  });
  const pointer = (inside: boolean) => {
    const e = new Event("pointerdown");
    Object.defineProperty(e, "target", { value: { closest: () => (inside ? {} : null) } });
    doc.dispatchEvent(e);
  };

  test("밀기로 열고, 다른 줄을 밀면 그 줄로 옮긴다 (한 줄만)", () => {
    swipeWheel("a", SWIPE_PX / 2, 0, 1);
    expect(swipedId()).toBeNull();
    swipeWheel("a", SWIPE_PX / 2, 0, 2);
    expect(swipedId()).toBe("a");
    swipeWheel("b", SWIPE_PX, 0, 3);
    expect(swipedId()).toBe("b");
  });

  test("바깥을 누르면 닫히고, 단추 안을 누르면 그대로다", () => {
    setSwiped("a");
    pointer(true);
    expect(swipedId()).toBe("a");
    pointer(false);
    expect(swipedId()).toBeNull();
  });

  test("Esc로 닫힌다", () => {
    setSwiped("a");
    doc.dispatchEvent(Object.assign(new Event("keydown"), { key: "Escape" }));
    expect(swipedId()).toBeNull();
  });

  test("목록을 스크롤하면 닫히지만, 밀기 바로 뒤의 작은 스크롤은 무시한다", () => {
    now = 1000;
    swipeWheel("a", SWIPE_PX, 2, now);
    now += 10;
    doc.dispatchEvent(new Event("scroll"));
    expect(swipedId()).toBe("a");
    now += SWIPE_GAP_MS + 1;
    doc.dispatchEvent(new Event("scroll"));
    expect(swipedId()).toBeNull();
  });

  test("노트 목록이 아닌 곳(실시간 자막 등)이 스크롤되면 닫지 않는다", () => {
    const btn = {};
    Object.assign(doc, { querySelector: () => btn });
    const scroll = (contains: boolean) => {
      const e = new Event("scroll");
      Object.defineProperty(e, "target", { value: { contains: (n: unknown) => contains && n === btn } });
      doc.dispatchEvent(e);
    };
    now = 5000;
    setSwiped("a");
    scroll(false);
    expect(swipedId()).toBe("a");
    scroll(true);
    expect(swipedId()).toBeNull();
  });

  test("오른쪽으로 밀면 그 줄이 닫힌다", () => {
    swipeWheel("a", SWIPE_PX, 0, 1);
    swipeWheel("a", -SWIPE_PX, 0, 2);
    expect(swipedId()).toBeNull();
  });
});
