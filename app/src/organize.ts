// 노트 정리: 즐겨찾기·태그·폴더·순서 (docs/desktop.md §2.12). 순수 함수만 둔다 (organize.test.ts).
// 코어(src/tractus/organize.py)와 같은 규칙을 쓴다: 태그·폴더 이름은 NFC로 합쳐 대소문자 구분 없이 비교하고, 제목 순서는 로케일에 따르지 않는다.
import type { MeetingInfo } from "./api";
import { t } from "./i18n";

// ── 한도 (코어와 같다) ──
export const MAX_TAGS = 20;
export const MAX_TAG = 30;
export const MAX_FOLDER_NAME = 40;
export const MAX_DEPTH = 3;

export const TAG_LONG = t("태그는 {n}자까지 쓸 수 있습니다.", { n: MAX_TAG });
export const TAGS_MANY = t("태그는 {n}개까지 붙일 수 있습니다.", { n: MAX_TAGS });
export const FOLDER_EMPTY = t("폴더 이름을 입력하세요.");
export const FOLDER_LONG = t("폴더 이름은 {n}자까지 쓸 수 있습니다.", { n: MAX_FOLDER_NAME });
export const FOLDER_SLASH = t("폴더 이름에 /는 쓸 수 없습니다.");
export const FOLDER_RESERVED = t("‘none’은 폴더 이름으로 쓸 수 없습니다."); // 인수 `none`은 폴더 없음 (코어)
export const FOLDER_DUP = t("같은 위치에 이름이 같은 폴더가 있습니다.");
export const FOLDER_DEPTH = t("폴더는 {n}단계까지 만들 수 있습니다.", { n: MAX_DEPTH });

export interface Folder {
  id: string;
  name: string;
  parent: string | null;
  order: number;
  created_at: string;
}

/** 노트에 붙는 정리 정보 (transcript.json의 favorite·tags·folder) */
export interface NoteMeta {
  favorite: boolean;
  tags: string[];
  folder: string | null;
}

/** 준 키만 바뀐다. folder: null은 폴더 없음 */
export type MetaPatch = Partial<NoteMeta>;

export type OrganisedNote = Pick<MeetingInfo, "id" | "title" | "created_at" | "duration_sec"> & Partial<Pick<MeetingInfo, "favorite" | "tags" | "folder" | "updated_at">>;

/** 보이지 않는 서식 문자(Cf: 폭 없는 공백·BOM·소프트 하이픈)를 뺀다. 이모지를 잇는 ZWJ(U+200D)는 남긴다 (코어 organize._visible) */
export const visible = (s: string): string => s.replace(/\p{Cf}/gu, (c) => (c === "\u200d" ? c : ""));

/** 비교 키: NFC + 대소문자 접기 (코어 organize.fold = NFC + casefold). 이름·태그·제목 비교에 쓴다. 대문자로 올렸다 내려서 ß→ss, ﬁ→fi 같은 접기도 맞춘다 */
export const foldKey = (s: string): string => s.normalize("NFC").toUpperCase().toLowerCase().replace(/ς/g, "σ");

/** 코드 포인트 순서 비교 (코어의 파이썬 문자열 비교와 같다). `<`는 UTF-16 순서라 이모지 같은 보충 평면 글자가 U+E000 이상 글자보다 앞에 온다 */
export function cmpCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    const xs = x >= 0xd800 && x <= 0xdfff;
    if (xs !== (y >= 0xd800 && y <= 0xdfff)) return xs ? 1 : -1; // 보충 평면 글자(서로게이트)는 모든 BMP 글자보다 크다
    return x < y ? -1 : 1;
  }
  return Math.sign(a.length - b.length);
}

// ── 순서 ──

export type SortKey = "updated" | "created" | "title" | "duration";
export type SortOrder = "asc" | "desc";

export const SORTS: { key: SortKey; label: string }[] = [
  { key: "updated", label: t("최근 수정 순") },
  { key: "created", label: t("만든 순") },
  { key: "title", label: t("제목 순") },
  { key: "duration", label: t("길이 순") },
];

/** 기준을 바꿀 때 처음 쓰는 방향: 시각·길이는 큰 것부터, 제목은 가나다 순 */
export const defaultOrder = (sort: SortKey): SortOrder => (sort === "title" ? "asc" : "desc");

export const DEFAULT_SORT: { sort: SortKey; order: SortOrder } = { sort: "updated", order: "desc" };

