import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { flushMemos, registerMemo } from "./memo";
import { PanelResizer, PanelsContext, PanelToggle, type PanelsApi } from "./PanelToggle";
import appSrc from "./App.tsx?raw";
import meetingSrc from "./MeetingView.tsx?raw";
import { canCollapse, clampWidth, DEFAULT_WIDTHS, restoreWidths, widthByKey, EXPANDED, initialPanels, NARROW_PX, PANELS_KEY, PANEL_TEXT, RAIL_REC_LABEL, panelKey, readPanels, restore, revealFor, choose, railPendingLabel, railRecState, serialize, toggleLabel, togglePanel, writePanels } from "./panels";

const key = (over: Partial<Parameters<typeof panelKey>[0]> = {}) => ({ code: "KeyB", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, ...over });
const memStore = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

describe("toggle", () => {
  test("flips one side and leaves the other, without mutating", () => {
    const a = togglePanel(EXPANDED, "left");
    expect(a).toEqual({ left: true, right: false });
    expect(EXPANDED).toEqual({ left: false, right: false });
    expect(togglePanel(a, "right")).toEqual({ left: true, right: true });
    expect(togglePanel(a, "left")).toEqual(EXPANDED);
  });
});

describe("persistence", () => {
  test("round-trips through serialize and restore", () => {
    for (const s of [EXPANDED, { left: true, right: false }, { left: true, right: true }]) expect(restore(serialize(s))).toEqual(s);
  });
  test.each([[null], [undefined], [""], ["not json"], ["null"], ["[]"], ["3"], ['"x"'], ['{"left":"yes"}'], ['{"left":1,"right":0}'], ["{}"]])("corrupt value %j falls back to null", (raw) => {
    expect(restore(raw)).toBeNull();
  });
  test("a half-saved or half-corrupt value keeps only the usable side", () => {
    expect(restore('{"left":true}')).toEqual({ left: true });
    expect(restore('{"left":"yes","right":false}')).toEqual({ right: false });
  });
  test("extra keys are ignored", () => {
    expect(restore('{"left":true,"right":false,"x":1}')).toEqual({ left: true, right: false });
  });
  test("write then read uses the namespaced key", () => {
    const st = memStore();
    writePanels({ left: true, right: false }, st);
    expect([...st.m.keys()]).toEqual([PANELS_KEY]);
    expect(PANELS_KEY).toMatch(/^tractus\./);
    expect(restore(readPanels(st))).toEqual({ left: true, right: false });
  });
  test("a store that throws (private window) never breaks the app", () => {
    const bad = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readPanels(bad)).toBeNull();
    expect(() => writePanels(EXPANDED, bad)).not.toThrow();
    expect(readPanels(null)).toBeNull();
    expect(() => writePanels(EXPANDED, null)).not.toThrow();
  });
});

describe("first layout", () => {
  test("wide window with nothing saved: both open", () => {
    expect(initialPanels(null, 1280)).toEqual(EXPANDED);
    expect(initialPanels(null, NARROW_PX)).toEqual(EXPANDED);
  });
  test("narrow window with nothing saved: right panel starts collapsed, left stays open", () => {
    expect(initialPanels(null, NARROW_PX - 1)).toEqual({ left: false, right: true });
    expect(initialPanels(null, 900)).toEqual({ left: false, right: true });
  });
  test("a corrupt saved value counts as nothing saved", () => {
    expect(initialPanels("{{", 900)).toEqual({ left: false, right: true });
  });
  test("a saved choice always wins, even when narrow", () => {
    expect(initialPanels(serialize({ left: false, right: false }), 900)).toEqual(EXPANDED);
    expect(initialPanels(serialize({ left: true, right: false }), 1600)).toEqual({ left: true, right: false });
  });
  test("a side the user never chose keeps following the default after the other one is toggled", () => {
    const stored = serialize(choose({}, "left", true)); // narrow start, user only collapsed the list
    expect(JSON.parse(stored)).toEqual({ left: true });
    expect(initialPanels(stored, 900)).toEqual({ left: true, right: true });
    expect(initialPanels(stored, 1600)).toEqual({ left: true, right: false }); // wide later: right is open
  });
  test("a strange width does not collapse anything by accident", () => {
    expect(initialPanels(null, Number.NaN)).toEqual(EXPANDED);
  });
});

