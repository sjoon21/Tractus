// 노트 줄을 트랙패드 두 손가락으로 왼쪽으로 밀면 줄 끝에 `삭제` 단추가 나온다 (macOS 메일처럼). 마우스 끌기는 폴더로 옮기기라(noteDrag) 쓰지 않는다.
// 한 번에 한 줄만 열린다. 오른쪽으로 밀기·Esc·다른 곳 누르기·목록 스크롤이면 닫힌다. 단추를 눌러도 바로 지우지 않고 확인 창을 띄운다(App의 askDelete).
// 줄마다 컨텍스트를 읽지 않게 상태는 이 모듈 하나에 둔다: 열린 줄이 바뀌면 그 두 줄만 다시 그린다 (useSwiped).
import { useSyncExternalStore } from "react";

/** 이만큼(px, wheel deltaX 합) 가로로 밀어야 열리거나 닫힌다 */
export const SWIPE_PX = 40;
/** 이보다 오래 wheel 이벤트가 없으면 새 밀기로 본다 (조금씩 흘린 값이 쌓이지 않게) */
export const SWIPE_GAP_MS = 250;
/** 단추 표시 (바깥 누르기 판단) */
export const SWIPE_ATTR = "data-swipe-delete";

export interface SwipeAcc {
  acc: number;
  at: number;
}

/**
 * wheel 이벤트 하나 → 쌓인 값과 할 일. 세로가 더 큰 움직임은 목록 스크롤이라 쌓은 값을 버린다.
 * macOS 기본(자연스러운 스크롤)에서 손가락을 왼쪽으로 밀면 deltaX가 양수다.
 * shortcut: 자연스러운 스크롤을 끈 Mac에서는 방향이 반대다. 그런 사용자가 있으면 설정으로 뒤집는다.
 */
export function swipeStep(s: SwipeAcc, dx: number, dy: number, now: number): { s: SwipeAcc; act: "open" | "close" | null } {
  if (Math.abs(dx) <= Math.abs(dy)) return { s: { acc: 0, at: now }, act: null };
  const acc = (now - s.at > SWIPE_GAP_MS ? 0 : s.acc) + dx;
  if (acc >= SWIPE_PX) return { s: { acc: 0, at: now }, act: "open" };
  if (acc <= -SWIPE_PX) return { s: { acc: 0, at: now }, act: "close" };
  return { s: { acc, at: now }, act: null };
}

let open: string | null = null; // 삭제 단추가 나온 노트 ID
const listeners = new Set<() => void>();

const onPointer = (e: PointerEvent) => {
  if (!(e.target as Element | null)?.closest?.(`[${SWIPE_ATTR}]`)) setSwiped(null);
};
const onKey = (e: KeyboardEvent) => {
  if (e.key === "Escape") setSwiped(null);
};
// 가로로 미는 동안 섞여 오는 작은 세로 움직임이 목록을 조금 굴려도 닫지 않는다
let sideAt = -Infinity;
const onScroll = () => {
  if (performance.now() - sideAt > SWIPE_GAP_MS) setSwiped(null);
};

/** 삭제 단추를 보일 줄을 바꾼다 (null이면 모두 닫는다). 열려 있는 동안만 바깥 누르기·Esc·스크롤을 듣는다 */
export function setSwiped(id: string | null): void {
  if (id === open) return;
  const was = open;
  open = id;
  if (was === null) {
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("scroll", onScroll, true);
  } else if (id === null) {
    document.removeEventListener("pointerdown", onPointer, true);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("scroll", onScroll, true);
  }
  listeners.forEach((f) => f());
}

let cur: SwipeAcc & { id: string } = { id: "", acc: 0, at: 0 };
/** 노트 줄의 onWheel에서 부른다 */
export function swipeWheel(id: string, dx: number, dy: number, now = performance.now()): void {
  const r = swipeStep(cur.id === id ? cur : { acc: 0, at: 0 }, dx, dy, now);
  cur = { id, ...r.s };
  if (Math.abs(dx) > Math.abs(dy)) sideAt = now;
  if (r.act === "open") setSwiped(id);
  else if (r.act === "close" && open === id) setSwiped(null);
}

/** 지금 삭제 단추가 나온 노트 ID */
export const swipedId = (): string | null => open;

/** 이 줄의 삭제 단추가 나와 있는가 */
export const useSwiped = (id: string): boolean =>
  useSyncExternalStore(
    (f) => {
      listeners.add(f);
      return () => void listeners.delete(f);
    },
    () => open === id,
    () => false,
  );
