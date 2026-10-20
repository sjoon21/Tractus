// 요약 유형과 한 노트의 여러 요약 (docs/desktop.md §2.13). 화면이 쓰는 순수 로직: 파일 → 화면 모델, 순서, 복사 마크다운, 유형 고르기, 직접 요약 입력 검사.
// 렌더링은 SummariesPanel.tsx, 대기열은 summaryQueue.ts. 옛 요약(summary.json의 결정 사항·할 일·주제)은 `legacy`로 그대로 두고 화면·복사·인쇄가 옛 경로를 쓴다.
import { t } from "./i18n";
import { evidenceLabel, summaryMarkdown, type SummaryLike } from "./lib";

/** 기본 요약(summary.json)의 key와 이름 */
export const DEFAULT_KEY = "meeting";
export const DEFAULT_NAME = t("회의록"); // words-ok: 회의록은 요약 유형(문서)의 이름이다
export const CUSTOM_NAME = t("직접 요약");
export const MAX_PROMPT = 4000;
export const MAX_NAME = 40;
export const MAX_DESC = 100;

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  /** 요약 방법 본문 */
  prompt: string;
  builtin: boolean;
}

export type SectionStyle = "bullets" | "checklist" | "numbered";

export interface SummaryItem {
  text: string;
  segment_ids: string[];
  owner: string | null;
  due: string | null;
}

/** 노트 완성(kind "enhanced")의 섹션 종류: 내 메모 한 줄 | 메모에 없던 내용 | 할 일 */
export type SectionPart = "memo" | "extra" | "todos";

export interface SummarySection {
  heading: string;
  style: SectionStyle;
  items: SummaryItem[];
  /** 노트 완성에만 있다 (다른 요약은 undefined) */
  part?: SectionPart;
  /** 내 메모 줄 ID: m0003(메모 탭) | r0002(녹음 중 메모·북마크). 노트 완성의 memo 섹션에만 */
  source?: string;
  /** 녹음 중 메모·북마크의 녹음 시각(초) */
  at?: number;
}

/** 옛 요약 원본 (결정 사항·할 일·주제). 화면·복사·인쇄가 옛 경로로 그린다 */
export type LegacySummary = SummaryLike & { provider: string | null; model: string | null };

export interface SummaryDoc {
  /** meeting(기본, summary.json) | 유형 ID | c-… (한 번만 쓴 직접 요약) */
  key: string;
  /** 탭 이름: 유형 이름, 직접 요약은 `직접 요약` */
  name: string;
  title: string;
  overview: string;
  sections: SummarySection[];
  legacy: LegacySummary | null;
  provider: string | null;
  model: string | null;
  /** 직접 쓴 요약 방법 (직접 요약·내 유형으로 만든 요약). 기본 유형은 null */
  prompt: string | null;
  /** 만든 유형의 ID (직접 요약은 custom) */
  template: string;
  /** "enhanced"면 노트 완성 (메모 탭이 전용 모양으로 그린다) */
  kind: "enhanced" | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObj) : []);
const STYLES: readonly string[] = ["bullets", "checklist", "numbered"];
const PARTS: readonly string[] = ["memo", "extra", "todos"];