describe("auto-expand", () => {
  const closed = { left: true, right: true };
  test("a memo line of a recording note opens the right panel only", () => {
    expect(revealFor(closed, { kind: "memo-line", memoNote: false })).toEqual({ left: true, right: false });
  });
  test("a memo note's lines live in the centre: nothing is forced open", () => {
    expect(revealFor(closed, { kind: "memo-line", memoNote: true })).toBe(closed);
  });
  test("⌘K opens the left list (the search box lives there) and nothing else", () => {
    expect(revealFor(closed, { kind: "search" })).toEqual({ left: false, right: true });
    expect(revealFor(EXPANDED, { kind: "search" })).toBe(EXPANDED);
  });
  test("seeking, opening a note and recording never force a panel open", () => {
    for (const kind of ["seek", "open-note", "record"] as const) expect(revealFor(closed, { kind })).toBe(closed);
  });
  test("an already open panel is the same object (no re-render, no write)", () => {
    expect(revealFor(EXPANDED, { kind: "memo-line", memoNote: false })).toBe(EXPANDED);
  });
});

describe("shortcuts", () => {
  test("⌘B is the left panel, ⌥⌘B the right one (physical key, so Korean input works)", () => {
    expect(panelKey(key())).toBe("left");
    expect(panelKey(key({ altKey: true }))).toBe("right");
  });
  test("nothing else matches", () => {
    expect(panelKey(key({ metaKey: false }))).toBeNull(); // B alone is the recording bookmark
    expect(panelKey(key({ ctrlKey: true }))).toBeNull();
    expect(panelKey(key({ shiftKey: true }))).toBeNull();
    expect(panelKey(key({ code: "KeyN" }))).toBeNull();
    expect(panelKey(key({ metaKey: false, ctrlKey: true }))).toBeNull();
  });
  test("they do not collide with the app's other shortcuts: the only other B is the bookmark, which refuses ⌘", () => {
    const app = appSrc;
    expect(app.match(/"KeyB"/g)).toHaveLength(1);
    expect(app).toMatch(/"KeyB" && !e\.metaKey && !e\.ctrlKey/);
  });
});

describe("collapsing the right panel saves the memo first", () => {
  test("flushes the open memo and lets it collapse when the save worked", async () => {
    const flush = vi.fn(async () => true);
    const off = registerMemo("N-panels-1", { flush, drop() {} });
    expect(await canCollapse("right", flushMemos)).toBe(true);
    expect(flush).toHaveBeenCalledTimes(1);
    off();
  });
  test("a failed save keeps the panel open so the editor can show the error", async () => {
    const off = registerMemo("N-panels-2", { flush: async () => false, drop() {} });
    expect(await canCollapse("right", flushMemos)).toBe(false);
    off();
  });
  test("collapsing the left list never touches the memo", async () => {
    const flush = vi.fn(async () => false);
    expect(await canCollapse("left", flush)).toBe(true);
    expect(flush).not.toHaveBeenCalled();
  });
  test("with no memo open there is nothing to save", async () => {
    expect(await canCollapse("right", flushMemos)).toBe(true);
  });
});

describe("collapsed rail keeps list-only status visible", () => {
  test("importing counts as converting; recording wins", () => {
    expect(railRecState({ recording: false, busy: false })).toBe("idle");
    expect(railRecState({ recording: false, busy: true })).toBe("converting");
    expect(railRecState({ recording: true, busy: true })).toBe("live");
  });
  test("a pending after-record question shows its own label, not `변환 중…`", () => {
    expect(railRecState({ recording: false, busy: true, asking: true })).toBe("asking");
    expect(railRecState({ recording: true, busy: false, asking: true })).toBe("live");
    expect(RAIL_REC_LABEL.asking).toBe("녹음 끝남");
  });
  test("pending recordings get a badge label", () => {
    expect(railPendingLabel(2)).toBe("변환 대기 중인 녹음 2개");
  });
});

describe("words", () => {
  test("labels name the panel and the action; the title adds the shortcut", () => {
    expect(toggleLabel("left", false)).toEqual({ label: "노트 목록 접기", title: "노트 목록 접기 (⌘B)" });
    expect(toggleLabel("left", true)).toEqual({ label: "노트 목록 펼치기", title: "노트 목록 펼치기 (⌘B)" });
    expect(toggleLabel("right", false)).toEqual({ label: "오른쪽 패널 접기", title: "오른쪽 패널 접기 (⌥⌘B)" });
    expect(toggleLabel("right", true)).toEqual({ label: "오른쪽 패널 펼치기", title: "오른쪽 패널 펼치기 (⌥⌘B)" });
  });
  test("no engineering words in the strings (WORDS.md §5)", () => {
    const banned = /회의|전사|세그먼트|화자|청크|벡터|임베딩|색인|모델|정렬|타이밍|용어집|묶음|무음|대목|미상|발화|발언|확정|공급자|LLM|MCP/;
    expect(JSON.stringify(PANEL_TEXT)).not.toMatch(banned);
  });
});

