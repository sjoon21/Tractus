// 변환 엔진이 한 번에 하나만 올라가므로, 무거운 작업은 한 번에 하나씩 순서대로 시작한다 (docs/desktop.md §3.3). 화면과 무관한 순수 함수: jobSchedule.test.ts
//   우선순위  녹음 변환 → 변환 전 노트의 변환 줄 → 파일 가져오기
//   녹음 중   녹음 프로그램은 가벼워 기본은 녹음과 변환이 함께 돈다. 이번 녹음에 실시간 자막(0.6B)이 있으면 변환(1.7B)과 GPU를 나눠 써 밀리므로
//            자막이 있는 녹음이 끝날 때까지 변환을 시작하지 않는다 (recordBusy.convertsWhileRecording)
// App의 useEffect들이 "다음 것을 시작해도 되는가"를 여기에 묻는다.
import { convertsWhileRecording } from "./recordBusy";

export interface Activity {
  /** 녹음 중 (시작·일시정지·마무리 포함) */
  recording: boolean;
  /** 이번 녹음에 실시간 텍스트 변환(자막)이 켜져 있다 */
  liveRec: boolean;
  /** 방금 끝낸 녹음을 어떻게 할지 묻는 창이 떠 있다 */
  asking: boolean;
  /** 녹음 변환이 도는 중 / 대기 줄에 선 녹음이 있다 */
  transcribeRunning: boolean;
  transcribeWaiting: boolean;
  /** 방금 끝낸 녹음을 노트로 저장하는 중 */
  finishRunning: boolean;
  /** 변환 전 노트의 변환 줄에 노트가 있다 / 그 변환이 실제로 도는 중 */
  converting: boolean;
  convertRunning: boolean;
  /** 파일 가져오기가 도는 중 / 대기 줄에 파일이 있다 */
  importRunning: boolean;
  importWaiting: boolean;
}

/** 새 녹음·가져오기·창 닫기 확인이 "변환 중"으로 보는 일: 녹음 변환(대기 포함), 노트로 저장, 변환 전 노트의 변환 줄 */
export const isTranscribing = (a: Activity): boolean => a.transcribeRunning || a.transcribeWaiting || a.finishRunning || a.converting;

/** 대기 줄의 첫 녹음을 변환하기 시작해도 되는가: 다른 변환·가져오기가 돌지 않고, 자막이 도는 녹음 중이 아닐 때 */
export const canStartTranscribe = (a: Activity): boolean =>
  a.transcribeWaiting && !a.transcribeRunning && !a.importRunning && !a.convertRunning && convertsWhileRecording(a.recording, a.liveRec);

/** 변환 줄의 첫 노트를 변환하기 시작해도 되는가: 녹음 변환(대기 포함)·저장·가져오기가 모두 끝났고, 묻는 창이 없을 때 */
export const canStartConvert = (a: Activity): boolean =>
  a.converting && convertsWhileRecording(a.recording, a.liveRec) && !a.asking && !a.transcribeRunning && !a.transcribeWaiting && !a.finishRunning && !a.importRunning;

/** 가져오기 줄의 첫 파일을 시작해도 되는가: 가져오기가 돌지 않고 어떤 변환도 없을 때 (녹음 변환이 먼저다) */
export const canStartImport = (a: Activity): boolean => a.importWaiting && !a.importRunning && !isTranscribing(a);
