// 사이드바 `새 노트` 메뉴의 항목과 키보드 (NewNoteMenu.tsx). 순수 로직은 menu.test.ts에서 검사한다.

export type NewNoteAction = "write" | "record" | "import";

export const NEW_NOTE_ITEMS: { action: NewNoteAction; label: string; hint?: string }[] = [
  { action: "write", label: "글쓰기", hint: "⌘N" },
  { action: "record", label: "녹음 시작" },
  { action: "import", label: "파일 가져오기" },
];

export type MenuMove = { type: "focus"; index: number } | { type: "close" } | null;

/**
 * 열린 메뉴에서 키를 눌렀을 때. ↑↓는 끝에서 돌고, Home·End는 처음·끝, Esc·Tab은 닫는다(Tab은 초점이 자연히 옮겨 가게 둔다).
 * Enter·Space는 단추의 click이 처리하므로 null. current: 지금 초점이 있는 항목(없으면 -1)
 */
export function menuKey(code: string, count: number, current: number): MenuMove {
  if (count <= 0) return null;
  switch (code) {
    case "ArrowDown":
      return { type: "focus", index: (current + 1) % count };
    case "ArrowUp":
      return { type: "focus", index: current <= 0 ? count - 1 : current - 1 };
    case "Home":
      return { type: "focus", index: 0 };
    case "End":
      return { type: "focus", index: count - 1 };
    case "Escape":
    case "Tab":
      return { type: "close" };
    default:
      return null;
  }
}

/** 닫힌 메뉴의 단추에서 ↓는 처음 항목으로, ↑는 마지막 항목으로 연다. 그 밖의 키는 null */
export const openKey = (code: string, count: number): number | null => (code === "ArrowDown" ? 0 : code === "ArrowUp" ? count - 1 : null);
