// 단추 옆에 뜨는 작은 창과 그 안의 메뉴 (노트 줄의 `…`, 폴더 고르기, 폴더 `…`). 사이드바 목록은 스크롤 영역이라 잘리지 않게 body에 띄운다 (position: fixed).
// 규칙은 새 노트 메뉴와 같다 (menu.ts): ↑↓는 끝에서 돌고 Home·End는 처음·끝, Esc는 닫고 단추로 초점을 돌려주고, Tab은 닫고 초점이 자연히 옮겨 가게 둔다.
// 바깥을 누르거나 스크롤·창 크기를 바꾸면 닫는다.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { MENU, MENU_ITEM } from "@/components/menu";
import { cn } from "@/components/ui/utils";
import { menuKey } from "./menu";

export type Close = (refocus?: boolean) => void;

export function Popover({
  anchor,
  label,
  role = "menu",
  align = "end",
  onClose,
  children,
}: {
  anchor: HTMLElement;
  label: string;
  role?: "menu" | "group" | "dialog";
  /** 단추의 어느 끝에 맞출지: end(오른쪽, 기본) | start(왼쪽) */
  align?: "start" | "end";
  onClose: () => void;
  children: (close: Close) => ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const close: Close = (refocus = false) => {
    onClose();
    if (refocus) anchor.focus();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  // 단추 아래, 오른쪽(start면 왼쪽) 끝을 맞춘다. 아래가 모자라면 위로 연다
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const w = box.current?.offsetWidth ?? 220;
    const h = box.current?.offsetHeight ?? 0;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, align === "start" ? r.left : r.right - w));
    const below = r.bottom + 4;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - 4 - h) : below;
    // 같은 자리면 상태를 바꾸지 않는다: 이 효과는 매 렌더 뒤에 돌므로, 새 객체를 그대로 넣으면 끝없이 다시 그린다
    setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
  });

  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !anchor.contains(t)) closeRef.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current(true);
      } else if (e.key === "Tab" && role === "dialog") {
        closeRef.current(true); // 단추로 초점을 돌려주고 Tab은 거기서 이어진다 (body 끝에 띄운 창이라 안 닫으면 초점만 떠난다)
      }
    };
    const away = (e: Event) => {
      if (!box.current?.contains(e.target as Node)) closeRef.current();
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", away);
    };
  }, [anchor, role]);

  return createPortal(
    <div ref={box} className={cn(MENU, "fixed z-50 min-w-[200px] max-w-[320px]")} role={role} aria-label={label} style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }}>
      {children(close)}
    </div>,
    document.body,
  );
}

export interface MenuEntry {
  id: string;
  label: string;
  onSelect: () => void;
  /** 고르는 항목(menuitemradio)이면 지금 고른 것인지 */
  checked?: boolean;
  /** 폴더 나무 안의 들여쓰기 단계 (0부터) */
  indent?: number;
  /** 못 쓰는 이유 (title로 말한다). 초점은 받되 아무 일도 하지 않는다 */
  disabled?: string;
  danger?: boolean;
  hint?: string;
  /** 앞에 가는 구분선 */
  divider?: boolean;
  /** 고른 뒤에도 닫지 않는다 (안에서 다른 화면으로 바꾸는 항목) */
  stay?: boolean;
}

/** 항목 목록. 처음 초점은 고른 항목(없으면 첫 항목). 항목을 고르면 닫는다 (stay인 항목만 그대로) */
export function ItemMenu({ entries, close }: { entries: MenuEntry[]; close: Close }) {
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    const first = Math.max(0, entries.findIndex((e) => e.checked));
    items.current[first]?.focus();
    // 처음 열릴 때만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div
      className="flex max-h-[min(420px,70vh)] flex-col overflow-y-auto"
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        const move = menuKey(e.code, entries.length, items.current.findIndex((el) => el === document.activeElement));
        if (!move) return;
        if (move.type === "focus") {
          e.preventDefault();
          items.current[move.index]?.focus();
        } else if (e.code === "Tab") close(true); // Esc는 Popover가 처리한다
      }}
    >
      {entries.map((it, i) => (
        <Fragment key={it.id}>
        {it.divider && <hr className="my-1 border-border" />}
        <button
          ref={(el) => void (items.current[i] = el)}
          type="button"
          role={it.checked === undefined ? "menuitem" : "menuitemradio"}
          aria-checked={it.checked}
          aria-disabled={it.disabled ? true : undefined}
          title={it.disabled}
          tabIndex={-1}
          className={cn(MENU_ITEM, it.danger && "text-destructive")}
          style={it.indent ? { paddingLeft: 8 + it.indent * 14 } : undefined}
          onClick={() => {
            if (it.disabled) return;
            it.onSelect();
            if (!it.stay) close(true);
          }}
        >
          {it.checked !== undefined && <span className="grid w-4 shrink-0 place-items-center" aria-hidden>{it.checked && <Check />}</span>}
          <span className="min-w-0 flex-1 truncate">{it.label}</span>
          {it.hint && <Kbd>{it.hint}</Kbd>}
        </button>
        </Fragment>
      ))}
    </div>
  );
}
