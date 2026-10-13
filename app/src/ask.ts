// 회의 질의 (docs/roadmap.md §3 6.3): `tractus ask --progress-json` 이벤트 → 화면 상태, 인용 파싱, 대화 기록, 전송 안내.
// 화면과 무관한 순수 로직. 전부 ask.test.ts에서 검사한다.
import { exitMessage, exitSentence, fmtTime, isMemoLineId, JOB_ERROR, warningText } from "./lib";

/** sources 이벤트 항목: 프롬프트에 넣은 근거 세그먼트 */
export interface AskSource {
  meeting_id: string;
  title: string;
  date: string;
  segment_id: string;
  speaker: string | null;
  start: number;
  text: string;
  /** 메모 노트의 근거: 본문의 줄 번호 (start는 0) */
  line?: number;
  /** "memo": 녹음 노트에 사용자가 적은 메모의 줄 (segment_id는 `m0003`, start는 0) */
  source?: string;
}

/** done의 citations: 답에 나오고 sources에도 있던 인용만 (코어가 거른다) */
export interface Citation {
  meeting_id: string;
  segment_id: string;
  start: number;
  /** 메모 노트의 인용: 본문의 줄 번호 (start는 0) */
  line?: number;
  /** "memo": 녹음 노트에 사용자가 적은 메모의 줄 (segment_id는 `m0003`) */
  source?: string;
}

export type AskEvent =
  | { job: string; event: "stage"; stage: string }
  | { job: string; event: "sources"; sources: AskSource[] }
  | { job: string; event: "delta"; text: string }
  | { job: string; event: "done"; answer: string; citations: Citation[]; provider: string; model: string }
  | { job: string; event: "error"; message: string; code?: string }
  /** chat_save_failed: --save 저장 실패 (done 앞에 온다). 답은 그대로 나온다 */
  | { job: string; event: "warning"; code: string; message: string }
  | { job: string; event: "exit"; code: number | null; stderr: string };

export type AskPhase = "starting" | "retrieve" | "answer" | "done" | "error" | "cancelled";

export interface AskState {
  phase: AskPhase;
  sources: AskSource[];
  /** 스트리밍 중에는 delta를 이어 붙인 것, done 뒤에는 코어가 후처리한 답 */
  answer: string;
  citations: Citation[];
  provider: string | null;
  model: string | null;
  /** 코어 원래 문구 (화면에는 lib.errorView로) */
  error: string | null;
  errorCode: string | null;
  /** 끝나지 않는 경고의 화면 문장 (예: 기록 저장 실패) */
  warning: string | null;
}

export const START_ASK: AskState = { phase: "starting", sources: [], answer: "", citations: [], provider: null, model: null, error: null, errorCode: null, warning: null };

export const isAsking = (s: AskState): boolean => s.phase === "starting" || s.phase === "retrieve" || s.phase === "answer";

/**
 * 성공은 done, 그 밖의 exit는 오류다. 끝난 턴에는 경고만 받는다 (저장 실패 경고는 done 앞에 오지만 어느 단계에서 와도 받는다).
 * 멈춘 턴에 늦게 온 done은 받는다: 코어는 done보다 먼저 chat.json에 저장하므로 화면도 저장된 답과 맞춘다
 */
export function askReduce(s: AskState, ev: AskEvent): AskState {
  if (ev.event === "warning") return { ...s, warning: warningText(ev) };
  if (s.phase === "cancelled" && ev.event === "done") return askReduce({ ...s, phase: "answer" }, ev);
  if (!isAsking(s)) return s;
  switch (ev.event) {
    case "stage":
      return ev.stage === "retrieve" || ev.stage === "answer" ? { ...s, phase: ev.stage } : s;
    case "sources":
      return { ...s, sources: ev.sources };
    case "delta":
      return { ...s, phase: "answer", answer: s.answer + ev.text };
    case "done":
      return { ...s, phase: "done", answer: ev.answer, citations: ev.citations, provider: ev.provider, model: ev.model };
    case "error":
      return { ...s, phase: "error", error: ev.message, errorCode: ev.code ?? null };
    case "exit":
      return { ...s, phase: "error", error: exitMessage(exitSentence(JOB_ERROR.ask, ev.code), ev.stderr) };
    default:
      return s; // 모르는 이벤트 (코어가 먼저 새 이벤트를 낼 수 있다)
  }
}

// ── 인용: [s0012] (노트 범위), [<26자 meeting_id>#s0012] (전체 범위). 녹음 노트의 메모 줄은 [m0003]. 한 괄호에 쉼표로 여럿도 받는다 ──

