// 모델 받기 작업의 앱 전체 저장소. 화면(모델 화면·시작 점검)을 닫았다 열어도 같은 진행이 보이고, 받기는 한 번에 하나만 돈다.
// Rust `models_download`가 `job` 이벤트(kind "models")로 코어의 JSON 줄을 그대로 보낸다. 상태 계산은 models.ts의 downloadReduce.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import { errFull } from "./api";
import { downloadReduce, IDLE_DOWNLOAD, type DownloadAction, type DownloadState, type ModelsEvent, type PlanItem } from "./models";

let state: DownloadState = IDLE_DOWNLOAD;
let jobId: string | null = null;
const subs = new Set<() => void>();

const dispatch = (a: DownloadAction) => {
  state = downloadReduce(state, a);
  subs.forEach((f) => f());
};

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};

export const useDownload = (): DownloadState => useSyncExternalStore(subscribe, () => state);

/** 받기를 시작한다. 이미 받는 중이면 아무것도 하지 않는다 (코어도 모델 폴더마다 하나만 허락한다) */
export async function startDownload(plan: PlanItem[]): Promise<void> {
  if (state.running || plan.length === 0) return;
  const job = crypto.randomUUID();
  jobId = job;
  dispatch({ type: "start", plan });
  try {
    await invoke("models_download", { job, ids: plan.map((p) => p.id), preset: null });
  } catch (e) {
    dispatch({ type: "failed", message: errFull(e) });
  }
}

/** 멈추기: 코어가 SIGTERM으로 깨끗이 멈추고 받은 부분은 남긴다. 다시 받으면 이어서 받는다 */
export function cancelDownload(): void {
  if (!state.running) return;
  dispatch({ type: "cancel" });
  invoke("models_cancel").catch(() => {});
}

/** `job` 이벤트 중 이 앱의 받기만 저장소로 보낸다. 끝나면(exit) onFinish. 앱이 켜져 있는 동안 한 번 */
export function attachModelsJobs(onFinish: (s: DownloadState) => void): () => void {
  const un = listen<ModelsEvent & { kind?: string }>("job", ({ payload }) => {
    if (payload.kind !== "models" || payload.job !== jobId) return;
    dispatch({ type: "event", ev: payload });
    if (payload.event === "exit") onFinish(state);
  });
  return () => void un.then((f) => f());
}
