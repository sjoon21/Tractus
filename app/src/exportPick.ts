// 내보내기(Markdown·Word)에 넣을 내용 고르기 (docs/desktop.md §2.4): 항목 목록, 처음 선택, 지난 선택 기억, 코어 인수. 창은 ExportDialog.tsx
import { VIEW_DONE } from "./enhanced";
import { t } from "./i18n";
import { MINUTES_KEY } from "./minutes";
import { DEFAULT_KEY, DEFAULT_NAME, orderDocs, summaryTabDocs, tabLabels, type SummaryDoc, type TemplateInfo } from "./summaries";

/** 고르기 창을 여는 형식 (코어 export.SELECT_FORMATS) */
export const PICK_FORMATS: readonly string[] = ["md", "docx"];
const ENHANCED_KEY = "enhanced";
const LEGACY_MINUTES = t("이전 형식의 회의록"); // words-ok: 회의록은 문서 이름 (회의록 탭의 옛 summary.json)

export interface ExportItem {
  /** 요약 key 또는 부분(transcript | memo | marks) */
  id: string;
  label: string;
  summary: boolean;
  /** 지난 선택을 기억하는 단위: 요약 유형(한 번만 쓴 직접 요약은 모두 custom)·부분 */
  kind: string;
}

/** 이 노트에 있는 것 */
export interface ExportHas {
  memoNote: boolean;
  transcript: boolean;
  memo: boolean;
  marks: boolean;
}

/** 창의 항목: 회의록 → 완성된 노트 → 이전 형식의 회의록 → 요약 탭의 요약(탭 순서·이름) → 대화 내용(메모 내용) → 메모 → 녹음 중 메모. 없는 것은 뺀다 */
export function exportItems(docs: SummaryDoc[], templates: TemplateInfo[], has: ExportHas): ExportItem[] {
  const item = (id: string, label: string, summary: boolean): ExportItem => ({ id, label, summary, kind: summary && id.startsWith("c-") ? "custom" : id });
  const fixed: [string, string][] = [
    [MINUTES_KEY, DEFAULT_NAME],
    [ENHANCED_KEY, VIEW_DONE],
    [DEFAULT_KEY, LEGACY_MINUTES],
  ];
  const rest = summaryTabDocs(orderDocs(docs, templates)).filter((d) => d.key !== ENHANCED_KEY);
  return [
    ...fixed.filter(([key]) => docs.some((d) => d.key === key)).map(([key, label]) => item(key, label, true)),
    ...tabLabels(rest).map((label, i) => item(rest[i].key, label, true)),
    ...(has.transcript ? [item("transcript", has.memoNote ? t("메모 내용") : t("대화 내용"), false)] : []),
    ...(has.memo ? [item("memo", t("메모"), false)] : []),
    ...(has.marks ? [item("marks", t("녹음 중 메모"), false)] : []),
  ];
}

export type Picks = Record<string, boolean>;

/** 처음 선택: 지난번에 끈 종류만 빼고 모두 */
export const initialPick = (items: ExportItem[], picks: Picks): Set<string> => new Set(items.filter((i) => picks[i.kind] ?? true).map((i) => i.id));

/** 코어 인수: 고른 요약(항목 순서)과 부분 */
export function exportSelection(items: ExportItem[], checked: Set<string>): { summaries: string[]; parts: string[] } {
  const on = items.filter((i) => checked.has(i.id));
  return { summaries: on.filter((i) => i.summary).map((i) => i.id), parts: on.filter((i) => !i.summary).map((i) => i.id) };
}

/** 이번 창에 보인 종류만 지금 선택으로 덮어쓴다 (보이지 않은 종류의 지난 선택은 그대로) */
export const mergePicks = (prev: Picks, items: ExportItem[], checked: Set<string>): Picks => ({ ...prev, ...Object.fromEntries(items.map((i) => [i.kind, checked.has(i.id)])) });

/** 저장한 글 → 선택. 깨졌으면 빈 선택 */
export function parsePicks(raw: string | null): Picks {
  try {
    const v: unknown = JSON.parse(raw ?? "{}");
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "boolean"));
  } catch {
    return {};
  }
}

// 지난 선택은 이 창(webview)의 localStorage에 둔다: 막히거나 비어 있으면 모두 고른 상태로 열 뿐이다
const PICKS_KEY = "tractus.export";
type Store = Pick<Storage, "getItem" | "setItem">;

const defaultStore = (): Store | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export function loadPicks(store: Store | null = defaultStore()): Picks {
  try {
    return parsePicks(store?.getItem(PICKS_KEY) ?? null);
  } catch {
    return {};
  }
}

export function savePicks(items: ExportItem[], checked: Set<string>, store: Store | null = defaultStore()): void {
  try {
    store?.setItem(PICKS_KEY, JSON.stringify(mergePicks(loadPicks(store), items, checked)));
  } catch {
    // 저장하지 못하면 다음에 모두 고른 상태로 연다
  }
}
