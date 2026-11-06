import { describe, expect, test } from "vitest";
import type { MeetingInfo } from "./api";
import { actionMatches, paletteSections, pickable, RECENT_NOTES, step, type PaletteAction, type PaletteItem } from "./palette";

const note = (id: string, title: string, updated: string) => ({ id, title, created_at: "2026-10-01T00:00:00", updated_at: updated }) as MeetingInfo;
const NOTES = [note("a", "4분기 예산 및 OKR", "2026-10-21"), note("b", "3분기 예산 계획", "2026-10-30"), note("c", "주간 회고", "2026-10-25")]; // words-ok: 가상 노트 제목
const act = (id: string, label: string, extra: Partial<PaletteAction> = {}): PaletteAction => ({ id, label, run: () => {}, ...extra });
const ACTIONS = [act("record", "녹음 시작"), act("write", "글쓰기", { keywords: "메모 new" }), act("dict", "사전", { keywords: "vocabulary" })];

describe("묶음", () => {
  test("빈 입력: 최근에 고친 노트부터 + 모든 동작, 찾기는 없다", () => {
    const s = paletteSections(NOTES, ACTIONS, "  ");
    expect(s.map((x) => x.title)).toEqual(["최근 노트", "동작"]);
    expect(s[0].items.map((i) => (i.kind === "note" ? i.note.id : ""))).toEqual(["b", "c", "a"]);
    expect(s[1].items).toHaveLength(3);
    const many = Array.from({ length: 9 }, (_, i) => note(`n${i}`, `노트 ${i}`, `2026-10-0${i + 1}`));
    expect(paletteSections(many, [], "")[0].items).toHaveLength(RECENT_NOTES);
  });

  test("입력: 제목이 맞는 노트와 동작, 맨 끝에 내용 찾기. 빈 묶음은 뺀다", () => {
    const s = paletteSections(NOTES, ACTIONS, "예산");
    expect(s.map((x) => x.title)).toEqual(["노트", "찾기"]);
    expect(s[0].items).toHaveLength(2);
    expect(s[1].items).toEqual([{ kind: "search", q: "예산" }]);
    expect(paletteSections(NOTES, ACTIONS, "메모").map((x) => x.title)).toEqual(["동작", "찾기"]); // 찾기 말로도 맞는다
  });

  test("이 노트의 동작은 맨 앞에, 폴더·태그는 입력이 있을 때만 동작 뒤에", () => {
    const mine = [act("favorite", "즐겨찾기에 추가"), act("export-md", "내보내기: Markdown", { keywords: "md" })];
    const jumps = [act("folder-1", "프로젝트/예산"), act("tag-x", "#회고")];
    expect(paletteSections(NOTES, ACTIONS, "", mine, jumps).map((x) => x.title)).toEqual(["이 노트", "최근 노트", "동작"]);
    expect(paletteSections(NOTES, ACTIONS, "예산", mine, jumps).map((x) => x.title)).toEqual(["노트", "폴더·태그", "찾기"]);
    const rare = act("export-srt", "내보내기: SRT 자막", { typed: true });
    expect(paletteSections(NOTES, ACTIONS, "", [...mine, rare])[0].items).toHaveLength(2); // 찾을 때만 나온다
    expect(paletteSections(NOTES, ACTIONS, "srt", [...mine, rare])[0].items).toHaveLength(1);
    const md = paletteSections(NOTES, ACTIONS, "md", mine, jumps);
    expect(md[0].title).toBe("이 노트");
    expect(md[0].items.map((i) => (i.kind === "action" ? i.action.id : ""))).toEqual(["export-md"]);
  });

  test("동작은 이름·찾기 말에 낱말이 모두 있어야 맞는다 (대소문자 무시)", () => {
    expect(actionMatches(ACTIONS[2], "VOCAB")).toBe(true);
    expect(actionMatches(ACTIONS[0], "녹음 시작")).toBe(true);
    expect(actionMatches(ACTIONS[0], "녹음 끝")).toBe(false);
  });
});

describe("키보드 고르기", () => {
  const items: PaletteItem[] = [{ kind: "action", action: act("x", "x", { blocked: "이미 녹음 중입니다" }) }, { kind: "search", q: "a" }, { kind: "action", action: act("y", "y") }];
  test("할 수 없는 동작은 건너뛰고, 끝에서는 반대쪽으로 돈다", () => {
    expect(pickable(items[0])).toBe(false);
    expect(step(items, -1, 1)).toBe(1);
    expect(step(items, 2, 1)).toBe(1);
    expect(step(items, 1, -1)).toBe(2);
  });
  test("고를 것이 없으면 -1", () => {
    expect(step([items[0]], -1, 1)).toBe(-1);
    expect(step([], -1, 1)).toBe(-1);
  });
});