/** Rust가 준 요약 파일(원본 JSON + key) 하나 → 화면 모델. 모양이 다르거나 비어 있는 곳은 너그럽게 읽는다. key가 없으면 null */
export function parseSummaryDoc(raw: unknown): SummaryDoc | null {
  if (!isObj(raw) || typeof raw.key !== "string" || !raw.key) return null;
  const base = {
    key: raw.key,
    title: str(raw.title),
    provider: strOrNull(raw.provider),
    model: strOrNull(raw.model),
    prompt: strOrNull(raw.prompt),
    template: str(raw.template) || raw.key,
    kind: raw.kind === "enhanced" ? ("enhanced" as const) : null,
  };
  if (Array.isArray(raw.sections)) {
    const sections = list(raw.sections).map((s) => ({
      heading: str(s.heading),
      style: (STYLES.includes(str(s.style)) ? s.style : "bullets") as SectionStyle,
      items: list(s.items).map((i) => ({ text: str(i.text), segment_ids: ids(i.segment_ids), owner: strOrNull(i.owner), due: strOrNull(i.due) })),
      ...(PARTS.includes(str(s.part)) ? { part: s.part as SectionPart } : {}),
      ...(typeof s.source === "string" && s.source ? { source: s.source } : {}),
      ...(typeof s.at === "number" && Number.isFinite(s.at) && s.at >= 0 ? { at: s.at } : {}),
    }));
    const custom = base.template === "custom" || base.key.startsWith("c-");
    return { ...base, name: str(raw.template_name) || (custom ? CUSTOM_NAME : base.key), overview: str(raw.overview), sections, legacy: null };
  }
  const legacy: LegacySummary = {
    summary: str(raw.summary),
    topics: list(raw.topics).map((t) => ({ title: str(t.title), segment_ids: ids(t.segment_ids) })),
    decisions: list(raw.decisions).map((d) => ({ text: str(d.text), segment_ids: ids(d.segment_ids) })),
    action_items: list(raw.action_items).map((a) => ({ task: str(a.task), owner: strOrNull(a.owner), due: strOrNull(a.due), segment_ids: ids(a.segment_ids) })),
    provider: base.provider,
    model: base.model,
  };
  return { ...base, name: str(raw.template_name) || DEFAULT_NAME, overview: legacy.summary, sections: [], legacy };
}

/** 파일 목록 → 화면 모델 (읽지 못하는 것은 뺀다) */
export const parseSummaryDocs = (raw: unknown): SummaryDoc[] => (Array.isArray(raw) ? raw.flatMap((r) => parseSummaryDoc(r) ?? []) : []);

/** 탭 순서: 기본 유형(목록 순서, 회의록이 맨 앞) → 내 유형·직접 요약(들어온 순서). 안정 정렬 */
export function orderDocs(docs: SummaryDoc[], templates: TemplateInfo[]): SummaryDoc[] {
  const slot = (d: SummaryDoc) => {
    const i = templates.findIndex((t) => t.builtin && t.id === d.key);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return docs.map((d, i) => ({ d, i })).sort((a, b) => slot(a.d) - slot(b.d) || a.i - b.i).map((x) => x.d);
}

/** 탭에 보일 이름. 같은 이름이 여러 개면 둘째부터 번호를 붙인다 (직접 요약을 여러 번 만든 경우) */
export function tabLabels(docs: SummaryDoc[]): string[] {
  const seen = new Map<string, number>();
  return docs.map((d) => {
    const n = (seen.get(d.name) ?? 0) + 1;
    seen.set(d.name, n);
    return n === 1 ? d.name : `${d.name} ${n}`;
  });
}

/** 선택한 요약이 목록에 있으면 그대로, 없으면(지웠거나 처음) 첫 번째 */
export const pickSelected = (docs: SummaryDoc[], key: string | null): SummaryDoc | null => docs.find((d) => d.key === key) ?? docs[0] ?? null;

/** 지운 뒤에 고를 요약: 지운 탭의 옆(다음, 없으면 앞) */
export function afterDelete(docs: SummaryDoc[], key: string): string | null {
  const i = docs.findIndex((d) => d.key === key);
  const rest = docs.filter((d) => d.key !== key);
  return (rest[Math.min(i, rest.length - 1)] ?? null)?.key ?? null;
}

// ── 복사 (마크다운) ──

/** '요약 복사' 마크다운: 옛 요약은 옛 형식 그대로, 새 요약은 개요 + 섹션. 항목마다 근거 시각(메모는 `메모 n번째 줄`)을 붙인다 */
export function docMarkdown(doc: SummaryDoc, starts: Map<string, number>, memoLines?: Map<string, number>): string {
  if (doc.legacy) return summaryMarkdown(doc.legacy, starts, memoLines);
  const at = (i: string[]) => {
    const label = evidenceLabel(i, starts, memoLines);
    return label === null ? "" : ` (${label})`;
  };
  const line = (s: SectionStyle, n: number, it: SummaryItem) => {
    const who = [it.owner, it.due].filter(Boolean).join(", ");
    const mark = s === "checklist" ? "- [ ] " : s === "numbered" ? `${n}. ` : "- ";
    return `${mark}${it.text}${who ? ` — ${who}` : ""}${at(it.segment_ids)}`;
  };
  const parts = doc.overview.trim() ? [["## " + t("요약"), "", doc.overview, ""]] : [];
  for (const s of doc.sections) if (s.items.length) parts.push([`## ${s.heading}`, "", ...s.items.map((it, i) => line(s.style, i + 1, it)), ""]);
  return parts.flat().join("\n");
}

/** 인쇄 모델: 선택한 요약 하나. 옛 요약은 printDoc의 옛 경로(summary)로 가고, 새 요약만 이 모양이다 */
export interface PrintSummary {
  name: string;
  lead: string;
  sections: { title: string; style: SectionStyle; items: { text: string; meta: string; at: string | null }[] }[];
}

export function printSummary(doc: SummaryDoc, at: (ids: string[]) => string | null): PrintSummary {
  return {
    name: doc.name,
    lead: doc.overview,
    sections: doc.sections
      .filter((s) => s.items.length)
      .map((s) => ({ title: s.heading, style: s.style, items: s.items.map((i) => ({ text: i.text, meta: [i.owner, i.due].filter(Boolean).join(" · "), at: at(i.segment_ids) })) })),
  };
}

// ── 만들기: 유형 고르기와 다시 만들기 ──

/** 요약 하나를 만드는 일. template/custom 중 하나 (둘 다 없으면 기본 회의록). key: 끝나면 만들어질 요약의 key (한 번만 쓴 새 직접 요약은 모른다) */
export interface SummarySpec {
  template?: string;
  custom?: { prompt: string; save_as?: string | null; key?: string | null };
  label: string;
  key: string | null;
}

export const templateSpec = (t: TemplateInfo): SummarySpec => ({ template: t.id, label: t.name, key: t.id });

/** 고른 유형(ID) → 만들 일들. 목록 순서대로, 모르는 ID(지운 유형)는 뺀다 */
export const specsFromPick = (picked: string[], templates: TemplateInfo[]): SummarySpec[] => templates.filter((t) => picked.includes(t.id)).map(templateSpec);

/** 유형 하나를 켜고 끈다 */
export const togglePick = (picked: string[], id: string): string[] => (picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id]);

