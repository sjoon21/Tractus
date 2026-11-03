// 노트마다 한 줄로 세우는 저장 줄(editQueue.ts)의 화면 쪽 얼굴: 도는 동안 `editing`을 켜고, 막혔을 때(삭제를 기다리는 중) 오류 줄에 알린다.
// 화자·문장 편집·목소리 등록·내보내기·스마트 교정 받기가 같은 줄에 선다 (코어가 transcript.json을 읽고-고쳐-쓰므로).
import { useCallback, useState } from "react";
import { editQueue } from "../editQueue";
import { EDIT_BLOCKED } from "../remove";

export function useEditQueue(id: string) {
  // 오류 표시는 사용자가 새로 고칠 때만 지운다: 줄에 선 다음 작업이 시작하며 지우면 실패를 못 보고 지나간다
  const [editError, setEditError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(0);
  /** 줄에 세워 돌린다. 막혀 있으면 undefined (아무것도 하지 않는다). 도는 동안 editing이 켜진다 */
  const run = useCallback(
    <T,>(task: () => Promise<T>): Promise<T | undefined> => {
      setInFlight((n) => n + 1);
      return Promise.resolve(editQueue.run(id, task)).finally(() => setInFlight((n) => n - 1));
    },
    [id],
  );
  const isBlocked = useCallback(() => editQueue.isBlocked(id), [id]);
  /** 막혀 있으면 오류 줄에 알리고 true. 낙관적 반영 전에 부른다 */
  const guard = useCallback(() => {
    if (!editQueue.isBlocked(id)) return false;
    setEditError(EDIT_BLOCKED);
    return true;
  }, [id]);
  /** 줄에 세운다. 막혀 있으면 오류 줄에 알리고 끝낸다 */
  const serial = useCallback((task: () => Promise<void>) => (guard() ? Promise.resolve() : run(task).then(() => {})), [guard, run]);
  return { editing: inFlight > 0, editError, setEditError, isBlocked, guard, run, serial };
}
export type EditQueue = ReturnType<typeof useEditQueue>;
