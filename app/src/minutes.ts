// 회의록 탭의 데이터와 칸 고치기 (docs/design/meeting-minutes.md). 화면과 무관한 순수 함수라 minutes.test.ts에서 검사한다.
// 그리기(위키용 Markdown·짧은 판)는 코어가 한다: `tractus minutes <노트> show|save`가 돌려주는 값을 그대로 쓴다.
import { t } from "./i18n";

export const MINUTES_KEY = "minutes";
export const MINUTES_NAME = t("회의록"); // words-ok: 회의록은 문서 이름 (WORDS.md §1)

export interface MLine {
  text: string;
  segment_ids: string[];
  /** 근거 문장에 없는 숫자 (`숫자 확인`) */
  unverified?: string[];
}
export interface MDetail extends MLine {
  children: MLine[];
}
export interface MPoint {
  label: string;
  details: MDetail[];
}
export interface MTopic {
  title: string;
  open: boolean;
  discussed: MLine[];
  agreed: MLine[];
  points: MPoint[];
  approach: MLine[];
}
export interface MAction extends MLine {
  team: string | null;
  owner: string | null;
  due: string | null;
  note: string | null;
}
export interface Minutes {
  agenda: string;
  topics: MTopic[];
  actions: MAction[];
  next_meeting: MLine[];
}
export interface MinutesShown {
  minutes: Minutes;
  attendees: string[];
  title: string;
  generated_at: string | null;
  edited_at: string | null;
  markdown: string;
  short: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
const arr = (v: unknown) => (Array.isArray(v) ? v : []);

function line(v: unknown): MLine | null {
  if (!isObj(v) || typeof v.text !== "string") return null;
  const ids = arr(v.segment_ids).filter((x): x is string => typeof x === "string");
  const nums = arr(v.unverified).filter((x): x is string => typeof x === "string");
  return { text: v.text, segment_ids: ids, ...(nums.length ? { unverified: nums } : {}) };
}
const lines = (v: unknown): MLine[] => arr(v).map(line).filter((x): x is MLine => x !== null);

/** `minutes show`의 응답. 회의록이 없거나 모양이 틀리면 null */
export function parseShown(raw: unknown): MinutesShown | null {
  if (!isObj(raw) || !isObj(raw.minutes)) return null;
  const m = raw.minutes;
  return {
    minutes: {
      agenda: str(m.agenda),
      topics: arr(m.topics).filter(isObj).map((tp) => ({
        title: str(tp.title),
        open: tp.open === true,
        discussed: lines(tp.discussed),
        agreed: lines(tp.agreed),
        points: arr(tp.points).filter(isObj).map((p) => ({
          label: str(p.label),
          details: arr(p.details).filter(isObj).map((d) => ({ ...(line(d) ?? { text: "", segment_ids: [] }), children: lines(d.children) })),
        })),
        approach: lines(tp.approach),
      })),
      actions: arr(m.actions).filter(isObj).map((a) => ({ ...(line(a) ?? { text: "", segment_ids: [] }), team: strOrNull(a.team), owner: strOrNull(a.owner), due: strOrNull(a.due), note: strOrNull(a.note) })),
      next_meeting: lines(m.next_meeting),
    },
    attendees: arr(raw.attendees).filter((x): x is string => typeof x === "string"),
    title: str(raw.title),
    generated_at: strOrNull(raw.generated_at),
    edited_at: strOrNull(raw.edited_at),
    markdown: str(raw.markdown),
    short: str(raw.short),
  };
}

/** 고칠 수 있는 줄의 자리. 비운 줄은 코어가 지운다 */
export type LinePath =
  | { kind: "agenda" }
  | { kind: "title"; topic: number }
  | { kind: "discussed" | "agreed" | "approach"; topic: number; i: number }
  | { kind: "detail"; topic: number; point: number; i: number }
  | { kind: "child"; topic: number; point: number; i: number; child: number }
  | { kind: "action"; i: number }
  | { kind: "next"; i: number };

const withText = <T extends MLine>(x: T, text: string): T => ({ ...x, text });
const replaceAt = <T>(xs: T[], i: number, f: (x: T) => T): T[] => xs.map((x, n) => (n === i ? f(x) : x));

/** 줄 하나의 글을 바꾼 새 회의록 (원본은 그대로) */
export function setLine(m: Minutes, p: LinePath, text: string): Minutes {
  const topic = (i: number, f: (tp: MTopic) => MTopic) => ({ ...m, topics: replaceAt(m.topics, i, f) });
  switch (p.kind) {
    case "agenda":
      return { ...m, agenda: text };
    case "title":
      return topic(p.topic, (tp) => ({ ...tp, title: text }));
    case "discussed":
    case "agreed":
    case "approach":
      return topic(p.topic, (tp) => ({ ...tp, [p.kind]: replaceAt(tp[p.kind], p.i, (x) => withText(x, text)) }));
    case "detail":
      return topic(p.topic, (tp) => ({ ...tp, points: replaceAt(tp.points, p.point, (pt) => ({ ...pt, details: replaceAt(pt.details, p.i, (d) => withText(d, text)) })) }));
    case "child":
      return topic(p.topic, (tp) => ({
        ...tp,
        points: replaceAt(tp.points, p.point, (pt) => ({ ...pt, details: replaceAt(pt.details, p.i, (d) => ({ ...d, children: replaceAt(d.children, p.child, (c) => withText(c, text)) })) })),
      }));
    case "action":
      return { ...m, actions: replaceAt(m.actions, p.i, (a) => withText(a, text)) };
    case "next":
      return { ...m, next_meeting: replaceAt(m.next_meeting, p.i, (x) => withText(x, text)) };
  }
}

/** 할 일의 담당·기한 칸을 바꾼 새 회의록. 담당 칸은 사람이 쓴 그대로 owner에 두고 팀 칸은 비운다(한 칸으로 보이므로) */
export function setActionField(m: Minutes, i: number, field: "who" | "due", value: string): Minutes {
  const v = value.trim() || null;
  return { ...m, actions: replaceAt(m.actions, i, (a) => (field === "who" ? { ...a, owner: v, team: null } : { ...a, due: v })) };
}

/** 할 일의 담당 칸 글자: 팀 · 이름 (코어 minutes._who와 같다). 없으면 빈 문자열 */
export const whoOf = (a: MAction) => [a.team, a.owner].filter(Boolean).join(" · ");

/** 담당·기한이 빈 할 일 수 (`담당 미정`·`기한 미정` 강조) */
export const missing = (m: Minutes) => m.actions.filter((a) => !whoOf(a) || !a.due).length;
