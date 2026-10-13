import { describe, expect, test } from "vitest";
import { createIndexScheduler, INDEX_DEBOUNCE_MS } from "./indexSchedule";

/** 가짜 시계: 타이머를 모아 두고 시간을 직접 흘린다 */
function harness(opts: { busy?: () => boolean; run?: () => Promise<boolean> } = {}) {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const calls = { run: 0, done: 0, errors: [] as unknown[] };
  const sched = createIndexScheduler({
    isBusy: opts.busy ?? (() => false),
    run: async () => {
      calls.run++;
      return opts.run ? opts.run() : true;
    },
    onDone: () => void calls.done++,
    onError: (e) => void calls.errors.push(e),
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (h) => void timers.delete(h as number),
  });
  const advance = async (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at <= now) {
        timers.delete(id);
        t.fn();
      }
    }
    await new Promise((r) => setTimeout(r, 0)); // run()의 Promise가 풀리도록
  };
  return { sched, calls, advance, pendingTimers: () => timers.size };
}

describe("index scheduler", () => {
  test("마지막 수정에서 20초가 지나기 전에는 하지 않고, 수정이 이어지면 계속 미룬다", async () => {
    const h = harness();
    h.sched.touch();
    await h.advance(INDEX_DEBOUNCE_MS - 1);
    expect(h.calls.run).toBe(0);
    h.sched.touch(); // 또 고쳤다: 여기서부터 다시 20초
    await h.advance(INDEX_DEBOUNCE_MS - 1);
    expect(h.calls.run).toBe(0);
    await h.advance(1);
    expect(h.calls.run).toBe(1);
    expect(h.calls.done).toBe(1);
  });

  test("여러 번 고쳐도 한 번만 돈다 (성공하면 조용하다: 오류 없음)", async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) h.sched.touch();
    await h.advance(INDEX_DEBOUNCE_MS);
    await h.advance(INDEX_DEBOUNCE_MS * 3);
    expect(h.calls.run).toBe(1);
    expect(h.calls.errors).toEqual([]);
    expect(h.pendingTimers()).toBe(0);
  });

  test("바쁘면(변환·녹음·가져오기·단어 싱크 중) 하지 않고, 한가해지면 한다", async () => {
    let busy = true;
    const h = harness({ busy: () => busy });
    h.sched.touch();
    await h.advance(INDEX_DEBOUNCE_MS);
    await h.advance(INDEX_DEBOUNCE_MS);
    expect(h.calls.run).toBe(0);
    busy = false;
    await h.advance(INDEX_DEBOUNCE_MS);
    expect(h.calls.run).toBe(1);
  });

  test("돌고 있는 동안 또 고치면 끝난 뒤 한 번 더, 동시에 둘은 돌지 않는다", async () => {
    let release!: (v: boolean) => void;
    let concurrent = 0;
    let maxConcurrent = 0;
    const h = harness({
      run: () =>
        new Promise<boolean>((r) => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          release = (v) => {
            concurrent--;
            r(v);
          };
        }),
    });
    h.sched.touch();
    await h.advance(INDEX_DEBOUNCE_MS);
    expect(h.calls.run).toBe(1);
    h.sched.touch(); // 돌고 있는 중에 고쳤다
    await h.advance(INDEX_DEBOUNCE_MS * 2);
    expect(h.calls.run).toBe(1); // 아직 앞의 것이 돈다
    release(true);
    await h.advance(0);
    await h.advance(INDEX_DEBOUNCE_MS);
    expect(h.calls.run).toBe(2);
    release(true);
    await h.advance(INDEX_DEBOUNCE_MS * 2);
    expect(h.calls.run).toBe(2);
    expect(maxConcurrent).toBe(1);
  });

  test("Rust가 비켜 갔으면(false) 나중에 다시 시도하고, 알림은 없다", async () => {
    const answers = [false, true];
    const h = harness({ run: async () => answers.shift() ?? true });
    h.sched.touch();
    await h.advance(INDEX_DEBOUNCE_MS);
    expect(h.calls.run).toBe(1);
    expect(h.calls.done).toBe(0);
    await h.advance(INDEX_DEBOUNCE_MS);
    expect(h.calls.run).toBe(2);
    expect(h.calls.done).toBe(1);
    expect(h.calls.errors).toEqual([]);
  });

  test("실패하면 오류를 한 번 알리고 혼자 계속 두드리지 않는다. 다음 수정에서 다시 시도한다", async () => {
    let fail = true;
    const h = harness({ run: async () => (fail ? Promise.reject(new Error("엔진 없음")) : true) });
    h.sched.touch();
    await h.advance(INDEX_DEBOUNCE_MS);
    await h.advance(INDEX_DEBOUNCE_MS * 5);
    expect(h.calls.run).toBe(1);
    expect(h.calls.errors).toHaveLength(1);
    fail = false;
    h.sched.touch();
    await h.advance(INDEX_DEBOUNCE_MS);
    expect(h.calls.run).toBe(2);
    expect(h.calls.done).toBe(1);
  });

  test("cancel은 대기 중인 갱신을 없앤다", async () => {
    const h = harness();
    h.sched.touch();
    h.sched.cancel();
    await h.advance(INDEX_DEBOUNCE_MS * 2);
    expect(h.calls.run).toBe(0);
  });
});
