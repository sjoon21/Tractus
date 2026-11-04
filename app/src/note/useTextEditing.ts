// 대화 문장 편집: 낙관적으로 반영하고 줄에 세워 저장하며, 되돌리기(⌘Z)는 묶음 단위다.
// 되돌리기 묶음은 저장이 성공한 뒤 코어가 확인한 직전 상태로 만든다: 화면(낙관적 반영)으로 만들면 앞 묶음이 실패했을 때 저장된 적 없는 문장으로 되돌린다.
import { useCallback, useRef } from "react";
import { api, errText } from "../api";
import { t } from "../i18n";
import { inverseEdits, oneLine, segText, type TextEdit } from "../lib";
import { termFromEdit } from "../vocab";
import type { NoteData } from "./useNoteData";
import type { NoteSaved } from "./useNoteSaved";
import type { EditQueue } from "./useEditQueue";

export function useTextEditing({ id, data, queue, noteSaved, suggestTerms }: { id: string; data: NoteData; queue: EditQueue; noteSaved: NoteSaved; suggestTerms: (all: string[]) => void }) {
  const { confirmed, pend, settle } = data;
  const { setEditError, serial, guard } = queue;
  /** 되돌릴 묶음. 스마트 교정 받기도 여기에 쌓는다 */
  const undoStack = useRef<TextEdit[][]>([]);
  // 저장 한 묶음 (serial 안에서 부른다)
  const persist = useCallback(
    async (edits: TextEdit[], isUndo: boolean, suggest = false) => {
      const before = confirmed.current;
      try {
        const { changed, meeting } = await api.editSegments(id, edits);
        noteSaved(meeting, "text", changed > 0);
        if (changed > 0) {
          if (!isUndo && before) undoStack.current.push(inverseEdits(before.segments, edits));
          const old = suggest && edits.length === 1 ? before?.segments.find((s) => s.id === edits[0].id) : undefined;
          const term = old ? termFromEdit(segText(old), edits[0].text) : null;
          if (term) suggestTerms([term]);
        }
      } catch (e) {
        // 아무것도 쓰이지 않았다(코어 계약). 화면은 원래 문장으로 돌아가므로 고친 문장을 메시지에 남긴다
        setEditError(
          edits.length === 1
            ? t("저장하지 못했습니다 (“{text}”): {error}", { text: oneLine(edits[0].text), error: errText(e) })
            : t("저장하지 못했습니다 (대화 {n}개): {error}", { n: edits.length, error: errText(e) }),
        );
        if (isUndo) undoStack.current.push(edits);
      } finally {
        settle(edits);
      }
    },
    [id, confirmed, settle, noteSaved, suggestTerms, setEditError],
  );
  /** suggestTerm: 대화 한 줄을 직접 고쳤을 때 (찾아 바꾸기는 '사전에 추가' 체크가 따로 있다) */
  const saveText = useCallback(
    (edits: TextEdit[], suggestTerm = false) => {
      if (!edits.length) return;
      if (guard()) return; // 삭제를 기다리는 중: 낙관적 반영도 하지 않는다
      setEditError(null);
      pend(edits);
      void serial(() => persist(edits, false, suggestTerm));
    },
    [guard, setEditError, pend, serial, persist],
  );
  // 되돌리기도 줄에 선다: 앞선 저장이 끝나 스택에 오른 뒤에 꺼낸다(저장 중에 ⌘Z를 눌러도 순서가 맞다)
  const undo = useCallback(() => {
    setEditError(null);
    void serial(async () => {
      const inv = undoStack.current.pop();
      if (!inv) return;
      pend(inv);
      await persist(inv, true);
    });
  }, [setEditError, serial, pend, persist]);
  return { saveText, undo, undoStack };
}
