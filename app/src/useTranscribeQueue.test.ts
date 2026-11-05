// @vitest-environment jsdom
// 녹음 변환 줄: 세우기(중복 없이, 시작은 스케줄러), 하나씩 시작, 끝났을 때 노트 열기·알리기, 실패를 녹음 화면이 못 보여 줄 때만 알리기, 지운 녹음 잊기.
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { JobState } from "./lib";

const idleJob: JobState = { running: false, stage: null, done: 0, total: 0, meetingId: null, error: null, errorCode: null, warnings: [] };
// 진짜 useJob처럼 startJob이 곧바로 running을 켜는 가짜 작업 (useImportQueue.test.ts와 같다)
const fake = vi.hoisted(() => ({
  setJob: null as unknown as (j: JobState) => void,
  startJob: vi.fn(),
  onDone: null as null | ((id: string) => void),
}));
vi.mock("./api", async () => {
  const { useState } = await import("react");
  return {
    useJob: (onDone: (id: string) => void) => {
      const [job, setJob] = useState<JobState>(idleJob);
      fake.onDone = onDone;
      fake.setJob = setJob;
      return {
        job,
        startJob: (...args: unknown[]) => {
          fake.startJob(...args);
          setJob((j) => ({ ...j, running: true }));
        },
      };
    },
  };
});

import { useTranscribeQueue } from "./useTranscribeQueue";

const NOTE = { id: "01NOTE", title: "주간 메모" };
function setup({ recording = false, hidden = false } = {}) {
  const notify = vi.fn();
  const refresh = vi.fn().mockResolvedValue([{ id: "01NEW", title: "녹음 10:00" }]);
  const openMeeting = vi.fn();
  const markNoteStale = vi.fn();
  const state = { recording, hidden };
  const hook = renderHook(() => useTranscribeQueue({ notify, refresh, openMeeting, markNoteStale, isRecording: () => state.recording, failureHidden: () => state.hidden }));
  return { notify, refresh, openMeeting, markNoteStale, state, ...hook };
}
const flush = () => act(async () => {});

beforeEach(() => vi.clearAllMocks());

describe("줄에 세우기와 시작", () => {
  test("같은 녹음은 한 번만 서고, 세우기만으로는 시작하지 않는다. 시작하면 줄의 첫 녹음부터", () => {
    const { result } = setup();
    act(() => {
      result.current.enqueue("/r/A");
      result.current.enqueue("/r/B", NOTE);
      result.current.enqueue("/r/A");
    });
    expect(result.current.waitList.map((x) => x.dir)).toEqual(["/r/A", "/r/B"]);
    expect(result.current.waitDir).toBe("/r/A");
    expect(fake.startJob).not.toHaveBeenCalled();
    act(() => result.current.startNext());
    expect(fake.startJob).toHaveBeenCalledWith("transcribe", "/r/A", undefined);
    expect(result.current.waitDir).toBe("/r/B");
    act(() => result.current.startNext());
    expect(fake.startJob).toHaveBeenLastCalledWith("transcribe", "/r/B", "01NOTE"); // 노트에 덧붙이는 녹음
    expect(result.current.current.current).toEqual({ dir: "/r/B", target: NOTE });
  });

  test("지운 녹음은 다시 변환할 대상에서 빠진다 (다른 녹음은 그대로)", () => {
    const { result } = setup();
    act(() => result.current.enqueue("/r/A"));
    act(() => result.current.startNext());
    act(() => result.current.forget("/r/OTHER"));
    expect(result.current.current.current?.dir).toBe("/r/A");
    act(() => result.current.forget("/r/A"));
    expect(result.current.current.current).toBeNull();
  });
});

describe("끝났을 때", () => {
  test("녹음 중이 아니면 노트를 연다", async () => {
    const { result, openMeeting, notify, markNoteStale } = setup();
    act(() => result.current.enqueue("/r/A"));
    act(() => result.current.startNext());
    fake.onDone!("01NEW");
    await flush();
    expect(openMeeting).toHaveBeenCalledWith("01NEW");
    expect(notify).not.toHaveBeenCalled();
    expect(markNoteStale).not.toHaveBeenCalled();
  });

  test("다음 녹음 중이면 화면을 바꾸지 않고 제목과 `열기`로 알린다", async () => {
    const { result, openMeeting, notify } = setup({ recording: true });
    act(() => result.current.enqueue("/r/A"));
    act(() => result.current.startNext());
    fake.onDone!("01NEW");
    await flush();
    expect(openMeeting).not.toHaveBeenCalled();
    const toast = notify.mock.calls[0][0];
    expect(toast.text).toContain("녹음 10:00");
    toast.action.run();
    expect(openMeeting).toHaveBeenCalledWith("01NEW");
  });

  test("노트에 덧붙인 녹음이면 그 노트를 다시 읽게 한다", async () => {
    const { result, markNoteStale } = setup();
    act(() => result.current.enqueue("/r/A", NOTE));
    act(() => result.current.startNext());
    fake.onDone!("01NOTE");
    await flush();
    expect(markNoteStale).toHaveBeenCalledWith("01NOTE");
  });
});

describe("실패 알림", () => {
  const fail = () => act(() => fake.setJob({ ...idleJob, error: "변환하지 못했습니다" }));

  test("녹음 화면에 보이면 알리지 않는다", () => {
    const { result, notify } = setup();
    act(() => result.current.enqueue("/r/A"));
    act(() => result.current.startNext());
    fail();
    expect(notify).not.toHaveBeenCalled();
  });

  test("녹음 화면이 못 보여 주면(다음 녹음 중·화면을 떠남) 알린다", () => {
    const { result, notify } = setup({ hidden: true });
    act(() => result.current.enqueue("/r/A"));
    act(() => result.current.startNext());
    fail();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ error: true }));
  });

  test("다음 녹음이 줄에 있으면 곧 그 진행으로 바뀌므로 알린다", () => {
    const { result, notify } = setup();
    act(() => result.current.enqueue("/r/A"));
    act(() => result.current.startNext());
    act(() => result.current.enqueue("/r/B"));
    fail();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ error: true }));
  });
});