/** 처음 고른 유형: 아직 없는 첫 기본 유형(회의록부터). 모두 있으면 회의록 */
/** 요약 탭에 보일 요약: 회의록(옛 summary.json과 새 회의록)은 회의록 탭으로 갔다 (docs/design/meeting-minutes.md) */
export const summaryTabDocs = (docs: SummaryDoc[]): SummaryDoc[] => docs.filter((d) => d.key !== DEFAULT_KEY && d.key !== "minutes");

/** 요약 탭의 유형 메뉴: 기본 유형 `회의록`은 회의록 탭의 `회의록 만들기`가 대신한다 */
export const summaryTemplates = (templates: TemplateInfo[]): TemplateInfo[] => templates.filter((x) => x.id !== DEFAULT_KEY);

/** 유형 목록을 읽지 못했을 때 만들 요약 */
export const FALLBACK_SPEC: SummarySpec = { template: "brief", label: t("핵심 요약"), key: "brief" };

export function defaultPick(docs: SummaryDoc[], templates: TemplateInfo[]): string[] {
  const made = new Set(docs.map((d) => d.key));
  const next = templates.find((t) => t.builtin && !made.has(t.id));
  return [next?.id ?? DEFAULT_KEY];
}

/** 단추 글자: 요약 유형 선택 상태 */
export function pickLabel(picked: string[], templates: TemplateInfo[]): string {
  const known = templates.filter((x) => picked.includes(x.id));
  if (known.length === 0) return t("요약 유형 고르기");
  return known.length === 1 ? t("요약 유형: {name}", { name: known[0].name }) : t("요약 유형: {n}개 선택", { n: known.length });
}

