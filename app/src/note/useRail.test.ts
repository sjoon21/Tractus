// @vitest-environment jsdom
// 오른쪽 패널 탭: 질문·메모·회의록 탭은 처음 열 때 만들고, 도크의 탭 클릭이 규칙(tabClickPlan)대로 접기·펴기·스크롤을 한다.  // words-ok: 회의록은 문서 이름
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_WIDTHS } from "../panels";
import { PanelsContext, type PanelsApi } from "../PanelToggle";

vi.mock("../memo", () => ({ flushMemos: vi.fn().mockResolvedValue(true) }));

import { useRail } from "./useRail";

function setup({ memoNote = false, collapsed = false, narrow = false } = {}) {
  const toggle = vi.fn().mockResolvedValue(undefined);
  const reveal = vi.fn();
  const panels = { state: { left: false, right: collapsed }, toggle, reveal, registerRight: () => () => {}, widths: DEFAULT_WIDTHS, setWidth: vi.fn() } as unknown as PanelsApi;
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: narrow && q.includes("1180"), media: q }));
  const setMemoPick = vi.fn();
  const memoRef = { current: memoNote };
  const wrapper = ({ children }: { children: ReactNode }) => createElement(PanelsContext.Provider, { value: panels }, children);
  const hook = renderHook(() => useRail(memoNote, memoRef, setMemoPick), { wrapper });
  return { toggle, reveal, setMemoPick, ...hook };
}

beforeEach(() => vi.clearAllMocks());

describe("탭 상태", () => {
  test("처음에는 요약이고, 질문·메모·회의록 탭은 아직 만들지 않았다", () => {
    const { result } = setup();
    expect(result.current.tabNow).toBe("summary");
    expect([result.current.askSeen, result.current.memoSeen, result.current.minutesSeen]).toEqual([false, false, false]);
  });

  test("탭을 열면 그 탭이 만들어지고 그 뒤에는 다른 탭으로 가도 남는다", () => {
    const { result } = setup();
    act(() => result.current.showTab("ask"));
    act(() => result.current.showTab("minutes"));
    act(() => result.current.showTab("summary"));
    expect([result.current.askSeen, result.current.minutesSeen, result.current.memoSeen]).toEqual([true, true, false]);
  });

  test("메모 탭을 눌러 열면 입력창에 초점을 두고, 방향키로 지나갈 때는 두지 않는다", () => {
    const { result, setMemoPick } = setup();
    act(() => result.current.showTab("memo", true));
    expect(setMemoPick).toHaveBeenCalledWith(expect.objectContaining({ segId: null }));
    setMemoPick.mockClear();
    act(() => result.current.showTab("summary"));
    act(() => result.current.showTab("memo"));
    expect(setMemoPick).not.toHaveBeenCalled();
  });

  test("메모 노트에는 회의록·메모 탭이 없고 없는 탭은 첫 탭으로 돌아간다", () => {
    const { result } = setup({ memoNote: true });
    expect(result.current.tabs).toEqual(["summary", "ask"]);
    act(() => result.current.showTab("memo"));
    expect(result.current.tabNow).toBe("summary");
  });
});

describe("도크의 탭 클릭", () => {
  test("열려 있는 탭을 다시 누르면 패널을 접는다", () => {
    const { result, toggle } = setup();
    act(() => result.current.pickTab("summary"));
    expect(toggle).toHaveBeenCalledWith("right");
  });

  test("접힌 패널에서 탭을 누르면 그 탭을 보이고 패널을 편다", () => {
    const { result, toggle } = setup({ collapsed: true });
    act(() => result.current.pickTab("ask"));
    expect(result.current.tabNow).toBe("ask");
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  test("다른 탭을 누르면 패널은 그대로 두고 탭만 바꾼다", () => {
    const { result, toggle } = setup();
    act(() => result.current.pickTab("ask"));
    expect(result.current.tabNow).toBe("ask");
    expect(toggle).not.toHaveBeenCalled();
  });

  test("좁은 창에서는 열려 있는 탭을 다시 눌러도 접지 않는다", () => {
    const { result, toggle } = setup({ narrow: true });
    act(() => result.current.pickTab("summary"));
    expect(toggle).not.toHaveBeenCalled();
  });
});

describe("메모의 줄로 가기", () => {
  test("녹음 노트는 메모 탭을 열고 접힌 패널이면 펴고 그 줄을 고른다", () => {
    const { result, reveal, setMemoPick } = setup();
    act(() => result.current.openMemoLine("m0003"));
    expect(result.current.tabNow).toBe("memo");
    expect(reveal).toHaveBeenCalled();
    expect(setMemoPick).toHaveBeenCalledWith(expect.objectContaining({ segId: "m0003" }));
  });

  test("메모 노트는 본문 편집기가 가운데에 있어 탭을 바꾸지 않고 줄만 고른다", () => {
    const { result, reveal, setMemoPick } = setup({ memoNote: true });
    act(() => result.current.openMemoLine("s0002"));
    expect(result.current.tabNow).toBe("summary");
    expect(reveal).not.toHaveBeenCalled();
    expect(setMemoPick).toHaveBeenCalledWith(expect.objectContaining({ segId: "s0002" }));
  });
});
