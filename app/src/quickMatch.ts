// 사이드바 검색창의 제목 바로가기 (QuickFind.tsx): 입력하는 동안 제목에 맞는 노트를 바로 열 수 있게 고른다 (내용 검색은 Enter로 SearchView).
import type { MeetingInfo } from "./api";

export const QUICK_MAX = 6;

/** 제목에 질의(공백으로 나눈 낱말 모두)가 든 노트. 제목이 질의로 시작하는 것을 앞에 두고, 나머지는 받은 순서(최근 순)를 지킨다 */
export function quickMatches<T extends Pick<MeetingInfo, "title">>(notes: readonly T[], query: string, limit = QUICK_MAX): T[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const hits = notes.filter((n) => {
    const title = (n.title ?? "").toLowerCase();
    return terms.every((w) => title.includes(w));
  });
  const q = terms.join(" ");
  const head = hits.filter((n) => (n.title ?? "").toLowerCase().startsWith(q));
  return [...head, ...hits.filter((n) => !head.includes(n))].slice(0, limit);
}
