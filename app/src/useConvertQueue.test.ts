// @vitest-environment jsdom
// 변환 전 노트의 변환 줄: 올리기(한 노트·모두), 시작(목록을 읽은 뒤·지워졌거나 이미 변환한 노트는 건너뜀·같은 노트를 두 번 시작하지 않음),
// 끝났을 때(알림·열기 단추·줄 넘기기), 새 녹음이 변환을 멈췄을 때의 이어하기. 언제 시작하는지는 useWorkScheduler가 정한다.
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Decision } from "./caps";
import type { JobState } from "./lib";

const idleJob: JobState = { running: false, stage: null, done: 0, total: 0, meetingId: null, error: null, errorCode: null, warnings: [] };
const store = vi.hoisted(() => ({
  job: null as unknown as JobState,
  start: vi.fn(),
  cancel: vi.fn(),
  onFinish: null as null | ((f: { noteId: string; ok: boolean; state: { error: string | null; errorCode: string | null; warnings: { code: string }[] } }) => void),
}));
vi.mock("./convertJobs", () => ({
  convertStore: { start: store.start, cancel: store.cancel },
  useConvertJob: () => store.job,
  attachConvertJobs: (cb: typeof store.onFinish) => {
    store.onFinish = cb;
    return () => {};
  },
}));

import { CONVERT_PAUSED } from "./recorded";
import { useConvertQueue } from "./useConvertQueue";

const OK: Decision = { ok: true };
const BLOCKED = { ok: false, reason: "변환 엔진이 없습니다", fix: { label: "모델 화면 열기" } } as unknown as Decision;
const note = (id: string, over: Record<string, unknown> = {}) => ({ id, title: `노트 ${id}`, state: "recorded", created_at: `2026-11-0${id.length}T00:00:00+09:00`, ...over }) as never;

function setup({ meetings = [note("a"), note("b")], gate = OK, viewing = "" } = {}) {
  const notify = vi.fn();
  const notifyBlocked = vi.fn();
  const refresh = vi.fn().mockResolvedValue([]);
  const openMeeting = vi.fn();
  const hook = renderHook((p: { meetings: unknown[] }) => useConvertQueue({ meetings: p.meetings as never, convertGate: () => gate, notify, notifyBlocked, refresh, openMeeting, isViewing: (id) => id === viewing }), { initialProps: { meetings } });
  return { notify, notifyBlocked, refresh, openMeeting, ...hook };
}

beforeEach(() => {
  vi.clearAllMocks();
  store.job = { ...idleJob };
});

describe("줄에 올리기", () => {
  test("변환 전 노트 하나를 올리면 그 노트가 차례다", () => {
    const { result } = setup();
    act(() => result.current.convertNote("a"));
    expect(result.current.queue.current).toBe("a");
    expect(result.current.converting).toBe(true);
  });

  test("변환할 수 없는 상태면 올리지 않고 이유를 알린다", () => {
    const { result, notifyBlocked } = setup({ gate: BLOCKED });
    act(() => result.current.convertNote("a"));
    expect(notifyBlocked).toHaveBeenCalledWith(BLOCKED);
    expect(result.current.converting).toBe(false);
  });

  test("모두 변환은 변환 전 노트만 만든 순서로 올린다 (메모·이미 변환한 노트는 뺀다)", () => {
    const meetings = [note("b", { created_at: "2026-11-02T00:00:00+09:00" }), note("a", { created_at: "2026-11-01T00:00:00+09:00" }), note("c", { state: null }), note("m", { kind: "memo" })];
    const { result } = setup({ meetings });
    expect(result.current.bulkIds).toEqual(["a", "b"]);
    act(() => result.current.convertAll());
    expect(result.current.queue.current).toBe("a");
    expect(result.current.queue.pending).toEqual(["b"]);
  });

  test("같은 노트를 두 번 올려도 한 번만 선다", () => {
    const { result } = setup();
    act(() => result.current.convertNote("a"));
    act(() => result.current.convertNote("a"));
    expect(result.current.queue.pending).toEqual([]);
  });

  test("줄 안의 위치를 노트마다 알려 준다 (도는 중·기다리는 중)", () => {
    const { result } = setup();
    act(() => result.current.convertAll());
    expect(result.current.slotOf("a")).toBe("queued"); // 아직 시작하지 않았다
    store.job = { ...idleJob, running: true };
    act(() => result.current.convertNote("zz")); // 다시 그리게 한다
    expect(result.current.slotOf("a")).toBe("running");
    expect(result.current.slotOf("b")).toBe("queued");
  });
});

