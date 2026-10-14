// 단어 싱크(`tractus align`) 작업 상태를 노트 ID별로 들고 있는다. 화면(MeetingView)이 아니라 모듈에 둔다:
// 작업 중에 노트를 닫았다 다시 열어도 진행 상태가 그대로 보이고, 버튼이 다시 켜져 같은 작업을 또 시작하지 않는다.
// 화면과 무관한 순수 로직 (Tauri 호출은 deps로 받는다). alignStore.test.ts에서 검사한다.
import { APP_ERROR, IDLE_JOB, jobReduce, type JobEvent, type JobState } from "./lib";

export interface AlignFinish {
  noteId: string;
  /** exit 0 + done: 단어 싱크를 맞췄다 */
  ok: boolean;
  /** 끝난 작업의 마지막 상태 (실패면 error·errorCode) */
  state: JobState;
}

export interface AlignDeps {
  /** Rust `job_start`. 실행조차 못 하면 거부 */
  start: (job: string, noteId: string) => Promise<void>;
  newId: () => string;
  /** 돌고 있는 작업을 멈춘다 (프로세스를 kill, 이미 끝났으면 아무 일도 없다). 없으면 cancel은 아무것도 하지 않는다 */
  cancel?: (job: string) => Promise<void>;
}

export function createAlignStore(deps: AlignDeps) {
  const states = new Map<string, JobState>();
  const jobs = new Map<string, string>(); // 작업 ID → 노트 ID
  const subs = new Set<() => void>();
  const finishSubs = new Set<(f: AlignFinish) => void>();

  const get = (noteId: string): JobState => states.get(noteId) ?? IDLE_JOB;
  const put = (noteId: string, s: JobState) => {
    states.set(noteId, s);
    subs.forEach((f) => f());
  };
  const finish = (noteId: string, ok: boolean) => {
    const state = get(noteId);
    finishSubs.forEach((f) => f({ noteId, ok, state }));
  };

  return {
    get,
    /** 상태가 바뀔 때마다 (useSyncExternalStore). 노트마다 상태 객체는 바뀔 때만 새로 만든다 */
    subscribe(fn: () => void): () => void {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    /** 작업이 끝날 때마다 한 번 (성공·실패 모두). 노트가 열려 있지 않아도 온다 */
    onFinish(fn: (f: AlignFinish) => void): () => void {
      finishSubs.add(fn);
      return () => void finishSubs.delete(fn);
    },
    /** 시작한다. 이 노트의 단어 싱크가 이미 돌고 있으면 아무것도 하지 않고 false */
    async start(noteId: string): Promise<boolean> {
      if (get(noteId).running) return false;
      // 작업 ID는 여기서 만든다: 빨리 끝나는 작업의 이벤트가 invoke 응답보다 먼저 와도 놓치지 않게
      const job = deps.newId();
      jobs.set(job, noteId);
      put(noteId, { ...IDLE_JOB, running: true });
      try {
        await deps.start(job, noteId);
      } catch (e) {
        jobs.delete(job);
        put(noteId, { ...IDLE_JOB, error: e instanceof Error ? e.message : String(e), errorCode: APP_ERROR }); // 실행 실패 등 Rust 문장
        finish(noteId, false);
      }
      return true;
    },
    /** 이 노트의 돌고 있는 작업을 멈춘다. 끝 상태(exit 이벤트)는 평소처럼 온다 */
    cancel(noteId: string): void {
      const job = [...jobs].find(([, n]) => n === noteId)?.[0];
      if (job) void deps.cancel?.(job)?.catch(() => {});
    },
    /** `job` 이벤트 하나. 이 저장소가 시작한 작업의 것만 받는다 */
    dispatch(ev: JobEvent): void {
      const noteId = jobs.get(ev.job);
      if (!noteId) return;
      const next = jobReduce(get(noteId), ev);
      put(noteId, next);
      if (ev.event !== "exit") return;
      jobs.delete(ev.job);
      finish(noteId, ev.code === 0 && next.meetingId !== null && !next.running);
    },
  };
}

export type AlignStore = ReturnType<typeof createAlignStore>;
