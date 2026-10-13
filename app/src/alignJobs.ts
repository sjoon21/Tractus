// 단어 싱크 작업의 앱 전체 저장소 (alignStore.ts)와 Tauri 연결. App이 attachAlignJobs로 `job` 이벤트를 받기 시작하고,
// 노트 화면은 useAlign(노트 ID)로 그 노트의 상태를 읽는다 (화면을 닫았다 열어도 같은 상태).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useSyncExternalStore } from "react";
import { createAlignStore, type AlignFinish } from "./alignStore";
import type { JobEvent } from "./lib";

export const alignStore = createAlignStore({
  start: (job, noteId) => invoke<void>("job_start", { kind: "align", target: noteId, job }),
  newId: () => crypto.randomUUID(),
});

/** `job` 이벤트를 저장소로 보내고 끝난 알림을 받는다. 앱이 켜져 있는 동안 한 번 (해제 함수를 돌려준다) */
export function attachAlignJobs(onFinish: (f: AlignFinish) => void): () => void {
  const un = listen<JobEvent>("job", ({ payload }) => alignStore.dispatch(payload));
  const off = alignStore.onFinish(onFinish);
  return () => {
    void un.then((f) => f());
    off();
  };
}

export function useAlign(noteId: string) {
  const job = useSyncExternalStore(alignStore.subscribe, () => alignStore.get(noteId));
  const start = useCallback(() => void alignStore.start(noteId), [noteId]);
  return { job, startAlign: start };
}
