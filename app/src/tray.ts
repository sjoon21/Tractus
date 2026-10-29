// 메뉴 막대(트레이) 아이콘과 화면의 연결 (docs/desktop.md §3.1, 이슈 #1). 순수 로직만 둔다: Rust(tray.rs)는 메뉴를 그리고, 화면은 상태를 밀어 주고 이벤트를 받는다.
// 메뉴의 녹음 시작·종료·북마크는 창의 단추와 같은 길로 처리한다 (App.tsx가 routeTrayAction의 결과를 같은 함수에 연결한다).

import { isRecLive, type RecPhase } from "./lib";

export type TrayPhase = "idle" | "recording" | "paused" | "converting";

export interface TrayRecent {
  id: string;
  title: string;
}

/** Rust `tray_update`가 받는 값. started_at_ms·progress_pct는 해당 단계에서만 있다 */
export interface TrayPayload {
  phase: TrayPhase;
  /** 녹음이 시작된 시각 (epoch ms). 경과 시간은 Rust가 센다. 일시정지한 시간은 센 적이 없는 것으로, 계속할 때마다 그만큼 뒤로 옮겨 다시 보낸다 */
  started_at_ms?: number;
  /** paused만: 일시정지한 순간의 경과 (ms). 일시정지 중에는 시계를 읽지 않고 이 값으로 멈춘다 */
  elapsed_ms?: number;
  /** 변환 진행률 0~100. 총량을 모르면 없다 */
  progress_pct?: number;
  can_record: boolean;
  can_bookmark: boolean;
  recent: TrayRecent[];
}

/** 실제로 보내는 값: 최근 노트 목록이 그대로면 `recent`를 뺀다 (Rust가 이전 목록을 둔다) */
export type TrayWire = Omit<TrayPayload, "recent"> & { recent?: TrayRecent[] };

export const TRAY_RECENT_MAX = 5;

interface NoteLike {
  id: string;
  title: string;
  created_at: string;
  updated_at?: string;
}

const stamp = (n: NoteLike): number => {
  const t = Date.parse(n.updated_at ?? n.created_at);
  return Number.isNaN(t) ? 0 : t;
};

/** 최근에 고친 순으로 5개. 같은 시각이면 목록의 원래 순서를 지킨다 */
export function recentNotes(notes: readonly NoteLike[]): TrayRecent[] {
  return notes
    .map((n, i) => ({ n, i, t: stamp(n) }))
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .slice(0, TRAY_RECENT_MAX)
    .map(({ n }) => ({ id: n.id, title: n.title }));
}

export interface TrayInput {
  rec: { phase: RecPhase };
  /** 녹음 시작 시각 (epoch ms, 일시정지한 시간을 뺀 값). 아직 모르면 null */
  startedAtMs: number | null;
  /** 일시정지한 순간의 경과(초). 일시정지 중에만 쓴다 */
  elapsedSec?: number;
  /** 변환 작업 (녹음 변환) */
  job: { running: boolean; done: number; total: number };
  /** 변환을 시작하려고 기다리는 중 (가져오기가 끝나기를 기다린다). 창의 `변환 대기 중…`과 같다 */
  waiting: boolean;
  /** 파일 가져오기·노트에 파일 추가 변환 (대기 중인 파일 포함). 창의 녹음 단추는 이것으로 막히지 않는다 */
  importing: { active: boolean; done: number; total: number };
  /** 녹음 프로그램을 쓸 수 있는가 (caps `record`) */
  recordOk: boolean;
  /** 새 녹음을 막는 일이 있는가 (recordBusy.recordBlock: 묻는 창·저장 중·실시간 텍스트 변환을 켠 채 녹음 변환 중). 없으면 막지 않는다 */
  recordBlocked?: boolean;
  notes: readonly NoteLike[];
}

/** 화면 상태 → 메뉴 막대 상태. 창의 녹음 단추와 같은 규칙: 녹음하는 동안·마무리하는 동안에는 새 녹음을 시작하지 않는다.
 * 녹음 변환 중에는 창과 같은 규칙(recordBlocked: 묻는 창·저장 중·실시간 텍스트 변환을 켜 둔 때)으로만 막는다(파일 가져오기는 막지 않는다) */
