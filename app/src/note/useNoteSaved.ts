// 코어가 노트를 저장해 고친 노트를 돌려줬을 때 하는 일: 확인한 노트로 받고, 사이드바의 수정 시각을 올리고, 요약을 낡음으로 표시하고, 검색 색인을 예약한다.
// 문장 저장·메모 저장·스마트 교정 받기가 모두 같은 일을 하므로 한곳에 둔다.
import { useCallback } from "react";
import type { MeetingDetail } from "../api";
import { indexer } from "../indexer";
import type { EditKind } from "../memo";
import type { EditSeq } from "./useEditSeq";
import type { NoteData } from "./useNoteData";

export function useNoteSaved({ id, data, seq, onEdited }: { id: string; data: NoteData; seq: EditSeq; onEdited?: (id: string, updatedAt: string) => void }) {
  const { commit } = data;
  const { bumpEdit } = seq;
  /** changed가 false면 노트만 받는다 (코어가 아무것도 바꾸지 않았다) */
  return useCallback(
    (meeting: MeetingDetail, kind: EditKind, changed = true) => {
      commit(meeting);
      if (!changed) return;
      onEdited?.(id, meeting.info.updated_at ?? "");
      bumpEdit(kind);
      indexer.touch(); // 한가할 때 조용히 검색에 반영한다 (마지막 수정 뒤 60초, 갱신 사이 5분)
    },
    [id, commit, bumpEdit, onEdited],
  );
}
export type NoteSaved = ReturnType<typeof useNoteSaved>;
