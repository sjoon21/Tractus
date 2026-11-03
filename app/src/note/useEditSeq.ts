// 요약이 낡았는지 가리는 편집 횟수: 코어가 실제로 바꾼 편집마다 하나 올라가고, 요약마다 시작할 때의 값과 견준다 (SummariesPanel).
// 요약하는 동안 고친 문장은 요약이 끝나도 '낡음'으로 남는다.
import { useCallback, useRef, useState } from "react";
import type { EditKind } from "../memo";

export function useEditSeq(summaryStale: boolean) {
  const [editSeq, setEditSeq] = useState(summaryStale ? 1 : 0);
  const editSeqRef = useRef(summaryStale ? 1 : 0); // 저장이 끝나 값이 바뀌어도 await 뒤에 최신 값을 읽는다 (요약 직전 저장이 '낡음'으로 남지 않게)
  const editKinds = useRef<EditKind[]>(summaryStale ? ["text"] : []); // 고친 것의 종류 (안내 문장: 대화 내용 / 메모 / 둘 다). 개수가 editSeq다
  const bumpEdit = useCallback((kind: EditKind) => {
    editKinds.current = [...editKinds.current, kind];
    setEditSeq(++editSeqRef.current);
  }, []);
  return { editSeq, editSeqRef, editKinds, bumpEdit };
}
export type EditSeq = ReturnType<typeof useEditSeq>;
