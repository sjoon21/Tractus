// 노트 줄을 폴더에 끌어 놓는 동작. HTML5 끌어 놓기(draggable·dataTransfer) 대신 포인터 이벤트로 직접 한다:
// Tauri 창은 파일 끌어 놓기(onDragDropEvent)를 위해 macOS에서 창 안의 끌어 놓기 이벤트를 먼저 가져가서 웹 쪽 dragover·drop이 오지 않을 수 있다.
// 순서: 줄에서 누르고(startNoteDrag) → 몇 픽셀 움직이면 끌기 시작(말풍선이 따라온다) → 폴더 줄(`data-folder-drop`) 위에서 놓으면 구독자에게 알린다.
import { useSyncExternalStore } from "react";

export const DROP_ATTR = "data-folder-drop";
export const DROP_NONE = "none"; // 폴더 없음 줄
const START_PX = 5; // 이만큼 움직여야 끌기다 (그 전에는 그냥 누르기)

/** 폴더 줄의 data 값 → 놓을 곳. null이면 폴더가 아닌 곳, 폴더 없음 줄은 폴더 값 null */
export function parseDrop(attr: string | null): { target: string | null } | null {
  if (attr === null || attr === "") return null;
  return { target: attr === DROP_NONE ? null : attr };
}

type Over = string | null; // 지금 올라가 있는 줄의 data 값 (끌지 않거나 폴더 밖이면 null)
let over: Over = null;
const changed = new Set<() => void>();
const setOver = (v: Over) => {
  if (v === over) return;
  over = v;
  changed.forEach((f) => f());
};
/** 끌어 온 노트가 올라와 있는 폴더 줄의 data 값 */
export const useDragOver = (): Over =>
  useSyncExternalStore(
    (f) => {
      changed.add(f);
      return () => void changed.delete(f);
    },
    () => over,
    () => null,
  );

type DropHandler = (id: string, target: string | null) => void;
const handlers = new Set<DropHandler>();
/** 노트를 폴더 줄에 놓았을 때 알림을 받는다. 해제 함수를 돌려준다 */
export const onNoteDrop = (h: DropHandler): (() => void) => {
  handlers.add(h);
  return () => void handlers.delete(h);
};

const rowAt = (x: number, y: number): string | null => document.elementFromPoint(x, y)?.closest(`[${DROP_ATTR}]`)?.getAttribute(DROP_ATTR) ?? null;

/** 노트 줄의 pointerdown에서 부른다. 마우스·펜만 끈다 (터치는 목록 스크롤이 먼저다) */
export function startNoteDrag(e: { button: number; pointerType: string; clientX: number; clientY: number }, id: string, title: string): void {
  if (e.button !== 0 || e.pointerType === "touch") return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let ghost: HTMLElement | null = null;

  const onMove = (m: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(m.clientX - x0, m.clientY - y0) < START_PX) return;
      ghost = document.createElement("div");
      ghost.className = "note-drag-ghost";
      ghost.textContent = title;
      document.body.append(ghost);
      document.body.classList.add("is-note-dragging");
    }
    ghost.style.transform = `translate(${m.clientX + 12}px, ${m.clientY + 12}px)`;
    setOver(rowAt(m.clientX, m.clientY));
  };
  const finish = (u: PointerEvent | null) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", onKey);
    if (!ghost) return;
    ghost.remove();
    document.body.classList.remove("is-note-dragging");
    setOver(null);
    const drop = u ? parseDrop(rowAt(u.clientX, u.clientY)) : null;
    // 같은 줄에서 놓으면 브라우저가 click을 보내 노트가 열리므로, 끌기 뒤 첫 click은 막는다
    const stop = (c: Event) => c.stopPropagation();
    window.addEventListener("click", stop, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 0);
    if (drop) handlers.forEach((h) => h(id, drop.target));
  };
  const cancel = () => finish(null);
  const onKey = (k: KeyboardEvent) => {
    if (k.key === "Escape") finish(null);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", onKey);
}
