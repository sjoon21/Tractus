// 삭제(휴지통으로 이동) 확인 대화상자의 상태와 문구 (WORDS.md §4.8). 실제 이동은 Rust `delete_meeting`·`delete_recording`이 한다.

export type DeleteTarget =
  | { kind: "note"; id: string; title: string; dir: string }
  | { kind: "recording"; dir: string; startedAt: string };

export interface DeleteState {
  target: DeleteTarget | null;
  /** 옮기는 중: 대화상자를 닫거나 다시 누를 수 없다 */
  busy: boolean;
}

export const IDLE_DELETE: DeleteState = { target: null, busy: false };

export type DeleteAction = { type: "ask"; target: DeleteTarget } | { type: "cancel" } | { type: "start" } | { type: "finish" };

export function deleteReduce(s: DeleteState, a: DeleteAction): DeleteState {
  switch (a.type) {
    case "ask":
      return s.busy ? s : { target: a.target, busy: false };
    case "cancel":
      return s.busy ? s : IDLE_DELETE;
    case "start":
      return s.target && !s.busy ? { ...s, busy: true } : s;
    case "finish":
      return IDLE_DELETE;
  }
}

/** 삭제를 기다리는 노트에 새 수정이 들어왔을 때 (저장 중인 수정은 끝까지 마친 뒤 지운다) */
export const EDIT_BLOCKED = "노트를 삭제하는 중이라 지금은 수정할 수 없습니다";

/** 사라진 노트를 가리키는 인용 칩의 설명 (칩은 눌러도 아무 일도 하지 않는다) */
export const NOTE_GONE = "삭제된 노트입니다";

/** 사이드바 '변환 대기 중인 녹음' 줄 이름. 예: `녹음 2026-10-07 14:05` */
export const recordingLabel = (startedAt: string): string => `녹음 ${startedAt.slice(0, 10)} ${startedAt.slice(11, 16)}`;

export const noteTitle = (title: string): string => title.trim() || "제목 없음";

const lastPart = (path: string): string => path.split("/").filter(Boolean).pop() ?? path;
const parentPath = (path: string): string => path.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";

export interface DeleteDialogText {
  title: string;
  body: string;
  cancel: string;
  confirm: string;
  /** 옮기는 중 확인 버튼 */
  busy: string;
}

export function deleteDialogText(t: DeleteTarget): DeleteDialogText {
  const restore = `되돌리려면 휴지통에서 ‘${lastPart(t.dir)}’ 폴더를 꺼내 ${parentPath(t.dir)} 폴더에 다시 넣으세요.`;
  const common = { cancel: "취소", confirm: "휴지통으로 이동", busy: "옮기는 중…" };
  if (t.kind === "note") {
    return {
      ...common,
      title: `‘${noteTitle(t.title)}’ 노트를 삭제할까요?`,
      body: `녹음 파일, 대화 내용, 요약, 질문 기록이 휴지통으로 옮겨지고, 검색과 AI 질문에서도 빠집니다. ${restore}`,
    };
  }
  return {
    ...common,
    title: "변환 대기 중인 녹음을 삭제할까요?",
    body: `${recordingLabel(t.startedAt)}에 시작한 녹음입니다. 아직 텍스트로 변환하지 않았습니다. 녹음 파일이 휴지통으로 옮겨집니다. ${restore}`,
  };
}

export const deletedText = (t: DeleteTarget): string => (t.kind === "note" ? `‘${noteTitle(t.title)}’ 노트를 휴지통으로 옮겼습니다` : "녹음을 휴지통으로 옮겼습니다");

/** Rust 오류(첫 줄 = 화면 문장, 나머지 = 원래 오류) → 토스트 문장과 '자세히' */
export function deleteFailure(t: DeleteTarget, message: string): { text: string; detail: string | null } {
  const [reason, ...rest] = message.split("\n");
  const base = t.kind === "note" ? `‘${noteTitle(t.title)}’ 노트를 삭제하지 못했습니다` : "녹음을 삭제하지 못했습니다";
  return { text: reason ? `${base}. ${reason}` : base, detail: rest.join("\n") || null };
}
