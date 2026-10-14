// 변환 전 노트를 차례로 변환하는 줄 (docs/desktop.md §3.3). 변환은 변환 엔진을 올리므로 한 번에 하나씩 돌린다. 노트 하나를 변환하는 것도 같은 줄을 쓴다.
// 실패해도 줄은 멈추지 않는다(실패는 알림으로 따로 알린다). 순수 상태 전이는 convertQueue.test.ts에서 검사한다.

export interface ConvertQueue {
  /** 지금 변환하는 노트(시작을 기다리는 중일 수도 있다) */
  current: string | null;
  /** 기다리는 노트 (차례대로) */
  pending: string[];
  /** 끝낸 개수 (성공·실패 모두) */
  finished: number;
  total: number;
}

export const IDLE_CONVERT: ConvertQueue = { current: null, pending: [], finished: 0, total: 0 };

/** 줄에 더한다. 이미 줄에 있는 노트·중복은 더하지 않는다. 쉬는 중이면 첫 노트가 바로 차례다 */
export function convertEnqueue(s: ConvertQueue, ids: readonly string[]): ConvertQueue {
  const have = new Set([s.current, ...s.pending]);
  const fresh = ids.filter((id, i) => !have.has(id) && ids.indexOf(id) === i);
  if (fresh.length === 0) return s;
  if (s.current === null) return { current: fresh[0], pending: fresh.slice(1), finished: 0, total: fresh.length };
  return { ...s, pending: [...s.pending, ...fresh], total: s.total + fresh.length };
}

/** 지금 노트가 끝났다(성공이든 실패든, 또는 건너뛴다): 다음 노트로, 없으면 쉰다 */
export function convertAdvance(s: ConvertQueue): ConvertQueue {
  if (s.current === null) return s;
  const [next, ...rest] = s.pending;
  return next === undefined ? IDLE_CONVERT : { current: next, pending: rest, finished: s.finished + 1, total: s.total };
}

/** 노트가 줄에서 어디에 있는가. `running`: 변환 작업이 돌고 있다. 지금 노트인데 아직 시작하지 않았으면 `queued` */
export function convertSlot(s: ConvertQueue, id: string, currentRunning: boolean): "running" | "queued" | null {
  if (s.current === id) return currentRunning ? "running" : "queued";
  return s.pending.includes(id) ? "queued" : null;
}

/** 줄에서 몇 번째인가 (진행 줄 문구용): 여럿일 때만 `2 / 3`, 하나면 null */
export const convertProgress = (s: ConvertQueue): { n: number; total: number } | null => (s.current !== null && s.total > 1 ? { n: s.finished + 1, total: s.total } : null);
