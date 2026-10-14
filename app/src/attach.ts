// 글만 있는 노트에 녹음 추가 (docs/desktop.md §2.11)의 순수 로직: 흐름 상태, 대상 찾기, 문구. 화면은 App.tsx·MeetingView.tsx·RecordView.tsx. attach.test.ts에서 검사한다.
import type { MeetingInfo, PendingRecording } from "./api";
import type { Decision } from "./caps";
import { isMemo } from "./memo";
import { baseName } from "./lib";

export interface AttachTarget {
  id: string;
  title: string;
}

/** 흐름: idle → recording(대상 노트에 녹음하는 중) → converting(녹음을 변환해 노트에 덧붙이는 중) → idle. 파일로 추가하면 idle → converting */
export type AttachPhase = "idle" | "recording" | "converting";

export interface AttachState {
  phase: AttachPhase;
  target: AttachTarget | null;
}

export const IDLE_ATTACH: AttachState = { phase: "idle", target: null };

export type AttachAction =
  /** 대상 노트에 녹음 시작. 이미 다른 흐름이 있으면 무시한다 */
  | { type: "record"; target: AttachTarget }
  /** 변환을 시작했다 (녹음을 마쳤거나, 남은 녹음·파일을 추가한다). 녹음 중이던 대상이 있으면 그대로 이어 간다 */
  | { type: "convert"; target: AttachTarget }
  /** 녹음이 시작되지 못했거나 변환 없이 끝났다 */
  | { type: "abort" }
  /** 변환이 끝났다(성공이든 실패든): 노트는 그대로이거나 녹음 노트가 되었다 */
  | { type: "finish" };

export function attachReduce(s: AttachState, a: AttachAction): AttachState {
  switch (a.type) {
    case "record":
      return s.phase === "idle" ? { phase: "recording", target: a.target } : s;
    case "convert":
      return s.phase === "converting" ? s : { phase: "converting", target: s.phase === "recording" && s.target ? s.target : a.target };
    case "abort":
    case "finish":
      return IDLE_ATTACH;
  }
}

/** 노트 id가 지금 쓰이는 중인지: "recording" | "converting"이면 글을 고치거나 지울 수 없다 */
export const lockOf = (s: AttachState, id: string): "recording" | "converting" | null => (s.target?.id === id && s.phase !== "idle" ? s.phase : null);

/** 대상 노트: 목록에 아직 있고 글만 있는 노트(메모)일 때만. 지워졌거나 이미 녹음이 있으면 null → 그 녹음은 새 노트로 변환한다 */
export function resolveTarget(id: string | null | undefined, notes: MeetingInfo[]): AttachTarget | null {
  const n = id ? notes.find((m) => m.id === id) : undefined;
  return n && isMemo(n) ? { id: n.id, title: n.title } : null;
}

/** 남은 녹음이 추가하려던 노트. attach_to가 없으면 null */
export const pendingTarget = (p: PendingRecording, notes: MeetingInfo[]): AttachTarget | null => resolveTarget(p.attach_to, notes);

/** App이 MeetingView에 넘기는 녹음 추가 제어 (글만 있는 노트에서만 쓴다) */
export interface AttachControls {
  /** 이 노트가 지금 쓰이는 중이면 recording | converting: 글을 고치거나 지울 수 없다 */
  lock: "recording" | "converting" | null;
  /** 추가 단추를 못 쓰는 이유 (없으면 null) */
  blocked: string | null;
  /** `파일에서 추가`는 변환 엔진·ffmpeg가 있어야 한다 (caps.decide "convert"). 없으면 이유와 고치는 길을 보인다. 안 주면 쓸 수 있다 */
  convert?: Decision;
  onRecord: (t: AttachTarget) => void;
  onFile: (t: AttachTarget) => void;
}

// ── 문구 (WORDS.md §4.11) ──

const quoted = (title: string) => `‘${title || "제목 없음"}’`;

export const RECORD_LABEL = (title: string) => `${quoted(title)} 노트에 녹음 추가 중`;
export const PENDING_LABEL = (title: string) => `${quoted(title)} 노트에 추가할 녹음`;
export const DROP_LABEL = (title: string) => `파일을 놓으면 ${quoted(title)} 노트에 추가합니다`;
export const DROP_CONFIRM = {
  title: (title: string) => `${quoted(title)} 노트에 파일을 추가할까요?`,
  body: "추가하면 지금까지 쓴 글은 메모 탭으로 옮겨지고, 노트는 녹음 노트로 바뀝니다. 되돌릴 수 없습니다.",
  cancel: "취소",
  confirm: "추가",
} as const;
export const ADD_RECORDING = "녹음 추가";
export const ADD_FILE = "파일에서 추가";
export const ADD_TITLE = "이 노트에 녹음을 추가합니다. 지금까지 쓴 글은 메모 탭으로 옮겨집니다";
export const ADD_FILE_TITLE = "오디오·동영상 파일을 이 노트에 추가합니다. 지금까지 쓴 글은 메모 탭으로 옮겨집니다";
export const ADD_BADGE = "추가하기";
export const BUSY_RECORDING = "이미 녹음 중입니다";
export const BUSY_CONVERTING = "변환이 끝난 뒤에 녹음할 수 있습니다";
export const BUSY_JOB = "작업이 끝난 뒤에 추가할 수 있습니다";
export const IMPORT_BUSY = "다른 변환이 끝난 뒤에 추가할 수 있습니다";
export const LOCK_NOTICE = { recording: "녹음이 끝나면 다시 쓸 수 있습니다", converting: "변환이 끝나면 다시 쓸 수 있습니다" } as const;
export const ADDED = (title: string, file: string) => `${quoted(title)} 노트에 녹음을 추가했습니다 — ${file}`;
export const failedFile = (file: string, why: string) => `‘${baseName(file)}’을(를) 텍스트로 변환하지 못했습니다${why}`;

/** 추가 단추를 못 쓰는 이유 (없으면 쓸 수 있다). busy: 요약·단어 싱크 같은 이 노트의 다른 작업 */
export function addBlocked(o: { recording: boolean; transcribing: boolean; lock: "recording" | "converting" | null; busy?: boolean }): string | null {
  if (o.lock) return LOCK_NOTICE[o.lock];
  if (o.recording) return BUSY_RECORDING;
  if (o.transcribing) return BUSY_CONVERTING;
  return o.busy ? BUSY_JOB : null;
}
