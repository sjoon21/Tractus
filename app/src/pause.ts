// 녹음 일시정지·계속의 문구와 사이드바 녹음 단추 글자 (WORDS.md §4.18). 순수 로직은 pause.test.ts에서 검사한다.
// 일시정지는 소리 받기만 멈춘다: 녹음 프로그램은 계속 떠 있고(macOS 마이크 사용 표시는 켜진 채), 일시정지한 시간은 녹음에 들어가지 않는다.
import { t } from "./i18n";
import { fmtTime, type RecPhase } from "./lib";

export const PAUSE_LABEL = t("일시정지");
export const RESUME_LABEL = t("계속");
export const PAUSE_TITLE = t("소리 받기를 잠시 멈춥니다. 멈춘 시간은 녹음에 들어가지 않습니다");
export const RESUME_TITLE = t("녹음을 이어서 합니다");
export const PAUSED_NOTE = t("일시정지 중입니다. 멈춘 시간은 녹음에 들어가지 않습니다. 마이크 사용 표시는 녹음을 끝낼 때까지 켜져 있습니다.");
export const PAUSED_STATUS = (seconds: number) => t("일시정지됨 {time}", { time: fmtTime(seconds) });

export interface RecButton {
  /** 단추의 큰 글자 */
  text: string;
  /** 오른쪽 시계 (녹음 중·일시정지) */
  time: string | null;
  /** 붉은 점이 깜빡이는 `녹음 중` 모양 (일시정지는 아니다) */
  live: boolean;
}

/**
 * 사이드바 녹음 단추의 글자. 녹음 중 `녹음 중 12:34`, 일시정지 `일시정지됨 12:34`, 끝낸 녹음을 어떻게 할지 묻는 중 `녹음 끝남`, 노트로 저장하는 중 `저장 중…`, 변환 중 `변환 중…`, 변환을 기다리는 중 `변환 대기 중…`.
 */
export function recButton(o: { phase: RecPhase; t: number; saving: boolean; converting: boolean; waiting: boolean; asking?: boolean }): RecButton {
  if (o.phase === "paused") return { text: t("일시정지됨"), time: fmtTime(o.t), live: false };
  if (o.phase === "recording" || o.phase === "starting" || o.phase === "stopping") return { text: t("녹음 중"), time: fmtTime(o.t), live: true };
  if (o.asking) return { text: t("녹음 끝남"), time: null, live: false };
  if (o.saving) return { text: t("저장 중…"), time: null, live: false };
  if (o.converting) return { text: t("변환 중…"), time: null, live: false };
  if (o.waiting) return { text: t("변환 대기 중…"), time: null, live: false };
  return { text: t("녹음 시작"), time: null, live: false };
}

/** 화면 시계의 기준: 마지막으로 헬퍼가 알린 녹음 시각(초, 일시정지한 시간을 뺀다)과 그 순간의 화면 시계(ms) */
export interface ClockAnchor {
  t: number;
  at: number;
}

/** 기준 뒤로 흐른 만큼 더한 녹음 시각(초). 화면 시계가 거꾸로 가도 기준보다 줄지 않는다 */
export const clockAt = (a: ClockAnchor, nowMs: number): number => a.t + Math.max(0, nowMs - a.at) / 1000;

/** 메뉴 막대가 `지금 - 시작`으로 경과를 세게 하는 시작 시각(epoch ms): 계속한 순간 경과가 녹음 시각과 같아진다. 일시정지한 시간은 센 적이 없는 것이 된다 */
export const resumedStartMs = (nowMs: number, elapsedSec: number): number => nowMs - Math.round(elapsedSec * 1000);
