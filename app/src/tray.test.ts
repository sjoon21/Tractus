import { describe, expect, test, vi } from "vitest";
import type { RecPhase } from "./lib";
import { createTraySender, deriveTrayState, recentNotes, routeTrayAction, type TrayInput, type TrayPayload } from "./tray";

const note = (id: string, updated_at: string | undefined, created_at = "2026-10-01T09:00:00+09:00", title = `노트 ${id}`) => ({ id, title, created_at, updated_at });

const base: TrayInput = {
  rec: { phase: "idle" },
  startedAtMs: null,
  job: { running: false, done: 0, total: 0 },
  waiting: false,
  importing: { active: false, done: 0, total: 0 },
  recordOk: true,
  notes: [],
};
const input = (o: Partial<TrayInput>): TrayInput => ({ ...base, ...o });

describe("recentNotes", () => {
  test("최근에 고친 순으로 5개만, updated_at이 없으면 만든 시각", () => {
    const notes = [
      note("a", "2026-10-02T10:00:00+09:00"),
      note("b", undefined, "2026-10-05T10:00:00+09:00"),
      note("c", "2026-10-03T10:00:00+09:00"),
      note("d", "2026-10-01T10:00:00+09:00"),
      note("e", "2026-10-04T10:00:00+09:00"),
      note("f", "2026-09-01T10:00:00+09:00"),
      note("g", "2026-10-06T10:00:00+09:00"),
    ];
    expect(recentNotes(notes).map((n) => n.id)).toEqual(["g", "b", "e", "c", "a"]);
  });

  test("시각이 같거나 읽을 수 없으면 목록 순서를 지킨다", () => {
    const same = "2026-10-02T10:00:00+09:00";
    expect(recentNotes([note("x", same), note("y", same), note("z", "깨진 값", "깨진 값")]).map((n) => n.id)).toEqual(["x", "y", "z"]);
  });

  test("시간대가 달라도 실제 시각으로 비교한다", () => {
    // 10:00+09:00 = 01:00Z, 02:00Z가 더 늦다
    expect(recentNotes([note("a", "2026-10-02T10:00:00+09:00"), note("b", "2026-10-02T02:00:00Z")]).map((n) => n.id)).toEqual(["b", "a"]);
  });

  test("제목과 ID만 싣는다", () => {
    expect(recentNotes([note("a", "2026-10-02T10:00:00+09:00", undefined, "회의 준비")])).toEqual([{ id: "a", title: "회의 준비" }]);
  });
});

