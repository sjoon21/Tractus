// 사전 화면(WORDS.md §4.29)의 순수 함수: 붙여 넣은 글 → 단어, 찾기, 엔진 안내. 화면은 DictionaryView.tsx, 저장은 코어 `glossary`.
import { engineInUse, type ModelRow } from "./models";
import { termFromEdit } from "./vocab";

/** 찾기 칸은 단어가 이보다 많을 때만 보인다 */
export const FIND_MIN = 10;

/** 쉼표·줄바꿈이 있으면 여러 단어로 본다 (붙여 넣기 미리보기) */
export const isMulti = (text: string) => /[,\n]/.test(text);

/** 쉼표·줄바꿈으로 나눈 단어: 앞뒤 공백과 glossary.md 줄 머리(`- `·`* `)를 떼고, 빈 값·중복을 빼고, 순서는 그대로 */
export function splitTerms(text: string): string[] {
  const out = text
    .split(/[,\n]/)
    .map((x) => x.trim().replace(/^[-*]\s+/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return [...new Set(out)];
}

/** 대소문자를 가리지 않는 부분 일치 */
export function matchTerms(terms: readonly string[], q: string): string[] {
  const k = q.trim().toLowerCase();
  return k ? terms.filter((x) => x.toLowerCase().includes(k)) : [...terms];
}

/** 지금 변환에 쓰는 엔진이 사전 단어를 쓰지 않는 계열인가 (Qwen 계열만 쓴다, CLAUDE.md). 엔진을 모르면 false */
export function engineSkipsVocab(models: Pick<ModelRow, "id" | "engine" | "installed">[], chosen: string | null | undefined, recommendedTrack: string | null | undefined): boolean {
  const id = engineInUse(models, chosen, recommendedTrack);
  const engine = models.find((m) => m.id === id)?.engine;
  return !!engine && engine !== "qwen3";
}

/** 사전 제안을 한 번에 보이는 수 */
export const SUGGEST_MAX = 8;

/** 사람이 고친 문장 쌍에서 고친 낱말(vocab.termFromEdit)을 모아, 사전에 없고 무시하지 않은 것을 많이 고친 순으로 */
export function suggestFromCorrections(pairs: readonly (readonly [string, string])[], terms: readonly string[], dismissed: ReadonlySet<string>, limit = SUGGEST_MAX): { term: string; count: number }[] {
  const have = new Set(terms.map((x) => x.toLowerCase()));
  const count = new Map<string, number>();
  for (const [before, after] of pairs) {
    const term = termFromEdit(before, after);
    if (term && !have.has(term.toLowerCase()) && !dismissed.has(term)) count.set(term, (count.get(term) ?? 0) + 1);
  }
  return [...count].map(([term, count]) => ({ term, count })).sort((a, b) => b.count - a.count).slice(0, limit); // 같은 수는 처음 나온 순서 (sort는 안정)
}
