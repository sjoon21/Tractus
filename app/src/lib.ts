// 화면과 무관한 순수 로직. 전부 lib.test.ts에서 검사한다.

export interface Segment {
  id: string;
  start: number;
  end: number;
  text: string;
  corrected_text?: string | null;
  /** "S1"… schema_version 1이나 화자 분리를 끈 회의는 없거나 null */
  speaker?: string | null;
  /** 단어 타이밍 (Phase 6.1, `tractus align`). 표시 텍스트의 공백 토큰과 1:1. 없거나 정렬 전이면 null */
  words?: Word[] | null;
}

/** 시각은 회의 기준 절대 초. approx: 문장을 고친 뒤 보간한 시각 */
export interface Word {
  text: string;
  start: number;
  end: number;
  approx?: boolean;
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
export function segmentIndexAt(segments: { start: number }[], t: number): number {
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

/** t초의 단어: start <= t인 마지막 단어. 첫 단어 전이면 -1 */
export const wordIndexAt: (words: Word[], t: number) => number = segmentIndexAt;

/** 공백으로 나눈 토큰의 글자 위치 (코어 seg_text(s).split()과 같은 토큰). 가라오케 Range와 단어 클릭에 쓴다 */
export const tokenOffsets = (text: string): { start: number; end: number }[] => [...text.matchAll(/\S+/g)].map((m) => ({ start: m.index, end: m.index + m[0].length }));

/** 표시 텍스트와 단어 수·글자가 맞을 때만 단어 타이밍을 쓴다. 저장 중인 편집(낙관적 반영)이면 어긋나므로 세그먼트 단위로 돌아간다 */
export function usableWords(seg: Segment): Word[] | null {
  const words = seg.words;
  if (!Array.isArray(words) || !words.length) return null;
  const tokens = segText(seg).match(/\S+/g) ?? [];
  return words.length === tokens.length && words.every((w, i) => w.text === tokens[i]) ? words : null;
}

/** 문장의 offset번째 글자를 눌렀을 때 이동할 시각: 그 단어의 시작. 단어 타이밍이 없거나, 단어 밖이거나, 보간한 단어면 세그먼트 시작 */
export function clickSeekTime(seg: Segment, offset: number | null): number {
  const words = offset === null ? null : usableWords(seg);
  if (!words || offset === null) return seg.start;
  const k = tokenOffsets(segText(seg)).findLastIndex((o) => o.start <= offset);
  return k < 0 || words[k].approx ? seg.start : words[k].start;
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

/** 등록된 목소리와 맞춘 제안 (Phase 7.1). 확정 전이라 표시 이름으로 쓰지 않는다. score는 코사인 유사도 0..1 */
export interface Suggestion {
  person_id: string;
  name: string;
  score: number;
}

export type Speakers = Record<string, { name: string | null; suggested?: Suggestion | null }>;

/** 표시 이름: 이름, 없으면 라벨. 화자가 없는 세그먼트는 null. */
export function speakerName(label: string | null | undefined, speakers: Speakers): string | null {
  if (!label) return null;
  return speakers[label]?.name?.trim() || label;
}

/** 화자 잉크(--spk-0…7) 수. 슬롯 8..15는 같은 잉크에 두 번째 표시(속 빈 점·빗금 막대)를 쓴다 (fluid 화자 분리는 9명 이상) */
export const SPEAKER_INKS = 8;
export const SPEAKER_SLOTS = SPEAKER_INKS * 2;
const labelNum = (label: string) => Number(/^S(\d+)$/.exec(label)?.[1] ?? NaN);

/** 색 슬롯 0..7. 라벨 번호로 정하므로 이름을 바꾸거나 다른 화자를 합쳐도 남은 화자의 색은 그대로다. 라벨이 아니면 -1(무채색). */
export function speakerSlot(label: string | null | undefined): number {
  const n = labelNum(label ?? "");
  return Number.isNaN(n) ? -1 : (((n - 1) % SPEAKER_INKS) + SPEAKER_INKS) % SPEAKER_INKS;
}

export interface SpeakerStat {
  label: string;
  display: string;
  segments: number;
  talkSec: number;
  /** 화자가 붙은 발화 시간 전체에 대한 비율 0..1 */
  share: number;
  /** 색 슬롯 0..15. 라벨 번호대로(speakerSlot) 두되, 이미 쓰인 슬롯이면 빈 슬롯(잉크 0..7 먼저, 다음 8..15)을 쓴다 (16명이 넘으면 겹친다) */
  slot: number;
  /** 목소리 제안. 이름을 붙인 화자는 null */
  suggested: Suggestion | null;
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
    suggested: suggestionOf(label, speakers),
  }));
}

