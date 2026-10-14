// AI 서비스(Upstage) API 키 설정 (docs/desktop.md §2.14). 키는 Rust(llm_key.rs)만 읽고, 화면은 등록 여부만 안다.
import { errorView, JOB_ERROR } from "./lib";

export const KEY_MIN = 10;
export const KEY_MAX = 200;

/** 저장 전 안내용 검사 (Rust llm_key::validate와 같은 규칙, 거기서 한 번 더 막는다). 문제가 없으면 null */
export function keyProblem(raw: string): string | null {
  const key = raw.trim();
  if (!key) return "API 키를 입력하세요.";
  const len = [...key].length;
  if (len < KEY_MIN || len > KEY_MAX) return `API 키는 ${KEY_MIN}자에서 ${KEY_MAX}자 사이여야 합니다.`;
  if (/[\s\p{Cc}]/u.test(key)) return "API 키 중간에 공백이나 줄바꿈이 있습니다. 키만 그대로 붙여 넣으세요.";
  if (!/^[\x21-\x7e]+$/.test(key)) return "API 키에 영문·숫자·기호가 아닌 글자가 있습니다. 키만 그대로 붙여 넣으세요.";
  return null;
}

export const keyStatusText = (saved: boolean | null): string => (saved === null ? "확인 중…" : saved ? "키가 등록되어 있습니다" : "등록된 키가 없습니다");

/** 코어가 AI 서비스 설정이 없다고 알리는 오류 코드: 이 앱에서는 키를 등록하면 풀린다 */
export const KEY_ERROR_CODE = "llm_config";

const KEY_MISSING = {
  summarize: "AI 키가 없어 요약할 수 없습니다. 설정에서 API 키를 등록하세요.",
  ask: "AI 키가 없어 답변할 수 없습니다. 설정에서 API 키를 등록하세요.",
} as const;

/** 요약·질문 실패 문장. `settings`가 true면 화면이 `설정 열기`를 함께 보인다 */
export function llmErrorView(kind: keyof typeof KEY_MISSING, message: string | null, code: string | null | undefined): { text: string; detail: string | null; settings: boolean } {
  const v = errorView(message, code, JOB_ERROR[kind]);
  return code === KEY_ERROR_CODE ? { ...v, text: KEY_MISSING[kind], settings: true } : { ...v, settings: false };
}

/** 키를 저장·삭제했다: 보내기 전 안내를 새로 읽어야 하는 화면에 알린다 */
export const KEY_CHANGED = "tractus:llm-key-changed";

/** 설정 화면 열기 요청 (깊은 화면에서 App으로) */
export const OPEN_SETTINGS = "tractus:open-settings";
export const requestSettings = () => window.dispatchEvent(new Event(OPEN_SETTINGS));
