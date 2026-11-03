// 노트 데이터: 코어가 확인한 노트(confirmed)와 화면에 그리는 노트(detail). 상태 전이는 noteState(순수 함수)가 한다.
// confirmed는 렌더를 기다리지 않고 읽는 ref다: 되돌리기 묶음은 이것으로 만든다.
import { useCallback, useMemo, useReducer, useRef } from "react";
import type { MeetingDetail } from "../api";
import type { TextEdit } from "../lib";
import { INITIAL_NOTE, noteReduce, viewNote } from "./noteState";

export function useNoteData() {
  const [state, dispatch] = useReducer(noteReduce, INITIAL_NOTE);
  const confirmed = useRef<MeetingDetail | null>(null);
  const detail = useMemo(() => viewNote(state), [state]);
  /** 코어가 확인한 노트를 받았다 */
  const commit = useCallback((d: MeetingDetail) => {
    confirmed.current = d;
    dispatch({ type: "commit", detail: d });
  }, []);
  /** 화면에 보이는 노트만 고친다 (낙관적 반영, 또는 저장이 끝난 값) */
  const patchView = useCallback((fn: (d: MeetingDetail) => MeetingDetail) => dispatch({ type: "patch", fn }), []);
  /** 코어가 확인한 노트(ref)를 고친다: 낙관적이던 값이 저장으로 확인됐을 때 */
  const patchConfirmed = useCallback((fn: (d: MeetingDetail) => MeetingDetail) => {
    if (confirmed.current) confirmed.current = fn(confirmed.current);
  }, []);
  const pend = useCallback((edits: TextEdit[]) => dispatch({ type: "pend", edits }), []);
  const settle = useCallback((edits: TextEdit[]) => dispatch({ type: "settle", edits }), []);
  /** 요약·메모 탭이 노트를 다시 읽게 한다 */
  const refresh = useCallback(() => dispatch({ type: "refresh" }), []);
  return { detail, summaryRev: state.rev, confirmed, commit, patchView, patchConfirmed, pend, settle, refresh };
}
export type NoteData = ReturnType<typeof useNoteData>;
