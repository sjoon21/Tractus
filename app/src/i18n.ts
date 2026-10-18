// 화면 언어: 한국어 문구가 원본이자 키다. `t("노트 {n}개", { n })` → 영어면 사전(./en)의 문장, 없으면 한국어 그대로.
// 언어는 시작할 때 한 번 정하고(main.tsx의 initLang), 바꾸면 화면을 다시 연다: 모듈 상수의 문구도 그 언어로 다시 만들어지게.
// 고른 값은 settings.json `ui_lang`이고 언어는 Rust가 정한다(i18n.rs: `시스템 설정`이면 macOS 언어). 메뉴 막대·코어도 같은 언어를 쓴다.
// 사전 모양·검사: docs/desktop.md §3.8, WORDS.md §7 (영어 용어), i18n.test.ts (빠진 번역·남은 한국어)

export type Lang = "ko" | "en";
export type LangPref = "system" | Lang;
/** 영어 문장. 배열이면 [n이 1일 때, 그 밖] (vars.n으로 고른다) */
export type Entry = string | readonly [string, string];
export type Dict = Readonly<Record<string, Entry>>;

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

/** 시각 표기: 한국어는 `15:00`, 영어는 `3:00 PM` (목록·캘린더·노트 머리가 같은 모양을 쓰게) */
export function clock(h: number, m: number): string {
  const mm = String(m).padStart(2, "0");
  return lang === "en" ? `${h % 12 || 12}:${mm} ${h < 12 ? "AM" : "PM"}` : `${String(h).padStart(2, "0")}:${mm}`;
}

export function t(ko: string, vars?: Readonly<Record<string, string | number>>): string {
  const e = lang === "en" ? dict[ko] : undefined;
  const s = e === undefined ? ko : typeof e === "string" ? e : vars?.n === 1 ? e[0] : e[1];
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

let pref: LangPref = "system";
/** 설정에 저장된 고른 값 (시작할 때 Rust ui_lang이 알려 준다) */
export const readLangPref = (): LangPref => pref;
export const setLangPref = (p: LangPref) => void (pref = p);

export const LANG_OPTIONS: readonly { value: LangPref; label: () => string }[] = [
  { value: "system", label: () => t("시스템 설정") },
  { value: "ko", label: () => "한국어" }, // i18n-ok: 언어 이름은 그 언어로 쓴다
  { value: "en", label: () => "English" },
];
