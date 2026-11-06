// ⌘K 빠른 실행 (WORDS.md §4.30): 노트(제목 일치, 비면 최근 노트)·앱 동작·내용 검색을 한 목록으로. 화면은 CommandPalette.tsx
import type { ReactNode } from "react";
import type { MeetingInfo } from "./api";
import { t } from "./i18n";
import { quickMatches } from "./quickMatch";

/** 빈 입력일 때 보이는 최근 노트 수 */
export const RECENT_NOTES = 5;

export type PaletteAction = {
  id: string;
  label: string;
  /** 찾을 때 함께 보는 말 (보이지 않는다) */
  keywords?: string;
  icon?: ReactNode;
  kbd?: string;
  /** 빈 입력에서는 보이지 않고 찾을 때만 나온다 (자주 쓰지 않는 것으로 목록을 길게 만들지 않게) */
  typed?: boolean;
  /** 지금 할 수 없으면 그 이유. 고를 수 없다 */
  blocked?: string;
  run: () => void;
};

export type PaletteItem = { kind: "note"; note: MeetingInfo } | { kind: "action"; action: PaletteAction } | { kind: "search"; q: string };
export type PaletteSection = { title: string; items: PaletteItem[] };

const byUpdated = (a: MeetingInfo, b: MeetingInfo) => (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at);

/** 동작 이름·찾기 말에 질의의 낱말이 모두 들어 있는가 (대소문자 무시) */
export function actionMatches(a: Pick<PaletteAction, "label" | "keywords">, query: string): boolean {
  const hay = `${a.label} ${a.keywords ?? ""}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/** 입력에 맞는 묶음. 빈 입력: 이 노트의 동작 + 최근 노트 + 모든 동작. 입력이 있으면 맞는 동작·노트 + 폴더·태그 + 맨 끝 `내용에서 찾기`. 빈 묶음은 뺀다.
 * noteActions: 지금 연 노트의 동작 (노트를 열었을 때만). jumps: 폴더·태그로 거르기 (입력이 있을 때만: 빈 목록을 길게 만들지 않게) */
export function paletteSections(notes: readonly MeetingInfo[], actions: readonly PaletteAction[], query: string, noteActions: readonly PaletteAction[] = [], jumps: readonly PaletteAction[] = []): PaletteSection[] {
  const q = query.trim();
  const found = q ? quickMatches(notes, q) : [...notes].sort(byUpdated).slice(0, RECENT_NOTES);
  const match = (list: readonly PaletteAction[]): PaletteItem[] => list.filter((a) => (q ? actionMatches(a, q) : !a.typed)).map((action) => ({ kind: "action", action }));
  const sections: PaletteSection[] = [
    { title: t("이 노트"), items: match(noteActions) },
    { title: q ? t("노트") : t("최근 노트"), items: found.map((note) => ({ kind: "note", note })) },
    { title: t("동작"), items: match(actions) },
    { title: t("폴더·태그"), items: q ? match(jumps) : [] },
    { title: t("찾기"), items: q ? [{ kind: "search", q }] : [] },
  ];
  return sections.filter((s) => s.items.length);
}

/** 키보드로 고를 수 있는 항목인가 (할 수 없는 동작은 건너뛴다) */
export const pickable = (i: PaletteItem) => !(i.kind === "action" && i.action.blocked);

/** ↑↓로 다음 고를 항목. 고를 것이 없으면 -1. 끝에서는 반대쪽 끝으로 돈다 */
export function step(items: readonly PaletteItem[], from: number, dir: 1 | -1): number {
  for (let k = 1; k <= items.length; k++) {
    const i = (((from + dir * k) % items.length) + items.length) % items.length;
    if (pickable(items[i])) return i;
  }
  return -1;
}
