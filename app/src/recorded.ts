// 변환 전 노트(녹음만 있고 아직 텍스트로 변환하지 않은 노트, transcript.json `state: "recorded"`)의 순수 로직: 목록 판정, 변환 상태 화면 모델, 문구.
// 화면은 MeetingView.tsx·ConvertPanel.tsx·NoteRow.tsx·App.tsx. recorded.test.ts에서 검사한다. 문구는 WORDS.md §4.18.
import type { Decision } from "./caps";
import { errorView, fmtTime, JOB_ERROR, STAGE_LABEL, type JobState } from "./lib";
import type { RailTab } from "./rail";

/** 목록·상세의 `state`와 `kind`로 변환 전 노트인가. 메모 노트나 모르는 값은 아니다 (Rust meetings::recorded_state와 같다) */
export const isRecorded = (m: { kind?: string | null; state?: string | null }): boolean => m.kind !== "memo" && m.state === "recorded";

/** 변환 전 노트의 ID들, 만든 순서(오래된 것부터). `변환 전 노트 모두 변환`이 이 순서로 돌린다 */
export function recordedIds(notes: readonly { id: string; kind?: string | null; state?: string | null; created_at: string }[]): string[] {
  return notes
    .filter(isRecorded)
    .map((n, i) => ({ n, i }))
    .sort((a, b) => a.n.created_at.localeCompare(b.n.created_at) || a.i - b.i)
    .map(({ n }) => n.id);
}

/** 모두 변환 단추는 변환 전 노트가 둘 이상일 때만 보인다 (하나면 그 노트의 `텍스트로 변환`) */
export const BULK_MIN = 2;

/** 노트 화면이 보는 변환 제어 (App이 만든다). 변환 줄(convertQueue)의 일부를 노트 하나 기준으로 내려 준다 */
export interface ConvertControls {
  /** 이 노트의 차례: 변환 중 | 줄에서 기다리는 중 | 없음 */
  slot: "running" | "queued" | null;
  /** 줄에서 기다리는 이유 문장 (녹음 중이거나 다른 변환·가져오기가 도는 중) */
  waitReason: string;
  /** 변환 엔진·ffmpeg가 있는가 (caps.decide "convert") */
  gate: Decision;
  /** 이 노트를 변환 줄에 올린다 */
  onConvert: (id: string) => void;
}

export type ConvertPanelView =
  | { phase: "idle" }
  | { phase: "queued"; text: string }
  | { phase: "running"; text: string; pct: number | null }
  | { phase: "error"; text: string; detail: string | null };

/** 변환 상태 화면 모델: 진행 중 > 기다리는 중 > 마지막 실패 > 쉬는 중. 코어의 변환 작업 상태(JobState)와 줄의 차례로 정한다 */
export function convertPanelView(job: JobState, slot: ConvertControls["slot"], waitReason: string): ConvertPanelView {
  if (slot === "running" || job.running) {
    return { phase: "running", text: STAGE_LABEL[job.stage ?? ""] ?? STAGE_FALLBACK_TEXT, pct: job.total ? Math.round((job.done / job.total) * 100) : null };
  }
  if (slot === "queued") return { phase: "queued", text: waitReason };
  if (job.error) return { phase: "error", ...errorView(job.error, job.errorCode, JOB_ERROR.convert) };
  return { phase: "idle" };
}

const STAGE_FALLBACK_TEXT = "변환 준비 중…";

/** 변환을 줄에 올릴 수 있는가: 변환 중이거나 기다리는 중이면 또 올리지 않는다 */
export const canQueueConvert = (slot: ConvertControls["slot"], job: JobState): boolean => slot === null && !job.running;

/** 노트 머리의 통계 줄. 변환 전에는 대화 개수가 없다: `12:34 · 녹음 중 메모 2개` */
export function recordedStats(durationSec: number, memos: number): string {
  return `${fmtTime(durationSec)}${memos > 0 ? ` · 녹음 중 메모 ${memos}개` : ""}`;
}

/** 오른쪽 패널 탭에 보일 안내: 변환 전에는 요약·AI 질문이 읽을 글이 없다. 메모 탭은 쓸 수 있다 (null) */
export const railNotice = (tab: RailTab, recorded: boolean): string | null => (recorded && tab !== "memo" ? CONVERT_FIRST : null);

