// @vitest-environment jsdom
// 파일 끌어다 놓기: 덮개 켜고 끄기, 놓은 파일을 가져오기 줄에 세우기, 글만 있는 노트를 보고 있으면 파일 하나는 그 노트에 추가할지 묻기.
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

type Payload = { type: "enter" | "over" | "leave" | "drop"; paths: string[] };
const drag = vi.hoisted(() => ({ emit: null as null | ((p: Payload) => void) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (h: (e: { payload: Payload }) => void) => {
      drag.emit = (payload) => h({ payload });
      return Promise.resolve(() => {});
    },
  }),
}));

import { useFileDrop } from "./useFileDrop";

const enqueue = vi.fn();
beforeEach(() => enqueue.mockClear());

test("끌어 오는 동안 덮개를 보이고, 놓으면 끄고 줄에 세운다", () => {
  const { result } = renderHook(() => useFileDrop(enqueue));
  act(() => drag.emit!({ type: "enter", paths: ["/a.m4a", "/b.mp3"] }));
  expect([result.current.dropping, result.current.dropCount]).toEqual([true, 2]);
  act(() => drag.emit!({ type: "leave", paths: [] }));
  expect(result.current.dropping).toBe(false);
  act(() => drag.emit!({ type: "drop", paths: ["/a.m4a"] }));
  expect(enqueue).toHaveBeenCalledWith(["/a.m4a"]);
  expect(result.current.dropAsk).toBeNull();
});

test("앱 안에서 끄는 것(경로 없음)은 덮개도 줄도 없다", () => {
  const { result } = renderHook(() => useFileDrop(enqueue));
  act(() => drag.emit!({ type: "enter", paths: [] }));
  act(() => drag.emit!({ type: "drop", paths: [] }));
  expect(result.current.dropping).toBe(false);
  expect(enqueue).not.toHaveBeenCalled();
});

test("노트를 보고 있으면 파일 하나는 그 노트에 추가할지 묻고, 여러 개는 줄에 세운다", () => {
  const { result } = renderHook(() => useFileDrop(enqueue));
  const note = { id: "01NOTE", title: "주간 메모" };
  result.current.dropNote.current = note;
  act(() => drag.emit!({ type: "drop", paths: ["/a.m4a"] }));
  expect(result.current.dropAsk).toEqual({ target: note, path: "/a.m4a" });
  expect(enqueue).not.toHaveBeenCalled();
  act(() => drag.emit!({ type: "drop", paths: ["/a.m4a", "/b.mp3"] }));
  expect(enqueue).toHaveBeenCalledWith(["/a.m4a", "/b.mp3"]);
});