/** 확정 전 제안만. 사용자가 이름을 붙였으면 제안은 없는 것으로 본다(코어도 rename 때 지운다) */
export function suggestionOf(label: string, speakers: Speakers): Suggestion | null {
  const sp = speakers[label];
  const s = sp?.suggested;
  return !sp?.name?.trim() && s && s.name?.trim() && Number.isFinite(s.score) ? s : null;
}

/** 배지 글: "홍길동? · 자동 인식 82%" */
export const suggestionText = (s: Suggestion) => `${s.name.trim()}? · 자동 인식 ${Math.round(Math.min(1, Math.max(0, s.score)) * 100)}%`;

export type RenameRequest = { name: string; remember: boolean } | { error: string };

/** 이름 바꾸기 폼 제출. '기억하기'는 이름과 동의 확인이 모두 있어야 한다 (생체정보, 개인정보보호법 제23조) */
export function renameRequest(raw: string, remember: boolean, consent: boolean): RenameRequest {
  const name = raw.trim();
  if (!remember) return { name, remember: false };
  if (!name) return { error: "목소리를 기억하려면 이름을 입력하세요" };
  if (!consent) return { error: "본인이거나 동의를 받은 사람인지 확인해 주세요" };
  return { name, remember: true };
}

export type RememberResult<M> =
  | { meeting: M; samples: number }
  | { meeting: M; voiceError: unknown } // 이름만 바꿨다
  | { voiceError: unknown; renameError: unknown };

/**
 * 이름 바꾸기 + 목소리 기억하기. 코어 `voices enroll`은 목소리를 못 구하면(모델 없음, 1.5초 이상 이어 말한 구간 없음,
 * voices.json 손상) 이름도 바꾸지 않고 멈춘다. 사용자가 입력한 이름은 잃지 않도록 이름만이라도 바꾼다
 */
export async function renameRemembering<M>(enroll: () => Promise<{ samples: number; meeting: M }>, rename: () => Promise<M>): Promise<RememberResult<M>> {
  try {
    const r = await enroll();
    return { meeting: r.meeting, samples: r.samples };
  } catch (voiceError) {
    try {
      return { meeting: await rename(), voiceError };
    } catch (renameError) {
      return { voiceError, renameError };
    }
  }
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
  voices: "목소리 맞춰 보는 중",
  encode: "오디오 보관 중",
  load_model: "모델 불러오는 중",
  transcribe: "전사 중",
  align: "단어 타이밍 맞추는 중",
  index: "검색 색인 중",
  summarize: "요약 중",
  // 앱 안 상태: 녹음 전사가 파일 가져오기가 끝나길 기다린다 (App.tsx waitDir)
  wait_import: "가져오는 파일이 끝나면 전사합니다",
  // 실시간 자막 (Phase 7.2, `tractus live`)
  live_load: "실시간 자막 준비 중",
  live: "실시간 자막",
};

/** 입력 중일 때는 단축키를 먹지 않는다: 글 입력, 세그먼트 편집(contentEditable), 재생 위치 막대(range, 방향키를 직접 쓴다). */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el.closest("[contenteditable]:not([contenteditable=false])") !== null || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
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
    default:
      // event 없는 줄(`tractus align`의 {"aligned": N, …} 결과)과 모르는 이벤트는 무시한다
      return s;
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

// ── 실시간 자막 (Phase 7.2, docs/desktop.md §2.8). 미리보기일 뿐 저장하지 않는다: 녹음이 끝나면 정식 전사가 다시 만든다 ──

