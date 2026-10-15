// AI 서비스 설정: 서비스·주소·AI 모델·API 키 (docs/desktop.md §2.14). 키는 Rust(llm_key.rs)만 읽고, 화면은 등록 여부만 안다.
import { isLoopbackHost, PROVIDERS } from "./ask";
import { errorView, JOB_ERROR } from "./lib";

/** 설정 화면에서 고를 수 있는 서비스 (Rust llm_key::PROVIDERS와 같은 순서·이름) */
export const LLM_CHOICES = ["upstage", "openai", "claude", "gemini", "custom"] as const;
export type LlmChoice = (typeof LLM_CHOICES)[number];
export const isLlmChoice = (id: string): id is LlmChoice => (LLM_CHOICES as readonly string[]).includes(id);

export const KEY_MIN = 5;
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

/** 설정 화면에서 고치는 오류 코드: 옆에 `설정 열기`가 붙는다 (키가 없다 / 키가 맞지 않다 / AI 모델이 없다) */
export const SETTINGS_FIX_CODES: readonly string[] = [KEY_ERROR_CODE, "llm_auth", "llm_model"];

const KEY_MISSING = {
  summarize: "AI 키가 없어 요약할 수 없습니다. 설정에서 API 키를 등록하세요.",
  ask: "AI 키가 없어 답변할 수 없습니다. 설정에서 API 키를 등록하세요.",
} as const;

/** 요약·질문 실패 문장. `settings`가 true면 화면이 `설정 열기`를 함께 보인다 */
export function llmErrorView(kind: keyof typeof KEY_MISSING, message: string | null, code: string | null | undefined): { text: string; detail: string | null; settings: boolean } {
  const v = errorView(message, code, JOB_ERROR[kind]);
  const settings = !!code && SETTINGS_FIX_CODES.includes(code);
  return code === KEY_ERROR_CODE ? { ...v, text: KEY_MISSING[kind], settings } : { ...v, settings };
}

/** 키·서비스 설정을 저장·삭제했다 (등록된 서비스·기본 서비스가 바뀌었을 수 있다): 보내기 전 안내와 AI 서비스 고르는 칸을 새로 읽어야 하는 화면에 알린다 */
export const KEY_CHANGED = "tractus:llm-key-changed";

/** 설정 화면 열기 요청 (깊은 화면에서 App으로) */
export const OPEN_SETTINGS = "tractus:open-settings";
export const requestSettings = () => window.dispatchEvent(new Event(OPEN_SETTINGS));


// ── 서비스·주소·AI 모델 ──

/** 서비스 기본 주소 (직접 입력은 없다). 끝의 `/`는 뗀다 */
export const defaultBaseUrl = (provider: string): string => PROVIDERS[provider]?.url ?? "";

/** 서비스 기본 AI 모델 (없으면 직접 입력해야 한다) */
export const defaultModel = (provider: string): string => PROVIDERS[provider]?.model ?? "";

export const URL_BAD = "서비스 주소는 http:// 또는 https://로 시작하는 올바른 주소여야 합니다.";
export const URL_CREDENTIALS = "서비스 주소에 사용자 이름이나 비밀번호를 넣을 수 없습니다. API 키는 따로 입력하세요.";

/** 입력한 주소 → 정리한 주소(끝의 `/` 없음, 빈 값은 빈 값). 올바르지 않으면 문장. Rust llm_key::normalize_base_url과 같은 규칙 */
export function normalizeBaseUrl(raw: string): { url: string } | { problem: string } {
  const text = raw.trim();
  if (!text) return { url: "" };
  if (/[\s\\\p{Cc}]/u.test(text) || !/^https?:\/\//i.test(text)) return { problem: URL_BAD };
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { problem: URL_BAD };
  }
  if (u.username || u.password || /^https?:\/\/[^/?#]*@/i.test(text)) return { problem: URL_CREDENTIALS };
  if (!u.hostname) return { problem: URL_BAD };
  return { url: text.replace(/\/+$/, "") };
}

/** 이 주소가 이 Mac인가 (정리한 주소 기준) */
export function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).host);
  } catch {
    return false;
  }
}

