// 녹음 중 남긴 메모·북마크 고치기·지우기 (marks.ts, `tractus marks save`): 낙관적으로 바꾸고 줄에 세워 저장한다. 실패하면 코어가 확인한 목록으로 되돌린다.
import { useCallback } from "react";
import { api, errDetail, errText } from "../api";
import type { Notify } from "../App";
import type { Memo } from "../lib";
import type { EditQueue } from "./useEditQueue";
import type { NoteData } from "./useNoteData";

export function useMarksEditing({ id, data, queue, notify }: { id: string; data: NoteData; queue: EditQueue; notify: Notify }) {
  const { confirmed, patchView, patchConfirmed } = data;
  const { guard, serial } = queue;
  return useCallback(
    (next: Memo[]) => {
      if (guard()) return;
      patchView((d) => ({ ...d, memos: next }));
      void serial(async () => {
        try {
          const { marks } = await api.marksSave(id, next);
          patchConfirmed((d) => ({ ...d, memos: marks }));
          patchView((d) => ({ ...d, memos: marks }));
        } catch (e) {
          const back = confirmed.current?.memos ?? [];
          patchView((d) => ({ ...d, memos: back }));
          notify({ text: errText(e), detail: errDetail(e), error: true });
        }
      });
    },
    [id, guard, serial, patchView, patchConfirmed, confirmed, notify],
  );
}
