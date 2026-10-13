// 메모 노트(녹음 없이 직접 쓴 글)와 노트 제목 수정의 순수 로직. 화면은 MemoView.tsx·MeetingView.tsx. 전부 memo.test.ts에서 검사한다.
import { EXPORT_FORMATS, fmtTime, isMemoLineId, oneLine, parseHms, segText, type NoteMemo, type Segment } from "./lib";

// ── 제목 ──

export const TITLE_MAX = 120;
export const TITLE_EMPTY = "제목을 입력하세요.";
export const TITLE_TOO_LONG = `제목은 ${TITLE_MAX}자까지 쓸 수 있습니다.`;

export type TitleCheck = { ok: true; title: string } | { ok: false; error: string };

/** 코어 `note title`과 같은 규칙: 공백·줄바꿈은 한 칸으로 줄이고 앞뒤를 자른다. 1~120자(글자 단위, 이모지 하나가 한 글자) */
export function checkTitle(raw: string): TitleCheck {
  const title = oneLine(raw);
  if (!title) return { ok: false, error: TITLE_EMPTY };
  if ([...title].length > TITLE_MAX) return { ok: false, error: TITLE_TOO_LONG };
  return { ok: true, title };
}

// ── 목록 ──

export type NoteKind = "recording" | "memo";

/** 코어 transcript.json의 kind는 없으면 녹음이다. 모르는 값도 녹음으로 본다 (Rust meetings::kind_of와 같다) */
export const kindOf = (m: { kind?: string | null }): NoteKind => (m.kind === "memo" ? "memo" : "recording");
export const isMemo = (m: { kind?: string | null }): boolean => kindOf(m) === "memo";

/** 사이드바 줄 아래 칸: 녹음은 길이, 메모는 만든 시각(길이가 없다) */
export function noteTime(m: { kind?: string | null; duration_sec: number; created_at: string }): string {
  if (!isMemo(m)) return fmtTime(m.duration_sec);
  return /T(\d{2}:\d{2})/.exec(m.created_at)?.[1] ?? "";
}

/** 내보내기 메뉴 형식. 메모는 시각이 없어 SRT·WebVTT 자막은 없다 (코어도 거절한다) */
export function exportFormatsFor(memo: boolean): typeof EXPORT_FORMATS {
  if (!memo) return EXPORT_FORMATS;
  const note: Record<string, string> = { txt: "메모 본문", md: "메모 + 요약", bundle: "메모 내용 + 요약" };
  return EXPORT_FORMATS.filter((f) => f.format !== "srt" && f.format !== "vtt").map((f) => ({ ...f, note: note[f.format] ?? f.note }));
}

// ── 줄 ──

/** 메모의 대화(줄)는 비어 있지 않은 줄 하나씩이다. i번째 줄이 본문의 몇 번째 줄이고 어디서 어디까지인지 */
export interface LineSpan {
  /** 본문 안의 1부터 세는 줄 번호 (빈 줄 포함). 인용 칩 `n번째 줄` */
  line: number;
  start: number;
  end: number;
}

export function lineSpans(body: string): LineSpan[] {
  const out: LineSpan[] = [];
  let at = 0;
  body.split("\n").forEach((text, i) => {
    if (text.trim()) out.push({ line: i + 1, start: at, end: at + text.length });
    at += text.length + 1;
  });
  return out;
}

/** 대화 id → 줄. 저장된 본문과 대화가 어긋나면(저장 중) 글이 같은 줄만 잇는다 */
export function segmentSpans(body: string, segments: Segment[]): Map<string, LineSpan> {
  const spans = lineSpans(body);
  const out = new Map<string, LineSpan>();
  segments.forEach((s, i) => {
    const sp = spans[i];
    if (sp && body.slice(sp.start, sp.end).trim() === segText(s).trim()) out.set(s.id, sp);
  });
  return out;
}

/** 인용·검색 결과가 가리키는 줄의 글자 범위. 현재 본문(text)에서 찾고, 못 찾으면 null */
export function citedRange(text: string, body: string, segments: Segment[], segId: string): { start: number; end: number } | null {
  const seg = segments.find((s) => s.id === segId);
  const sp = segmentSpans(body, segments).get(segId);
  if (sp && text === body) return sp;
  const want = seg && segText(seg).trim();
  if (!want) return null;
  const at = text.indexOf(want);
  return at < 0 ? null : { start: at, end: at + want.length };
}

