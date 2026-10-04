// 화면과 무관한 순수 로직. 전부 lib.test.ts에서 검사한다.

export interface Segment {
  id: string;
  start: number;
  end: number;
  text: string;
  corrected_text?: string | null;
  /** "S1"… schema_version 1이나 화자 분리를 끈 회의는 없거나 null */
  speaker?: string | null;
}

export interface Memo {
  t: number;
  kind: "memo" | "bookmark" | string;
  text: string | null;
}

/** 초 → "4:05", 한 시간이 넘으면 "1:02:03". */
export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "00:05:31" 또는 "05:31" → 331. 형식이 틀리면 0. */
export function parseHms(hms: string): number {
  const parts = hms.split(":").map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** t초에 재생 중인 세그먼트: start <= t인 마지막 세그먼트(발화 사이 공백에서도 직전 세그먼트를 유지). 첫 세그먼트 전이면 -1. */
export function segmentIndexAt(segments: Segment[], t: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export type Row = { kind: "seg"; seg: Segment; index: number; turnStart?: boolean } | { kind: "memo"; memo: Memo };

/** 전사 세그먼트와 메모·북마크를 시각 순으로 합친다. 같은 시각이면 세그먼트가 먼저다. */
export function interleave(segments: Segment[], memos: Memo[]): Row[] {
  const sorted = [...memos].sort((a, b) => a.t - b.t);
  const rows: Row[] = [];
  let j = 0;
  segments.forEach((seg, index) => {
    while (j < sorted.length && sorted[j].t < seg.start) rows.push({ kind: "memo", memo: sorted[j++] });
    rows.push({ kind: "seg", seg, index });
  });
  while (j < sorted.length) rows.push({ kind: "memo", memo: sorted[j++] });
  return rows;
}

// ── 화자 (transcript.json schema_version 2, docs/desktop.md §2.1). 라벨은 자동 추정이고 이름은 사용자가 붙인다 ──

export type Speakers = Record<string, { name: string | null }>;

/** 표시 이름: 이름, 없으면 라벨. 화자가 없는 세그먼트는 null. */
export function speakerName(label: string | null | undefined, speakers: Speakers): string | null {
  if (!label) return null;
  return speakers[label]?.name?.trim() || label;
}

export const SPEAKER_SLOTS = 8;
const labelNum = (label: string) => Number(/^S(\d+)$/.exec(label)?.[1] ?? NaN);

/** 색 슬롯 0..7. 라벨 번호로 정하므로 이름을 바꾸거나 다른 화자를 합쳐도 남은 화자의 색은 그대로다. 라벨이 아니면 -1(무채색). */
export function speakerSlot(label: string | null | undefined): number {
  const n = labelNum(label ?? "");
  return Number.isNaN(n) ? -1 : (((n - 1) % SPEAKER_SLOTS) + SPEAKER_SLOTS) % SPEAKER_SLOTS;
}

export interface SpeakerStat {
  label: string;
  display: string;
  segments: number;
  talkSec: number;
  /** 화자가 붙은 발화 시간 전체에 대한 비율 0..1 */
  share: number;
  /** 색 슬롯. 라벨 번호대로(speakerSlot) 두되, 이미 쓰인 슬롯이면 빈 슬롯을 쓴다 (8명이 넘으면 겹친다) */
  slot: number;
}

/** 화자 막대용 목록. 편집해도 순서가 흔들리지 않게 라벨 번호 순이다. */
export function speakerStats(segments: Segment[], speakers: Speakers): SpeakerStat[] {
  const talk = new Map<string, { segments: number; talkSec: number }>(Object.keys(speakers).map((l) => [l, { segments: 0, talkSec: 0 }]));
  for (const s of segments) {
    if (!s.speaker) continue;
    const t = talk.get(s.speaker) ?? { segments: 0, talkSec: 0 };
    talk.set(s.speaker, { segments: t.segments + 1, talkSec: t.talkSec + Math.max(0, s.end - s.start) });
  }
  const total = [...talk.values()].reduce((a, t) => a + t.talkSec, 0);
  const sorted = [...talk.entries()].sort(([a], [b]) => (labelNum(a) || Infinity) - (labelNum(b) || Infinity) || a.localeCompare(b));
  const used = new Set<number>();
  const own = sorted.map(([label]) => {
    const n = speakerSlot(label);
    if (n < 0 || used.has(n)) return null;
    used.add(n);
    return n;
  });
  const free = [...Array(SPEAKER_SLOTS).keys()].filter((n) => !used.has(n));
  return sorted.map(([label, t], i) => ({
    label,
    display: speakerName(label, speakers)!,
    ...t,
    share: total ? t.talkSec / total : 0,
    slot: own[i] ?? (speakerSlot(label) < 0 ? -1 : (free.shift() ?? speakerSlot(label))),
  }));
}

/**
 * 화면에 그릴 행. only가 있으면 그 화자의 세그먼트만(메모는 숨김). index는 원래 위치 그대로다(재생 위치 강조용).
 * turnStart: 바로 앞 행이 같은 화자의 바로 앞 세그먼트가 아니면 새 발언이다 — 이름은 발언마다 한 번만 보인다.
 */
export function transcriptRows(segments: Segment[], memos: Memo[], only: string | null): Row[] {
  const rows: Row[] = only === null ? interleave(segments, memos) : segments.flatMap((seg, index) => (seg.speaker === only ? [{ kind: "seg" as const, seg, index }] : []));
  return rows.map((r, i) => {
    if (r.kind !== "seg") return r;
    const prev = rows[i - 1];
    const same = prev?.kind === "seg" && prev.index === r.index - 1 && (prev.seg.speaker ?? null) === (r.seg.speaker ?? null);
    return { ...r, turnStart: !same };
  });
}

/** 요약 항목의 근거 세그먼트 중 가장 이른 시각. 없으면 null. */
export function evidenceStart(segmentIds: string[], starts: Map<string, number>): number | null {
  const ts = segmentIds.map((id) => starts.get(id)).filter((t): t is number => t !== undefined);
  return ts.length ? Math.min(...ts) : null;
}

/** MCP tools/call result → 구조화 결과. isError면 서버 메시지로 예외를 던진다. */
export function parseToolResult<T>(result: unknown): T {
  const r = (result ?? {}) as { isError?: boolean; structuredContent?: T; content?: { type: string; text?: string }[] };
  const text = r.content?.find((c) => c.type === "text")?.text;
  if (r.isError) throw new Error((text ?? "검색 실패").replace(/^Error executing tool \w+: /, ""));
  if (r.structuredContent !== undefined) return r.structuredContent;
  if (text === undefined) throw new Error("MCP 응답에 결과가 없습니다");
  return JSON.parse(text) as T;
}

export interface DayGroup<T> {
  day: string; // YYYY-MM-DD
  items: T[];
}

/** 이미 최신순인 목록을 회의 날짜(created_at의 앞 10자, 회의 현지 날짜)별로 묶는다. */
export function groupByDay<T extends { created_at: string }>(items: T[]): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const item of items) {
    const day = item.created_at.slice(0, 10) || "날짜 없음";
    const last = groups[groups.length - 1];
    if (last?.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

/** "2026-10-02" → { month: "2026년 10월", day: "2", weekday: "금" } */
export function dayParts(day: string): { month: string; day: string; weekday: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return { month: "", day: day, weekday: "" };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const weekday = WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  return { month: `${y}년 ${mo}월`, day: String(d), weekday };
}

/** 질의 단어를 표시용으로 나눈다. <mark>로 감싸려고 쓴다(innerHTML 없이). */
export function highlight(text: string, query: string): { text: string; hit: boolean }[] {
  const terms = query.split(/\s+/).filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!terms.length) return [{ text, hit: false }];
  const re = new RegExp(`(${terms.join("|")})`, "gi");
  return text
    .split(re)
    .filter((p) => p !== "")
    .map((p) => ({ text: p, hit: terms.some((t) => new RegExp(`^${t}$`, "i").test(p)) }));
}

/** dBFS(-60..0) → 0..1 미터 비율. null(트랙 없음)은 0. */
export function levelFraction(db: number | null | undefined): number {
  if (db === null || db === undefined || !Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

export const STAGE_LABEL: Record<string, string> = {
  decode: "오디오 읽는 중",
  vad: "발화 구간 찾는 중",
  diarize: "화자 구분 중…",
  encode: "오디오 보관 중",
  load_model: "모델 불러오는 중",
  transcribe: "전사 중",
  index: "검색 색인 중",
  summarize: "요약 중",
};

/** 입력 중일 때는 단축키를 먹지 않는다. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

// ── 하위 프로세스 이벤트 → 화면 상태 (docs/desktop.md §1·§2). 이벤트 끝에는 Rust가 붙인 exit가 온다 ──

/** stderr 끝 세 줄. 비어 있으면 fallback. */
const stderrTail = (stderr: string, fallback: string) => stderr.trim().split("\n").slice(-3).join("\n") || fallback;

export type JobEvent =
  | { job: string; event: "stage"; stage: string }
  | { job: string; event: "progress"; done: number; total: number }
  | { job: string; event: "done"; meeting_id: string; meeting_dir: string }
  | { job: string; event: "warning"; code: string; message: string }
  | { job: string; event: "error"; message: string }
  | { job: string; event: "exit"; code: number | null; stderr: string };

export interface JobState {
  running: boolean;
  stage: string | null;
  done: number;
  total: number;
  meetingId: string | null;
  error: string | null;
  /** 끝나지 않는 경고 (예: diarizer_missing → 화자 없이 계속) */
  warnings: { code: string; message: string }[];
}

export const IDLE_JOB: JobState = { running: false, stage: null, done: 0, total: 0, meetingId: null, error: null, warnings: [] };

/** 성공은 exit 0 + done 이벤트. 그 밖의 종료는 error 이벤트 메시지, 없으면 stderr 끝부분을 오류로 보인다. */
export function jobReduce(s: JobState, ev: JobEvent): JobState {
  switch (ev.event) {
    case "stage":
      return { ...s, stage: ev.stage, done: 0, total: 0 };
    case "progress":
      return { ...s, done: ev.done, total: ev.total };
    case "done":
      return { ...s, meetingId: ev.meeting_id };
    case "warning":
      return s.warnings.some((w) => w.code === ev.code) ? s : { ...s, warnings: [...s.warnings, { code: ev.code, message: ev.message }] };
    case "error":
      return { ...s, error: ev.message };
    case "exit": {
      const ok = ev.code === 0 && s.meetingId !== null;
      return { ...s, running: false, error: ok ? null : (s.error ?? stderrTail(ev.stderr, `종료 코드 ${ev.code}`)) };
    }
  }
}

export type RecEvent =
  | { event: "started"; dir: string; tracks: string[]; started_at: string }
  | { event: "level"; t: number; mic: number | null; system: number | null }
  | { event: "mark"; t: number; kind: string; text: string | null }
  | { event: "warning"; code: string; message: string }
  | { event: "stopped"; dir: string; duration: number }
  | { event: "error"; message: string }
  | { event: "exit"; code: number | null; stderr: string };

// ── 녹음 방식. 기본은 대면 회의(방 안 여러 사람, 마이크 하나) ──

export type RecMode = "in_person" | "hybrid";

export const REC_MODES: { mode: RecMode; label: string; note: string }[] = [
  { mode: "in_person", label: "대면 회의", note: "마이크 하나로 방 안의 모든 사람을 녹음합니다. 노트북을 테이블 가운데에 두세요." },
  { mode: "hybrid", label: "화상·하이브리드", note: "상대방 소리(시스템 오디오)와 내 마이크를 함께 녹음합니다. 스피커로 들어도 에코를 제거합니다." },
];

/** 설정 파일의 값 → 녹음 방식. 모르는 값이면 대면 회의. */
export const recMode = (v: unknown): RecMode => (v === "hybrid" ? "hybrid" : "in_person");

/** 녹음 방식 → tractus-rec record 추가 인수 (docs/desktop.md §1). */
export const recFlags = (mode: RecMode): string[] => (mode === "hybrid" ? ["--echo-cancel"] : ["--no-system"]);

/** 설정을 고치지 않고 녹음 방식만 바꾼 사본. */
export const withRecMode = <T extends { rec_mode: string }>(settings: T, mode: RecMode): T => ({ ...settings, rec_mode: mode });

/** 녹음을 계속하면서 알리는 경고 중 설명을 덧붙이는 것. 모르는 코드는 헬퍼 메시지만 보인다. */
const WARNING_NOTE: Record<string, string> = {
  echo_cancel_failed: "에코 제거 없이 녹음을 계속합니다. 스피커 소리가 마이크 트랙에 섞여 같은 말이 두 번 전사될 수 있습니다.",
};

export const warningText = (w: { code: string; message: string }): string => (WARNING_NOTE[w.code] ? `${w.message} — ${WARNING_NOTE[w.code]}` : w.message);

export type RecPhase = "idle" | "starting" | "recording" | "stopping" | "stopped" | "error";

export interface RecState {
  phase: RecPhase;
  mode: RecMode;
  dir: string | null;
  t: number;
  mic: number | null;
  system: number | null;
  tracks: string[];
  marks: Memo[];
  warnings: { code: string; message: string }[];
  error: string | null;
}

export const IDLE_REC: RecState = { phase: "idle", mode: "in_person", dir: null, t: 0, mic: null, system: null, tracks: [], marks: [], warnings: [], error: null };

/** 같은 경고는 한 번만 보인다. stopped 없이 끝나면(exit) 오류다. */
export function recReduce(s: RecState, ev: RecEvent): RecState {
  switch (ev.event) {
    case "started":
      return { ...s, phase: "recording", dir: ev.dir, tracks: ev.tracks };
    case "level":
      return { ...s, t: ev.t, mic: ev.mic, system: ev.system };
    case "mark":
      return { ...s, marks: [...s.marks, { t: ev.t, kind: ev.kind, text: ev.text }] };
    case "warning":
      return s.warnings.some((w) => w.code === ev.code) ? s : { ...s, warnings: [...s.warnings, { code: ev.code, message: ev.message }] };
    case "stopped":
      return { ...s, phase: "stopped", t: ev.duration, dir: ev.dir };
    case "error":
      return { ...s, phase: "error", error: ev.message };
    case "exit":
      if (s.phase === "stopped" || s.phase === "error") return s;
      return { ...s, phase: "error", error: stderrTail(ev.stderr, `녹음 헬퍼가 종료되었습니다 (코드 ${ev.code})`) };
  }
}