describe("deriveTrayState", () => {
  test("쉬는 중이면 녹음 프로그램이 있을 때만 녹음할 수 있다", () => {
    expect(deriveTrayState(input({}))).toMatchObject({ phase: "idle", can_record: true, can_bookmark: false });
    expect(deriveTrayState(input({ recordOk: false }))).toMatchObject({ phase: "idle", can_record: false });
    for (const phase of ["stopped", "error"] as RecPhase[]) expect(deriveTrayState(input({ rec: { phase } })).phase).toBe("idle");
  });

  test("녹음 중: 시작 시각을 싣고 북마크를 켠다", () => {
    const p = deriveTrayState(input({ rec: { phase: "recording" }, startedAtMs: 1_700_000_000_000 }));
    expect(p).toMatchObject({ phase: "recording", started_at_ms: 1_700_000_000_000, can_record: false, can_bookmark: true });
    expect(deriveTrayState(input({ rec: { phase: "recording" } }))).not.toHaveProperty("started_at_ms");
  });

  test("시작하는 중: 시각 없이 녹음으로 보고 북마크는 막는다", () => {
    const p = deriveTrayState(input({ rec: { phase: "starting" }, startedAtMs: 123 }));
    expect(p).toMatchObject({ phase: "recording", can_record: false, can_bookmark: false });
    expect(p).not.toHaveProperty("started_at_ms");
  });

  test("변환 중: 진행률을 싣고 새 녹음은 막는다 (창의 녹음 단추와 같다)", () => {
    expect(deriveTrayState(input({ job: { running: true, done: 9, total: 20 } }))).toMatchObject({ phase: "converting", progress_pct: 45, can_record: false });
    expect(deriveTrayState(input({ job: { running: true, done: 1, total: 3 } })).progress_pct).toBe(33);
    expect(deriveTrayState(input({ job: { running: true, done: 30, total: 20 } })).progress_pct).toBe(100);
    // 총량을 모르는 단계, 기다리는 중, 마무리하는 중은 진행률 없이 변환 중
    for (const i of [input({ job: { running: true, done: 0, total: 0 } }), input({ waiting: true }), input({ rec: { phase: "stopping" } })]) {
      const p = deriveTrayState(i);
      expect(p).toMatchObject({ phase: "converting", can_record: false });
      expect(p).not.toHaveProperty("progress_pct");
    }
    // 끝난 작업의 마지막 진행률은 남아 있어도 쉬는 중으로 본다
    expect(deriveTrayState(input({ job: { running: false, done: 20, total: 20 } })).phase).toBe("idle");
  });

  test("파일 가져오기 변환 중: 변환 중으로 보이지만 녹음은 창처럼 시작할 수 있다", () => {
    expect(deriveTrayState(input({ importing: { active: true, done: 1, total: 4 } }))).toMatchObject({ phase: "converting", progress_pct: 25, can_record: true, can_bookmark: false });
    // 총량을 모르거나 대기 중인 파일만 있으면 진행률 없이
    const p = deriveTrayState(input({ importing: { active: true, done: 0, total: 0 } }));
    expect(p).toMatchObject({ phase: "converting", can_record: true });
    expect(p).not.toHaveProperty("progress_pct");
    // 녹음 프로그램이 없으면 가져오는 중에도 녹음은 막힌다
    expect(deriveTrayState(input({ importing: { active: true, done: 1, total: 2 }, recordOk: false })).can_record).toBe(false);
    // 녹음 변환이 있으면 그쪽이 먼저다 (새 녹음 막힘)
    expect(deriveTrayState(input({ importing: { active: true, done: 1, total: 2 }, job: { running: true, done: 9, total: 20 } }))).toMatchObject({ progress_pct: 45, can_record: false });
    expect(deriveTrayState(input({ importing: { active: false, done: 2, total: 2 } })).phase).toBe("idle");
  });

  test("일시정지: 일시정지한 순간의 경과를 싣고, 새 녹음·변환은 막고, 끝내기·북마크는 켠다", () => {
    const p = deriveTrayState(input({ rec: { phase: "paused" }, startedAtMs: 1_700_000_000_000, elapsedSec: 754.9 }));
    expect(p).toMatchObject({ phase: "paused", elapsed_ms: 754_900, can_record: false, can_bookmark: true });
    // 시작 시각은 싣지 않는다: Rust가 시계를 읽어 흐르게 하지 않는다 (타이머가 멈춘다)
    expect(p).not.toHaveProperty("started_at_ms");
    expect(deriveTrayState(input({ rec: { phase: "paused" } }))).toMatchObject({ phase: "paused", elapsed_ms: 0 });
    expect(deriveTrayState(input({ rec: { phase: "paused" }, elapsedSec: -3 })).elapsed_ms).toBe(0);
    // 일시정지가 변환보다 먼저다
    expect(deriveTrayState(input({ rec: { phase: "paused" }, job: { running: true, done: 1, total: 2 } })).phase).toBe("paused");
  });

  test("계속하면 시작 시각이 일시정지한 시간만큼 뒤로 옮겨져 같은 값으로 다시 흐른다", () => {
    // 12:34(754초)에 일시정지했다가 10분 뒤(wall 1_000_600_000)에 계속하면 시작 시각 = wall - 754초
    const resumedAt = 1_000_600_000;
    const virtualStart = resumedAt - 754_000;
    const p = deriveTrayState(input({ rec: { phase: "recording" }, startedAtMs: virtualStart }));
    expect(p.started_at_ms).toBe(virtualStart);
    expect(resumedAt - (p.started_at_ms ?? 0)).toBe(754_000); // Rust의 경과 = now - started → 계속한 순간 12:34
  });

  test("일시정지 → 계속 → 일시정지의 전송: 같은 상태만 다시 보내지 않는다", () => {
    const send = vi.fn();
    const push = createTraySender(send);
    const paused = () => deriveTrayState(input({ rec: { phase: "paused" }, elapsedSec: 60 }));
    expect(push(paused())).toBe(true);
    expect(push(paused())).toBe(false);
    expect(push(deriveTrayState(input({ rec: { phase: "recording" }, startedAtMs: 5 })))).toBe(true);
    expect(push(deriveTrayState(input({ rec: { phase: "paused" }, elapsedSec: 61 })))).toBe(true);
    expect(send.mock.calls.map((c) => c[0].phase)).toEqual(["paused", "recording", "paused"]);
  });

  test("녹음 중이 변환보다 먼저다", () => {
    expect(deriveTrayState(input({ rec: { phase: "recording" }, job: { running: true, done: 1, total: 2 } })).phase).toBe("recording");
  });

  test("최근 노트는 모든 단계에서 싣는다", () => {
    const notes = [note("a", "2026-10-02T10:00:00+09:00")];
    for (const i of [input({ notes }), input({ notes, rec: { phase: "recording" } }), input({ notes, waiting: true })]) expect(deriveTrayState(i).recent).toEqual([{ id: "a", title: "노트 a" }]);
  });
});

