// 노트 화면의 노트 데이터와 편집 (한 노트): 작은 훅들을 조립한다. 각 훅은 책임 하나만 갖고 필요한 것만 받는다.
//   data     코어가 확인한 노트와 화면에 그리는 노트 (noteState: 순수 상태 전이)
//   queue    저장 줄 (editQueue): 도는 동안 editing, 막힘·오류 줄
//   seq      요약이 낡았는지 가리는 편집 횟수
//   noteSaved 코어가 고친 노트를 돌려줬을 때 공통으로 하는 일
//   text·speakers·marks·rename·memo  각 편집 동작
import type { Notify } from "../App";
import { useEditQueue } from "./useEditQueue";
import { useEditSeq } from "./useEditSeq";
import { useGlossarySuggest } from "./useGlossarySuggest";
import { useMarksEditing } from "./useMarksEditing";
import { useMemoSync } from "./useMemoSync";
import { useNoteData } from "./useNoteData";
import { useNoteSaved } from "./useNoteSaved";
import { useSpeakerEditing } from "./useSpeakerEditing";
import { useTextEditing } from "./useTextEditing";
import { useTitleEditing } from "./useTitleEditing";

export function useNote({ id, summaryStale, notify, onEdited, onChanged }: { id: string; summaryStale: boolean; notify: Notify; onEdited?: (id: string, updatedAt: string) => void; onChanged: () => void }) {
  const data = useNoteData();
  const queue = useEditQueue(id);
  const seq = useEditSeq(summaryStale);
  const noteSaved = useNoteSaved({ id, data, seq, onEdited });
  const suggestTerms = useGlossarySuggest(notify);
  const text = useTextEditing({ id, data, queue, noteSaved, suggestTerms });
  const speakers = useSpeakerEditing({ id, data, queue, notify });
  const saveMarks = useMarksEditing({ id, data, queue, notify });
  const renameNote = useTitleEditing({ id, data, queue, notify, onChanged });
  const memo = useMemoSync({ id, data, noteSaved, notify });
  return { data, queue, seq, noteSaved, suggestTerms, text, speakers, saveMarks, renameNote, memo };
}
export type Note = ReturnType<typeof useNote>;