// ── 녹음 노트의 메모 (오른쪽 패널의 메모 탭) ──

/** 메모의 줄을 대화 모양으로: 줄 위치 계산(`segmentSpans`·`citedRange`)이 메모 노트와 같은 코드로 돈다 */
export const memoLineSegments = (memo: NoteMemo | null | undefined): Segment[] =>
  (memo?.lines ?? []).map((l) => ({ id: l.id, start: 0, end: 0, text: l.text, line: l.line }));

/** 줄 ID → 본문의 줄 번호 (요약·질문의 칩 `메모 3번째 줄`) */
export const memoLineNumbers = (memo: NoteMemo | null | undefined): Map<string, number> => new Map((memo?.lines ?? []).map((l) => [l.id, l.line]));

/** 노트를 마지막으로 고친 것이 무엇인가. 요약이 낡았다는 안내 문장이 이것으로 정해진다 */
export type EditKind = "text" | "memo";

/** 요약을 만든 뒤 고친 것들 → `대화 내용을 수정했습니다` / `메모를 수정했습니다` / 둘 다 (WORDS.md §4.10) */
export function staleSentence(kinds: EditKind[]): string {
  const text = kinds.includes("text");
  const memo = kinds.includes("memo");
  return `${text && memo ? "대화 내용과 메모를" : memo ? "메모를" : "대화 내용을"} 수정했습니다`;
}

/** 검색 결과의 한 줄 (코어 search_meetings 세그먼트). 녹음 노트의 메모 줄은 id가 `m0003`이고 source가 "memo" */
export interface HitSegment {
  id: string;
  time: string;
  text: string;
  source?: string;
  line?: number;
}

export interface HitView {
  /** 메모 줄이다 (메모 노트의 줄이거나 녹음 노트의 메모 줄): 시각이 없다 */
  memo: boolean;
  /** 녹음 노트의 메모 줄: 결과 줄에 작은 `메모` 표시를 붙인다 (메모 노트는 노트 전체가 메모라 머리에 있다) */
  tagged: boolean;
  /** 결과 줄의 시각 칸: 시각(`5:31`) 또는 `3번째 줄` */
  label: string;
  /** 노트를 열 때 넘기는 위치. 메모 줄은 시각이 없다 */
  seek: { segId: string; t: number };
}

/** 검색 결과 한 줄이 어디를 가리키고 어떻게 보이는가. 코어의 `line`을 먼저 보고, 없으면 시각 칸의 `n번째 줄`을 쓴다 */
export function hitView(s: HitSegment, memoNote: boolean): HitView {
  const tagged = s.source === "memo" || isMemoLineId(s.id);
  const memo = memoNote || tagged;
  if (!memo) return { memo, tagged, label: fmtTime(parseHms(s.time)), seek: { segId: s.id, t: parseHms(s.time) } };
  const line = s.line ?? /^(?:메모 )?(\d+)번째 줄$/.exec(s.time)?.[1];
  return { memo, tagged, label: line ? `${line}번째 줄` : "메모", seek: { segId: s.id, t: 0 } };
}

// ── 자동 저장 ──

/** 마지막으로 쓴 뒤 이만큼 조용하면 저장한다 */
export const AUTOSAVE_MS = 1200;

export type SaveStatus = "saved" | "dirty" | "saving" | "failed";
export interface SaveState {
  status: SaveStatus;
  /** failed일 때 마지막 오류 */
  error?: unknown;
}

export interface AutosaveDeps {
  /** 저장 한 번. 실패하면 던진다 (노트별 줄에 세우는 것은 부르는 쪽이 한다) */
  save: (body: string) => Promise<void>;
  /** 처음 디스크에 있는 본문 */
  initial: string;
  onState: (s: SaveState) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  debounceMs?: number;
}