describe("createTraySender", () => {
  const payload = (o: Partial<TrayPayload> = {}): TrayPayload => ({ phase: "idle", can_record: true, can_bookmark: false, recent: [{ id: "a", title: "하나" }], ...o });

  test("같은 상태는 다시 보내지 않는다", () => {
    const send = vi.fn();
    const push = createTraySender(send);
    expect(push(payload())).toBe(true);
    expect(push(payload())).toBe(false);
    expect(push(payload({ recent: [{ id: "a", title: "하나" }] }))).toBe(false); // 다른 배열이어도 내용이 같다
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("첫 전송은 최근 노트를 싣고, 상태만 바뀌면 빼고, 목록이 바뀌면 다시 싣는다", () => {
    const send = vi.fn();
    const push = createTraySender(send);
    push(payload());
    push(payload({ phase: "recording", started_at_ms: 5, can_record: false, can_bookmark: true }));
    expect(send.mock.calls[0][0]).toHaveProperty("recent");
    expect(send.mock.calls[1][0]).not.toHaveProperty("recent");
    expect(send.mock.calls[1][0]).toMatchObject({ phase: "recording", started_at_ms: 5 });
    push(payload({ phase: "recording", started_at_ms: 5, can_record: false, can_bookmark: true, recent: [{ id: "b", title: "둘" }] }));
    expect(send.mock.calls[2][0].recent).toEqual([{ id: "b", title: "둘" }]);
    // 목록만 바뀌어도 한 번 보낸다
    push(payload({ phase: "recording", started_at_ms: 5, can_record: false, can_bookmark: true, recent: [] }));
    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls[3][0].recent).toEqual([]);
  });

  test("보내지 못하면(화면이 낡았거나 Rust가 거절) 다음에 모두 다시 보낸다", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue(undefined);
    const push = createTraySender(send);
    push(payload());
    await Promise.resolve();
    await Promise.resolve();
    expect(push(payload())).toBe(true);
    expect(send.mock.calls[1][0]).toHaveProperty("recent");
    expect(push(payload())).toBe(false);

    const throws = vi.fn(() => {
      throw new Error("sync");
    });
    const push2 = createTraySender(throws);
    expect(() => push2(payload())).not.toThrow();
    expect(push2(payload())).toBe(true);
  });
});

