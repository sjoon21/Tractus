// 양쪽 사이드 패널의 상태(앱 전체)와 접기·펼치기 단추. 순수 로직은 panels.ts. docs/desktop.md §3.2
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PanelLeft, PanelRight } from "lucide-react";
import { isImeKey } from "./lib";
import { flushMemos } from "./memo";
import { canCollapse, choose, clampWidth, DEFAULT_WIDTHS, EXPANDED, initialPanels, PANEL_TEXT, PANEL_WIDTH, panelKey, readPanels, restore, restoreWidths, revealFor, toggleLabel, widthByKey, WIDTH_LABEL, WIDTHS_KEY, writePanels, type PanelChoice, type PanelIntent, type PanelState, type PanelWidths, type Side } from "./panels";

export interface PanelsApi {
  state: PanelState;
  /** 접기·펼치기. 오른쪽을 접을 때는 쓰던 메모를 먼저 저장하고, 저장하지 못하면 접지 않는다. 접는 패널 안에 초점이 있으면 그 패널의 단추로 옮긴다 */
  toggle: (side: Side) => Promise<void>;
  /** 어떤 일이 접힌 패널의 내용을 보여야 하면 펼친다 (panels.revealFor) */
  reveal: (intent: PanelIntent) => void;
  /** 노트 화면이 떠 있는 동안 부른다(돌려주는 함수로 해제). 오른쪽 패널이 없는 화면에서는 ⌥⌘B가 아무것도 하지 않게 한다 */
  registerRight: () => () => void;
  /** 패널 폭(px). CSS 변수 --sidebar-w·--rail로 그린다 */
  widths: PanelWidths;
  /** 폭을 바꾼다 (범위·가운데 최소 폭 안으로). save면 이 Mac에 기억한다 (끌기가 끝날 때) */
  setWidth: (side: Side, px: number, save?: boolean) => void;
}

const NOOP_API: PanelsApi = { state: EXPANDED, toggle: async () => {}, reveal() {}, registerRight: () => () => {}, widths: DEFAULT_WIDTHS, setWidth() {} };

const readWidths = (): PanelWidths => {
  try {
    return restoreWidths(localStorage.getItem(WIDTHS_KEY));
  } catch {
    return DEFAULT_WIDTHS;
  }
};
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

  const [widths, setWidths] = useState<PanelWidths>(readWidths);
  const widthsRef = useRef(widths);
  const setWidth = useCallback((side: Side, px: number, save = false) => {
    const cur = widthsRef.current;
    const next = { ...cur, [side]: clampWidth(side, px, cur[side === "left" ? "right" : "left"], window.innerWidth) };
    widthsRef.current = next;
    setWidths(next);
    if (save) {
      try {
        localStorage.setItem(WIDTHS_KEY, JSON.stringify(next));
      } catch {
        // 저장하지 못하면 이번 실행에서만 유지된다
      }
    }
  }, []);
  // 그리는 폭: 정한 폭을 지금 창에 맞춘다. 창을 줄였다 다시 키우면 정한 폭으로 돌아온다 (정한 폭은 그대로)
  useEffect(() => {
    const paint = () => {
      const w = window.innerWidth;
      const left = clampWidth("left", widths.left, PANEL_WIDTH.right.min, w);
      const root = document.documentElement.style;
      root.setProperty("--sidebar-w", `${left}px`);
      root.setProperty("--rail", `${clampWidth("right", widths.right, left, w)}px`);
    };
    paint();
    window.addEventListener("resize", paint);
    return () => window.removeEventListener("resize", paint);
  }, [widths]);

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

  const api = useMemo<PanelsApi>(() => ({ state, toggle, reveal, registerRight, widths, setWidth }), [state, toggle, reveal, registerRight, widths, setWidth]);
  return <PanelsContext.Provider value={api}>{children}</PanelsContext.Provider>;
}

/** 패널 가장자리의 접기·펼치기 단추. 접혀도 남는 자리에 두므로 언제나 닿는다 (아이콘 + 이름 + 단축키) */
export function PanelToggle({ side }: { side: Side }) {
  const { state, toggle } = usePanels();
  const collapsed = state[side];
  const t = PANEL_TEXT[side];
  const { label, title } = toggleLabel(side, collapsed);
  return (
    <button type="button" id={t.toggleId} className={`panel-toggle is-${side} absolute z-30 grid size-7 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 [&_svg]:size-4 ${side === "left" ? (collapsed ? "top-[48px] left-1/2 -translate-x-1/2" : "top-[14px] right-2") : collapsed ? "top-[12px] left-1/2 -translate-x-1/2" : "top-[12px] right-3"}`} aria-label={label} title={title} aria-expanded={!collapsed} aria-controls={t.controls} aria-keyshortcuts={t.shortcut} onClick={() => void toggle(side)}>
      {side === "left" ? <PanelLeft aria-hidden /> : <PanelRight aria-hidden />}
    </button>
  );
}

/**
 * 패널 경계의 폭 조절 손잡이 (role=separator). 끌거나, 초점을 두고 ←/→(한 번에 16px)·Home·End, 두 번 누르면 기본 폭.
 * 왼쪽 패널은 창 왼쪽 끝에서, 오른쪽 패널은 창 오른쪽 끝에서 잰다. 놓을 때 이 Mac에 기억한다
 */
export function PanelResizer({ side, className }: { side: Side; className?: string }) {
  const { widths, setWidth } = usePanels();
  const px = widths[side];
  const fromPointer = (x: number) => (side === "left" ? x : window.innerWidth - x);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={WIDTH_LABEL[side]}
      title={WIDTH_LABEL[side]}
      aria-valuenow={px}
      aria-valuemin={PANEL_WIDTH[side].min}
      aria-valuemax={PANEL_WIDTH[side].max}
      tabIndex={0}
      className={`group absolute inset-y-0 z-20 w-2 cursor-col-resize outline-none ${side === "left" ? "-right-1" : "-left-1"} ${className ?? ""}`}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) setWidth(side, fromPointer(e.clientX));
      }}
      onPointerUp={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        setWidth(side, fromPointer(e.clientX), true);
      }}
      onDoubleClick={() => setWidth(side, PANEL_WIDTH[side].def, true)}
      onKeyDown={(e) => {
        const next = widthByKey(side, e.key, px);
        if (next === null) return;
        e.preventDefault(); // 재생 단축키(←/→)로 다시 쓰지 않게
        setWidth(side, next, true);
      }}
    >
      <span aria-hidden className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-ring/60 group-focus-visible:bg-ring group-active:bg-ring" />
    </div>
  );
}

