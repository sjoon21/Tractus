import { describe, expect, test } from "vitest";
import {
  addTags,
  applyMeta,
  touchNote,
  buildFolderTree,
  canNest,
  checkFolderName,
  collectTags,
  defaultOrder,
  depthOf,
  dropOutcome,
  filterNotes,
  folderOf,
  folderPath,
  foldKey,
  groupByMonth,
  groupForList,
  isFiltered,
  metaOf,
  monthIsOpen,
  NO_FILTER,
  normalizeTag,
  DEFAULT_FOLD,
  parseFold,
  readSortPrefs,
  removeTag,
  sortNotes,
  splitTags,
  subtreeIds,
  suggestTags,
  visibleRows,
  type Folder,
  type OrganisedNote,
} from "./organize";
import { DROP_NONE, parseDrop } from "./noteDrag";

const note = (id: string, title: string, extra: Record<string, unknown> = {}): OrganisedNote => ({ id, title, created_at: "2026-10-01T09:00:00+09:00", duration_sec: 0, ...extra });
const folder = (id: string, name: string, parent: string | null = null, order = 1): Folder => ({ id, name, parent, order, created_at: "" });

describe("sorting", () => {
  const ns = [
    note("1", "나비", { created_at: "2026-10-01T09:00:00+09:00" }),
    note("2", "가방", { created_at: "2026-10-02T09:00:00+09:00", updated_at: "2026-10-09T09:00:00+09:00", duration_sec: 90 }),
    note("3", "다람쥐", { created_at: "2026-10-03T09:00:00+09:00", duration_sec: 30 }),
    note("4", "Banana", { created_at: "2026-10-04T09:00:00+09:00" }),
    note("5", "apple pie", { created_at: "2026-10-05T09:00:00+09:00" }),
  ];
  const ids = (a: { id: string }[]) => a.map((n) => n.id).join("");

  test("updated falls back to created for old notes", () => {
    expect(ids(sortNotes(ns, "updated", "desc"))).toBe("25431"); // 2번만 수정 시각이 10-09, 나머지는 만든 시각
    expect(ids(sortNotes(ns, "updated", "asc"))).toBe("13452");
  });
  test("created and duration", () => {
    expect(ids(sortNotes(ns, "created", "desc"))).toBe("54321");
    expect(ids(sortNotes(ns, "duration", "desc"))).toBe("23541"); // 길이가 같으면 만든 시각 순(역순), 그다음 ID
  });
  test("title: case-insensitive, Latin before Hangul, Hangul in dictionary order", () => {
    expect(sortNotes(ns, "title", "asc").map((n) => n.title)).toEqual(["apple pie", "Banana", "가방", "나비", "다람쥐"]);
    expect(sortNotes(ns, "title", "desc")[0].title).toBe("다람쥐");
  });
  test("title compares NFC, so decomposed Hangul sorts like composed", () => {
    const nfd = "가나"; // 가나 (자모)
    const out = sortNotes([note("a", "다"), note("b", nfd), note("c", "가다")], "title", "asc");
    expect(out.map((n) => n.id)).toEqual(["b", "c", "a"]);
    expect(foldKey(nfd)).toBe("가나");
  });
  test("is stable and does not touch the input", () => {
    const same = [note("b", "같음"), note("a", "같음")];
    expect(ids(sortNotes(same, "title", "asc"))).toBe("ab");
    expect(ids(same)).toBe("ba");
  });
  test("a missing or odd timestamp sorts as the oldest", () => {
    const odd = [note("x", "a", { created_at: "" }), note("y", "b", { created_at: "garbage" }), note("z", "c")];
    expect(ids(sortNotes(odd, "created", "desc"))).toBe("zyx");
  });
  test("default order per key and settings values", () => {
    expect(defaultOrder("title")).toBe("asc");
    expect(defaultOrder("updated")).toBe("desc");
    expect(readSortPrefs({ list_sort: "title", list_order: "asc" })).toEqual({ sort: "title", order: "asc" });
    expect(readSortPrefs({ list_sort: "title" })).toEqual({ sort: "title", order: "asc" });
    expect(readSortPrefs({ list_sort: "size", list_order: "up" })).toEqual({ sort: "updated", order: "desc" });
    expect(readSortPrefs(null)).toEqual({ sort: "updated", order: "desc" });
  });
});