export type AnswerPart = { kind: "text"; text: string } | { kind: "cite"; meetingId: string | null; segId: string };

const ONE = String.raw`(?:[0-9A-Za-z]{26}#)?[sm]\d{4,}`;
const GROUP = new RegExp(String.raw`\[(${ONE}(?:\s*,\s*${ONE})*)\]`, "g");

/** 스트리밍 중 끝에 덜 온 인용 ("[s00", "[01K…#s0"). 내부 ID가 잠깐이라도 보이지 않게 뗀다 */
const PARTIAL = /\[(?:[0-9A-Za-z]{0,26}#?[sm]?\d*\s*,\s*)*[0-9A-Za-z]{0,26}#?[sm]?\d*$/;

/** 답 → 글과 인용 칩. 다른 대괄호는 글 그대로, 끝에 덜 온 인용은 뗀다 */
export function answerParts(raw: string): AnswerPart[] {
  const text = raw.replace(PARTIAL, "");
  const parts: AnswerPart[] = [];
  let last = 0;
  for (const m of text.matchAll(GROUP)) {
    if (m.index > last) parts.push({ kind: "text", text: text.slice(last, m.index) });
    for (const one of m[1].split(",")) {
      const [a, b] = one.trim().split("#");
      parts.push(b === undefined ? { kind: "cite", meetingId: null, segId: a } : { kind: "cite", meetingId: a, segId: b });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

/**
 * 인용 칩이 이동할 곳. meetingId: 회의 범위 질문의 회의(전체 범위면 없음).
 * done의 citations(시각 포함) → sources → 회의 세그먼트(starts) 순으로 찾는다. 못 찾으면 null(칩 대신 글자)
 */
export function citeTarget(
  cite: { meetingId: string | null; segId: string },
  ctx: { meetingId?: string; citations: Citation[]; sources: AskSource[]; starts?: Map<string, number> },
): { meetingId: string; segId: string; t: number; line?: number } | null {
  const meetingId = cite.meetingId ?? ctx.meetingId;
  if (!meetingId) return null;
  const hit = [...ctx.citations, ...ctx.sources].find((c) => c.meeting_id === meetingId && c.segment_id === cite.segId);
  // 녹음 노트 메모의 줄(m0003)은 시각이 없다: 시각 0으로 두고 줄로 간다
  const t = hit?.start ?? (meetingId === ctx.meetingId ? ctx.starts?.get(cite.segId) : undefined) ?? (isMemoLineId(cite.segId) && hit ? 0 : undefined);
  return t === undefined ? null : { meetingId, segId: cite.segId, t, line: hit?.line };
}

/**
 * 인용 칩 글자. 녹음은 시각(`5:31`), 전체 범위에서는 날짜도(`10/2 5:31`).
 * 메모는 시각이 없다: 줄을 알면 `3번째 줄`, 모르면 `메모`. 전체 범위에서는 날짜도(`10/13 3번째 줄`) (WORDS.md §4.5)
 */
export function citeLabel(t: number, o: { date?: string; memo?: boolean; line?: number; tagged?: boolean } = {}): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(o.date ?? "");
  const day = m ? `${Number(m[1])}/${Number(m[2])} ` : "";
  if (!o.memo) return `${day}${fmtTime(t)}`;
  // tagged: 녹음 노트의 메모 줄. 같은 노트의 시각 칩과 섞여 보이므로 `메모`를 앞에 붙인다 (메모 노트는 모두 메모라 붙이지 않는다)
  const where = o.line ? `${o.line}번째 줄` : "메모";
  return `${day}${o.tagged && o.line ? `메모 ${where}` : where}`;
}

/** 녹음 노트에 사용자가 적은 메모의 줄인가 (`source: "memo"` 또는 `m0003`). 칩 글자에 `메모`를 붙이는 쪽 */
export const isTaggedMemo = (c: { segment_id: string; source?: string }): boolean => c.source === "memo" || isMemoLineId(c.segment_id);

/** 인용·출처가 메모의 줄인가: 녹음 노트의 메모 줄이거나 메모 노트의 줄. memoNote: 그 인용이 가리키는 노트가 메모 노트인가 */
export const isMemoCite = (c: { segment_id: string; source?: string }, memoNote: boolean): boolean => memoNote || isTaggedMemo(c);

/**
 * 인용이 가리키는 노트가 지금 노트 목록에 없는가 (삭제되었다). `known`은 앱이 읽은 노트 ID 목록이고, 아직 못 읽었으면 null → 판단하지 않는다.
 * 전체 범위 질문은 답을 쓰는 동안 노트가 삭제될 수 있다: 칩은 오류 없이 눌러도 아무 일도 하지 않게 하고 이유를 보여 준다
 */
export const isNoteGone = (known: ReadonlySet<string> | null | undefined, meetingId: string): boolean => !!known && !known.has(meetingId);

// ── 대화 기록: stdin의 history. 코어도 자르지만 보내는 양을 줄이려고 앱에서도 자른다 ──

export type ChatMessage = { role: "user" | "assistant"; content: string };
export const HISTORY_TURNS = 6; // 메시지 6개 (질문·답 3쌍)
export const HISTORY_CHARS = 12_000;

/** 마지막 6개, 합이 12k자를 넘으면 오래된 것부터 버린다. 맨 앞은 질문이어야 한다 */
export function trimHistory(msgs: ChatMessage[]): ChatMessage[] {
  let out = msgs.slice(-HISTORY_TURNS);
  const size = (m: ChatMessage[]) => m.reduce((n, x) => n + x.content.length, 0);
  while (out.length && (size(out) > HISTORY_CHARS || out[0].role !== "user")) out = out.slice(1);
  return out;
}

/** chat.json 항목 (Rust meetings::ChatEntry) → 질문·답 메시지 */
export const historyFromEntries = (entries: { question: string; answer: string }[]): ChatMessage[] =>
  entries.flatMap((e) => [
    { role: "user" as const, content: e.question },
    { role: "assistant" as const, content: e.answer },
  ]);

/** 화면의 턴 중 답을 끝낸 것만 기록으로 */
export const turnsHistory = (turns: { question: string; state: AskState }[]): ChatMessage[] =>
  historyFromEntries(turns.filter((t) => t.state.phase === "done").map((t) => ({ question: t.question, answer: t.state.answer })));

// ── 전송 안내: 어디로 무엇이 가는지 보내기 전에 알린다 (코어 llm.PROVIDERS와 같은 표) ──

export interface LlmConfig {
  provider: string | null;
  model: string | null;
  local_only: boolean;
}

const PROVIDERS: Record<string, { label: string; model: string | null; local?: boolean }> = {
  upstage: { label: "Upstage", model: "solar-pro4" },
  openai: { label: "OpenAI", model: null },
  claude: { label: "Anthropic", model: "claude-sonnet-5-5" },
  gemini: { label: "Google Gemini", model: null },
  "gemma-local": { label: "이 Mac의 AI", model: "gemma4:31b", local: true },
};

/** 화면에 보일 AI 서비스 이름 (요약 바닥글·답한 AI). 모르는 값은 그대로 */
export const providerLabel = (provider: string): string => PROVIDERS[provider]?.label ?? provider;

/** 끝난 턴에 실제로 답한 곳 ("Upstage(solar-pro4)"). 근거도 인용도 없으면 LLM을 부르지 않았을 수 있어 보이지 않는다 */
export function answeredBy(s: AskState): string | null {
  if (s.phase !== "done" || !s.provider || (s.sources.length === 0 && s.citations.length === 0)) return null;
  const p = PROVIDERS[s.provider];
  const name = p?.local ? "이 Mac의 AI" : (p?.label ?? s.provider);
  return s.model ? `${name}(${s.model})` : name;
}

export function sendNotice(c: LlmConfig): { text: string; warn: boolean } {
  if (!c.provider) return { text: "AI 서비스가 설정되지 않았습니다. .env.local에 TRACTUS_LLM_PROVIDER를 지정하세요", warn: true };
  const p = PROVIDERS[c.provider];
  if (!p) return { text: `알 수 없는 AI 서비스입니다: ${c.provider}`, warn: true };
  if (c.local_only && !p.local) return { text: `로컬 전용 모드(TRACTUS_LOCAL_ONLY)라 외부 AI 서비스(${p.label})로 보내지 않습니다`, warn: true };
  const model = c.model || p.model;
  if (!model) return { text: `사용할 ${p.label} AI 모델을 지정하세요 (TRACTUS_LLM_MODEL)`, warn: true };
  return p.local
    ? { text: `질문과 관련 대화 일부를 이 Mac의 AI(${model})가 처리합니다`, warn: false }
    : { text: `질문과 관련 대화 일부가 ${p.label}(${model})로 전송됩니다`, warn: false };
}
