// @vitest-environment jsdom
// 찾아 바꾸기: 일치 목록, 현재 일치 하나 / 모두 바꾸기, 바꿔도 같을 때의 안내, 바꾼 말을 자주 쓰는 단어에 추가.
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Segment } from "../lib";

const api = vi.hoisted(() => ({ glossaryAdd: vi.fn() }));
vi.mock("../api", () => ({ api, errText: (e: unknown) => (e instanceof Error ? e.message : String(e)) }));

import { useFind } from "./useFind";

const seg = (id: string, text: string): Segment => ({ id, start: 0, end: 1, text, corrected_text: null });
const visible = [seg("s0001", "예산 회의 예산안"), seg("s0002", "다음 주 일정")];

function setup() {
  const saveText = vi.fn();
  const setEditError = vi.fn();
  const notify = vi.fn();
  const hook = renderHook(() => useFind({ visible, rows: [], editingId: null, list: { current: null }, saveText, setEditError, notify }));
  return { saveText, setEditError, notify, ...hook };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("CSS", {}); // jsdom에는 CSS Custom Highlight API가 없다: 강조는 건너뛴다
});

describe("찾기", () => {
  test("찾을 말이 없으면 일치가 없다", () => {
    const { result } = setup();
    expect(result.current.matches).toEqual([]);
    expect(result.current.curMatch).toBeNull();
  });

  test("글자 그대로 모든 일치를 문장 순서로 찾는다", () => {
    const { result } = setup();
    act(() => result.current.setFind({ q: "예산", r: "", glossary: false }));
    expect(result.current.matches).toEqual([
      { id: "s0001", start: 0, length: 2 },
      { id: "s0001", start: 6, length: 2 },
    ]);
    expect(result.current.curIndex).toBe(0);
  });

  test("찾는 말을 바꾸면 현재 일치는 처음으로 돌아간다", () => {
    const { result } = setup();
    act(() => result.current.setFind({ q: "예산", r: "", glossary: false }));
    act(() => result.current.setCur(1));
    expect(result.current.curIndex).toBe(1);
    act(() => result.current.setFind({ q: "회의", r: "", glossary: false }));
    expect(result.current.curIndex).toBe(0);
  });
});

describe("바꾸기", () => {
  test("현재 일치 하나만 바꾼다", () => {
    const { result, saveText } = setup();
    act(() => result.current.setFind({ q: "예산", r: "비용", glossary: false }));
    act(() => result.current.replace(false));
    expect(saveText).toHaveBeenCalledWith([{ id: "s0001", text: "비용 회의 예산안" }]);
  });

  test("모두 바꾸면 모든 문장을 한 묶음으로 저장한다", () => {
    const { result, saveText } = setup();
    act(() => result.current.setFind({ q: "예산", r: "비용", glossary: false }));
    act(() => result.current.replace(true));
    expect(saveText).toHaveBeenCalledWith([{ id: "s0001", text: "비용 회의 비용안" }]);
  });

  test("바꿔도 내용이 같거나 비게 되면 저장하지 않고 오류 줄에 알린다", () => {
    const { result, saveText, setEditError } = setup();
    act(() => result.current.setFind({ q: "예산", r: "예산", glossary: false }));
    act(() => result.current.replace(true));
    expect(saveText).not.toHaveBeenCalled();
    expect(setEditError).toHaveBeenCalledWith(expect.stringContaining("바꾸지 않았습니다"));
  });

  test("일치가 없으면 아무 일도 하지 않는다", () => {
    const { result, saveText, setEditError } = setup();
    act(() => result.current.setFind({ q: "없는말", r: "x", glossary: false }));
    act(() => result.current.replace(true));
    expect(saveText).not.toHaveBeenCalled();
    expect(setEditError).not.toHaveBeenCalled();
  });

  test("바꾼 말을 자주 쓰는 단어에 추가하면 알려 준다", async () => {
    const { result, notify } = setup();
    api.glossaryAdd.mockResolvedValue(1);
    act(() => result.current.setFind({ q: "예산", r: " 비용 ", glossary: true }));
    await act(async () => result.current.replace(false));
    expect(api.glossaryAdd).toHaveBeenCalledWith(["비용"]); // 앞뒤 공백은 뗀다
    expect(notify).toHaveBeenCalledWith({ text: expect.stringContaining("추가했습니다") });
  });

  test("이미 있는 단어면 그렇게 알리고, 추가에 실패하면 오류로 알린다", async () => {
    const { result, notify } = setup();
    act(() => result.current.setFind({ q: "예산", r: "비용", glossary: true }));
    api.glossaryAdd.mockResolvedValueOnce(0);
    await act(async () => result.current.replace(false));
    expect(notify).toHaveBeenLastCalledWith({ text: expect.stringContaining("이미 자주 쓰는 단어에 있습니다") });
    api.glossaryAdd.mockRejectedValueOnce(new Error("사전 저장 실패"));
    await act(async () => result.current.replace(false));
    expect(notify).toHaveBeenLastCalledWith({ text: expect.stringContaining("사전 저장 실패"), error: true });
  });

  test("체크하지 않으면 자주 쓰는 단어에 추가하지 않는다", () => {
    const { result } = setup();
    act(() => result.current.setFind({ q: "예산", r: "비용", glossary: false }));
    act(() => result.current.replace(false));
    expect(api.glossaryAdd).not.toHaveBeenCalled();
  });
});
