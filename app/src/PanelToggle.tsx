// 양쪽 사이드 패널의 상태(앱 전체)와 접기·펼치기 단추. 순수 로직은 panels.ts. docs/desktop.md §3.2
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isImeKey } from "./lib";
import { flushMemos } from "./memo";
import { canCollapse, choose, EXPANDED, initialPanels, PANEL_TEXT, panelKey, readPanels, restore, revealFor, toggleLabel, writePanels, type PanelChoice, type PanelIntent, type PanelState, type Side } from "./panels";

export interface PanelsApi {
  state: PanelState;
  /** 접기·펼치기. 오른쪽을 접을 때는 쓰던 메모를 먼저 저장하고, 저장하지 못하면 접지 않는다. 접는 패널 안에 초점이 있으면 그 패널의 단추로 옮긴다 */
  toggle: (side: Side) => Promise<void>;
  /** 어떤 일이 접힌 패널의 내용을 보여야 하면 펼친다 (panels.revealFor) */
  reveal: (intent: PanelIntent) => void;
  /** 노트 화면이 떠 있는 동안 부른다(돌려주는 함수로 해제). 오른쪽 패널이 없는 화면에서는 ⌥⌘B가 아무것도 하지 않게 한다 */
  registerRight: () => () => void;
}

const NOOP_API: PanelsApi = { state: EXPANDED, toggle: async () => {}, reveal() {}, registerRight: () => () => {} };
export const PanelsContext = createContext<PanelsApi>(NOOP_API);
export const usePanels = (): PanelsApi => useContext(PanelsContext);

/** 접히는 패널 안에 초점이 있으면 (숨기면 잃으므로) 그 패널의 단추로 옮긴다 */
function moveFocusOut(side: Side): void {
  const t = PANEL_TEXT[side];
  const body = document.getElementById(t.controls);
  if (body?.contains(document.activeElement)) document.getElementById(t.toggleId)?.focus();
}

export function PanelsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PanelState>(() => initialPanels(readPanels(), window.innerWidth));
  const ref = useRef(state);
  const rightCount = useRef(0);
  // 사용자가 직접 정한 칸만 저장한다. 좁은 창의 기본값·자동 펼침은 저장하지 않는다
  const chosen = useRef<PanelChoice>(restore(readPanels()) ?? {});
  const apply = useCallback((next: PanelState) => {
    ref.current = next;
    setState(next);
  }, []);

  const toggle = useCallback(
    async (side: Side) => {
      const collapse = !ref.current[side];
      if (collapse && !(await canCollapse(side, flushMemos))) return;
      if (ref.current[side] === collapse) return; // 기다리는 사이 다른 길로 이미 바뀌었다
      if (collapse) moveFocusOut(side);
      chosen.current = choose(chosen.current, side, collapse);
      writePanels(chosen.current);
      apply({ ...ref.current, [side]: collapse });
    },
    [apply],
  );
  const reveal = useCallback(
    (intent: PanelIntent) => {
      const next = revealFor(ref.current, intent);
      if (next !== ref.current) apply(next);
    },
    [apply],
  );
  const registerRight = useCallback(() => {
    rightCount.current += 1;
    return () => void (rightCount.current -= 1);
  }, []);

  // ⌘B 왼쪽, ⌥⌘B 오른쪽. 글을 쓰는 중에도 된다(⌘B는 이 앱에서 굵게 쓰기가 아니다). 키를 누르고 있어도 한 번만
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const side = panelKey(e);
      if (!side || isImeKey(e) || (side === "right" && rightCount.current === 0)) return;
      e.preventDefault();
      if (!e.repeat) void toggle(side);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  const api = useMemo<PanelsApi>(() => ({ state, toggle, reveal, registerRight }), [state, toggle, reveal, registerRight]);
  return <PanelsContext.Provider value={api}>{children}</PanelsContext.Provider>;
}

/** 패널 가장자리의 접기·펼치기 단추. 접혀도 남는 자리에 두므로 언제나 닿는다 (아이콘 + 이름 + 단축키) */
export function PanelToggle({ side }: { side: Side }) {
  const { state, toggle } = usePanels();
  const collapsed = state[side];
  const t = PANEL_TEXT[side];
  const { label, title } = toggleLabel(side, collapsed);
  const pointsLeft = side === "left" ? !collapsed : collapsed; // 접으면 가장자리 쪽으로, 펼치면 안쪽으로
  return (
    <button type="button" id={t.toggleId} className={`panel-toggle is-${side}`} aria-label={label} title={title} aria-expanded={!collapsed} aria-controls={t.controls} aria-keyshortcuts={t.shortcut} onClick={() => void toggle(side)}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden focusable="false">
        <path d={pointsLeft ? "M10 3.5 5.5 8l4.5 4.5" : "M6 3.5 10.5 8 6 12.5"} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