export interface Autosave {
  /** 본문이 바뀌었다 (마지막 입력에서 1.2초 뒤 저장) */
  change: (body: string) => void;
  /** 지금 저장한다. 앞선 저장이 돌고 있으면 기다린다. 모두 저장됐으면 true, 실패하면 false(글은 그대로 남는다) */
  flush: () => Promise<boolean>;
  /** 저장하지 않은 글이 있는가 */
  isDirty: () => boolean;
  /** 더는 저장하지 않는다 (노트를 지울 때) */
  dispose: () => void;
}

/**
 * 한 번에 하나만 저장하고, 저장하는 동안 쓴 글은 끝난 뒤 이어서 저장한다. 실패하면 글을 dirty로 두고 스스로 다시 두드리지 않는다:
 * 다음 입력(change)이나 flush(포커스 나감·이동·⌘S)가 다시 시도한다. 저장한 적 없는 글을 버리지 않는다.
 */
export function createAutosave(deps: AutosaveDeps): Autosave {
  const wait = deps.debounceMs ?? AUTOSAVE_MS;
  let latest = deps.initial;
  let saved = deps.initial;
  let timer: unknown = null;
  let inflight: Promise<void> | null = null;
  let failed: { error: unknown } | null = null;
  let disposed = false;

  const state = (): SaveState => (inflight ? { status: "saving" } : failed ? { status: "failed", error: failed.error } : { status: latest !== saved ? "dirty" : "saved" });
  const emit = () => !disposed && deps.onState(state());
  const disarm = () => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  };
  const arm = () => {
    disarm();
    timer = deps.setTimer(() => {
      timer = null;
      void saveOnce();
    }, wait);
  };

  function saveOnce(): Promise<void> {
    if (inflight) return inflight;
    if (disposed || latest === saved) return Promise.resolve();
    const body = latest;
    failed = null;
    inflight = deps
      .save(body)
      .then(
        () => void (saved = body),
        (error) => void (failed = { error }),
      )
      .then(() => {
        inflight = null;
        if (latest === saved) failed = null; // 저장하는 동안 저장된 글로 되돌렸다
        emit();
        // 저장하는 동안 더 썼으면 이어서 (실패했으면 두드리지 않는다)
        if (!failed && latest !== saved && !disposed) arm();
      });
    emit();
    return inflight;
  }

  return {
    change(body) {
      if (disposed) return;
      latest = body;
      if (latest === saved) failed = null;
      if (inflight) return; // 저장 중이면 끝난 뒤 이어서 저장한다 (saveOnce의 then)
      emit();
      if (latest === saved) disarm();
      else arm();
    },
    async flush() {
      disarm();
      for (;;) {
        await saveOnce();
        if (failed || latest === saved || disposed) return latest === saved;
        disarm();
      }
    },
    isDirty: () => latest !== saved,
    dispose() {
      disposed = true;
      disarm();
    },
  };
}

// ── 앱 전체: 열려 있는 메모의 저장 (화면 이동·창 닫기 전에 저장을 마친다) ──

interface Open {
  flush: () => Promise<boolean>;
  drop: () => void;
}
const open = new Map<string, Open>();

/** 열린 메모를 등록한다. 돌려주는 함수로 해제 */
export function registerMemo(id: string, h: Open): () => void {
  open.set(id, h);
  return () => void (open.get(id) === h && open.delete(id));
}

/** 열린 메모를 모두 저장한다. 하나라도 실패하면 false (그 메모가 오류를 이미 보여 준다) */
export async function flushMemos(): Promise<boolean> {
  const results = await Promise.all([...open.values()].map((h) => h.flush()));
  return results.every(Boolean);
}

/** 노트를 삭제하기 전: 마지막으로 저장해 둔다(휴지통에서 되살려도 최신 글이 있게). 편집기는 그대로 둔다: 삭제가 실패해도 계속 저장된다 */
export async function settleMemo(id: string): Promise<void> {
  await open.get(id)?.flush();
}

/** 삭제가 끝난 뒤: 이 메모는 더 저장하지 않는다 (지워진 폴더에 저장하지 않게) */
export function dropMemo(id: string): void {
  open.get(id)?.drop();
}

/** 저장 실패 알림에 쓰는 문장 */
export const SAVE_FAILED = "저장하지 못했습니다";
export const SAVE_STATUS: Record<SaveStatus, string> = { saved: "저장됨", dirty: "", saving: "저장 중…", failed: SAVE_FAILED };