export type LiveEvent =
  | { event: "stage"; stage: string }
  | { event: "live"; kind: "partial" | "final"; id: string; start: number; end: number; text: string }
  | { event: "warning"; code: string; message: string }
  | { event: "error"; message: string }
  | { event: "done" }
  | { event: "exit"; code: number | null; stderr: string };

export interface LiveLine {
  id: string;
  start: number;
  end: number;
  text: string;
}

/** off: 프로세스가 없다 (설정이 꺼져 있거나 아직 녹음 전). stopped: 정지 명령으로 끝남(done + exit 0). failed: 그 밖의 종료 */
export type LiveStatus = "off" | "loading" | "on" | "stopped" | "failed";

export interface LiveState {
  status: LiveStatus;
  finals: LiveLine[];
  /** 말하는 중인 발화. 같은 id의 다음 partial·final이 바꾼다 */
  partial: LiveLine | null;
  done: boolean;
  warnings: { code: string; message: string }[];
  error: string | null;
}

export const IDLE_LIVE: LiveState = { status: "off", finals: [], partial: null, done: false, warnings: [], error: null };

/** 화면에 남기는 확정 줄 수. 긴 회의에서 DOM이 끝없이 커지지 않게 (정식 전사는 녹음이 끝난 뒤에 따로 만든다) */
export const LIVE_CAP = 500;

const liveLine = ({ id, start, end, text }: LiveLine): LiveLine => ({ id, start, end, text });

export function liveReduce(s: LiveState, ev: LiveEvent): LiveState {
  switch (ev.event) {
    case "stage":
      return { ...s, status: ev.stage === "live" ? "on" : "loading" };
    case "live": {
      const line = liveLine(ev);
      if (ev.kind === "partial") return s.finals.some((f) => f.id === ev.id) ? s : { ...s, partial: line }; // 이미 확정된 발화의 늦은 partial
      // 빈 final은 "그 id의 줄을 지워라"다 (docs/desktop.md §2.8)
      const kept = s.finals.filter((f) => f.id !== ev.id);
      const finals = ev.text ? [...kept, line].sort((a, b) => a.start - b.start).slice(-LIVE_CAP) : kept;
      return { ...s, finals, partial: s.partial?.id === ev.id ? null : s.partial };
    }
    case "warning":
      return s.warnings.some((w) => w.code === ev.code) ? s : { ...s, warnings: [...s.warnings, { code: ev.code, message: ev.message }] };
    case "error":
      return { ...s, error: ev.message };
    case "done":
      return { ...s, done: true };
    case "exit": {
      // 확정되지 않은 partial은 버린다
      const ok = ev.code === 0 && s.done;
      // code null = 신호로 끝남 (kill -9, 메모리 부족으로 OS가 정리). stderr가 비면 코드 대신 사람이 읽을 말을 쓴다
      const fallback = ev.code === null ? "자막 프로세스가 종료되었습니다" : `종료 코드 ${ev.code}`;
      return { ...s, status: ok ? "stopped" : "failed", partial: null, error: ok ? s.error : (s.error ?? stderrTail(ev.stderr, fallback)) };
    }
    default:
      return s;
  }
}

/** "실시간 자막이 멈췄습니다" 안내를 띄울지. 앱은 녹음 단계를 벗어난 뒤에야 stop을 보내므로,
 *  녹음 중의 종료는 정상 종료(SIGTERM → done + exit 0)라도 예상 밖이다 */
export const liveHalted = (s: LiveState, recording: boolean) => recording && (s.status === "failed" || s.status === "stopped");

// ── Phase 5: 재생 컨트롤·편집·찾기·가져오기·내보내기 (docs/roadmap.md §2) ──

/** 표시 텍스트: 사용자가 고친 문장(corrected_text)이 있으면 그것, 없으면 원문. 코어 store.seg_text와 같다. */
export const segText = (s: Segment): string => s.corrected_text ?? s.text;

/** 재생 속도. 단축키 Shift+, / Shift+. 로 한 칸씩 (bbc/react-transcript-editor defaultHotKeys.js, MIT 참고) */
export const RATES = [0.8, 1, 1.2, 1.5, 1.8, 2];
export const SEEK_STEP = 5;
export const SEEK_STEP_BIG = 10;