/** 설정에서 읽은 값: 모르는 값은 기본값이다 (파일을 손으로 고쳤거나 옛 앱이 쓴 경우) */
export function readSortPrefs(s: { list_sort?: unknown; list_order?: unknown } | null | undefined): { sort: SortKey; order: SortOrder } {
  const sort = SORTS.find((x) => x.key === s?.list_sort)?.key ?? DEFAULT_SORT.sort;
  const order = s?.list_order === "asc" || s?.list_order === "desc" ? s.list_order : defaultOrder(sort);
  return { sort, order };
}

const ts = (iso: string | undefined | null): number => {
  const n = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(n) ? n : 0;
};

/** 목록에 쓰는 수정 시각: 값이 없으면(옛 노트) 만든 시각 */
export const updatedAt = (m: Pick<OrganisedNote, "created_at" | "updated_at">): string => m.updated_at || m.created_at;

function compareBy(sort: SortKey): (a: OrganisedNote, b: OrganisedNote) => number {
  const tail = (a: OrganisedNote, b: OrganisedNote) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  switch (sort) {
    case "title":
      return (a, b) => {
        return cmpCodePoints(foldKey(a.title || ""), foldKey(b.title || "")) || ts(a.created_at) - ts(b.created_at) || tail(a, b);
      };
    case "created":
      return (a, b) => ts(a.created_at) - ts(b.created_at) || tail(a, b);
    case "updated":
      return (a, b) => ts(updatedAt(a)) - ts(updatedAt(b)) || tail(a, b);
    default:
      return (a, b) => a.duration_sec - b.duration_sec || ts(a.created_at) - ts(b.created_at) || tail(a, b);
  }
}

/** 새 배열. 같은 값이면 만든 시각·ID로 가려 안정적이다 (코어 organize.list_notes와 같다) */
export function sortNotes<T extends OrganisedNote>(notes: readonly T[], sort: SortKey, order: SortOrder): T[] {
  const cmp = compareBy(sort);
  const sign = order === "desc" ? -1 : 1;
  return [...notes].sort((a, b) => sign * cmp(a, b));
}

// ── 폴더 ──

export interface TreeNode {
  folder: Folder;
  depth: number; // 최상위 폴더 1
  children: TreeNode[];
  /** 이 폴더와 하위 폴더에 든 노트 수 (폴더를 누르면 보이는 노트와 같다) */
  count: number;
}

const byOrder = (a: Folder, b: Folder) => a.order - b.order || cmpCodePoints(foldKey(a.name), foldKey(b.name)) || cmpCodePoints(a.id, b.id);

/** 노트가 들어 있는 폴더 ID. 지워졌거나 모르는 ID면 null (폴더 없음) */
export const folderOf = (m: Pick<OrganisedNote, "folder">, known: ReadonlySet<string>): string | null => (m.folder && known.has(m.folder) ? m.folder : null);

/** 폴더 목록 → 나무. 없는 부모는 최상위로 본다 (코어가 이미 걸러 주지만 앱도 안전하게). 노트 수는 하위 폴더를 합친다 */
export function buildFolderTree(folders: readonly Folder[], notes: readonly Pick<OrganisedNote, "folder">[]): TreeNode[] {
  const ids = new Set(folders.map((f) => f.id));
  const own = new Map<string, number>();
  for (const n of notes) {
    const f = folderOf(n, ids);
    if (f) own.set(f, (own.get(f) ?? 0) + 1);
  }
  const kids = new Map<string | null, Folder[]>();
  for (const f of folders) {
    const p = f.parent && ids.has(f.parent) && f.parent !== f.id ? f.parent : null;
    kids.set(p, [...(kids.get(p) ?? []), f]);
  }
  const seen = new Set<string>();
  const build = (parent: string | null, depth: number): TreeNode[] =>
    [...(kids.get(parent) ?? [])]
      .sort(byOrder)
      .filter((f) => !seen.has(f.id) && seen.add(f.id))
      .map((folder) => {
        const children = build(folder.id, depth + 1);
        return { folder, depth, children, count: (own.get(folder.id) ?? 0) + children.reduce((n, c) => n + c.count, 0) };
      });
  return build(null, 1);
}

/** 펼친 폴더만 따라 한 줄씩 (사이드바 그리기용) */
export function visibleRows(tree: readonly TreeNode[], expanded: ReadonlySet<string>): TreeNode[] {
  return tree.flatMap((n) => [n, ...(expanded.has(n.folder.id) ? visibleRows(n.children, expanded) : [])]);
}

