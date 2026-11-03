// @vitest-environment jsdom
// 노트 데이터·편집 훅의 동작 (useNote가 조립한 것): 낙관적 반영, 실패 복구, 되돌리기, 삭제를 기다리는 동안의 막힘, 제목·녹음 중 메모 고치기.
// 코어(api)만 가짜로 바꾸고 훅·저장 줄(editQueue)·상태 전이는 진짜를 쓴다.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MeetingDetail } from "../api";
import { editQueue } from "../editQueue";
import { segText } from "../lib";
import { EDIT_BLOCKED } from "../remove";

const api = vi.hoisted(() => ({
  editSegments: vi.fn(),
  noteTitle: vi.fn(),
  marksSave: vi.fn(),
  editSpeakers: vi.fn(),
  glossaryAdd: vi.fn(),
}));
vi.mock("../api", () => ({ api, errText: (e: unknown) => (e instanceof Error ? e.message : String(e)), errDetail: () => null }));
const touch = vi.hoisted(() => vi.fn());
vi.mock("../indexer", () => ({ indexer: { touch } }));

import { useNote } from "./useNote";

const seg = (id: string, text: string) => ({ id, start: 0, end: 1, text, corrected_text: null });
const note = (title = "제목", texts = ["안녕하세요", "반갑습니다"], updated = "2026-11-03T10:00:00+09:00") =>
  ({ info: { title, updated_at: updated }, segments: texts.map((t, i) => seg(`s000${i + 1}`, t)), memos: [], speakers: {} }) as unknown as MeetingDetail;
const shown = (d: MeetingDetail | null) => d?.segments.map(segText);

/** 끝낼 때를 정할 수 있는 약속 (저장 중인 상태를 들여다보려고) */
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

