// 여러 유형을 한 번에 만드는 대기열 (docs/desktop.md §2.13). 요약은 한 번에 하나씩 차례로 돌린다(AI 서비스 한도·메모리). 순수 상태 전이는 summaryQueue.test.ts에서 검사한다.
import type { SummarySpec } from "./summaries";

export interface QueueState {
  /** 지금 만드는 것 */
  current: SummarySpec | null;
  /** 기다리는 것 (차례대로) */
  pending: SummarySpec[];
  /** 끝낸 개수 */
  finished: number;
  total: number;
  /** 실패해서 멈춘 것. 실패하면 남은 것은 돌리지 않는다 */
  failed: SummarySpec | null;
}

export const IDLE_QUEUE: QueueState = { current: null, pending: [], finished: 0, total: 0, failed: null };

/** 새로 시작한다. 이미 돌고 있으면 그대로 둔다 (겹쳐 돌리지 않는다). 빈 목록은 아무것도 하지 않는다 */
export function queueStart(s: QueueState, specs: SummarySpec[]): QueueState {
  if (s.current || specs.length === 0) return s;
  return { current: specs[0], pending: specs.slice(1), finished: 0, total: specs.length, failed: null };
}

/** 지금 것이 끝났다: 다음 것으로, 없으면 쉰다 */
export function queueAdvance(s: QueueState): QueueState {
  if (!s.current) return s;
  const [next, ...rest] = s.pending;
  return { ...s, current: next ?? null, pending: rest, finished: s.finished + 1 };
}

/** 지금 것이 실패했다: 남은 것은 버리고 멈춘다 */
export function queueFail(s: QueueState): QueueState {
  return s.current ? { ...s, current: null, pending: [], failed: s.current } : s;
}

/** 진행 줄. 하나뿐이면 번호 없이 `핵심 요약`, 여럿이면 `2 / 3 · 핵심 요약` */
export function queueLabel(s: QueueState): string | null {
  if (!s.current) return null;
  return s.total > 1 ? `${s.finished + 1} / ${s.total} · ${s.current.label}` : s.current.label;
}