/** 다음 속도. 목록에 없는 값이면 그 방향으로 가장 가까운 값, 끝이면 그대로. */
export function stepRate(rate: number, dir: 1 | -1): number {
  const next = dir > 0 ? RATES.find((r) => r > rate + 1e-9) : [...RATES].reverse().find((r) => r < rate - 1e-9);
  return next ?? (dir > 0 ? Math.max(rate, RATES[RATES.length - 1]) : Math.min(rate, RATES[0]));
}

/** localStorage에 남긴 속도. 목록에 있는 값만 받는다. */
export const parseRate = (raw: string | null): number => RATES.find((r) => String(r) === raw?.trim()) ?? 1;

export const SILENCE_GAP = 1.0;
export const SILENCE_LEAD = 0.2;

/**
 * 무음 건너뛰기: t가 발화 사이에 있고 다음 발화까지 1초 넘게 남았으면 다음 발화 0.2초 전 시각, 아니면 null.
 * segments에 한 화자의 세그먼트만 넘기면 '이 화자만 듣기'가 된다(다른 화자의 발화도 공백으로 본다).
 * ponytail: 세그먼트가 겹치지 않는다고 본다(코어가 시각 순으로 자른다). 겹치면 앞 세그먼트 중간에서 건너뛸 수 있다.
 */
export function silenceSkip(segments: Segment[], t: number): number | null {
  const i = segmentIndexAt(segments, t);
  if (i >= 0 && t < segments[i].end) return null;
  const next = segments[i + 1];
  return next && next.start - t > SILENCE_GAP ? next.start - SILENCE_LEAD : null;
}

/** `tractus segments <회의> edit` 한 건. text가 원문과 같으면 코어가 corrected_text를 해제한다. */
export type TextEdit = { id: string; text: string };

/**
 * 한 줄로: 코어 store.one_line과 같다. 공백·줄바꿈(파이썬 str.split 기준)은 한 칸으로, 앞뒤는 자르고, 제어 문자(C0·C1)는 뺀다.
 * 편집기 입력·낙관적 반영·원문 비교가 모두 이것을 써야 코어 결과와 어긋나지 않는다.
 */
export const oneLine = (s: string): string =>
  s
    .replace(/[\s\x1c-\x1f\x85]+/g, " ")
    .trim()
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "");

/** 편집을 낙관적으로 반영한 새 목록 (코어와 같은 규칙: 한 줄로 줄이고, 한 줄로 줄인 원문과 같으면 null). */
export function applyEdits(segments: Segment[], edits: TextEdit[]): Segment[] {
  const by = new Map(edits.map((e) => [e.id, oneLine(e.text)]));
  return segments.map((s) => {
    const text = by.get(s.id);
    return text === undefined ? s : { ...s, corrected_text: text === oneLine(s.text) ? null : text };
  });
}

/** 되돌리기 묶음: 편집 직전의 표시 텍스트. 원문이었으면 코어가 해제하므로 그대로 원래 상태가 된다. */
export function inverseEdits(segments: Segment[], edits: TextEdit[]): TextEdit[] {
  const by = new Map(segments.map((s) => [s.id, s]));
  return edits.flatMap((e) => {
    const s = by.get(e.id);
    return s ? [{ id: e.id, text: segText(s) }] : [];
  });
}

/**
 * 한글 조합 중인 키. 조합 중 Enter는 조합을 끝낼 뿐 저장하지 않는다. WebKit은 compositionend가 keydown보다
 * 먼저 와서 isComposing이 false인 keyCode 229 keydown이 온다 → 세 가지를 다 본다.
 */
export const isImeKey = (e: { isComposing?: boolean; keyCode?: number }, composing = false): boolean => composing || !!e.isComposing || e.keyCode === 229;

export interface Match {
  id: string;
  start: number;
  length: number;
}

const literal = (q: string) => new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");