describe("title order matches the core (NFC + casefold, code point order)", () => {
  test("same order as Python sorted(key=casefold) for odd titles", () => {
    const titles = ["가계부", "나", "다", "Apple", "apple", "ÀB", "zebra", "😀 회의", "ＡＢＣ", "ㄱ자", "1월", "_x", "한", "각", "갂", "Ｚ", "\u{20000}확장", "ǅ", "İstanbul", "ß", "ss", "Straße", "STRASSE", "ﬁ", "fi"];
    const ns = titles.map((t, i) => note(`n${String(i).padStart(2, "0")}`, t));
    // 파이썬으로 구한 기대값 (이름이 같게 접히는 제목은 입력 순서)
    expect(sortNotes(ns, "title", "asc").map((n) => n.title)).toEqual(["1월", "_x", "Apple", "apple", "ﬁ", "fi", "İstanbul", "ß", "ss", "Straße", "STRASSE", "zebra", "ÀB", "ǅ", "ㄱ자", "가계부", "각", "갂", "나", "다", "한", "ＡＢＣ", "Ｚ", "😀 회의", "\u{20000}확장"]);
  });
  test("Straße and STRASSE are the same name", () => {
    expect(foldKey("Straße")).toBe(foldKey("STRASSE"));
  });
});

describe("folder tree", () => {
  const fs = [folder("a", "업무"), folder("b", "프로젝트", "a"), folder("c", "2026", "b"), folder("d", "개인", null, 2), folder("e", "독서", "d")];
  const notes = [note("1", "x", { folder: "c" }), note("2", "x", { folder: "b" }), note("3", "x", { folder: "gone" }), note("4", "x"), note("5", "x", { folder: "d" })];

  test("builds nested nodes with depth and subtree counts", () => {
    const tree = buildFolderTree(fs, notes);
    expect(tree.map((n) => [n.folder.id, n.depth, n.count])).toEqual([["a", 1, 2], ["d", 1, 1]]);
    expect(tree[0].children[0].children[0]).toMatchObject({ depth: 3, count: 1 });
  });
  test("a note in a folder that no longer exists counts nowhere", () => {
    expect(buildFolderTree(fs, [note("3", "x", { folder: "gone" })]).every((n) => n.count === 0)).toBe(true);
    expect(folderOf({ folder: "gone" }, new Set(["a"]))).toBeNull();
  });
  test("siblings sort by order then name; orphans become top level; cycles do not loop", () => {
    const odd = [folder("z", "나", null, 1), folder("y", "가", null, 1), folder("o", "고아", "nope"), folder("p", "고리1", "q"), folder("q", "고리2", "p")];
    const names = buildFolderTree(odd, []).map((n) => n.folder.name);
    expect(names.slice(0, 3)).toEqual(["가", "고아", "나"]);
    expect(buildFolderTree(odd, []).length).toBeGreaterThanOrEqual(3);
  });
  test("visibleRows follows only expanded folders", () => {
    const tree = buildFolderTree(fs, notes);
    expect(visibleRows(tree, new Set()).map((n) => n.folder.id)).toEqual(["a", "d"]);
    expect(visibleRows(tree, new Set(["a", "b"])).map((n) => n.folder.id)).toEqual(["a", "b", "c", "d"]);
  });
  test("subtree, depth and path", () => {
    expect([...subtreeIds(fs, "a")].sort()).toEqual(["a", "b", "c"]);
    expect([...subtreeIds(fs, "c")]).toEqual(["c"]);
    expect([depthOf(fs, null), depthOf(fs, "a"), depthOf(fs, "c"), depthOf(fs, "nope")]).toEqual([0, 1, 3, 0]);
    expect(folderPath(fs, "c")).toBe("업무 / 프로젝트 / 2026");
    expect(folderPath(fs, null)).toBe("");
    expect(canNest(fs, "b")).toBe(true);
    expect(canNest(fs, "c")).toBe(false);
    expect(canNest(fs, null)).toBe(true);
  });
  test("name check mirrors the core: trim, NFC, slash, length, duplicates among siblings", () => {
    const sib = [folder("a", "업무"), folder("x", "가")];
    expect(checkFolderName("  새\n 폴더 ", sib)).toEqual({ ok: true, name: "새 폴더" });
    expect(checkFolderName("  ", sib)).toEqual({ ok: false, error: "폴더 이름을 입력하세요." });
    expect(checkFolderName("a/b", sib)).toEqual({ ok: false, error: "폴더 이름에 /는 쓸 수 없습니다." });
    expect(checkFolderName("가".repeat(40), sib).ok).toBe(true);
    expect(checkFolderName(" None ", sib)).toEqual({ ok: false, error: "‘none’은 폴더 이름으로 쓸 수 없습니다." });
    expect(checkFolderName("n\u200bone", sib).ok).toBe(false);
    expect(checkFolderName("업\u200b무", [{ ...sib[0], name: "업무" }]).ok).toBe(false); // 보이지 않는 글자를 빼면 같은 이름이다
    expect(checkFolderName("가".repeat(41), sib)).toEqual({ ok: false, error: "폴더 이름은 40자까지 쓸 수 있습니다." });
    expect(checkFolderName("😀".repeat(40), sib).ok).toBe(true); // 글자 수로 센다
    expect(checkFolderName(" 업무 ", sib)).toEqual({ ok: false, error: "같은 위치에 이름이 같은 폴더가 있습니다." });
    expect(checkFolderName("업무", sib, "a").ok).toBe(true); // 자기 이름은 겹침이 아니다
    expect(checkFolderName("가", sib)).toEqual({ ok: false, error: "같은 위치에 이름이 같은 폴더가 있습니다." }); // NFD 가 = NFC 가
  });
});

