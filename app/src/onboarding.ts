// 첫 사용자 온보딩 ① 체크리스트 (WORDS.md §4.25). 단계는 할 수 있으면 노트·모델 상태에서 읽고, 그렇지 않은 것만 이 Mac에 기억한다.
import { useEffect, useState } from "react";
import type { MeetingInfo } from "./api";
import { ONBOARD_MODELS } from "./caps";
import { t } from "./i18n";

export const ONBOARD_TITLE = t("Tractus 시작하기");
export const ONBOARD_CLOSE = t("닫기");
export const SAMPLE_BADGE = t("예시");
export const HELP_SECTION = t("도움말");
export const HELP_REPLAY = t("처음 사용 안내");
export const HELP_REPLAY_HINT = t("시작하기 목록과 기능 안내를 처음부터 다시 보여 줍니다.");
export const HELP_REPLAY_BUTTON = t("다시 보기");
export const HELP_TIPS = t("기능 안내");
export const HELP_TIPS_HINT = t("기능을 처음 쓸 때 옆에 짧은 안내를 띄웁니다.");

export type StepId = "models" | "sample" | "record" | "enhance";
export interface Step {
  id: StepId;
  label: string;
  hint: string;
  action: string;
  done: boolean;
}

const KEY = "tractus.onboarding";
export interface OnboardState {
  dismissed: boolean;
  sampleOpened: boolean;
  enhancedSeen: boolean;
}
const EMPTY: OnboardState = { dismissed: false, sampleOpened: false, enhancedSeen: false };
const EVENT = "tractus-onboarding";

export function readOnboard(): OnboardState {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<OnboardState> | null;
    return { dismissed: v?.dismissed === true, sampleOpened: v?.sampleOpened === true, enhancedSeen: v?.enhancedSeen === true };
  } catch {
    return EMPTY;
  }
}

/** 한 칸만 바꿔 기억한다 (이미 그 값이면 아무것도 하지 않는다) */
export function markOnboard(key: keyof OnboardState, value = true) {
  const cur = readOnboard();
  if (cur[key] === value) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...cur, [key]: value }));
  } catch {
    /* 막혀 있으면 기억하지 못한다: 목록이 다시 보일 뿐이다 */
  }
  window.dispatchEvent(new Event(EVENT));
}

export function resetOnboard() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 위와 같다 */
  }
  window.dispatchEvent(new Event(EVENT));
}

export function useOnboard(): OnboardState {
  const [s, set] = useState(readOnboard);
  useEffect(() => {
    const f = () => set(readOnboard());
    window.addEventListener(EVENT, f);
    return () => window.removeEventListener(EVENT, f);
  }, []);
  return s;
}

/** 단계와 끝났는지. convertOk: 녹음을 텍스트로 바꿀 모델이 있다 (caps `convert`) */
export function onboardSteps(s: OnboardState, notes: MeetingInfo[], convertOk: boolean): Step[] {
  const recorded = notes.some((n) => n.kind !== "memo" && !n.sample);
  return [
    { id: "models", ...ONBOARD_MODELS, done: convertOk },
    { id: "sample", label: t("예시 노트 둘러보기"), hint: t("녹음 없이 대화 내용·요약·완성된 노트를 미리 봅니다."), action: t("예시 노트 열기"), done: s.sampleOpened },
    { id: "record", label: t("첫 녹음"), hint: t("녹음하며 짧게 메모해 두세요. 끝나면 이 Mac에서 텍스트로 바꿉니다."), action: t("녹음 시작"), done: recorded },
    { id: "enhance", label: t("완성된 노트 보기"), hint: t("메모 탭에서 내 메모에 대화 내용의 세부가 붙은 노트를 봅니다."), action: t("예시 노트에서 보기"), done: s.enhancedSeen },
  ];
}

export const showOnboard = (s: OnboardState, steps: Step[]) => !s.dismissed && steps.some((x) => !x.done);
