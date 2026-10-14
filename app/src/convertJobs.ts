// 변환 전 노트 변환 작업(`tractus transcribe --into`)의 앱 전체 저장소와 Tauri 연결. 단어 싱크(alignJobs.ts)와 같은 틀이다:
// 노트 ID별 상태를 모듈에 두므로 노트 화면을 닫았다 열어도 진행이 보이고, 같은 노트의 변환을 또 시작하지 못한다.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import { createAlignStore, type AlignFinish } from "./alignStore";
import type { JobEvent, JobState } from "./lib";

export const convertStore = createAlignStore({
  start: (job, noteId) => invoke<void>("convert_note", { id: noteId, job }),
  newId: () => crypto.randomUUID(),
  cancel: (job) => invoke<void>("ask_cancel", { job }), // 작업 프로세스 표(질문과 같은 표)에서 찾아 kill한다 (deferred.rs)
});

/** `job` 이벤트를 저장소로 보내고 끝난 알림을 받는다. 앱이 켜져 있는 동안 한 번 (해제 함수를 돌려준다) */
export function attachConvertJobs(onFinish: (f: AlignFinish) => void): () => void {
  const un = listen<JobEvent>("job", ({ payload }) => convertStore.dispatch(payload));
  const off = convertStore.onFinish(onFinish);
  return () => {
    void un.then((f) => f());
    off();
  };
}

/** 노트 하나의 변환 상태. 노트가 없으면(null) 쉬는 상태 */
export function useConvertJob(noteId: string | null): JobState {
  return useSyncExternalStore(convertStore.subscribe, () => convertStore.get(noteId ?? ""));
}