/** 폴더와 그 아래 모든 폴더의 ID */
export function subtreeIds(folders: readonly Folder[], id: string): Set<string> {
  const out = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of folders) {
      if (f.parent && out.has(f.parent) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
    }
  }
  return out;
}

/** 폴더의 깊이 (최상위 1, 없으면 0) */
export function depthOf(folders: readonly Folder[], id: string | null): number {
  const by = new Map(folders.map((f) => [f.id, f]));
  let n = 0;
  for (let cur = id ? by.get(id) : undefined; cur && n <= folders.length; cur = cur.parent ? by.get(cur.parent) : undefined) n++;
  return n;
}

/** `업무 / 프로젝트` 같은 경로 글자 (폴더 고르기 단추·알림). 없는 폴더는 빈 글자 */
export function folderPath(folders: readonly Folder[], id: string | null): string {
  const by = new Map(folders.map((f) => [f.id, f]));
  const names: string[] = [];
  for (let cur = id ? by.get(id) : undefined; cur && names.length <= folders.length; cur = cur.parent ? by.get(cur.parent) : undefined) names.unshift(cur.name);
  return names.join(" / ");
}

/** 폴더 이름 검사 (코어 organize.clean_folder_name과 같은 규칙). 정리한 이름 또는 오류 문장 */
export function checkFolderName(raw: string, siblings: readonly Folder[], self?: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = visible(raw.normalize("NFC").split(/\s+/).filter(Boolean).join(" ").replace(/[\u0000-\u001f\u007f-\u009f]/g, ""));
  if (!name) return { ok: false, error: FOLDER_EMPTY };
  if (name.toLowerCase() === "none") return { ok: false, error: FOLDER_RESERVED };
  if (name.includes("/")) return { ok: false, error: FOLDER_SLASH };
  if ([...name].length > MAX_FOLDER_NAME) return { ok: false, error: FOLDER_LONG };
  if (siblings.some((f) => f.id !== self && foldKey(f.name) === foldKey(name))) return { ok: false, error: FOLDER_DUP };
  return { ok: true, name };
}

/** 새 하위 폴더를 만들 수 있는 깊이인지 */
export const canNest = (folders: readonly Folder[], parent: string | null): boolean => depthOf(folders, parent) + 1 <= MAX_DEPTH;

/** 같은 부모의 폴더들 */
export const siblingsOf = (folders: readonly Folder[], parent: string | null): Folder[] => folders.filter((f) => (f.parent ?? null) === parent);

// ── 끌어 놓기 ──

/**
 * 노트를 폴더(또는 최상위 `null`)에 놓았을 때: 옮길지와 옮길 곳. 지금 있는 폴더에 놓거나 없는 폴더에 놓으면 옮기지 않는다
 * (폴더가 그 사이 지워졌을 수 있다)
 */
export function dropOutcome(note: Pick<OrganisedNote, "folder"> | undefined, target: string | null, known: ReadonlySet<string>): { move: boolean; folder: string | null } {
  if (!note) return { move: false, folder: null };
  if (target !== null && !known.has(target)) return { move: false, folder: null };
  return { move: folderOf(note, known) !== target, folder: target };
}

// ── 태그 ──

