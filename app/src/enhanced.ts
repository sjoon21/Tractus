// 노트 완성: 내 메모를 뼈대로 대화 내용의 세부를 붙인 완성된 노트 (docs/design/enhanced-notes.md, WORDS.md §4.22).
// 코어가 summaries/enhanced.json(요약 v2 + kind·part·source·at)로 저장한다. 여기는 화면이 쓰는 문구와 순수 계산만 둔다.
import type { SummaryDoc, SummarySection } from "./summaries";

export const ENHANCED_KEY = "enhanced";
export const ENHANCE_LABEL = "노트 완성";
export const REDO_LABEL = "다시 완성";
export const VIEW_MINE = "내 메모";
export const VIEW_DONE = "완성된 노트";
export const EXTRA_TITLE = "메모에 없던 내용";
export const NO_MEMO_NOTICE = "적은 메모가 없어 AI가 구성했습니다.";
export const RUNNING_TEXT = "노트를 완성하는 중…";
export const ENHANCE_HINT = "내가 적은 메모를 뼈대로, 대화 내용에서 찾은 세부를 붙여 노트를 완성합니다.";
export const staleNotice = (sentence: string): string => `${sentence}. 다시 완성하면 반영됩니다.`;

/** 노트의 요약 목록에서 노트 완성 한 건 (없으면 null) */
export const findEnhanced = (docs: readonly SummaryDoc[]): SummaryDoc | null => docs.find((d) => d.kind === "enhanced") ?? null;

/** 화면 묶음: 내 메모 섹션(입력 순서) · 메모에 없던 내용 · 할 일. 내 메모가 하나도 없으면 noMemo */
export function enhancedView(doc: SummaryDoc): { memo: SummarySection[]; extra: SummarySection[]; todos: SummarySection[]; noMemo: boolean } {
  const memo = doc.sections.filter((s) => s.part === "memo");
  return {
    memo,
    extra: doc.sections.filter((s) => s.part === "extra"),
    todos: doc.sections.filter((s) => s.part === "todos" && s.items.length > 0),
    noMemo: memo.length === 0,
  };
}

/** 요약 탭은 노트 완성을 만들지 않는다: 요약 유형 메뉴·기본 제안에서 뺀다 (만든 노트 완성은 요약 목록에 한 칸으로 남는다) */
export const isEnhanced = (key: string): boolean => key === ENHANCED_KEY;