/** '다시 만들기': 같은 유형이 있으면 그 유형으로, 지운 유형이거나 직접 요약이면 저장해 둔 요약 방법으로(직접 요약은 같은 key를 덮어쓴다). 방법을 모르면 null */
export function rerunSpec(doc: SummaryDoc, templates: TemplateInfo[]): SummarySpec | null {
  if (doc.key === DEFAULT_KEY) return { label: doc.name, key: DEFAULT_KEY };
  if (doc.kind === "enhanced") return { template: doc.key, label: doc.name, key: doc.key }; // 노트 완성: 요약 유형 목록에 없지만 같은 명령으로 다시 만든다
  const t = templates.find((x) => x.id === doc.key);
  if (t) return templateSpec(t);
  if (!doc.prompt) return null;
  return { custom: { prompt: doc.prompt, key: doc.key.startsWith("c-") ? doc.key : null }, label: doc.name, key: doc.key.startsWith("c-") ? doc.key : null };
}

// ── 직접 프롬프트 입력 ──

export interface CustomDraft {
  prompt: string;
  save: boolean;
  name: string;
}

export interface CustomCheck {
  ok: boolean;
  prompt: string | null;
  name: string | null;
}

export const PROMPT_EMPTY = t("요약 방법을 입력하세요.");
export const PROMPT_LONG = t("요약 방법은 {n}자까지 쓸 수 있습니다.", { n: MAX_PROMPT.toLocaleString("en-US") });
export const NAME_EMPTY = t("이름을 입력하세요.");
export const NAME_LONG = t("이름은 {n}자까지 쓸 수 있습니다.", { n: MAX_NAME });

const squash = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");

/** 입력 검사 (코어와 같은 한도·문장). 글자 수는 코드 포인트로 센다 */
export function checkCustom(d: CustomDraft): CustomCheck {
  const count = (s: string) => [...s].length;
  const prompt = d.prompt.trim();
  const name = squash(d.name);
  const promptErr = !prompt ? PROMPT_EMPTY : count(prompt) > MAX_PROMPT ? PROMPT_LONG : null;
  const nameErr = !d.save ? null : !name ? NAME_EMPTY : count(name) > MAX_NAME ? NAME_LONG : null;
  return { ok: !promptErr && !nameErr, prompt: promptErr, name: nameErr };
}

/** 입력 → 만들 일. 이름을 저장하면 탭 이름도 그 이름이다 */
export function customSpec(d: CustomDraft): SummarySpec {
  const name = squash(d.name);
  const save = d.save && name ? name : null;
  return { custom: { prompt: d.prompt.trim(), save_as: save }, label: save ?? CUSTOM_NAME, key: null };
}

/** 글자 수 표시 `1,234 / 4,000` */
export const promptCounter = (prompt: string): string => `${[...prompt.trim()].length.toLocaleString("en-US")} / ${MAX_PROMPT.toLocaleString("en-US")}`;

// ── 내 유형 편집 (설정) ──

export interface TemplateDraft {
  name: string;
  description: string;
  prompt: string;
}

export interface TemplateCheck {
  ok: boolean;
  name: string | null;
  description: string | null;
  prompt: string | null;
}

export function checkTemplate(d: TemplateDraft): TemplateCheck {
  const count = (s: string) => [...s].length;
  const name = squash(d.name);
  const nameErr = !name ? NAME_EMPTY : count(name) > MAX_NAME ? NAME_LONG : null;
  const descErr = count(squash(d.description)) > MAX_DESC ? t("설명은 {n}자까지 쓸 수 있습니다.", { n: MAX_DESC }) : null;
  const prompt = checkCustom({ prompt: d.prompt, save: false, name: "" }).prompt;
  return { ok: !nameErr && !descErr && !prompt, name: nameErr, description: descErr, prompt };
}

/** '복사해서 만들기': 기본 유형을 고칠 수 있는 내 유형 초안으로 */
export const copyDraft = (tpl: TemplateInfo): TemplateDraft => ({ name: t("{name} (복사)", { name: [...tpl.name].slice(0, MAX_NAME - 5).join("") }), description: tpl.description, prompt: tpl.prompt });