describe("drag and drop", () => {
  const known = new Set(["a", "b"]);
  test("reads the drop target from a folder row, and ignores everything else", () => {
    expect(parseDrop("F1")).toEqual({ target: "F1" });
    expect(parseDrop(DROP_NONE)).toEqual({ target: null }); // 폴더 없음 줄
    expect(parseDrop(null)).toBeNull();
    expect(parseDrop("")).toBeNull();
  });
  test("tags drop invisible characters but keep the emoji joiner", () => {
    expect(normalizeTag("a\u200bb")).toBe("ab");
    expect(normalizeTag("\u200b")).toBe("");
    expect(normalizeTag("👩\u200d💻")).toBe("👩\u200d💻");
  });
  test("moves to another folder or to the top level, and ignores no-ops and stale targets", () => {
    expect(dropOutcome({ folder: "a" }, "b", known)).toEqual({ move: true, folder: "b" });
    expect(dropOutcome({ folder: "a" }, "a", known)).toEqual({ move: false, folder: "a" });
    expect(dropOutcome({ folder: null }, null, known).move).toBe(false);
    expect(dropOutcome({ folder: "a" }, null, known)).toEqual({ move: true, folder: null });
    expect(dropOutcome({ folder: "gone" }, null, known).move).toBe(false); // 이미 폴더 없음으로 읽힌다
    expect(dropOutcome({ folder: "a" }, "gone", known).move).toBe(false);
    expect(dropOutcome(undefined, "a", known).move).toBe(false);
  });
});

describe("tags", () => {
  test("normalise like the core", () => {
    expect(normalizeTag("  ##회의\t록 ")).toBe("회의 록");
    expect(normalizeTag("a\u0000b")).toBe("ab");
    expect(normalizeTag("#")).toBe("");
    expect(normalizeTag("가")).toBe("가");
  });
  test("split on commas and newlines, dropping empties", () => {
    expect(splitTags("a, #b ,,c\nd，e")).toEqual(["a", "b", "c", "d", "e"]);
    expect(splitTags(" , ")).toEqual([]);
  });
  test("addTags dedupes case-insensitively and keeps the first form", () => {
    expect(addTags(["Idea"], "idea, 새 태그")).toEqual({ tags: ["Idea", "새 태그"], error: null });
    expect(addTags([], "")).toEqual({ tags: [], error: null });
  });
  test("limits: 30 characters, 20 tags (counted once per distinct tag)", () => {
    expect(addTags([], "가".repeat(30)).error).toBeNull();
    expect(addTags(["x"], "가".repeat(31))).toEqual({ tags: ["x"], error: "태그는 30자까지 쓸 수 있습니다." });
    const twenty = Array.from({ length: 20 }, (_, i) => `t${i}`);
    expect(addTags(twenty, "T0, t1").error).toBeNull(); // 이미 있는 태그라 개수가 늘지 않는다
    expect(addTags(twenty, "새로").error).toBe("태그는 20개까지 붙일 수 있습니다.");
    expect(addTags(twenty.slice(0, 19), "a, b")).toEqual({ tags: twenty.slice(0, 19), error: "태그는 20개까지 붙일 수 있습니다." }); // 하나도 더하지 않는다
  });
  test("removeTag ignores case", () => {
    expect(removeTag(["A", "b"], "a")).toEqual(["b"]);
  });
  test("collectTags groups case-insensitively, shows the most used form, orders by count then name", () => {
    const got = collectTags([note("1", "", { tags: ["Q3", "회의"] }), note("2", "", { tags: ["q3"] }), note("3", "", { tags: ["Q3", "q3", "아이디어"] }), note("4", "")]);
    expect(got).toEqual([{ tag: "Q3", count: 3 }, { tag: "아이디어", count: 1 }, { tag: "회의", count: 1 }]); // 한 노트의 q3·Q3는 한 번
  });
  test("suggestTags: prefix first, skips attached tags", () => {
    const all = [{ tag: "회의록", count: 5 }, { tag: "주간회의", count: 9 }, { tag: "회의", count: 1 }, { tag: "Idea", count: 2 }];
    expect(suggestTags(all, ["회의"], "회")).toEqual(["회의록", "주간회의"]);
    expect(suggestTags(all, [], "회의")).toEqual(["회의록", "회의", "주간회의"]);
    expect(suggestTags(all, [], "ID")).toEqual(["Idea"]);
    expect(suggestTags(all, [], "")).toHaveLength(4);
    expect(suggestTags(all, [], "", 2)).toHaveLength(2);
  });
});