/** 코어 organize.clean_tag와 같다: 공백은 한 칸으로, 제어 문자·앞의 #은 뗀다. 비면 빈 글자 */
export const normalizeTag = (raw: string): string =>
  visible(
    raw
      .normalize("NFC")
      .split(/\s+/)
      .filter(Boolean)
      .join(" ")
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ""),
  )
    .replace(/^#+/, "")
    .trim();

/** 입력 글을 쉼표·줄바꿈 기준으로 나눠 정리한 태그들 (빈 것은 뺀다) */
export const splitTags = (raw: string): string[] => raw.split(/[,\n，]/).map(normalizeTag).filter(Boolean);

/**
 * 태그를 더한다: 쉼표로 나눠 한꺼번에 붙여 넣어도 된다. 이미 있는 태그(대소문자 구분 없음)는 건너뛴다.
 * 30자를 넘거나 20개를 넘으면 아무것도 더하지 않고 문장을 돌려준다
 */
export function addTags(current: readonly string[], raw: string): { tags: string[]; error: string | null } {
  const have = new Set(current.map(foldKey));
  const next = [...current];
  for (const t of splitTags(raw)) {
    if ([...t].length > MAX_TAG) return { tags: [...current], error: TAG_LONG };
    if (have.has(foldKey(t))) continue;
    have.add(foldKey(t));
    next.push(t);
  }
  return next.length > MAX_TAGS ? { tags: [...current], error: TAGS_MANY } : { tags: next, error: null };
}

export const removeTag = (tags: readonly string[], tag: string): string[] => tags.filter((t) => foldKey(t) !== foldKey(tag));

export interface TagCount {
  tag: string;
  count: number;
}

/** 모든 노트의 태그와 노트 수 (대소문자 구분 없이 하나로 센다. 보이는 모양은 가장 많이 쓴 것). 많이 쓴 순, 같으면 이름 순 */
export function collectTags(notes: readonly Pick<OrganisedNote, "tags">[]): TagCount[] {
  const groups = new Map<string, { forms: Map<string, number>; count: number }>();
  for (const n of notes) {
    const here = new Map<string, string>(); // 한 노트의 q3·Q3는 한 번만 센다
    for (const x of n.tags ?? []) if (!here.has(foldKey(x))) here.set(foldKey(x), x.normalize("NFC"));
    for (const [k, t] of here) {
      const g = groups.get(k) ?? { forms: new Map(), count: 0 };
      g.count++;
      g.forms.set(t, (g.forms.get(t) ?? 0) + 1);
      groups.set(k, g);
    }
  }
  return [...groups.entries()]
    .map(([k, g]) => ({ k, tag: [...g.forms.entries()].sort((a, b) => b[1] - a[1])[0][0], count: g.count }))
    .sort((a, b) => b.count - a.count || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
    .map(({ tag, count }) => ({ tag, count }));
}

/** 입력 중인 글에 맞는 기존 태그 (이미 붙은 것은 뺀다). 앞부분이 같은 것을 먼저, 많이 쓴 순 */
export function suggestTags(all: readonly TagCount[], current: readonly string[], input: string, limit = 6): string[] {
  const q = foldKey(normalizeTag(input));
  const have = new Set(current.map(foldKey));
  const hits = all.filter((t) => !have.has(foldKey(t.tag)) && (!q || foldKey(t.tag).includes(q)));
  const starts = hits.filter((t) => foldKey(t.tag).startsWith(q));
  return [...starts, ...hits.filter((t) => !starts.includes(t))].slice(0, limit).map((t) => t.tag);
}

// ── 목록 걸러내기 ──

export interface NoteFilter {
  /** 제목에 들어 있는 글 (대소문자 구분 없음). 비면 거르지 않는다 */
  query: string;
  /** 모두 붙은 노트만 (AND) */
  tags: readonly string[];
  /** null: 폴더로 거르지 않음, "none": 폴더 없는 노트, 그 밖: 그 폴더와 하위 폴더 */
  folder: string | "none" | null;
}

export const NO_FILTER: NoteFilter = { query: "", tags: [], folder: null };
export const isFiltered = (f: NoteFilter): boolean => f.query.trim() !== "" || f.tags.length > 0 || f.folder !== null;

export function filterNotes<T extends OrganisedNote>(notes: readonly T[], f: NoteFilter, folders: readonly Folder[]): T[] {
  const q = foldKey(f.query.trim());
  const want = f.tags.map(foldKey);
  const known = new Set(folders.map((x) => x.id));
  const scope = f.folder && f.folder !== "none" ? subtreeIds(folders, f.folder) : null;
  return notes.filter((n) => {
    if (q && !foldKey(n.title || "").includes(q)) return false;
    if (want.length) {
      const have = new Set((n.tags ?? []).map(foldKey));
      if (!want.every((t) => have.has(t))) return false;
    }
    if (f.folder === "none") return folderOf(n, known) === null;
    if (scope) {
      const at = folderOf(n, known);
      return at !== null && scope.has(at);
    }
    return true;
  });
}

// ── 날짜 묶음 ──

export interface ListGroup<T> {
  /** 날짜 묶음의 날짜(YYYY-MM-DD). null이면 묶지 않은 목록 */
  day: string | null;
  items: T[];
}

/** 시각 순서(최근 수정·만든 순)는 그 시각의 날짜별로 묶고, 제목·길이 순서는 묶지 않는다 */
export function groupForList<T extends OrganisedNote>(sorted: readonly T[], sort: SortKey): ListGroup<T>[] {
  if (sort === "title" || sort === "duration") return sorted.length ? [{ day: null, items: [...sorted] }] : [];
  const groups: ListGroup<T>[] = [];
  for (const item of sorted) {
    const day = (sort === "updated" ? updatedAt(item) : item.created_at).slice(0, 10) || t("날짜 없음");
    const last = groups[groups.length - 1];
    if (last?.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}

// ── 낙관적 갱신 ──

/** 목록에서 노트 하나의 정리 정보를 바꾼 새 목록 (저장하기 전에 화면에 먼저 보인다). 다른 노트는 같은 객체 그대로라 줄이 다시 그려지지 않는다 */
export function applyMeta<T extends OrganisedNote>(notes: readonly T[], id: string, patch: MetaPatch): T[] {
  return notes.map((n) => (n.id === id ? { ...n, ...patch } : n));
}

/** 노트 내용을 저장한 뒤 코어가 올린 수정 시각을 목록에 반영한 새 목록 (기본 순서 `최근 수정 순`이 새로 고치기 전에도 맞도록). 같으면 같은 목록을 돌려준다 */
export function touchNote<T extends OrganisedNote>(notes: readonly T[], id: string, updatedAt: string | undefined): readonly T[] {
  if (!updatedAt || !notes.some((n) => n.id === id && n.updated_at !== updatedAt)) return notes;
  return notes.map((n) => (n.id === id ? { ...n, updated_at: updatedAt } : n));
}

/** 노트의 정리 정보 (없는 값은 기본값) */
export const metaOf = (n: Pick<OrganisedNote, "favorite" | "tags" | "folder"> | undefined): NoteMeta => ({ favorite: n?.favorite === true, tags: n?.tags ?? [], folder: n?.folder ?? null });

// ── 사이드바 접힘 (이 화면에서만 쓰는 편의라 localStorage) ──

export interface SidebarFold {
  favorites: boolean;
  folders: boolean;
  tags: boolean;
  /** 펼친 폴더 ID */
  open: string[];
  /** 사용자가 직접 펼치거나 접은 달(`YYYY-MM`). 없는 달은 `monthIsOpen`의 기본 규칙 */
  months: Record<string, boolean>;
}

export const DEFAULT_FOLD: SidebarFold = { favorites: true, folders: true, tags: true, open: [], months: {} };

/** 저장된 글을 읽는다: 깨졌거나 모양이 다르면 기본값 (true = 펼침) */
export function parseFold(raw: string | null): SidebarFold {
  try {
    const v = JSON.parse(raw ?? "null") as Partial<SidebarFold> | null;
    if (!v || typeof v !== "object") return DEFAULT_FOLD;
    const bool = (x: unknown, d: boolean) => (typeof x === "boolean" ? x : d);
    return {
      favorites: bool(v.favorites, true),
      folders: bool(v.folders, true),
      tags: bool(v.tags, true),
      open: Array.isArray(v.open) ? v.open.filter((x): x is string => typeof x === "string") : [],
      months: v.months && typeof v.months === "object" && !Array.isArray(v.months) ? Object.fromEntries(Object.entries(v.months).filter(([, x]) => typeof x === "boolean")) : {},
    };
  } catch {
    return DEFAULT_FOLD;
  }
}

// ── 달 묶음 (노트가 많아져도 목록이 길어지지 않게) ──

export interface MonthGroup<T> {
  /** `YYYY-MM` (날짜가 없는 노트는 그 문구) */
  key: string;
  days: ListGroup<T>[];
  count: number;
}

/** 날짜별 묶음을 달별로 다시 묶는다 (날짜 없는 묶음 `day: null`은 호출하는 쪽이 따로 다룬다) */
export function groupByMonth<T>(groups: readonly ListGroup<T>[]): MonthGroup<T>[] {
  const months: MonthGroup<T>[] = [];
  for (const g of groups) {
    if (g.day === null) continue;
    const key = g.day.slice(0, 7);
    const last = months[months.length - 1];
    if (last?.key === key) {
      last.days.push(g);
      last.count += g.items.length;
    } else months.push({ key, days: [g], count: g.items.length });
  }
  return months;
}

/** 이 달을 펼쳐 보이는가: 직접 정한 값이 먼저, 아니면 이번 달과 지난달만 펼친다 */
export function monthIsOpen(fold: SidebarFold, key: string, now: Date = new Date()): boolean {
  if (key in fold.months) return fold.months[key];
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return key >= `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
}
