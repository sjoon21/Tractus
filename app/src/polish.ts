// AI 다듬기 (docs/design/transcript-polish.md): 제안 거르기·낱말 diff·문구. 화면과 무관한 순수 로직 (polish.test.ts).
import { t } from "./i18n";
import { segText, type Segment } from "./lib";

/** 코어 polish.json의 제안 하나. flags: "number"(짐작한 숫자) · "rewrite"(여러 낱말을 다시 씀) */
export interface PolishSuggestion {
  id: string;
  start: number;
  before: string;
  text: string;
  kind: string;
  flags: string[];
}

export const POLISH_LABEL = t("스마트 교정");
export const POLISH_TITLE = t("AI가 대화 내용 전체를 보고, 잘못 들은 말이 있는 문장의 고친 문장을 제안합니다. 받을지는 문장마다 정합니다");
export const POLISH_AGAIN_TITLE = t("다시 교정하면 지금 남은 제안은 새 제안으로 바뀝니다");
export const polishRunning = (done: number, total: number) => (total ? t("스마트 교정 중… {done}/{total}", { done, total }) : t("스마트 교정 중…"));
export const ACCEPT = t("수락");
export const REJECT = t("거절");
export const ACCEPT_ALL = t("모두 수락");
export const REJECT_ALL = t("모두 거절");
export const ACCEPT_ALL_TITLE = t("숫자 확인·다시 쓴 문장 표시가 있는 제안은 하나씩 정하세요");
export const AI_EDITED = t("스마트 교정됨");
export const NO_SUGGESTIONS = t("고칠 곳을 찾지 못했습니다");
export const FLAG_LABEL: Record<string, { text: string; title: string }> = {
  number: { text: t("숫자 확인"), title: t("원문에 없던 숫자가 생겼습니다. AI가 짐작했을 수 있습니다") },
  rewrite: { text: t("다시 쓴 문장"), title: t("여러 낱말을 한꺼번에 바꿨습니다. 녹음을 들어 보고 정하세요") },
};
export const suggestionCount = (n: number, flagged: number) =>
  flagged ? t("교정 제안 {n}개 · 확인할 것 {flagged}개", { n, flagged }) : t("교정 제안 {n}개", { n });

/** 지금도 맞는 제안만: 문장이 있고, 제안을 만든 뒤 아무도 고치지 않았다(before == 지금 문장). 같은 문장은 하나 (뒤의 것) */
export function livePolish(segments: Segment[], list: PolishSuggestion[]): Map<string, PolishSuggestion> {
  const now = new Map(segments.map((s) => [s.id, segText(s)]));
  const out = new Map<string, PolishSuggestion>();
  for (const x of list) if (now.get(x.id) === x.before) out.set(x.id, x);
  return out;
}

/** 모두 받기의 대상: 표시(number·rewrite)가 없는 제안 */
export const bulkAcceptIds = (live: Map<string, PolishSuggestion>): string[] => [...live.values()].filter((x) => x.flags.length === 0).map((x) => x.id);

export type DiffPart = { text: string; op: "same" | "del" | "ins" };

/** 낱말(공백 토큰) 단위 diff: 지운 말과 새 말을 이웃한 덩어리로 묶는다 (LCS, 문장 하나라 O(n·m)로 충분) */
export function wordDiff(before: string, after: string): DiffPart[] {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  const L = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const parts: DiffPart[] = [];
  const push = (op: DiffPart["op"], w: string) => {
    const last = parts[parts.length - 1];
    if (last?.op === op) last.text += " " + w;
    else parts.push({ op, text: w });
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      push("same", a[i]);
      i++;
      j++;
    } else if (j < b.length && (i === a.length || L[i][j + 1] >= L[i + 1][j])) push("ins", b[j++]);
    else push("del", a[i++]);
  }
  // 바꾼 자리는 지운 말 → 새 말 순서로 (읽는 순서)
  for (let k = 0; k + 1 < parts.length; k++) if (parts[k].op === "ins" && parts[k + 1].op === "del") [parts[k], parts[k + 1]] = [parts[k + 1], parts[k]];
  return parts;
}

/** 아직 AI가 보지 않은 문장 (빛나는 줄): 끝난 범위([첫 ID, 끝 ID]) 밖의 문장. 범위는 문장 순서로 본다 */
export function pendingIds(segments: Segment[], doneRanges: [string, string][]): Set<string> {
  const at = new Map(segments.map((s, i) => [s.id, i]));
  const done = new Array<boolean>(segments.length).fill(false);
  for (const [a, b] of doneRanges) {
    const lo = at.get(a);
    const hi = at.get(b);
    if (lo === undefined || hi === undefined) continue;
    for (let i = lo; i <= hi; i++) done[i] = true;
  }
  return new Set(segments.filter((_, i) => !done[i]).map((s) => s.id));
}
