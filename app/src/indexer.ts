// 고친 문장을 검색에 반영하는 백그라운드 갱신의 앱 전체 하나 (시점은 indexSchedule.ts).
// 화면 쪽은 touch()로 "고쳤다"만 알리고, App이 bindIndexer로 '바쁜지'와 '오류 알림'을 연결한다.
import { api } from "./api";
import { createIndexScheduler } from "./indexSchedule";

interface Binding {
  isBusy: () => boolean;
  onError: (e: unknown) => void;
}

let binding: Binding = { isBusy: () => false, onError: () => {} };
const listeners = new Set<() => void>();

/** App이 연결한다. 연결을 풀면(반환 함수) 이전 상태로 돌아간다 */
export function bindIndexer(b: Binding): () => void {
  binding = b;
  return () => {
    if (binding === b) binding = { isBusy: () => false, onError: () => {} };
  };
}

/** 갱신이 끝날 때마다 (예: 설정의 스마트 검색 상태 줄을 새로 읽는다). 돌려주는 함수로 해제 */
export function onIndexed(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export const indexer = createIndexScheduler({
  isBusy: () => binding.isBusy(),
  run: () => api.indexRefresh(),
  onDone: () => listeners.forEach((f) => f()),
  onError: (e) => binding.onError(e),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
});
