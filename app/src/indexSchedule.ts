// 문장을 고친 뒤 검색에 반영하는 조용한 백그라운드 갱신 (`tractus index`)의 시점 정하기. 화면과 무관한 순수 로직.
// 마지막 수정에서 INDEX_DEBOUNCE_MS가 지나고 앱이 한가할 때만 한 번에 하나씩 돌리고, 성공하면 아무것도 보이지 않는다.
// 갱신은 임베딩 엔진을 올리는 일이라 비싸다: 수정이 잦아도 끝난 뒤 INDEX_MIN_GAP_MS 안에는 다시 올리지 않는다.
// 앱을 끝내면 '고쳤다' 표시는 사라지지만, App이 시작할 때 `touch()`를 한 번 불러 바뀐 청크를 따라잡는다 (`tractus index`는 증분).

/** 마지막 수정 뒤 이만큼 조용하면 갱신한다 */
export const INDEX_DEBOUNCE_MS = 60_000;
/** 갱신을 마친 뒤 다음 갱신까지 최소 간격 */
export const INDEX_MIN_GAP_MS = 300_000;

export interface IndexSchedulerDeps {
  /** 변환·가져오기·요약·단어 싱크·녹음(실시간 변환 포함)이 돌고 있으면 true. 그동안은 하지 않는다 */
  isBusy: () => boolean;
  /** 갱신 한 번. 했으면 true, 다른 작업이 돌고 있어 비켜 갔으면 false (Rust index_refresh) */
  run: () => Promise<boolean>;
  /** 갱신을 마쳤다 (조용히: 알림 없이 설정의 상태 줄 같은 것만 새로 읽는다) */
  onDone: () => void;
  onError: (e: unknown) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  debounceMs?: number;
  minGapMs?: number;
  /** 지금 시각(ms). 기본 Date.now */
  now?: () => number;
}

export interface IndexScheduler {
  /** 문장을 고쳤다 (고친 시각부터 다시 기다린다) */
  touch: () => void;
  /** 대기 중인 갱신을 취소한다 */
  cancel: () => void;
}

export function createIndexScheduler(deps: IndexSchedulerDeps): IndexScheduler {
  const wait = deps.debounceMs ?? INDEX_DEBOUNCE_MS;
  const gap = deps.minGapMs ?? INDEX_MIN_GAP_MS;
  const now = deps.now ?? Date.now;
  let lastDone: number | null = null;
  let timer: unknown = null;
  let running = false;
  let dirty = false;

  const disarm = () => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  };
  const arm = () => {
    disarm();
    const sinceDone = lastDone === null ? gap : now() - lastDone;
    timer = deps.setTimer(() => void fire(), Math.max(wait, gap - sinceDone));
  };

  async function fire(): Promise<void> {
    timer = null;
    if (!dirty || running) return; // 돌고 있으면 끝난 뒤 다시 잡는다
    if (deps.isBusy()) return arm(); // 바쁘면 한 번 더 기다린다
    running = true;
    dirty = false;
    let failed = false;
    try {
      if (await deps.run()) {
        lastDone = now();
        deps.onDone();
      } else dirty = true; // 비켜 갔다: 나중에 다시
    } catch (e) {
      failed = true;
      dirty = true; // 다음 수정이 오면 다시 시도한다. 오류를 알린 채 혼자 계속 두드리지는 않는다
      deps.onError(e);
    } finally {
      running = false;
    }
    if (dirty && !failed && timer === null) arm();
  }

  return {
    touch() {
      dirty = true;
      if (!running) arm(); // 돌고 있으면 끝난 뒤에 잡는다 (한 번에 하나)
    },
    cancel() {
      dirty = false;
      disarm();
    },
  };
}
