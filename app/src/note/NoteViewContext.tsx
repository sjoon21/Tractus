// 노트 화면 안의 부품들이 함께 쓰는 노트 단위의 값. 오른쪽 패널의 탭들이 같은 값을 props로 줄줄이 받지 않게 한다.
// 값은 MeetingView가 만들어 내려 준다. 탭 하나에만 필요한 것은 Context에 넣지 않고 그 탭의 props로 받는다.
import { createContext, useContext, type MutableRefObject } from "react";
import type { Notify } from "../App";
import type { AttachControls } from "../attach";
import type { EditKind } from "../memo";

export interface NoteView {
  id: string;
  memoNote: boolean;
  /** 변환 전 노트 (대화가 없다) */
  recorded: boolean;
  hasSegments: boolean;
  notify: Notify;
  /** 사이드바 목록을 새로 읽는다 */
  onChanged: () => void;
  /** 노트를 다시 읽을 때마다 올라간다: 탭이 자기 파일을 다시 읽는 신호 */
  summaryRev: number;
  refreshNote: () => void;
  /** 요약이 낡았는지 가리는 편집 횟수 */
  edit: { editSeq: number; editSeqRef: MutableRefObject<number>; editKinds: MutableRefObject<EditKind[]> };
  /** 대화 내용이나 메모를 저장하는 중: 요약·회의록·완성을 시작하지 않는다 */
  busy: boolean;
  /** 글만 있는 노트에 녹음 추가 (attach.ts). 없으면 잠금도 없다 */
  attach?: AttachControls;
  seekTo: (sec: number, play?: boolean) => void;
  openMemoLine: (segId: string | null) => void;
  /** 대화 id → 시작 시각 */
  starts: Map<string, number>;
  /** 근거 칩의 시각 지도 (메모 노트는 비어 있다) */
  railStarts: Map<string, number>;
  /** 메모 줄 ID → 줄 번호 */
  memoLines: Map<string, number>;
  /** 작업이 도는 동안 삭제를 막는 표시 */
  setRunning: { summary: (r: boolean) => void; minutes: (r: boolean) => void; enhance: (r: boolean) => void };
}

const Ctx = createContext<NoteView | null>(null);
export const NoteViewProvider = Ctx.Provider;

export function useNoteView(): NoteView {
  const v = useContext(Ctx);
  if (!v) throw new Error("useNoteView must be used inside NoteViewProvider");
  return v;
}