describe("시작", () => {
  test("시작해도 되면 줄의 첫 노트를 변환하고, 같은 노트를 두 번 시작하지 않는다", () => {
    const { result } = setup();
    act(() => result.current.convertNote("a"));
    act(() => result.current.tryStart(true, true));
    expect(store.start).toHaveBeenCalledWith("a");
    act(() => result.current.tryStart(true, true));
    expect(store.start).toHaveBeenCalledTimes(1);
  });

  test("시작하면 안 되는 때(다른 변환이 돌 때)는 기다린다", () => {
    const { result } = setup();
    act(() => result.current.convertNote("a"));
    act(() => result.current.tryStart(true, false));
    expect(store.start).not.toHaveBeenCalled();
    expect(result.current.queue.current).toBe("a");
  });

  test("노트 목록을 읽기 전에는 지워졌는지 알 수 없어 아무것도 하지 않는다", () => {
    const { result } = setup({ meetings: [] });
    act(() => result.current.convertNote("a"));
    act(() => result.current.tryStart(false, true));
    expect(store.start).not.toHaveBeenCalled();
    expect(result.current.queue.current).toBe("a");
  });

  test("지워졌거나 이미 변환한 노트는 시작하지 않고 줄을 넘긴다", () => {
    const { result } = setup({ meetings: [note("b")] }); // a는 목록에 없다
    act(() => result.current.convertNote("a"));
    act(() => result.current.convertNote("b"));
    act(() => result.current.tryStart(true, true));
    expect(store.start).not.toHaveBeenCalled();
    expect(result.current.queue.current).toBe("b"); // a는 건너뛰었다
    const done = setup({ meetings: [note("c", { state: null })] }); // 이미 변환했다
    act(() => done.result.current.convertNote("c"));
    act(() => done.result.current.tryStart(true, true));
    expect(done.result.current.converting).toBe(false);
  });

  test("줄이 비면 시작할 것이 없다", () => {
    const { result } = setup();
    act(() => result.current.tryStart(true, true));
    expect(store.start).not.toHaveBeenCalled();
  });
});

describe("끝났을 때", () => {
  const finish = (noteId: string, ok: boolean, state: Partial<{ error: string | null; errorCode: string | null; warnings: { code: string }[] }> = {}) =>
    act(() => store.onFinish!({ noteId, ok, state: { error: null, errorCode: null, warnings: [], ...state } }));

  test("성공하면 완료를 알리고 열기 단추를 주며 목록을 새로 읽고 줄을 넘긴다", () => {
    const { result, notify, refresh, openMeeting } = setup();
    act(() => result.current.convertAll());
    finish("a", true);
    expect(notify).toHaveBeenCalledWith({ text: expect.stringContaining("노트 a"), action: { label: "열기", run: expect.any(Function) } });
    notify.mock.calls[0][0].action.run();
    expect(openMeeting).toHaveBeenCalledWith("a");
    expect(refresh).toHaveBeenCalled();
    expect(result.current.queue.current).toBe("b");
  });

  test("지금 보고 있는 노트면 열기 단추를 주지 않는다", () => {
    const { result, notify } = setup({ viewing: "a" });
    act(() => result.current.convertNote("a"));
    finish("a", true);
    expect(notify).toHaveBeenCalledWith({ text: expect.any(String), action: undefined });
  });

  test("실패해도 오류로 알리고 줄은 이어진다", () => {
    const { result, notify } = setup();
    act(() => result.current.convertAll());
    finish("a", false, { error: "ffmpeg 오류" });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ error: true, text: expect.stringContaining("노트 a") }));
    expect(result.current.queue.current).toBe("b");
  });

  test("다른 노트의 끝 소식은 줄을 넘기지 않는다", () => {
    const { result } = setup();
    act(() => result.current.convertAll());
    finish("zz", true);
    expect(result.current.queue.current).toBe("a");
  });

  test("경고가 있으면 하나씩 알린다", () => {
    const { result, notify } = setup();
    act(() => result.current.convertNote("a"));
    finish("a", true, { warnings: [{ code: "diarizer_missing" }] });
    expect(notify.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("새 녹음이 변환을 멈췄을 때", () => {
  test("도는 변환을 취소하고 알린다", () => {
    store.job = { ...idleJob, running: true };
    const { result, notify } = setup();
    act(() => result.current.convertNote("a"));
    act(() => result.current.preempt());
    expect(store.cancel).toHaveBeenCalledWith("a");
    expect(notify).toHaveBeenCalledWith({ text: CONVERT_PAUSED });
  });

  test("돌고 있지 않으면 아무것도 하지 않는다", () => {
    const { result, notify } = setup();
    act(() => result.current.convertNote("a"));
    act(() => result.current.preempt());
    expect(store.cancel).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  test("멈춘 변환의 실패 소식은 알리지 않고 줄도 넘기지 않으며, 같은 노트를 다시 시작할 수 있다", () => {
    store.job = { ...idleJob, running: true };
    const { result, notify } = setup();
    act(() => result.current.convertNote("a"));
    act(() => result.current.tryStart(true, true));
    expect(store.start).toHaveBeenCalledTimes(1);
    act(() => result.current.preempt());
    notify.mockClear();
    act(() => store.onFinish!({ noteId: "a", ok: false, state: { error: "취소됨", errorCode: null, warnings: [] } }));
    expect(notify).not.toHaveBeenCalled();
    expect(result.current.queue.current).toBe("a");
    act(() => result.current.tryStart(true, true));
    expect(store.start).toHaveBeenCalledTimes(2); // 이어서 시작한다
  });
});