describe("filtering", () => {
  const fs = [folder("a", "업무"), folder("b", "프로젝트", "a"), folder("c", "개인")];
  const ns = [
    note("1", "Q3 예산 회의", { tags: ["회의", "Q3"], folder: "b" }),
    note("2", "장보기", { tags: ["q3"], folder: "c" }),
    note("3", "예산 초안", { folder: "a" }),
    note("4", "무제"),
    note("5", "지워진 폴더", { folder: "gone" }),
  ];
  const ids = (f: Partial<typeof NO_FILTER>) => filterNotes(ns, { ...NO_FILTER, ...f }, fs).map((n) => n.id).join("");

  test("no filter keeps everything", () => {
    expect(ids({})).toBe("12345");
    expect(isFiltered(NO_FILTER)).toBe(false);
  });
  test("title substring: case-insensitive, NFC, trimmed", () => {
    expect(ids({ query: " q3 " })).toBe("1");
    expect(ids({ query: "예산" })).toBe("13");
    expect(ids({ query: "다" })).toBe(""); // NFD 다: '다'가 든 제목이 없다
    expect(isFiltered({ ...NO_FILTER, query: "x" })).toBe(true);
  });
  test("several tags are ANDed, case-insensitively", () => {
    expect(ids({ tags: ["q3"] })).toBe("12");
    expect(ids({ tags: ["Q3", "회의"] })).toBe("1");
    expect(ids({ tags: ["없는"] })).toBe("");
  });
  test("a folder includes its subfolders; none means no folder (a deleted folder counts as none)", () => {
    expect(ids({ folder: "a" })).toBe("13");
    expect(ids({ folder: "b" })).toBe("1");
    expect(ids({ folder: "none" })).toBe("45");
    expect(ids({ folder: "gone" })).toBe(""); // 지워진 폴더를 고르고 있으면 아무것도 없다
  });
  test("filters combine", () => {
    expect(ids({ folder: "a", tags: ["회의"], query: "예산" })).toBe("1");
  });
});

describe("list grouping", () => {
  const ns = [note("1", "a", { created_at: "2026-10-03T10:00:00+09:00", updated_at: "2026-10-09T10:00:00+09:00" }), note("2", "b", { created_at: "2026-10-03T08:00:00+09:00" }), note("3", "c", { created_at: "2026-10-01T08:00:00+09:00" })];
  test("time orders group by the day of that time", () => {
    expect(groupForList(sortNotes(ns, "created", "desc"), "created").map((g) => [g.day, g.items.length])).toEqual([["2026-10-03", 2], ["2026-10-01", 1]]);
    expect(groupForList(sortNotes(ns, "updated", "desc"), "updated").map((g) => g.day)).toEqual(["2026-10-09", "2026-10-03", "2026-10-01"]);
  });
  test("title and length orders are one flat group", () => {
    expect(groupForList(ns, "title")).toEqual([{ day: null, items: ns }]);
    expect(groupForList([], "duration")).toEqual([]);
  });
});

