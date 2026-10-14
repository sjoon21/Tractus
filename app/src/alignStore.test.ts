import { describe, expect, test } from "vitest";
import { createAlignStore, type AlignFinish } from "./alignStore";
import { IDLE_JOB } from "./lib";

function setup(opts: { fail?: string } = {}) {
  const started: { job: string; noteId: string }[] = [];
  let n = 0;
  const cancelled: string[] = [];
  const store = createAlignStore({
    start: async (job, noteId) => {
      started.push({ job, noteId });
      if (opts.fail) throw opts.fail;
    },
    newId: () => `job${++n}`,
    cancel: async (job) => void cancelled.push(job),
  });
  const finished: AlignFinish[] = [];
  store.onFinish((f) => finished.push(f));
  return { store, started, finished, cancelled };
}

describe("단어 싱크 작업 저장소", () => {
  test("cancel은 그 노트의 돌고 있는 작업만 멈춘다 (끝난 뒤·없는 노트는 아무 일 없다)", async () => {
    const { store, cancelled } = setup();
    await store.start("n1");
    await store.start("n2");
    store.cancel("n2");
    expect(cancelled).toEqual(["job2"]);
    store.dispatch({ job: "job2", event: "exit", code: null, stderr: "" }); // kill된 프로세스의 exit
    expect(store.get("n2").running).toBe(false);
    store.cancel("n2");
    store.cancel("없는 노트");
    expect(cancelled).toEqual(["job2"]);
  });

  test("시작하면 그 노트가 running이고, 다시 열어 읽어도 진행이 보인다", async () => {
    const { store, started } = setup();
    expect(store.get("n1")).toBe(IDLE_JOB);
    expect(await store.start("n1")).toBe(true);
    expect(store.get("n1").running).toBe(true);
    expect(started).toEqual([{ job: "job1", noteId: "n1" }]);
    store.dispatch({ job: "job1", event: "stage", stage: "align" });
    store.dispatch({ job: "job1", event: "progress", done: 3, total: 10 });
    // MeetingView를 닫았다 다시 열어도 (저장소는 그대로) 단계와 진행률이 이어진다
    expect(store.get("n1")).toMatchObject({ running: true, stage: "align", done: 3, total: 10 });
    expect(store.get("n2").running).toBe(false); // 다른 노트는 영향이 없다
  });

  test("이 노트의 단어 싱크가 도는 동안 또 시작하지 않는다 (다른 노트는 시작한다)", async () => {
    const { store, started } = setup();
    expect(await store.start("n1")).toBe(true);
    expect(await store.start("n1")).toBe(false);
    expect(started).toHaveLength(1);
    expect(await store.start("n2")).toBe(true);
    expect(started.map((s) => s.noteId)).toEqual(["n1", "n2"]);
  });

  test("성공: exit 0 + done이면 끝난 알림이 한 번 가고 다시 시작할 수 있다", async () => {
    const { store, finished } = setup();
    await store.start("n1");
    store.dispatch({ job: "job1", event: "done", meeting_id: "n1", meeting_dir: "/x" });
    expect(finished).toEqual([]); // exit 전에는 끝나지 않았다
    store.dispatch({ job: "job1", event: "exit", code: 0, stderr: "" });
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ noteId: "n1", ok: true });
    expect(store.get("n1").running).toBe(false);
    expect(await store.start("n1")).toBe(true);
  });

  test("실패: 오류 코드와 문구가 남고 ok=false", async () => {
    const { store, finished } = setup();
    await store.start("n1");
    store.dispatch({ job: "job1", event: "error", message: "model missing", code: "model_missing" });
    store.dispatch({ job: "job1", event: "exit", code: 1, stderr: "" });
    expect(finished[0]).toMatchObject({ noteId: "n1", ok: false });
    expect(store.get("n1")).toMatchObject({ running: false, errorCode: "model_missing", error: "model missing" });
  });

  test("시작하지 못하면(Rust 거부) 오류 상태와 끝난 알림, 다시 시작할 수 있다", async () => {
    const { store, finished } = setup({ fail: "Tractus 엔진을 실행할 수 없습니다\nNo such file" });
    await store.start("n1");
    expect(finished[0]).toMatchObject({ noteId: "n1", ok: false });
    expect(store.get("n1")).toMatchObject({ running: false, errorCode: "app", error: "Tractus 엔진을 실행할 수 없습니다\nNo such file" });
    expect(await store.start("n1")).toBe(true);
  });

  test("모르는 작업의 이벤트는 무시한다 (요약·변환 등)", async () => {
    const { store, finished } = setup();
    await store.start("n1");
    const before = store.get("n1");
    store.dispatch({ job: "other", event: "exit", code: 0, stderr: "" });
    expect(store.get("n1")).toBe(before);
    expect(finished).toEqual([]);
  });

  test("구독자는 상태가 바뀔 때마다 불리고, 해제하면 끝난다", async () => {
    const { store } = setup();
    let calls = 0;
    const off = store.subscribe(() => calls++);
    await store.start("n1");
    store.dispatch({ job: "job1", event: "progress", done: 1, total: 2 });
    expect(calls).toBe(2);
    off();
    store.dispatch({ job: "job1", event: "progress", done: 2, total: 2 });
    expect(calls).toBe(2);
  });
});