describe("routeTrayAction", () => {
  const idle = { recPhase: "idle" as RecPhase, transcribing: false };
  const rec = { recPhase: "recording" as RecPhase, transcribing: false };

  test("쉬는 중의 시작은 시작이다", () => {
    expect(routeTrayAction({ action: "record_start" }, idle)).toEqual({ kind: "start" });
    for (const recPhase of ["stopped", "error"] as RecPhase[]) expect(routeTrayAction({ action: "record_start" }, { recPhase, transcribing: false })).toEqual({ kind: "start" });
  });

  test("이미 녹음 중이거나 시작·마무리하는 중이거나 변환 중이면 시작은 아무 일도 아니다 (두 번 누름)", () => {
    for (const recPhase of ["starting", "recording", "stopping"] as RecPhase[]) expect(routeTrayAction({ action: "record_start" }, { recPhase, transcribing: false })).toBeNull();
    expect(routeTrayAction({ action: "record_start" }, { recPhase: "idle", transcribing: true })).toBeNull();
  });

  test("일시정지는 녹음 중에만, 계속은 일시정지 중에만 (두 번 눌러도 한 번)", () => {
    const paused = { recPhase: "paused" as RecPhase, transcribing: false };
    expect(routeTrayAction({ action: "record_pause" }, rec)).toEqual({ kind: "pause" });
    expect(routeTrayAction({ action: "record_resume" }, paused)).toEqual({ kind: "resume" });
    expect(routeTrayAction({ action: "record_pause" }, paused)).toBeNull();
    expect(routeTrayAction({ action: "record_resume" }, rec)).toBeNull();
    for (const recPhase of ["idle", "starting", "stopping", "stopped", "error"] as RecPhase[]) {
      expect(routeTrayAction({ action: "record_pause" }, { recPhase, transcribing: false })).toBeNull();
      expect(routeTrayAction({ action: "record_resume" }, { recPhase, transcribing: false })).toBeNull();
    }
  });

  test("일시정지 중에도 종료·북마크는 되고, 새 녹음 시작은 안 된다", () => {
    const paused = { recPhase: "paused" as RecPhase, transcribing: false };
    expect(routeTrayAction({ action: "record_stop" }, paused)).toEqual({ kind: "stop" });
    expect(routeTrayAction({ action: "bookmark" }, paused)).toEqual({ kind: "bookmark" });
    expect(routeTrayAction({ action: "record_start" }, paused)).toBeNull();
  });

  test("종료·북마크는 녹음 중에만", () => {
    expect(routeTrayAction({ action: "record_stop" }, rec)).toEqual({ kind: "stop" });
    expect(routeTrayAction({ action: "bookmark" }, rec)).toEqual({ kind: "bookmark" });
    for (const recPhase of ["idle", "starting", "stopping", "stopped", "error"] as RecPhase[]) {
      expect(routeTrayAction({ action: "record_stop" }, { recPhase, transcribing: false })).toBeNull();
      expect(routeTrayAction({ action: "bookmark" }, { recPhase, transcribing: false })).toBeNull();
    }
  });

  test("노트 열기는 ID가 있을 때만, 상태와 상관없다", () => {
    expect(routeTrayAction({ action: "open_note", id: "abc123" }, rec)).toEqual({ kind: "open", id: "abc123" });
    expect(routeTrayAction({ action: "open_note" }, idle)).toBeNull();
    expect(routeTrayAction({ action: "open_note", id: "" }, idle)).toBeNull();
    expect(routeTrayAction({ action: "open_note", id: 7 }, idle)).toBeNull();
  });

  test("모르는 이벤트·이상한 값은 버린다", () => {
    for (const raw of [null, undefined, 5, "record_start", [], {}, { action: "quit" }, { action: 3 }]) expect(routeTrayAction(raw, idle)).toBeNull();
  });
});