export function deriveTrayState(i: TrayInput): TrayPayload {
  const recent = recentNotes(i.notes);
  const { phase } = i.rec;
  if (phase === "recording") {
    return { phase: "recording", ...(i.startedAtMs !== null && { started_at_ms: i.startedAtMs }), can_record: false, can_bookmark: true, recent };
  }
  // 일시정지: 앱은 그대로 녹음 중으로 보고(새 녹음·변환은 막힌다) 시계만 멈춘다
  if (phase === "paused") return { phase: "paused", elapsed_ms: Math.max(0, Math.round((i.elapsedSec ?? 0) * 1000)), can_record: false, can_bookmark: true, recent };
  // 시작하는 중: 아직 시각이 없다 (Rust는 `녹음 준비 중…`을 보이고 종료·북마크를 막는다)
  if (phase === "starting") return { phase: "recording", can_record: false, can_bookmark: false, recent };
  // 마무리하는 중(정지를 보냈고 변환이 곧 시작된다)도 변환으로 본다
  if (phase === "stopping" || i.job.running || i.waiting) {
    const pct = i.job.running && i.job.total > 0 ? Math.min(100, Math.round((i.job.done / i.job.total) * 100)) : undefined;
    return { phase: "converting", ...(pct !== undefined && { progress_pct: pct }), can_record: phase !== "stopping" && !i.recordBlocked && i.recordOk, can_bookmark: false, recent };
  }
  // 가져오기 변환 중에도 창처럼 녹음은 시작할 수 있다: 상태 줄만 `변환 중`으로 보이고 can_record는 그대로다
  if (i.importing.active) {
    const { done, total } = i.importing;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : undefined;
    return { phase: "converting", ...(pct !== undefined && { progress_pct: pct }), can_record: i.recordOk, can_bookmark: false, recent };
  }
  return { phase: "idle", can_record: i.recordOk, can_bookmark: false, recent };
}

/** 같은 상태를 다시 보내지 않는다. 최근 노트 목록은 바뀔 때만 싣는다. 보내지 못하면 다음에 모두 다시 보낸다.
 * 타이머로 모으지 않는다: 숨은 창의 setTimeout은 늦어져 메뉴 막대가 한참 낡은 채로 남는다 (React가 한 렌더에 한 번만 부른다) */
export function createTraySender(send: (p: TrayWire) => Promise<void> | void): (p: TrayPayload) => boolean {
  let lastRest: string | null = null;
  let lastRecent: string | null = null;
  return (p) => {
    const { recent, ...rest } = p;
    const restKey = JSON.stringify(rest);
    const recentKey = JSON.stringify(recent);
    if (restKey === lastRest && recentKey === lastRecent) return false;
    const wire: TrayWire = recentKey === lastRecent ? rest : p;
    lastRest = restKey;
    lastRecent = recentKey;
    const forget = () => {
      lastRest = lastRecent = null;
    };
    try {
      void Promise.resolve(send(wire)).catch(forget);
    } catch {
      forget();
    }
    return true;
  };
}

export type TrayRoute = { kind: "start" } | { kind: "pause" } | { kind: "resume" } | { kind: "stop" } | { kind: "bookmark" } | { kind: "open"; id: string };

/** 창에서 이미 녹음하거나 마무리하는 중인 단계 (사이드바의 `recording`) */
const REC_ACTIVE = new Set<RecPhase>(["starting", "recording", "paused", "stopping"]);

/** Rust가 보낸 `tray-action`을 할 일로 바꾼다. 지금 상태에서 뜻이 없으면 null (두 번 누른 시작, 녹음 중이 아닌 종료 등은 아무 일도 하지 않는다) */
export function routeTrayAction(raw: unknown, s: { recPhase: RecPhase; transcribing: boolean }): TrayRoute | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { action, id } = raw as { action?: unknown; id?: unknown };
  switch (action) {
    case "record_start":
      return REC_ACTIVE.has(s.recPhase) || s.transcribing ? null : { kind: "start" };
    case "record_pause":
      return s.recPhase === "recording" ? { kind: "pause" } : null;
    case "record_resume":
      return s.recPhase === "paused" ? { kind: "resume" } : null;
    case "record_stop":
      return isRecLive(s.recPhase) ? { kind: "stop" } : null;
    case "bookmark":
      return isRecLive(s.recPhase) ? { kind: "bookmark" } : null;
    case "open_note":
      return typeof id === "string" && id !== "" ? { kind: "open", id } : null;
    default:
      return null;
  }
}