export const HTTP_WARNING = "https가 아닌 주소입니다. 키와 대화 내용이 암호화되지 않은 채 전송됩니다.";

/** 막지는 않지만 알릴 것: 이 Mac이 아닌데 https가 아니다 (이 Mac 주소의 http는 경고하지 않는다) */
export function baseUrlWarning(url: string): string | null {
  return /^http:\/\//i.test(url) && !isLoopbackUrl(url) ? HTTP_WARNING : null;
}

export const URL_REQUIRED = "서비스 주소를 입력하세요.";
export const MODEL_REQUIRED = "AI 모델 이름을 입력하세요.";
export const MODEL_BAD = "AI 모델 이름에는 공백이나 줄바꿈을 넣을 수 없고 200자까지 쓸 수 있습니다.";

export interface LlmForm {
  provider: string;
  baseUrl: string;
  model: string;
}

/** 저장·테스트 전 검사. 문제가 없으면 null. 기본 AI 모델이 없는 서비스(OpenAI·직접 입력)는 모델 이름이 필요하고 (`needModel`이 false면 묻지 않는다: AI 모델 목록은 이름 없이 불러온다), 직접 입력은 주소도 필요하다 */
export function formProblem(f: LlmForm, needModel = true): string | null {
  if (!isLlmChoice(f.provider)) return `알 수 없는 AI 서비스입니다: ${f.provider}`;
  const url = normalizeBaseUrl(f.baseUrl);
  if ("problem" in url) return url.problem;
  if (f.provider === "custom" && !url.url) return URL_REQUIRED;
  const model = f.model.trim();
  if (needModel && !model && !defaultModel(f.provider)) return MODEL_REQUIRED;
  if ([...model].length > 200 || /[\s\p{Cc}]/u.test(model)) return MODEL_BAD;
  return null;
}

/** 저장할 값: 서비스 기본 주소·기본 AI 모델과 같으면 빈 값으로 저장한다 (기본값이 바뀌어도 따라가게). 검사를 통과한 입력만 넣는다 */
export function toStored(f: LlmForm): { baseUrl: string; model: string } {
  const url = normalizeBaseUrl(f.baseUrl);
  const base = "url" in url ? url.url : "";
  const model = f.model.trim();
  return { baseUrl: base === defaultBaseUrl(f.provider) ? "" : base, model: model === defaultModel(f.provider) ? "" : model };
}

/** 저장된 값 → 입력칸. 주소 칸은 기본 주소를 미리 채운다 (모델 칸은 비워 두고 placeholder가 기본값을 보인다) */
export const toForm = (provider: string, storedBase: string, storedModel: string): LlmForm => ({ provider, baseUrl: storedBase || defaultBaseUrl(provider), model: storedModel });

/** 이 서비스를 지금 쓸 수 있는 키 상태인가: 키가 등록돼 있거나, 이 Mac 주소의 직접 입력 (키 없이 쓴다) */
export const keyReady = (provider: string, baseUrl: string, saved: boolean): boolean => saved || (provider === "custom" && isLoopbackUrl(baseUrl));

export const PROVIDER_NOTE: Record<LlmChoice, string> = {
  upstage: "키는 console.upstage.ai에서 받을 수 있습니다.",
  openai: "키는 platform.openai.com에서 받을 수 있습니다.",
  claude: "키는 console.anthropic.com에서 받을 수 있습니다.",
  gemini: "키는 aistudio.google.com에서 받을 수 있습니다.",
  custom: "OpenAI 호환 서비스(OpenRouter, Ollama 등)의 주소와 키를 입력합니다.",
};

