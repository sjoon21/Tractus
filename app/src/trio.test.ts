// 세 기능이 함께 만든 홈(tests/fixtures/trio_home, 코어가 실제로 쓴 파일)을 앱 모델로 읽는다.
// list.json은 Rust 쪽 meetings.rs의 reads_the_trio_home_written_by_the_real_core가 같은 파일과 맞춰 본다.
import { describe, expect, test } from "vitest";
import type { MeetingInfo } from "./api";
import { collectTags, filterNotes, NO_FILTER, sortNotes, type Folder } from "./organize";
import { docMarkdown, parseSummaryDoc, parseSummaryDocs, tabLabels } from "./summaries";

const files = import.meta.glob("../../tests/fixtures/trio_home/**/*.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const json = (p: string) => JSON.parse(files[`../../tests/fixtures/trio_home/${p}`]);
const NOTES: MeetingInfo[] = json("list.json");
const FOLDERS: Folder[] = json("folders.json").folders;
const A = "01M4T7YEJWABPHP3GATPMX8MYT";
const OLD = "01LEGACY0000000000000000AB";
const noteDir = (id: string) => `meetings/${NOTES.find((n) => n.id === id)!.dir}`;
const withKey = (path: string, key: string) => ({ ...json(path), key });

describe("코어가 쓴 노트 목록", () => {
  test("녹음을 덧붙인 노트의 정리 정보와 수정 시각을 읽고, 옛 노트는 정리 정보 없이 읽는다", () => {
    const a = NOTES.find((n) => n.id === A)!;
    expect([a.kind, a.favorite, a.tags, a.folder]).toEqual(["recording", true, ["장보기", "급함"], FOLDERS[0].id]);
    expect((a.updated_at ?? "") > a.created_at).toBe(true);
    const old = NOTES.find((n) => n.id === OLD)!;
    expect([old.favorite, old.tags, old.folder, old.updated_at]).toEqual([false, [], null, old.created_at]);
  });

  test("순서·거르기·태그 모으기가 그 목록에서 돈다", () => {
    expect(sortNotes(NOTES, "updated", "desc").map((n) => n.id)).toEqual([A, OLD]);
    expect(sortNotes(NOTES, "created", "asc").map((n) => n.id)).toEqual([OLD, A]);
    expect(filterNotes(NOTES, { ...NO_FILTER, folder: FOLDERS[0].id, tags: ["급함"] }, FOLDERS).map((n) => n.id)).toEqual([A]);
    expect(filterNotes(NOTES, { ...NO_FILTER, folder: "none" }, FOLDERS).map((n) => n.id)).toEqual([OLD]);
    expect(collectTags(NOTES).map((t) => t.tag)).toEqual(expect.arrayContaining(["장보기", "급함"]));
  });
});

describe("코어가 쓴 요약 파일", () => {
  const docs = parseSummaryDocs([
    withKey(`${noteDir(A)}/summary.json`, "meeting"),
    withKey(`${noteDir(A)}/summaries/brief.json`, "brief"),
    withKey(`${noteDir(A)}/summaries/todo.json`, "todo"),
    withKey(`${noteDir(A)}/summaries/u-83fc6d3d.json`, "u-83fc6d3d"),
  ]);

  test("옛 스키마(회의록)와 새 스키마(유형별·내 유형)를 한 목록에서 읽는다", () => {
    expect(docs.map((d) => [d.key, d.legacy !== null, d.sections.length > 0])).toEqual([
      ["meeting", true, false],
      ["brief", false, true],
      ["todo", false, true],
      ["u-83fc6d3d", false, true],
    ]);
    expect(tabLabels(docs)).toEqual(["회의록", "핵심 요약", "할 일 중심", "한 문장 결정"]);
    expect(docs[3].prompt).toContain("한 문장");
    expect(docs[1].prompt).toBeNull(); // 기본 유형은 방법을 저장하지 않는다
  });

  test("녹음을 덧붙이며 옮긴 메모 줄 근거(m####)가 복사 문장에 `메모 n번째 줄`로 나온다", () => {
    const memo = new Map<string, number>(json(`${noteDir(A)}/transcript.json`).memo.lines.map((l: { id: string; line: number }) => [l.id, l.line]));
    const todo = docs.find((d) => d.key === "todo")!;
    expect(todo.sections[0].items.flatMap((i) => i.segment_ids)).toContain("m0002");
    expect(docMarkdown(todo, new Map(), memo)).toContain("메모 3번째 줄");
    expect(docMarkdown(docs[0], new Map(), memo)).toContain("메모 3번째 줄"); // 옛 스키마 요약도 같은 줄로 옮겨졌다
  });

  test("옛 노트의 옛 요약은 그대로 읽힌다", () => {
    const d = parseSummaryDoc(withKey(`${noteDir(OLD)}/summary.json`, "meeting"))!;
    expect([d.name, d.legacy?.decisions[0].text, d.sections]).toEqual(["회의록", "예산 확정", []]);
  });
});