let n = 0;
function setup(summaryStale = false) {
  const id = `note-${++n}`; // 저장 줄은 모듈에 있으므로 테스트마다 다른 노트로 쓴다
  const notify = vi.fn();
  const onEdited = vi.fn();
  const onChanged = vi.fn();
  const hook = renderHook(() => useNote({ id, summaryStale, notify, onEdited, onChanged }));
  act(() => hook.result.current.data.commit(note()));
  return { id, notify, onEdited, onChanged, ...hook };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("문장 편집", () => {
  test("저장하는 동안 고친 문장이 보이고, 코어가 돌려준 노트로 바뀌며, 수정 시각·낡음 표시·색인을 알린다", async () => {
    const { result, id, onEdited } = setup();
    const saving = deferred<{ changed: number; meeting: MeetingDetail }>();
    api.editSegments.mockReturnValue(saving.promise);

    act(() => result.current.text.saveText([{ id: "s0001", text: "고친 문장" }]));
    expect(shown(result.current.data.detail)).toEqual(["고친 문장", "반갑습니다"]); // 낙관적 반영
    expect(result.current.queue.editing).toBe(true);
    await act(async () => {}); // 저장 줄은 작업을 다음 틱에 시작한다
    expect(api.editSegments).toHaveBeenCalledWith(id, [{ id: "s0001", text: "고친 문장" }]);

    const saved = note("제목", ["고친 문장", "반갑습니다"], "2026-11-03T11:00:00+09:00");
    await act(async () => saving.resolve({ changed: 1, meeting: saved }));
    expect(result.current.data.detail).toBe(saved);
    expect(result.current.queue.editing).toBe(false);
    expect(onEdited).toHaveBeenCalledWith(id, "2026-11-03T11:00:00+09:00");
    expect(result.current.seq.editSeq).toBe(1);
    expect(touch).toHaveBeenCalledTimes(1);
  });

  test("코어가 아무것도 바꾸지 않았으면 노트만 받고 수정 시각·낡음 표시는 건드리지 않는다", async () => {
    const { result, onEdited } = setup();
    api.editSegments.mockResolvedValue({ changed: 0, meeting: note() });
    await act(async () => result.current.text.saveText([{ id: "s0001", text: "안녕하세요" }]));
    expect(onEdited).not.toHaveBeenCalled();
    expect(result.current.seq.editSeq).toBe(0);
    expect(touch).not.toHaveBeenCalled();
  });

  test("저장이 실패하면 원래 문장으로 돌아가고 고친 문장을 오류 줄에 남기며 되돌릴 것도 쌓지 않는다", async () => {
    const { result } = setup();
    api.editSegments.mockRejectedValue(new Error("디스크가 가득 찼습니다"));
    await act(async () => result.current.text.saveText([{ id: "s0001", text: "고친 문장" }]));
    expect(shown(result.current.data.detail)).toEqual(["안녕하세요", "반갑습니다"]);
    expect(result.current.queue.editError).toContain("고친 문장");
    expect(result.current.queue.editError).toContain("디스크가 가득 찼습니다");
    expect(result.current.text.undoStack.current).toEqual([]);
    expect(result.current.queue.editing).toBe(false);
  });

  test("되돌리기는 코어가 확인한 직전 문장으로 저장한다", async () => {
    const { result } = setup();
    api.editSegments.mockResolvedValueOnce({ changed: 1, meeting: note("제목", ["고친 문장", "반갑습니다"]) });
    await act(async () => result.current.text.saveText([{ id: "s0001", text: "고친 문장" }]));
    expect(result.current.text.undoStack.current).toEqual([[{ id: "s0001", text: "안녕하세요" }]]);

    api.editSegments.mockResolvedValueOnce({ changed: 1, meeting: note() });
    await act(async () => result.current.text.undo());
    expect(api.editSegments).toHaveBeenLastCalledWith(expect.any(String), [{ id: "s0001", text: "안녕하세요" }]);
    expect(result.current.text.undoStack.current).toEqual([]);
    expect(shown(result.current.data.detail)).toEqual(["안녕하세요", "반갑습니다"]);
  });

  test("되돌리기 저장이 실패하면 그 묶음을 스택에 다시 올려 둔다", async () => {
    const { result } = setup();
    api.editSegments.mockResolvedValueOnce({ changed: 1, meeting: note("제목", ["고친 문장", "반갑습니다"]) });
    await act(async () => result.current.text.saveText([{ id: "s0001", text: "고친 문장" }]));
    api.editSegments.mockRejectedValueOnce(new Error("실패"));
    await act(async () => result.current.text.undo());
    expect(result.current.text.undoStack.current).toEqual([[{ id: "s0001", text: "안녕하세요" }]]);
  });

  test("되돌릴 것이 없으면 아무것도 저장하지 않는다", async () => {
    const { result } = setup();
    await act(async () => result.current.text.undo());
    expect(api.editSegments).not.toHaveBeenCalled();
  });

  test("삭제를 기다리는 중에는 낙관적 반영도 저장도 하지 않고 오류 줄에 알린다", async () => {
    const { result, id } = setup();
    editQueue.block(id);
    await act(async () => result.current.text.saveText([{ id: "s0001", text: "고친 문장" }]));
    expect(api.editSegments).not.toHaveBeenCalled();
    expect(shown(result.current.data.detail)).toEqual(["안녕하세요", "반갑습니다"]);
    expect(result.current.queue.editError).toBe(EDIT_BLOCKED);
    editQueue.unblock(id);
  });

  test("연달아 고치면 줄에 서서 차례로 저장된다", async () => {
    const { result, id } = setup();
    const first = deferred<{ changed: number; meeting: MeetingDetail }>();
    api.editSegments.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ changed: 1, meeting: note("제목", ["하나", "둘"]) });
    act(() => {
      result.current.text.saveText([{ id: "s0001", text: "하나" }]);
      result.current.text.saveText([{ id: "s0002", text: "둘" }]);
    });
    expect(shown(result.current.data.detail)).toEqual(["하나", "둘"]); // 둘 다 낙관적으로 보인다
    await act(async () => {});
    expect(api.editSegments).toHaveBeenCalledTimes(1); // 둘째는 첫째가 끝나길 기다린다
    await act(async () => first.resolve({ changed: 1, meeting: note("제목", ["하나", "반갑습니다"]) }));
    expect(api.editSegments).toHaveBeenCalledTimes(2);
    expect(api.editSegments).toHaveBeenNthCalledWith(2, id, [{ id: "s0002", text: "둘" }]);
  });
});

