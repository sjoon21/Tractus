// 변환 중 녹음 (docs/desktop.md §3.3, v3.71): 녹음 프로그램은 가벼워 기본은 녹음과 변환이 함께 돈다(연달아 하는 회의를 녹음할 수 있게). words-ok
// 실시간 텍스트 변환을 켜 두면 자막(0.6B)이 변환(1.7B)과 GPU를 나눠 써 밀리므로, 그때만 예전처럼 변환이 끝난 뒤에 녹음하고
// 녹음하는 동안에는 변환 전 노트의 변환을 멈춘다. 화면과 무관한 순수 함수: recordBusy.test.ts
import { t } from "./i18n";

export const LIVE_BLOCKS_RECORD = t("실시간 텍스트 변환을 켜 두면 변환이 끝난 뒤에 녹음할 수 있습니다. 설정에서 끄면 변환 중에도 녹음할 수 있습니다");

export interface RecordBusy {
  /** 녹음을 변환하는 중이거나 변환을 기다리는 녹음이 있다 */
  converting: boolean;
  /** 방금 끝낸 녹음을 노트로 저장하는 중 (몇 초) */
  saving: boolean;
  /** 방금 끝낸 녹음을 어떻게 할지 묻는 창이 떠 있다 */
  asking: boolean;
  /** 설정의 실시간 텍스트 변환 */
  liveOn: boolean;
}

/** 새 녹음을 막는 까닭. null이면 시작할 수 있다. 묻는 창·저장 중은 실시간 텍스트 변환과 상관없이 막는다 */
export function recordBlock(b: RecordBusy): "asking" | "saving" | "live" | null {
  if (b.asking) return "asking";
  if (b.saving) return "saving";
  if (b.converting && b.liveOn) return "live";
  return null;
}

/** 녹음하는 동안 변환을 시작하거나 계속해도 되는가: 이번 녹음에 실시간 텍스트 변환이 없을 때 */
export const convertsWhileRecording = (recording: boolean, liveRec: boolean): boolean => !recording || !liveRec;
