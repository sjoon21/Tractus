// 녹음 노트의 메모 탭과 요약의 연결: 메모 저장이 끝났을 때 노트를 받고, 요약을 메모 끝에 붙인다.
// 요약을 붙이면 쓰던 메모를 먼저 저장하고 최신 본문에 붙인 뒤 편집기를 새 본문으로 다시 연다(memoRev가 편집기의 key).
import { useCallback, useState } from "react";
import { api, errDetail, errText, type MeetingDetail } from "../api";
import type { Notify } from "../App";
import { editQueue } from "../editQueue";
import { t } from "../i18n";
import { flushMemos } from "../memo";
import { appendBlock } from "../memoEdit";
import { EDIT_BLOCKED } from "../remove";
import type { NoteData } from "./useNoteData";
import type { NoteSaved } from "./useNoteSaved";

export function useMemoSync({ id, data, noteSaved, notify }: { id: string; data: NoteData; noteSaved: NoteSaved; notify: Notify }) {
  const { confirmed } = data;
  const [memoRev, setMemoRev] = useState(0);
  const onMemoSaved = useCallback((m: MeetingDetail) => noteSaved(m, "memo"), [noteSaved]);
  const sendToMemo = useCallback(
    async (markdown: string) => {
      if (!(await flushMemos())) return;
      if (editQueue.isBlocked(id)) return notify({ text: EDIT_BLOCKED, error: true });
      const body = appendBlock(confirmed.current?.note_memo?.body ?? "", markdown);
      try {
        const r = await editQueue.run(id, () => api.noteSave(id, body));
        if (!r) return notify({ text: EDIT_BLOCKED, error: true });
        onMemoSaved(r.meeting);
        setMemoRev((n) => n + 1);
        notify({ text: t("요약을 메모에 붙였습니다") });
      } catch (e) {
        notify({ text: t("메모에 붙이지 못했습니다: {error}", { error: errText(e) }), detail: errDetail(e), error: true });
      }
    },
    [id, confirmed, notify, onMemoSaved],
  );
  return { memoRev, onMemoSaved, sendToMemo };
}
