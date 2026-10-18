// 화면 언어: 한국어 문구가 원본이자 키다. `t("노트 {n}개", { n })` → 영어면 사전(./en)의 문장, 없으면 한국어 그대로.
// 언어는 시작할 때 한 번 정하고(main.tsx의 initLang), 바꾸면 화면을 다시 연다: 모듈 상수의 문구도 그 언어로 다시 만들어지게.
// 고르는 값은 이 Mac의 브라우저 저장소(`tractus.lang`, 테마와 같은 곳), `시스템 설정`이면 macOS 언어(Rust system_lang).
// 사전 모양·검사: docs/desktop.md §3.8, WORDS.md §7 (영어 용어), i18n.test.ts (빠진 번역·남은 한국어)

export type Lang = "ko" | "en";
export type LangPref = "system" | Lang;
/** 영어 문장. 배열이면 [n이 1일 때, 그 밖] (vars.n으로 고른다) */
export type Entry = string | readonly [string, string];
export type Dict = Readonly<Record<string, Entry>>;

const KEY = "tractus.lang";
let lang: Lang = "ko";
let dict: Dict = {};

export const getLang = (): Lang => lang;
/** Intl·toLocale…에 넘길 로캘 */
export const locale = (): string => (lang === "en" ? "en-US" : "ko-KR");

/** 언어를 정한다. 영어면 사전도 함께 (테스트는 직접 부른다) */
export function setLang(l: Lang, d: Dict = {}): void {
  lang = l;
  dict = l === "en" ? d : {};
  if (typeof document !== "undefined") document.documentElement.lang = l;
}

export function t(ko: string, vars?: Readonly<Record<string, string | number>>): string {
  const e = lang === "en" ? dict[ko] : undefined;
  const s = e === undefined ? ko : typeof e === "string" ? e : vars?.n === 1 ? e[0] : e[1];
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

export function readLangPref(): LangPref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "ko" || v === "en" ? v : "system";
  } catch {
    return "system";
  }
}

export function saveLangPref(p: LangPref): void {
  try {
    if (p === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, p);
  } catch {
    /* 저장하지 못하면 다음 실행에서 시스템 설정으로 돌아간다 */
  }
}

/** macOS 첫 번째 선호 언어(BCP 47, 예: `ko-KR`, `en-US`)가 한국어면 한국어, 아니면 영어. 모르면 한국어 */
export const resolveLang = (p: LangPref, system: string | null): Lang =>
  p !== "system" ? p : system === null ? "ko" : /^ko\b/i.test(system) ? "ko" : "en";

export const LANG_OPTIONS: readonly { value: LangPref; label: () => string }[] = [
  { value: "system", label: () => t("시스템 설정") },
  { value: "ko", label: () => "한국어" }, // i18n-ok: 언어 이름은 그 언어로 쓴다
  { value: "en", label: () => "English" },
];
