// 사이드바·노트 머리 정리 화면이 그려지는지 (서버 렌더). 끌어 놓기·메뉴 같은 상호작용은 순수 로직(organize.test.ts)과 손으로 확인한다.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { MeetingInfo } from "./api";
import { NoteLibrary } from "./NoteLibrary";
import { NoteOrganizer } from "./NoteOrganizer";
import { buildFolderTree, collectTags, NO_FILTER, type Folder } from "./organize";
import { OrganizeContext, type OrganizeValue } from "./useOrganize";

const folders: Folder[] = [
  { id: "F1", name: "업무", parent: null, order: 1, created_at: "" },
  { id: "F2", name: "프로젝트", parent: "F1", order: 1, created_at: "" },
];
const note = (id: string, title: string, extra: Partial<MeetingInfo> = {}): MeetingInfo => ({ id, dir: "", title, created_at: "2026-10-13T09:00:00+09:00", duration_sec: 0, segments: 1, has_summary: false, kind: "memo", ...extra });
const notes = [note("N1", "예산 회의", { favorite: true, tags: ["회의", "Q3"], folder: "F2" }), note("N2", "장보기", { tags: ["개인"] }), ...Array.from({ length: 2000 }, (_, i) => note(`X${i}`, `노트 ${i}`, { tags: ["대량"] }))];

const value = (over: Partial<OrganizeValue> = {}): OrganizeValue => {
  const noop = async () => true;
  return {
    folders, tree: buildFolderTree(folders, notes), tags: collectTags(notes), filter: NO_FILTER, setQuery() {}, toggleTag() {}, selectFolder() {}, clearFilters() {},
    sort: "updated", order: "desc", setSort() {}, toggleOrder() {},
    metaOf: (id) => ({ favorite: id === "N1", tags: id === "N1" ? ["회의", "Q3"] : [], folder: id === "N1" ? "F2" : null }),
    setFavorite: noop, setTags: noop, moveNote: noop, createFolder: async () => null, renameFolder: noop, moveFolder: noop, deleteFolder: noop, tagFocus: null, requestTagFocus() {},
    ...over,
  };
};
const render = (el: ReturnType<typeof createElement>, v = value()) => renderToStaticMarkup(createElement(OrganizeContext.Provider, { value: v }, el));

describe("sidebar library", () => {
  test("renders sections, favorites, folders, tags and the list", () => {
    const t0 = performance.now();
    const html = render(createElement(NoteLibrary, { notes, activeId: "N2", onOpen() {} }));
    const ms = performance.now() - t0;
    expect(html).toContain("즐겨찾기");
    expect(html).toContain("업무");
    expect(html).toContain("폴더 없음");
    expect(html).toContain('aria-label="노트 순서"');
    expect(html).toContain("전체 노트");
    expect(html).toContain("2002"); // 전체 노트 수
    expect(html).toContain('aria-pressed="false"');
    expect(html.match(/class="note-row[ "]/g)?.length).toBe(2002 + 1); // 목록 + 즐겨찾기 한 줄
    expect(ms).toBeLessThan(2000);
  });
  test("shows the filter summary and the empty message", () => {
    const html = render(createElement(NoteLibrary, { notes, activeId: null, onOpen() {} }), value({ filter: { query: "없는제목", tags: ["회의"], folder: "F1" } }));
    expect(html).toContain("폴더: 업무 / 프로젝트".replace(" / 프로젝트", ""));
    expect(html).toContain("태그: 회의");
    expect(html).toContain("조건에 맞는 노트가 없습니다.");
  });
  test("renders nothing for an empty home", () => {
    expect(render(createElement(NoteLibrary, { notes: [], activeId: null, onOpen() {} }), value({ folders: [], tree: [] }))).toBe("");
  });
});

describe("note header", () => {
  test("favorite toggle is pressed, folder path and tags show", () => {
    const html = render(createElement(NoteOrganizer, { id: "N1" }));
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("업무 / 프로젝트");
    expect(html).toContain("태그 회의 빼기");
  });
  test("no folder, no tags", () => {
    const html = render(createElement(NoteOrganizer, { id: "N2" }));
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("폴더 없음");
    expect(html).toContain("태그 추가 (Enter 또는 쉼표)");
  });
});