describe("optimistic meta patch", () => {
  test("changes one note and keeps the others identical (so their rows do not redraw)", () => {
    const ns = [note("1", "a"), note("2", "b")];
    const out = applyMeta(ns, "2", { favorite: true, tags: ["x"] });
    expect(out[0]).toBe(ns[0]);
    expect(out[1]).toMatchObject({ id: "2", favorite: true, tags: ["x"] });
    expect(ns[1]).not.toHaveProperty("favorite");
  });
  test("a saved note moves to the top of the recent-edit order without a refresh", () => {
    const ns = [note("1", "a", { updated_at: "2026-10-01T09:00:00+09:00" }), note("2", "b", { updated_at: "2026-10-02T09:00:00+09:00" })];
    const out = touchNote(ns, "1", "2026-10-13T09:00:00+09:00");
    expect(sortNotes(out, "updated", "desc").map((n) => n.id)).toEqual(["1", "2"]);
    expect(out[1]).toBe(ns[1]);
    expect(touchNote(ns, "1", "2026-10-01T09:00:00+09:00")).toBe(ns); // 같은 값이면 목록을 그대로 둔다
    expect(touchNote(ns, "1", undefined)).toBe(ns);
  });
  test("metaOf fills defaults", () => {
    expect(metaOf(undefined)).toEqual({ favorite: false, tags: [], folder: null });
    expect(metaOf({ favorite: true, tags: ["a"], folder: "f" })).toEqual({ favorite: true, tags: ["a"], folder: "f" });
  });
});

describe("sidebar fold", () => {
  test("reads the saved state and falls back to the default for anything odd", () => {
    expect(parseFold('{"favorites":false,"folders":true,"tags":false,"open":["a",3],"months":{"2026-01":false,"2026-02":"x"}}')).toEqual({ favorites: false, folders: true, tags: false, open: ["a"], months: { "2026-01": false } });
    for (const raw of [null, "", "{", "[]", "3", '{"favorites":"no","open":"x"}']) {
      expect(parseFold(raw)).toEqual({ favorites: true, folders: true, tags: true, open: [], months: {} });
    }
  });
});

describe("month groups", () => {
  const g = (day: string, n: number) => ({ day, items: Array.from({ length: n }, (_, i) => i) });
  test("groups the day groups by month and counts the notes", () => {
    expect(groupByMonth([g("2026-10-03", 2), g("2026-10-01", 1), g("2026-09-30", 4), { day: null, items: [9] }]).map((m) => [m.key, m.days.length, m.count])).toEqual([["2026-10", 2, 3], ["2026-09", 1, 4]]);
    expect(groupByMonth([])).toEqual([]);
  });

  test("opens this month and last month by default; a saved choice wins", () => {
    const now = new Date(2026, 0, 15); // 1월: 지난달은 작년 12월
    expect(monthIsOpen(DEFAULT_FOLD, "2026-01", now)).toBe(true);
    expect(monthIsOpen(DEFAULT_FOLD, "2025-12", now)).toBe(true);
    expect(monthIsOpen(DEFAULT_FOLD, "2025-11", now)).toBe(false);
    expect(monthIsOpen({ ...DEFAULT_FOLD, months: { "2025-11": true, "2026-01": false } }, "2025-11", now)).toBe(true);
    expect(monthIsOpen({ ...DEFAULT_FOLD, months: { "2026-01": false } }, "2026-01", now)).toBe(false);
  });
});

describe("2,000 notes", () => {
  test("sorting, filtering, tags and the tree stay fast", () => {
    const fs = Array.from({ length: 30 }, (_, i) => folder(`f${i}`, `폴더 ${i}`, i % 3 === 0 ? null : `f${i - (i % 3)}`));
    const ns = Array.from({ length: 2000 }, (_, i) => note(`n${i}`, `노트 ${(i * 7919) % 2000}`, { created_at: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString(), tags: [`t${i % 40}`, "공통"], folder: `f${i % 30}`, duration_sec: i % 500 }));
    const t0 = performance.now();
    const sorted = sortNotes(ns, "title", "asc");
    const filtered = filterNotes(sorted, { query: "노트 1", tags: ["공통", "t3"], folder: "f0" }, fs);
    collectTags(ns);
    buildFolderTree(fs, ns);
    groupForList(sortNotes(ns, "updated", "desc"), "updated");
    const ms = performance.now() - t0;
    expect(sorted).toHaveLength(2000);
    expect(filtered.length).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThan(800); // 보통 수십 ms. 느린 CI를 위해 넉넉히
  });
});
