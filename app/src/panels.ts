// 양쪽 사이드 패널 접기·펼치기 (왼쪽 노트 목록, 오른쪽 패널). 화면과 무관한 순수 로직: panels.test.ts, docs/desktop.md §3.2.

import { t } from "./i18n";

export type Side = "left" | "right";
/** true = 접힘. 둘 다 펼친 것이 기본이다 */
export interface PanelState {
  left: boolean;
  right: boolean;
}

export const EXPANDED: PanelState = { left: false, right: false };
/** localStorage 키: 이 창(webview)에만 저장한다. 모양을 바꾸면 버전을 올린다 */
export const PANELS_KEY = "tractus.panels.v1";
/** 저장한 선택이 없고 창 너비가 이보다 좁으면 오른쪽 패널을 접고 시작한다 (최소 창 너비 900) */
export const NARROW_PX = 960;

/** 문구 (WORDS.md §4.17) */
export const PANEL_TEXT = {
  left: { collapse: t("노트 목록 접기"), expand: t("노트 목록 펼치기"), controls: "sidebar-body", toggleId: "panel-toggle-left", key: "⌘B", shortcut: "Meta+B" },
  right: { collapse: t("오른쪽 패널 접기"), expand: t("오른쪽 패널 펼치기"), controls: "rail-body", toggleId: "panel-toggle-right", key: "⌥⌘B", shortcut: "Alt+Meta+B" },
} as const;

/** 단추 이름(`aria-label`)과 `title`. 단축키는 title에만 덧붙인다 (aria-keyshortcuts가 따로 알린다) */
export const toggleLabel = (side: Side, collapsed: boolean): { label: string; title: string } => {
  const p = PANEL_TEXT[side];
  const label = collapsed ? p.expand : p.collapse;
  return { label, title: `${label} (${p.key})` };
};

/** 접힌 왼쪽 띠의 녹음 단추 이름 */
export const RAIL_REC_LABEL = { idle: t("녹음 시작"), live: t("녹음 중"), asking: t("녹음 끝남"), converting: t("변환 중…") } as const;
/** 접힌 띠의 배지: 목록에서만 보이는 '변환 대기 중인 녹음'이 있음을 알린다 */
export const railPendingLabel = (n: number): string => t("변환 대기 중인 녹음 {n}개", { n });
/** 접힌 띠의 단추 상태: 파일 가져오기도 변환이다 */
export const railRecState = (s: { recording: boolean; busy: boolean; asking?: boolean }): keyof typeof RAIL_REC_LABEL => (s.recording ? "live" : s.asking ? "asking" : s.busy ? "converting" : "idle");

export const togglePanel = (s: PanelState, side: Side): PanelState => ({ ...s, [side]: !s[side] });

/** 앱이 '펼침'을 요구하는 일 (오른쪽 패널에 있는 것을 보여야 할 때). 그 밖의 일은 접힘을 건드리지 않는다 */
export type PanelIntent =
  | { kind: "memo-line"; memoNote: boolean } // 인용·검색 결과가 가리키는 녹음 노트의 메모 줄 (메모 탭)
  | { kind: "seek" } // 대화 시각으로 이동: 가운데에서 일어난다
  | { kind: "search" } // ⌘K: 검색창이 왼쪽 목록 안에 있으므로 접혀 있으면 펼친다
  | { kind: "open-note" } // 검색 결과·목록·인용으로 노트를 연다: 왼쪽을 억지로 펼치지 않는다
  | { kind: "record" }; // 녹음 단추: 접힌 띠에서도 누를 수 있다

/** 오른쪽 패널이 접혀 있으면 펼쳐야 하는가. 메모 노트의 줄은 가운데 본문에서 고르므로 펼치지 않는다 */
export const needsRight = (i: PanelIntent): boolean => i.kind === "memo-line" && !i.memoNote;
export const needsLeft = (i: PanelIntent): boolean => i.kind === "search";

/** 이 일을 하려고 필요한 만큼만 펼친다. 바뀔 것이 없으면 같은 객체를 돌려준다 */
export function revealFor(s: PanelState, i: PanelIntent): PanelState {
  const left = s.left && !needsLeft(i);
  const right = s.right && !needsRight(i);
  return left === s.left && right === s.right ? s : { left, right };
}

/** 사용자가 직접 정한 칸만 담는다. 없는 칸은 기본값(좁은 창 규칙 포함)을 따른다 */
export type PanelChoice = Partial<PanelState>;

export const serialize = (c: PanelChoice): string => JSON.stringify({ left: c.left, right: c.right });

/** 사용자가 이 칸을 정했음을 기록한다 (새 객체). 기본값이나 자동 펼침은 기록하지 않는다 */
export const choose = (c: PanelChoice, side: Side, collapsed: boolean): PanelChoice => ({ ...c, [side]: collapsed });

