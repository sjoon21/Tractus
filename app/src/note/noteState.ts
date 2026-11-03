// 노트 화면이 들고 있는 노트 데이터의 상태 전이 (순수 함수). 화면에 보이는 노트는 두 겹이다:
//   base    코어가 마지막으로 확인한 노트 (낙관적으로 고친 제목·녹음 중 메모 목록 포함)
//   pending 저장 중인 문장 편집 묶음 (낙관적 반영: 저장이 끝나면 걷어 낸다)
// rev는 코어가 확인한 노트를 새로 받을 때만 올라간다(요약 탭이 요약 파일을 다시 읽는 신호). 낙관적 고침은 올리지 않는다.
import type { MeetingDetail } from "../api";
import { applyEdits, type TextEdit } from "../lib";

export interface NoteState {
  base: MeetingDetail | null;
  pending: TextEdit[][];
  rev: number;
}

export const INITIAL_NOTE: NoteState = { base: null, pending: [], rev: 0 };

export type NoteAction =
  /** 코어가 확인한 노트를 받았다 */
  | { type: "commit"; detail: MeetingDetail }
  /** 확인 전에 화면만 고친다(제목·메모 목록). 아직 읽지 않은 노트에는 아무 일도 하지 않는다 */
  | { type: "patch"; fn: (d: MeetingDetail) => MeetingDetail }
  /** 문장 편집 한 묶음을 낙관적으로 반영한다 */
  | { type: "pend"; edits: TextEdit[] }
  /** 저장이 끝났다(성공이든 실패든): 그 묶음을 걷어 낸다. 같은 묶음 객체로 찾는다 */
  | { type: "settle"; edits: TextEdit[] }
  /** 요약·메모 탭이 노트를 다시 읽게 한다 */
  | { type: "refresh" };

export function noteReduce(s: NoteState, a: NoteAction): NoteState {
  switch (a.type) {
    case "commit":
      return { ...s, base: a.detail, rev: s.rev + 1 };
    case "patch":
      return s.base ? { ...s, base: a.fn(s.base) } : s;
    case "pend":
      return { ...s, pending: [...s.pending, a.edits] };
    case "settle":
      return { ...s, pending: s.pending.filter((x) => x !== a.edits) };
    case "refresh":
      return { ...s, rev: s.rev + 1 };
  }
}

/** 화면에 그리는 노트: base에 저장 중인 문장 편집을 차례로 겹친 것. 저장 중인 것이 없으면 base 그대로 */
export function viewNote(s: NoteState): MeetingDetail | null {
  return s.base && s.pending.length ? { ...s.base, segments: s.pending.reduce(applyEdits, s.base.segments) } : s.base;
}
