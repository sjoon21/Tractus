// 사이드바의 `새 노트` 메뉴: 글쓰기 / 녹음 시작 / 파일 가져오기. 키보드와 열고 닫는 규칙은 menu.ts (menu.test.ts).
// 단추는 aria-haspopup="menu", 항목은 role="menuitem"(초점이 가는 것만 tabIndex 0). 바깥을 누르거나 Esc·Tab이면 닫고, 닫힌 뒤에는 초점이 단추로 돌아온다(바깥을 누른 경우는 누른 곳에 둔다).
import { useEffect, useRef, useState } from "react";
import { menuKey, NEW_NOTE_ITEMS, openKey, type NewNoteAction } from "./menu";

export function NewNoteMenu({ onPick, disabled }: { onPick: (a: NewNoteAction) => void; disabled: Partial<Record<NewNoteAction, string>> }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const focusAt = useRef(0); // 열릴 때 초점을 둘 항목

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  useEffect(() => {
    if (open) items.current[focusAt.current]?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  return (
    <div className="new-note" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="new-note-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? "new-note-menu" : undefined}
        aria-keyshortcuts="Meta+N"
        title="새 노트: 글쓰기, 녹음, 파일 가져오기 (⌘N은 바로 글쓰기)"
        onClick={() => {
          focusAt.current = 0;
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          const at = e.nativeEvent.isComposing ? null : openKey(e.code, NEW_NOTE_ITEMS.length);
          if (at === null) return;
          e.preventDefault();
          focusAt.current = at;
          setOpen(true);
        }}
      >
        <span>새 노트</span>
        <kbd aria-hidden>⌘N</kbd>
      </button>
      {open && (
        <div
          id="new-note-menu"
          className="new-note-menu"
          role="menu"
          aria-label="새 노트 만들기"
          onKeyDown={(e) => {
            const move = menuKey(e.code, NEW_NOTE_ITEMS.length, items.current.findIndex((el) => el === document.activeElement));
            if (!move) return;
            if (move.type === "focus") {
              e.preventDefault();
              items.current[move.index]?.focus();
            } else {
              if (e.code === "Escape") e.preventDefault();
              close(true); // Tab도 초점을 단추로 옮긴 뒤 기본 동작이 이어져 단추 다음으로 간다 (사라지는 항목에 초점이 남지 않게)
            }
          }}
        >
          {NEW_NOTE_ITEMS.map((it, i) => {
            const why = disabled[it.action];
            return (
              <button
                key={it.action}
                ref={(el) => void (items.current[i] = el)}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-disabled={why ? true : undefined}
                title={why}
                onClick={() => {
                  if (why) return; // 못 쓰는 항목은 초점은 받되 아무 일도 하지 않는다
                  close(true);
                  onPick(it.action);
                }}
              >
                <span>{it.label}</span>
                {it.hint && <kbd aria-hidden>{it.hint}</kbd>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