/** 서비스가 돌려준 AI 모델 이름에서 대화용이 아닌 것(검색용·음성·이미지·영상)을 뺀다. 다 빠지면 그대로 둔다. 제안 목록일 뿐이라 이름으로 어림한다 */
const NOT_CHAT = /embed|tts|image|imagen|veo|aqa|whisper|moderation|transcribe|dall-e|realtime|rerank|audio|speech/i;
export const chatModels = (ids: readonly string[]): string[] => {
  const chat = ids.filter((id) => !NOT_CHAT.test(id));
  return chat.length > 0 ? chat : [...ids];
};

export const PRIVACY_NOTE = "요약·질문할 때 노트 내용이 선택한 AI 서비스로 전송됩니다. 키는 이 Mac에만 저장됩니다.";
export const ENV_OVERRIDE_NOTE = "셸이나 .env의 설정이 이 화면보다 먼저 적용되고 있습니다.";
export const TEST_HINT = "연결 테스트는 입력한 내용을 먼저 저장합니다.";

/** 연결 테스트 결과 한 줄. 응답이 비어 와도 연결은 된 것이다 */
export const testOkText = (r: { host: string | null; latency_ms: number | null; empty?: boolean }): string => `${r.empty ? "응답을 받았습니다" : "연결되었습니다"}${r.host ? ` (${r.host}${r.latency_ms !== null ? `, ${r.latency_ms}ms` : ""})` : ""}`;

// ── 요약·질문마다 AI 서비스 고르기 ──

/** 고른 서비스를 기능마다 따로 기억한다 (이 화면에서만의 편의: 저장하지 못해도 기본 서비스로 쓴다) */
export type LlmFeature = "summary" | "ask";
const choiceKey = (f: LlmFeature) => `tractus:llm-choice:${f}`;

export function readChoice(f: LlmFeature): string | null {
  try {
    return localStorage.getItem(choiceKey(f));
  } catch {
    return null;
  }
}

export function writeChoice(f: LlmFeature, provider: string): void {
  try {
    localStorage.setItem(choiceKey(f), provider);
  } catch {
    // 기억하지 못해도 된다
  }
}

/** 이번에 쓸 서비스: 기억한 서비스가 지금도 등록돼 있으면 그것, 아니면 기본 서비스 */
export const pickService = (registered: readonly string[], def: string, remembered: string | null): string => (remembered && registered.includes(remembered) ? remembered : def);

/** 등록된 서비스가 둘 이상일 때만 고르는 칸을 보인다 (하나뿐이면 고를 것이 없다). 환경이 서비스를 정했으면 고를 수 없다 */
export const showServicePicker = (registered: readonly string[], fixed: boolean): boolean => !fixed && registered.length > 1;

// ── 스마트 검색 방식 (Upstage 선택) ──

export type EmbeddingChoice = "local" | "upstage";
export const EMBED_LABEL = "스마트 검색 방식";
export const EMBED_OPTIONS: Record<EmbeddingChoice, string> = { local: "이 Mac(기본)", upstage: "Upstage solar-embedding-2" };
export const EMBED_LOCAL_ONLY = "로컬 전용 모드라 Upstage로 보내지 않고 단어 일치로만 찾습니다.";
export const EMBED_NO_KEY = "Upstage API 키를 등록하면 고를 수 있습니다.";
export const EMBED_NOTE = "기본은 이 Mac에서 처리합니다. Upstage를 고르면 노트 내용과 검색어가 전송됩니다.";
export const EMBED_CONFIRM = {
  title: "스마트 검색을 Upstage로 바꿀까요?",
  body: "노트 내용과 검색어가 Upstage로 전송됩니다. Upstage의 데이터 보관 정책은 확인하지 못했습니다. 검색 정보를 새로 만드는 동안에는 단어 일치로만 찾습니다.",
  cancel: "취소",
  confirm: "Upstage로 바꾸기",
} as const;
export const EMBED_SAVED: Record<EmbeddingChoice, string> = { local: "스마트 검색을 이 Mac에서 처리합니다.", upstage: "스마트 검색을 Upstage로 처리합니다." };
