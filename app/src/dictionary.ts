// 사전 화면(WORDS.md §4.29)의 순수 함수: 붙여 넣은 글 → 단어, 찾기, 엔진 안내. 화면은 DictionaryView.tsx, 저장은 코어 `glossary`.
import { engineInUse, type ModelRow } from "./models";

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