/** 삭제를 막는 이유: 변환 중이거나 줄에서 기다리는 노트는 지울 수 없다 (줄에서 기다리는 노트를 지우면 시작할 때 실패한다) */
export const deleteBlockedWhileConverting = (slot: ConvertControls["slot"]): string | null => (slot ? DELETE_BLOCKED : null);

const MB = 1024 ** 2;
const KEPT_BIG = 1024 ** 3;
const KEPT_STALE_MS = 7 * 24 * 3600 * 1000;
const mbText = (bytes: number) => `${Math.max(1, Math.round(bytes / MB)).toLocaleString("ko-KR")} MB`;

/** 사이드바 배지 `title`: 보관 중인 원본 녹음의 크기. 없으면(0·모름) undefined */
export const keptTitle = (bytes?: number): string | undefined => (bytes ? KEPT_TITLE(mbText(bytes)) : undefined);

/** 변환 전 노트 가운데에 보일 안내: 보관 중인 원본 크기, 1 GB 이상이거나 7일이 넘었으면 `warn`도. 크기를 모르면 null (D5, 표시와 안내만) */
export function keptNotice(bytes: number | undefined, createdAt: string, now: number): { line: string; warn: string | null } | null {
  if (!bytes) return null;
  const age = now - Date.parse(createdAt); // 날짜를 못 읽으면 NaN: 오래됐다고 보지 않는다
  return { line: KEPT_LINE(mbText(bytes)), warn: bytes >= KEPT_BIG || age > KEPT_STALE_MS ? KEPT_WARN : null };
}

// ── 문구 (WORDS.md §4.18) ──

export const RECORDED_BADGE = "변환 전";
export const ROW_RUNNING = "변환 중…";
export const ROW_QUEUED = "변환 대기";
export const CONVERT_LABEL = "텍스트로 변환";
export const CONVERT_RETRY = "다시 변환";
export const CONVERT_EMPTY_TITLE = "아직 텍스트로 변환하지 않았습니다";
export const CONVERT_EMPTY_BODY = "녹음은 저장되어 있어 아래 플레이어로 들어 볼 수 있습니다. 준비가 되면 텍스트로 변환하세요. 변환하기 전에도 메모를 쓰고 제목·태그·폴더를 정리할 수 있습니다.";
export const KEPT_LINE = (size: string) => `원본 녹음 ${size}를 보관 중입니다. 텍스트로 변환하면 지워집니다.`;
export const KEPT_WARN = "변환하지 않으면 용량을 계속 차지합니다.";
export const KEPT_TITLE = (size: string) => `원본 녹음 ${size} 보관 중`;
export const CONVERT_FIRST = "먼저 텍스트로 변환하세요";
export const CONVERT_FAILED_TITLE = "텍스트 변환 실패";
/** 변환 전 노트를 변환하는 중에 새 녹음을 시작할 때 (알림) */
export const CONVERT_PAUSED = "녹음하는 동안 변환을 멈춥니다. 녹음이 끝나면 이어서 변환합니다.";
export const WAIT_RECORDING = "녹음이 끝나면 변환을 시작합니다";
export const WAIT_OTHER = "앞선 변환이 끝나면 시작합니다";
export const DELETE_BLOCKED = "변환이 끝난 뒤에 삭제할 수 있습니다";
export const CONVERT_ALL = (n: number) => `변환 전 노트 모두 변환 (${n})`;
export const CONVERT_ALL_TITLE = "변환 전 노트를 차례로 텍스트로 변환합니다. 하나가 실패해도 나머지는 계속합니다";
export const CONVERT_ROW = "텍스트로 변환";
export const SAVE_NOTE = "노트로 저장";
export const SAVE_NOTE_TITLE = "변환하지 않고 노트로 저장합니다. 나중에 노트에서 텍스트로 변환할 수 있습니다";
export const SAVING = "저장 중…";
export const SAVE_FAILED_TITLE = "녹음 저장 실패";
export const SAVE_DONE_TITLE = "녹음 저장 완료";
export const SAVE_RETRY = "다시 저장";
export const noteLabel = (title: string) => `‘${title.trim() || "제목 없음"}’`;
export const CONVERTED = (title: string) => `${noteLabel(title)} 노트를 텍스트로 변환했습니다`;
export const CONVERT_FAIL = (title: string, why: string) => `${noteLabel(title)} 노트를 텍스트로 변환하지 못했습니다${why}`;
/** 모두 변환 진행 줄: `2 / 3 · ‘제목’` */
export const CONVERT_ALL_LINE = (n: number, total: number, title: string) => `${n} / ${total} · ${noteLabel(title)}`;