describe("toggle button render", () => {
  const api = (state: { left: boolean; right: boolean }): PanelsApi => ({ state, toggle: async () => {}, reveal() {}, registerRight: () => () => {}, widths: DEFAULT_WIDTHS, setWidth() {} });
  const html = (side: "left" | "right", state: { left: boolean; right: boolean }) => renderToStaticMarkup(createElement(PanelsContext.Provider, { value: api(state) }, createElement(PanelToggle, { side })));

  test("expanded: says what it does, exposes state, controls and shortcut", () => {
    const h = html("left", EXPANDED);
    expect(h).toContain('id="panel-toggle-left"');
    expect(h).toContain('aria-label="노트 목록 접기"');
    expect(h).toContain('aria-expanded="true"');
    expect(h).toContain('aria-controls="sidebar-body"');
    expect(h).toContain('aria-keyshortcuts="Meta+B"');
    expect(h).toContain('title="노트 목록 접기 (⌘B)"');
  });
  test("collapsed: offers to expand", () => {
    const h = html("right", { left: false, right: true });
    expect(h).toContain('aria-label="오른쪽 패널 펼치기"');
    expect(h).toContain('aria-expanded="false"');
    expect(h).toContain('aria-controls="rail-body"');
    expect(h).toContain('aria-keyshortcuts="Alt+Meta+B"');
  });
  test("the controlled ids exist in the markup even while collapsed (content stays mounted, only hidden)", () => {
    const app = appSrc;
    const meeting = meetingSrc;
    expect(app).toMatch(/id="sidebar-body"[^>]*hidden=\{panels\.state\.left\}/);
    expect(meeting).toMatch(/id="rail-body"[^>]*hidden=\{railCollapsed\}/);
    expect(app).toContain('<PanelToggle side="left" />');
    expect(meeting).toContain('<PanelToggle side="right" />');
  });
});

describe("패널 폭 조절", () => {
  test("범위와 가운데 최소 폭을 지킨다", () => {
    expect(clampWidth("left", 100, 340, 1600)).toBe(200);
    expect(clampWidth("left", 999, 340, 1600)).toBe(400);
    expect(clampWidth("right", 500, 260, 1600)).toBe(500);
    expect(clampWidth("right", 560, 400, 1100)).toBe(280); // 1100 − 400 − 420 = 280: 가운데를 지킨다
    expect(clampWidth("right", 560, 400, 900)).toBe(280); // 그래도 최소보다 작아지지 않는다
  });

  test("저장한 폭: 없거나 깨지면 기본값, 범위 밖은 범위 안으로", () => {
    expect(restoreWidths(null)).toEqual(DEFAULT_WIDTHS);
    expect(restoreWidths("{")).toEqual(DEFAULT_WIDTHS);
    expect(restoreWidths('{"left": 9999, "right": "x"}')).toEqual({ left: 400, right: 340 });
  });

  test("←/→는 경계가 움직이는 방향, Home·End는 최소·최대", () => {
    expect(widthByKey("left", "ArrowRight", 260)).toBe(276);
    expect(widthByKey("right", "ArrowLeft", 340)).toBe(356);
    expect(widthByKey("right", "ArrowRight", 340)).toBe(324);
    expect(widthByKey("left", "Home", 300)).toBe(200);
    expect(widthByKey("left", "Enter", 300)).toBeNull();
  });
});

test("폭 조절 손잡이: separator와 현재·최소·최대 폭, 이름", () => {
  const api: PanelsApi = { state: EXPANDED, toggle: async () => {}, reveal() {}, registerRight: () => () => {}, widths: { left: 300, right: 340 }, setWidth() {} };
  const out = renderToStaticMarkup(createElement(PanelsContext.Provider, { value: api }, createElement(PanelResizer, { side: "left" })));
  expect(out).toContain('role="separator"');
  expect(out).toContain('aria-valuenow="300"');
  expect(out).toContain('aria-valuemin="200"');
  expect(out).toContain('aria-label="노트 목록 폭 조절"');
});

