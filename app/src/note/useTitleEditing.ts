// 제목 바꾸기: 낙관적으로 바꾸고 줄에 세워 저장한다. 실패하면 원래 제목으로 되돌리고 알린다. 폴더 이름은 그대로다 (코어).
import { useCallback } from "react";
import { api, errDetail, errText } from "../api";
import type { Notify } from "../App";
import { EDIT_BLOCKED } from "../remove";
import type { EditQueue } from "./useEditQueue";
import type { NoteData } from "./useNoteData";

export function useTitleEditing({ id, data, queue, notify, onChanged }: { id: string; data: NoteData; queue: EditQueue; notify: Notify; onChanged: () => void }) {
  const { confirmed, patchView, patchConfirmed } = data;
  const { isBlocked, run } = queue;
  return useCallback(
    (title: string) => {
      if (isBlocked()) return notify({ text: EDIT_BLOCKED, error: true });
      const before = confirmed.current?.info.title ?? "";
      const setTitle = (x: string) => patchView((d) => ({ ...d, info: { ...d.info, title: x } }));
      setTitle(title);
      void run(() => api.noteTitle(id, title))
        .then((saved) => {
          if (saved === undefined) throw new Error(EDIT_BLOCKED);
          patchConfirmed((d) => ({ ...d, info: { ...d.info, title: saved } }));
          setTitle(saved);
          onChanged(); // 사이드바 제목
        })
        .catch((e) => {
          setTitle(before);
          notify({ text: errText(e), detail: errDetail(e), error: true });
        });
    },
    [id, isBlocked, run, confirmed, patchView, patchConfirmed, notify, onChanged],
  );
}
