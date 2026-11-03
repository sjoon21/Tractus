// @vitest-environment jsdom
// 파일 가져오기 줄: 줄에 세울 때의 검사(못 쓰는 상태·가져올 수 없는 형식·중복), 다른 변환이 끝난 뒤에 하나씩 시작, 끝났을 때·실패했을 때의 알림.
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Decision } from "./caps";
import type { JobState } from "./lib";

const idleJob: JobState = { running: false, stage: null, done: 0, total: 0, meetingId: null, error: null, errorCode: null, warnings: [] };
// 진짜 useJob처럼 startJob이 곧바로 running을 켜는 가짜 작업: 상태는 React state라 바뀌면 훅이 다시 그려진다
const fake = vi.hoisted(() => ({
  initial: null as unknown as JobState,
  setJob: null as unknown as (j: JobState) => void,
  startJob: vi.fn(),
  onDone: null as null | ((id: string, warnings: { code: string }[]) => void),
}));
vi.mock("./api", async () => {
  const { useState } = await import("react");
  return {
    useJob: (onDone: (id: string, warnings: { code: string }[]) => void) => {
      const [job, setJob] = useState<JobState>(fake.initial);
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

import { useImportQueue } from "./useImportQueue";

const OK: Decision = { ok: true };
const BLOCKED = { ok: false, reason: "변환 엔진이 없습니다", fix: { label: "모델 화면 열기" } } as unknown as Decision;
function setup(gate: Decision = OK) {
  const notify = vi.fn();
  const notifyBlocked = vi.fn();
  const refresh = vi.fn().mockResolvedValue([]);
  const openMeeting = vi.fn();
  const markNoteStale = vi.fn();
  const hook = renderHook(() => useImportQueue({ convertGate: () => gate, notify, notifyBlocked, refresh, openMeeting, markNoteStale }));
  return { notify, notifyBlocked, refresh, openMeeting, markNoteStale, ...hook };
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.initial = { ...idleJob };
});

/** 도는 가져오기가 끝났다 */
const finishJob = () => act(() => fake.setJob({ ...idleJob }));

describe("줄에 세우기", () => {
  test("가져올 수 있는 파일은 줄에 서고, 시작은 스케줄러가 한다 (세우기만으로 시작하지 않는다)", () => {
    const { result } = setup();
    act(() => result.current.enqueue(["/a/회의1.m4a", "/a/회의2.mp3"]));
    expect(result.current.queue).toEqual(["/a/회의1.m4a", "/a/회의2.mp3"]);
    expect(fake.startJob).not.toHaveBeenCalled();
  });

  test("가져올 수 없는 형식은 빼고 이름을 알린다", () => {
    const { result, notify } = setup();
    act(() => result.current.enqueue(["/a/문서.pdf", "/a/회의.wav"]));
    expect(notify).toHaveBeenCalledWith({ text: expect.stringContaining("문서.pdf"), error: true });
    expect(result.current.queue).toEqual(["/a/회의.wav"]);
  });

  test("이미 줄에 있는 파일은 다시 세우지 않는다", () => {
    const { result } = setup();
    act(() => result.current.enqueue(["/a/회의.m4a"]));
    act(() => result.current.enqueue(["/a/회의.m4a", "/a/다른.m4a"]));
    expect(result.current.queue).toEqual(["/a/회의.m4a", "/a/다른.m4a"]);
  });

  test("변환할 수 없는 상태(모델·도구 없음)면 줄에 세우지 않고 이유를 알린다", () => {
    const { result, notifyBlocked } = setup(BLOCKED);
    act(() => result.current.enqueue(["/a/회의.m4a"]));
    expect(notifyBlocked).toHaveBeenCalledWith(BLOCKED);
    expect(result.current.queue).toEqual([]);
  });
});

describe("시작", () => {
  test("줄의 첫 파일을 가져오기 시작하고 남은 것은 줄에 남는다 (한 번에 하나)", () => {
    const { result } = setup();
    act(() => result.current.enqueue(["/a/1.m4a", "/a/2.m4a", "/a/3.m4a"]));
    act(() => result.current.startNext());
    expect(fake.startJob).toHaveBeenCalledTimes(1);
    expect(fake.startJob).toHaveBeenCalledWith("import", "/a/1.m4a");
    expect(result.current.importing).toBe("/a/1.m4a");
    expect(result.current.queue).toEqual(["/a/2.m4a", "/a/3.m4a"]);
    finishJob();
    act(() => result.current.startNext());
    expect(fake.startJob).toHaveBeenNthCalledWith(2, "import", "/a/2.m4a");
    expect(result.current.queue).toEqual(["/a/3.m4a"]);
  });

  test("줄이 비었으면 아무것도 시작하지 않는다", () => {
    const { result } = setup();
    act(() => result.current.startNext());
    expect(fake.startJob).not.toHaveBeenCalled();
  });
});

describe("끝났을 때", () => {
  async function started() {
    const s = setup();
    act(() => s.result.current.enqueue(["/a/회의.m4a"]));
    act(() => s.result.current.startNext());
    return s;
  }

  test("노트 목록을 새로 읽고 완료를 알리며 열기 단추를 준다 (화면은 바꾸지 않는다)", async () => {
    const { refresh, notify, openMeeting } = await started();
    act(() => fake.onDone!("m-1", []));
    expect(refresh).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith({ text: expect.stringContaining("회의.m4a"), action: { label: "열기", run: expect.any(Function) } });
    notify.mock.calls.at(-1)![0].action.run();
    expect(openMeeting).toHaveBeenCalledWith("m-1");
  });

  test("이미 변환한 파일이면 그렇게 알린다", async () => {
    const { notify } = await started();
    act(() => fake.onDone!("m-1", [{ code: "duplicate" }]));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("이미 텍스트로 변환한 파일") }));
  });

  test("노트에 추가하려던 파일이면 그 노트를 다시 읽게 하고 추가했다고 알린다", async () => {
    const { result, notify, markNoteStale } = setup();
    act(() => result.current.startAttach("/a/녹음.m4a", { id: "memo-1", title: "메모 노트" } as never));
    expect(fake.startJob).toHaveBeenCalledWith("import", "/a/녹음.m4a", "memo-1");
    act(() => fake.onDone!("memo-1", []));
    expect(markNoteStale).toHaveBeenCalledWith("memo-1");
    expect(notify).toHaveBeenCalledWith({ text: expect.stringContaining("메모 노트") });
  });

  test("줄에서 시작한 가져오기는 그 노트에 추가한 것으로 보지 않는다", async () => {
    const { result, markNoteStale } = setup();
    act(() => result.current.startAttach("/a/녹음.m4a", { id: "memo-1", title: "메모 노트" } as never));
    act(() => fake.onDone!("memo-1", [{ code: "duplicate" }]));
    expect(markNoteStale).not.toHaveBeenCalled(); // 중복이면 노트가 바뀌지 않았다
  });
});

describe("실패", () => {
  test("실패하면 파일 이름과 이유를 오류로 알린다", () => {
    const { result, notify } = setup();
    act(() => result.current.enqueue(["/a/깨진.m4a"]));
    act(() => result.current.startNext());
    act(() => fake.setJob({ ...idleJob, error: "ffmpeg가 읽지 못했습니다", errorCode: null }));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("깨진.m4a"), error: true }));
  });
});

describe("진행률", () => {
  test("전체를 모르면 null, 알면 0~1", () => {
    const { result } = setup();
    expect(result.current.importPct).toBeNull();
    act(() => fake.setJob({ ...idleJob, running: true, done: 1, total: 4 }));
    expect(result.current.importPct).toBe(0.25);
  });
});
