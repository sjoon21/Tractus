// 녹음을 끝낸 뒤의 갈림길 (docs/desktop.md §3.3, WORDS.md §4.18): 바로 변환 | 노트로 저장만 하고 나중에 변환 | 매번 묻기.
// 설정 `after_record`와 기능 잠금으로 무엇을 할지 정하는 순수 로직이다. 화면은 App.tsx·AfterRecordDialog.tsx·SettingsView.tsx. afterRecord.test.ts에서 검사한다.
import type { Decision } from "./caps";
import { t } from "./i18n";
import { fmtTime } from "./lib";

export type AfterRecord = "ask" | "convert" | "later";

/** 설정 파일의 값 → 선택. 없거나 모르는 값(옛 설정 파일)이면 매번 묻는다 */
export const afterRecord = (v: unknown): AfterRecord => (v === "convert" || v === "later" ? v : "ask");

export type StopAction =
  /** 바로 텍스트로 변환한다 (`transcribe --recording`, 옛 흐름 그대로) */
  | { kind: "convert" }
  /** 노트로 저장만 한다 (`recording finish`) */
  | { kind: "later" }
  /** 묻는 창을 띄운다 */
  | { kind: "ask" }
  /** 변환할 수 없어 녹음만 남긴다 (`변환 대기 중인 녹음`, 옛 흐름 그대로) */
  | { kind: "leave" };

/**
 * 녹음 헬퍼가 끝났을 때 할 일.
 * - 글만 있는 노트에 추가하는 녹음(attach)은 노트에 덧붙여야 하므로 언제나 바로 변환이다. 변환할 수 없으면 남긴다.
 * - `바로 변환`인데 변환할 수 없으면 옛 흐름 그대로 남긴다 (녹음은 잃지 않는다).
 * - `나중에 변환`은 변환 엔진 없이도 된다. 묻기는 창이 갈림길을 보인다.
 */
export function stopAction(o: { setting: AfterRecord; convertOk: boolean; attach: boolean }): StopAction {
  if (o.attach || o.setting === "convert") return o.convertOk ? { kind: "convert" } : { kind: "leave" };
  return { kind: o.setting === "later" ? "later" : "ask" };
}

export type AskChoice = "convert" | "later";

export interface AskView {
  /** `바로 변환하기`를 누를 수 있는가 */
  convertEnabled: boolean;
  /** 못 쓰는 이유 (쓸 수 있으면 null) */
  reason: string | null;
  /** 처음 초점: 안전한 `바로 변환하기`, 못 쓰면 `나중에 변환하기` */
  focus: AskChoice;
}

export function askView(convert: Decision): AskView {
  return convert.ok ? { convertEnabled: true, reason: null, focus: "convert" } : { convertEnabled: false, reason: convert.reason, focus: "later" };
}

/** 고른 것이 `다음부터 묻지 않기`로 설정에 남을 값. 체크하지 않았으면 null (설정은 그대로) */
export const rememberedChoice = (choice: AskChoice, remember: boolean): AfterRecord | null => (remember ? choice : null);

/** 묻는 창에서 고른 것을 할 일로: 변환할 수 없는 상태에서 `바로 변환`은 `나중에`로 바꾼다 (녹음은 노트로 남는다) */
export const effectiveChoice = (choice: AskChoice, convertOk: boolean): AskChoice => (choice === "convert" && !convertOk ? "later" : choice);

// ── 문구 (WORDS.md §4.18) ──

/** 묻는 창이 떠 있는 동안 새 녹음 메뉴 항목이 눌리지 않는 이유 */
export const ASK_BLOCKS_RECORD = t("방금 한 녹음을 어떻게 할지 먼저 정해 주세요");

export const AFTER_ASK = {
  title: t("녹음을 끝냈습니다"),
  body: (seconds: number) => t("녹음 길이 {time}. 지금 텍스트로 변환할까요? 나중에 변환하려면 노트로 저장해 두세요. 저장한 노트는 바로 들어 볼 수 있고, 노트에서 ‘텍스트로 변환’을 눌러 언제든 변환할 수 있습니다.", { time: fmtTime(seconds) }),
  convert: t("바로 변환하기"),
  later: t("나중에 변환하기"),
  /** 묻는 창 뒤의 녹음 화면에 보이는 한 줄 (아직 변환도 저장도 시작하지 않았다) */
  pending: t("녹음을 끝냈습니다. 지금 변환할지 정해 주세요."),
  remember: t("다음부터 묻지 않기"),
  rememberHint: t("고른 방법이 설정의 ‘녹음을 끝내면’에 저장됩니다."),
} as const;

export const AFTER_SETTING = {
  label: t("녹음을 끝내면"),
  hint: t("나중에 변환하면 ‘변환 전’ 노트로 저장됩니다."),
  options: [
    { value: "ask", label: t("매번 묻기") },
    { value: "convert", label: t("바로 변환하기") },
    { value: "later", label: t("저장만 하고 나중에 변환하기") },
  ] as { value: AfterRecord; label: string }[],
} as const;