describe("제목 바꾸기", () => {
  test("낙관적으로 바꾸고, 저장된 제목으로 확정하며 사이드바 목록을 새로 읽게 한다", async () => {
    const { result, onChanged } = setup();
    const saving = deferred<string>();
    api.noteTitle.mockReturnValue(saving.promise);
    act(() => result.current.renameNote("새 제목"));
    expect(result.current.data.detail?.info.title).toBe("새 제목");
    await act(async () => saving.resolve("새 제목 (정리됨)"));
    expect(result.current.data.detail?.info.title).toBe("새 제목 (정리됨)");
    expect(result.current.data.confirmed.current?.info.title).toBe("새 제목 (정리됨)");
    expect(onChanged).toHaveBeenCalled();
  });

  test("실패하면 원래 제목으로 돌아가고 알린다", async () => {
    const { result, notify } = setup();
    api.noteTitle.mockRejectedValue(new Error("저장 실패"));
    await act(async () => result.current.renameNote("새 제목"));
    expect(result.current.data.detail?.info.title).toBe("제목");
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ text: "저장 실패", error: true }));
  });

  test("삭제를 기다리는 중에는 바꾸지 않고 알림으로 알린다", async () => {
    const { result, id, notify } = setup();
    editQueue.block(id);
    await act(async () => result.current.renameNote("새 제목"));
    expect(api.noteTitle).not.toHaveBeenCalled();
    expect(result.current.data.detail?.info.title).toBe("제목");
    expect(notify).toHaveBeenCalledWith({ text: EDIT_BLOCKED, error: true });
    editQueue.unblock(id);
  });
});

describe("녹음 중 메모·북마크 고치기", () => {
  const marks = [{ t: 3, kind: "memo" as const, text: "확인" }];
  test("낙관적으로 바꾸고, 코어가 확인한 목록으로 확정한다", async () => {
    const { result } = setup();
    const saving = deferred<{ marks: typeof marks }>();
    api.marksSave.mockReturnValue(saving.promise);
    act(() => result.current.saveMarks(marks));
    expect(result.current.data.detail?.memos).toEqual(marks);
    const confirmedByCore = [{ ...marks[0], text: "확인 (코어가 다듬음)" }];
    await act(async () => saving.resolve({ marks: confirmedByCore }));
    expect(result.current.data.detail?.memos).toEqual(confirmedByCore);
    expect(result.current.data.confirmed.current?.memos).toEqual(confirmedByCore);
  });

  test("실패하면 코어가 확인한 목록으로 되돌리고 알린다", async () => {
    const { result, notify } = setup();
    api.marksSave.mockRejectedValue(new Error("메모 저장 실패"));
    await act(async () => result.current.saveMarks(marks));
    expect(result.current.data.detail?.memos).toEqual([]);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ text: "메모 저장 실패", error: true }));
  });
});

describe("요약이 낡았는지", () => {
  test("녹음을 방금 추가해 연 노트는 처음부터 낡음으로 시작한다", () => {
    const { result } = setup(true);
    expect(result.current.seq.editSeq).toBe(1);
    expect(result.current.seq.editKinds.current).toEqual(["text"]);
  });
});

describe("화자 편집", () => {
  test("코어가 돌려준 노트로 바뀐다", async () => {
    const { result, id } = setup();
    const renamed = note("제목", ["안녕하세요", "반갑습니다"], "2026-11-03T12:00:00+09:00");
    api.editSpeakers.mockResolvedValue(renamed);
    await act(async () => result.current.speakers.editSpeakers({ op: "rename", label: "S1", name: "김지훈" }));
    expect(api.editSpeakers).toHaveBeenCalledWith(id, { op: "rename", label: "S1", name: "김지훈" });
    expect(result.current.data.detail).toBe(renamed);
  });

  test("실패하면 노트는 그대로이고 오류 줄에 남긴다", async () => {
    const { result } = setup();
    api.editSpeakers.mockRejectedValue(new Error("화자 편집 실패"));
    await act(async () => result.current.speakers.editSpeakers({ op: "dismiss", label: "S1" }));
    expect(result.current.queue.editError).toBe("화자 편집 실패");
  });
});