/** 표시 텍스트에서 부분 문자열 찾기(대소문자 무시, 정규식 아님). 화자 이름은 찾지 않는다. */
export function findMatches(segments: Segment[], query: string): Match[] {
  if (!query) return [];
  const re = literal(query);
  return segments.flatMap((s) => [...segText(s).matchAll(re)].map((m) => ({ id: s.id, start: m.index, length: m[0].length })));
}

/**
 * 바꾸기 → 편집 묶음 하나 (anarlog session-correction.ts, MIT 참고). only가 있으면 그 위치 하나만.
 * 바꿔도 같거나 빈 문장이 되는 세그먼트는 뺀다(코어는 빈 문장을 거부하고, 그러면 묶음 전체가 실패한다).
 */
export function replaceEdits(segments: Segment[], query: string, replacement: string, only?: Match): TextEdit[] {
  if (!query) return [];
  return segments.flatMap((s) => {
    if (only && s.id !== only.id) return [];
    const before = segText(s);
    const text = before.replace(literal(query), (m, offset: number) => (!only || offset === only.start ? replacement : m));
    return oneLine(text) !== oneLine(before) && oneLine(text) ? [{ id: s.id, text }] : [];
  });
}

/** 가져올 수 있는 파일 (오디오·동영상). 대소문자 무시. 코어가 ffmpeg로 읽는다 */
export const IMPORT_EXTS = ["m4a", "mp3", "wav", "aac", "flac", "ogg", "opus", "webm", "mp4", "mov", "m4v"];
export const baseName = (path: string): string => path.split("/").pop() ?? path;
export function isImportable(path: string): boolean {
  const m = /^[^.].*\.([^.]+)$/.exec(baseName(path));
  return !!m && IMPORT_EXTS.includes(m[1].toLowerCase());
}

/** `tractus export --format`. bundle은 회의 폴더 묶음(zip) */
export const EXPORT_FORMATS: { format: string; ext: string; label: string; note: string }[] = [
  { format: "txt", ext: "txt", label: "텍스트", note: "[시각] 화자: 문장" },
  { format: "md", ext: "md", label: "Markdown", note: "전사 + 요약" },
  { format: "srt", ext: "srt", label: "SRT 자막", note: "영상 편집기" },
  { format: "vtt", ext: "vtt", label: "WebVTT 자막", note: "브라우저·Obsidian" },
  { format: "csv", ext: "csv", label: "CSV", note: "Excel" },
  { format: "docx", ext: "docx", label: "Word", note: "Word·Pages" },
  { format: "bundle", ext: "zip", label: "묶음", note: "오디오·전사·요약 zip" },
];

/** 저장 대화상자 기본 이름: <날짜>_<제목>.<확장자>. 파일 이름에 못 쓰는 문자는 공백으로. */
export function exportFilename(createdAt: string, title: string, ext: string): string {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(createdAt)?.[0] ?? "회의";
  const clean = title.replace(/[/\\:*?"<>|\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${day}_${clean || "제목 없음"}.${ext}`;
}

export interface SummaryLike {
  summary: string;
  topics: { title: string; segment_ids: string[] }[];
  decisions: { text: string; segment_ids: string[] }[];
  action_items: { task: string; owner: string | null; due: string | null; segment_ids: string[] }[];
}

/** '요약 복사' 마크다운. 결정 사항에는 근거 시각을 붙인다. */
export function summaryMarkdown(s: SummaryLike, starts: Map<string, number>): string {
  const at = (ids: string[]) => {
    const t = evidenceStart(ids, starts);
    return t === null ? "" : ` (${fmtTime(t)})`;
  };
  const section = (title: string, lines: string[]) => (lines.length ? [`## ${title}`, "", ...lines, ""] : []);
  return [
    ...section("요약", [s.summary]),
    ...section("결정 사항", s.decisions.map((d) => `- ${d.text}${at(d.segment_ids)}`)),
    ...section("할 일", s.action_items.map((a) => `- [ ] ${a.task}${a.owner || a.due ? ` — ${[a.owner, a.due].filter(Boolean).join(", ")}` : ""}${at(a.segment_ids)}`)),
    ...section("주제", s.topics.map((t) => `- ${t.title}${at(t.segment_ids)}`)),
  ].join("\n");
}
