// 오른쪽 패널의 탭 모델과 키보드 (MeetingView). 화면과 무관한 순수 로직은 rail.test.ts에서 검사한다.

import { t } from "./i18n";

export type RailTab = "summary" | "minutes" | "ask" | "memo";

export const RAIL_LABEL: Record<RailTab, string> = { summary: t("요약"), minutes: t("회의록"), ask: t("AI 질문"), memo: t("메모") }; // words-ok: 회의록은 문서 이름

/** 녹음 노트는 요약·회의록·AI 질문·메모, 메모 노트는 본문이 가운데에 있으므로 요약·AI 질문 (회의록은 녹음 노트만: docs/design/meeting-minutes.md) */
export const railTabs = (memoNote: boolean): RailTab[] => (memoNote ? ["summary", "ask"] : ["summary", "minutes", "ask", "memo"]);

/** 고른 탭이 이 노트에 없으면(다른 종류의 노트로 바뀜) 첫 탭 */
export const validTab = (tabs: RailTab[], tab: RailTab): RailTab => (tabs.includes(tab) ? tab : tabs[0]);

/**
 * 탭 목록에서 키를 누르면 이동할 탭. ←→는 끝에서 돌고, Home·End는 처음·끝. 그 밖의 키는 null (건드리지 않는다).
 * e.code로 본다: 한글 입력 상태에서도 방향키는 같다. 부르는 쪽이 preventDefault를 해서 재생 단축키(←→ 5초 이동)가 이 키를 다시 쓰지 않게 한다
 */
export function railKey(tabs: RailTab[], current: RailTab, code: string): RailTab | null {
  const at = Math.max(0, tabs.indexOf(current));
  switch (code) {
    case "ArrowRight":
      return tabs[(at + 1) % tabs.length];
    case "ArrowLeft":
      return tabs[(at - 1 + tabs.length) % tabs.length];
    case "Home":
      return tabs[0];
    case "End":
      return tabs[tabs.length - 1];
    default:
      return null;
  }
}

/** 탭 접근성 이름: 오른쪽 패널 전체 (`aside`) */
export const railLabel = (memoNote: boolean): string => (memoNote ? t("요약과 AI 질문") : t("요약, 회의록, AI 질문, 메모")); // words-ok: 회의록은 문서 이름

/**
 * 도크의 탭을 눌렀을 때 할 일 (순수 규칙). 넓은 창에서 이미 열려 있는 탭을 다시 누르면 패널을 접는다.
 * 그 밖에는 그 탭을 보이고, 패널이 접혀 있었으면 펴며, 좁은 창(패널이 본문 아래로 내려간 때)에서는 패널로 스크롤한다.
 */
export type TabClickPlan = { kind: "fold" } | { kind: "open"; expand: boolean; scroll: boolean };
export function tabClickPlan({ narrow, collapsed, current, clicked }: { narrow: boolean; collapsed: boolean; current: RailTab; clicked: RailTab }): TabClickPlan {
  if (!narrow && !collapsed && clicked === current) return { kind: "fold" };
  return { kind: "open", expand: collapsed, scroll: narrow };
}
