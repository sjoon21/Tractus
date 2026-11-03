// @vitest-environment jsdom
// 중앙 스케줄러: 활동 상태가 바뀔 때 규칙(jobSchedule)대로 다음 것을 시작한다. 규칙 자체의 표는 jobSchedule.test.ts에 있다.
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Activity } from "./jobSchedule";
import { useWorkScheduler } from "./useWorkScheduler";

const idle: Activity = {
  recording: false,
  liveRec: false,
  asking: false,
  transcribeRunning: false,
  transcribeWaiting: false,
  finishRunning: false,
  converting: false,
  convertRunning: false,
  importRunning: false,
  importWaiting: false,
};

const startNextTranscribe = vi.fn();
const tryStartConvert = vi.fn();
const startNextImport = vi.fn();

function setup(activity: Partial<Activity> = {}, listLoaded = true) {
  let current = { activity: { ...idle, ...activity }, listLoaded, startNextTranscribe, tryStartConvert, convertWatch: [] as unknown, startNextImport, waitKey: [] as unknown, importKey: [] as unknown };
  const hook = renderHook((p: typeof current) => useWorkScheduler(p), { initialProps: current });
  /** 활동 상태를 (누적해서) 바꾸고 다시 그린다 */
  const update = (a: Partial<Activity>, rest: Partial<typeof current> = {}) => {
    current = { ...current, ...rest, activity: { ...current.activity, ...a } };
    hook.rerender(current);
  };
  return { ...hook, update };
}

beforeEach(() => vi.clearAllMocks());

describe("녹음 변환", () => {
  test("기다리는 녹음이 있고 다른 일이 없으면 시작한다", () => {
    setup({ transcribeWaiting: true });
    expect(startNextTranscribe).toHaveBeenCalledTimes(1);
  });
  test("자막이 도는 녹음 중에는 시작하지 않고, 녹음이 끝나면 시작한다", () => {
    const { update } = setup({ transcribeWaiting: true, recording: true, liveRec: true });
    expect(startNextTranscribe).not.toHaveBeenCalled();
    update({ recording: false });
    expect(startNextTranscribe).toHaveBeenCalledTimes(1);
  });
  test("앞 변환이 끝나면 다음 녹음을 시작한다", () => {
    const { update } = setup({ transcribeWaiting: true, transcribeRunning: true });
    expect(startNextTranscribe).not.toHaveBeenCalled();
    update({ transcribeRunning: false });
    expect(startNextTranscribe).toHaveBeenCalledTimes(1);
  });
});

describe("변환 전 노트의 변환 줄", () => {
  test("매번 줄을 살피되, 시작해도 되는지는 규칙이 정해 넘긴다", () => {
    setup({ converting: true });
    expect(tryStartConvert).toHaveBeenLastCalledWith(true, true);
  });
  test("녹음 변환이 기다리면 시작해도 되지 않는다고 넘긴다 (줄의 정리는 계속한다)", () => {
    setup({ converting: true, transcribeWaiting: true });
    expect(tryStartConvert).toHaveBeenLastCalledWith(true, false);
  });
  test("노트 목록을 읽었는지도 넘긴다", () => {
    setup({ converting: true }, false);
    expect(tryStartConvert).toHaveBeenLastCalledWith(false, true);
  });
  test("노트 목록이 바뀌면 다시 살핀다", () => {
    const { update } = setup({ converting: true });
    const n = tryStartConvert.mock.calls.length;
    update({}, { convertWatch: [{ id: "새 목록" }] });
    expect(tryStartConvert.mock.calls.length).toBe(n + 1);
  });
});

describe("파일 가져오기", () => {
  test("어떤 변환도 없으면 시작한다", () => {
    setup({ importWaiting: true });
    expect(startNextImport).toHaveBeenCalledTimes(1);
  });
  test.each(["transcribeWaiting", "transcribeRunning", "finishRunning", "converting"] as const)("%s이면 기다리고, 끝나면 시작한다", (k) => {
    const { update } = setup({ importWaiting: true, [k]: true });
    expect(startNextImport).not.toHaveBeenCalled();
    update({ [k]: false });
    expect(startNextImport).toHaveBeenCalledTimes(1);
  });
});

describe("우선순위", () => {
  test("세 줄이 모두 기다리면 녹음 변환만 시작하고, 끝나면 변환 줄, 그다음 가져오기가 차례로 온다", () => {
    const { update } = setup({ transcribeWaiting: true, converting: true, importWaiting: true });
    expect(startNextTranscribe).toHaveBeenCalledTimes(1);
    expect(tryStartConvert).toHaveBeenLastCalledWith(true, false);
    expect(startNextImport).not.toHaveBeenCalled();
    update({ transcribeWaiting: false });
    expect(tryStartConvert).toHaveBeenLastCalledWith(true, true);
    expect(startNextImport).not.toHaveBeenCalled(); // 변환 줄이 아직 있다
    update({ converting: false });
    expect(startNextImport).toHaveBeenCalledTimes(1);
  });
});
