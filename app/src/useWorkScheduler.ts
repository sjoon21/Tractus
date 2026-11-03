// 무거운 작업을 한 번에 하나씩 순서대로 시작하는 곳 (규칙은 jobSchedule.ts): 녹음 변환 → 변환 전 노트의 변환 줄 → 파일 가져오기.
// 줄들(useConvertQueue·useImportQueue·녹음 변환 대기 줄)은 상태와 동작만 갖고, "누가 다음에 시작하는가"는 여기서만 정한다.
import { useEffect } from "react";
import { canStartConvert, canStartImport, canStartTranscribe, type Activity } from "./jobSchedule";

export function useWorkScheduler({
  activity,
  listLoaded,
  startNextTranscribe,
  tryStartConvert,
  convertWatch,
  startNextImport,
  waitKey,
  importKey,
}: {
  activity: Activity;
  /** 노트 목록을 한 번이라도 읽었는지 (읽기 전에는 변환 줄의 노트가 지워졌는지 알 수 없다) */
  listLoaded: boolean;
  /** 대기 줄의 첫 녹음을 변환하기 시작한다 */
  startNextTranscribe: () => void;
  /** 변환 줄의 첫 노트를 시작한다 (canStart: 지금 시작해도 되는가) */
  tryStartConvert: (listLoaded: boolean, canStart: boolean) => void;
  /** 이 값(노트 목록)이 바뀌면 변환 줄을 다시 살핀다. 줄이 바뀌면 tryStartConvert의 정체가 바뀐다 */
  convertWatch: unknown;
  startNextImport: () => void;
  /** 줄의 내용이 바뀌면 다시 살핀다 */
  waitKey: unknown;
  importKey: unknown;
}) {
  const a = activity;
  // 녹음 변환: 자막이 도는 녹음 중에는 변환 엔진을 올리지 않는다 (자막이 밀린다). 자막이 없으면 녹음과 함께 돈다
  useEffect(() => {
    if (canStartTranscribe(a)) startNextTranscribe();
  }, [waitKey, a.transcribeRunning, a.importRunning, a.convertRunning, a.recording, a.liveRec, startNextTranscribe]);

  // 변환 전 노트의 변환 줄: 녹음 변환·저장·가져오기가 끝난 뒤에. 지워졌거나 다른 곳에서 이미 변환한 노트는 건너뛴다
  const canConvert = canStartConvert(a);
  useEffect(() => {
    tryStartConvert(listLoaded, canConvert);
  }, [tryStartConvert, convertWatch, listLoaded, canConvert, a.convertRunning]);

  // 파일 가져오기: 어떤 변환도 없을 때 (녹음 변환이 먼저다)
  useEffect(() => {
    if (canStartImport(a)) startNextImport();
  }, [importKey, a.importRunning, a.transcribeRunning, a.transcribeWaiting, a.finishRunning, a.converting, startNextImport]);
}