/** 저장한 값을 읽는다. 없거나 깨졌으면(JSON이 아님·객체가 아님) null. 불리언이 아닌 칸은 버리고, 쓸 칸이 없으면 null */
export function restore(raw: string | null | undefined): PanelChoice | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return null;
    const { left, right } = v as Record<string, unknown>;
    const c: PanelChoice = { ...(typeof left === "boolean" && { left }), ...(typeof right === "boolean" && { right }) };
    return Object.keys(c).length ? c : null;
  } catch {
    return null;
  }
}

/** 처음 그릴 때의 상태: 저장한 선택이 먼저다. 정하지 않은 칸은 기본값: 펼침, 단 좁은 창에서는 오른쪽을 접는다 */
export function initialPanels(raw: string | null | undefined, width: number): PanelState {
  const c = restore(raw);
  return { left: c?.left ?? false, right: c?.right ?? (Number.isFinite(width) && width < NARROW_PX) };
}

type Store = Pick<Storage, "getItem" | "setItem">;
const defaultStore = (): Store | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export function readPanels(store: Store | null = defaultStore()): string | null {
  try {
    return store?.getItem(PANELS_KEY) ?? null;
  } catch {
    return null;
  }
}

/** 저장하지 못하면 이번 실행에서만 유지된다 */
export function writePanels(s: PanelChoice, store: Store | null = defaultStore()): void {
  try {
    store?.setItem(PANELS_KEY, serialize(s));
  } catch {
    // 개인정보 보호 창·저장소 가득 참
  }
}

/**
 * 오른쪽 패널을 접을 때: 쓰던 메모를 먼저 저장한다. 숨기면 입력창의 blur가 믿을 수 없고, 단축키로 접으면 blur 자체가 없다.
 * 저장하지 못하면 접지 않는다 (오류는 열려 있는 편집기가 이미 보이고 있다. 화면 이동과 같은 규칙)
 */
export async function canCollapse(side: Side, flush: () => Promise<boolean>): Promise<boolean> {
  return side === "right" ? flush() : true;
}

/** ⌘B → 왼쪽, ⌥⌘B → 오른쪽. 물리 키(code)로 본다: 한글 입력 상태에서도 같고 ⌥B는 `∫`이다. 그 밖의 조합은 null */
export function panelKey(e: { code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): Side | null {
  if (e.code !== "KeyB" || !e.metaKey || e.ctrlKey || e.shiftKey) return null;
  return e.altKey ? "right" : "left";
}

// ── 폭 조절 (v3.49): 경계를 끌거나 손잡이에 초점을 두고 ←/→. 두 번 누르면 기본 폭 ──

/** 패널마다 최소·최대·기본 폭(px). 기본은 theme.css의 --sidebar-w·--rail과 같다 */
export const PANEL_WIDTH = { left: { min: 200, max: 400, def: 260 }, right: { min: 280, max: 560, def: 340 } } as const;
/** 가운데(대화 내용)가 이보다 좁아지지 않게 한다 */
export const CENTER_MIN_PX = 420;
/** 손잡이에 초점이 있을 때 ←/→ 한 번에 바뀌는 폭 */
export const WIDTH_STEP_PX = 16;
export const WIDTHS_KEY = "tractus.panelWidths.v1";
export type PanelWidths = Record<Side, number>;
export const DEFAULT_WIDTHS: PanelWidths = { left: PANEL_WIDTH.left.def, right: PANEL_WIDTH.right.def };

/** 그 패널의 최소·최대 사이로, 그리고 다른 패널과 함께 가운데를 CENTER_MIN_PX보다 좁히지 않게 (그래도 최소보다 작아지지는 않는다) */
export function clampWidth(side: Side, px: number, other: number, windowW: number): number {
  const { min, max } = PANEL_WIDTH[side];
  const room = Number.isFinite(windowW) ? windowW - other - CENTER_MIN_PX : max;
  return Math.round(Math.max(min, Math.min(px, max, room)));
}

/** 저장한 폭. 없거나 깨졌으면 기본값, 범위 밖이면 범위 안으로 */
export function restoreWidths(raw: string | null | undefined): PanelWidths {
  try {
    const v = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const pick = (side: Side) => (typeof v[side] === "number" && Number.isFinite(v[side]) ? Math.min(PANEL_WIDTH[side].max, Math.max(PANEL_WIDTH[side].min, v[side] as number)) : PANEL_WIDTH[side].def);
    return { left: pick("left"), right: pick("right") };
  } catch {
    return DEFAULT_WIDTHS;
  }
}

/** 손잡이의 ←/→: 화살표 방향으로 경계가 움직인다 (왼쪽 패널은 →가 넓히고, 오른쪽 패널은 ←가 넓힌다). 그 밖의 키는 null */
export function widthByKey(side: Side, key: string, px: number): number | null {
  if (key === "Home") return PANEL_WIDTH[side].min;
  if (key === "End") return PANEL_WIDTH[side].max;
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  const grow = (key === "ArrowRight") === (side === "left");
  return px + (grow ? WIDTH_STEP_PX : -WIDTH_STEP_PX);
}

export const WIDTH_LABEL: Record<Side, string> = { left: t("노트 목록 폭 조절"), right: t("오른쪽 패널 폭 조절") };
