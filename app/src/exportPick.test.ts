import { describe, expect, test } from "vitest";
import { exportItems, exportSelection, initialPick, loadPicks, mergePicks, parsePicks, savePicks, type ExportHas } from "./exportPick";
import type { SummaryDoc, TemplateInfo } from "./summaries";

const doc = (key: string, name: string, kind: "enhanced" | null = null): SummaryDoc => ({
  key, name, title: "", overview: "", sections: [], legacy: null, provider: null, model: null, prompt: null, template: key, kind,
});
const tpl = (id: string): TemplateInfo => ({ id, name: id, description: "", prompt: "", builtin: true });
const ALL: ExportHas = { memoNote: false, transcript: true, memo: true, marks: true };

describe("exportItems", () => {
  test("회의록 → 완성된 노트 → 이전 형식 → 요약 탭 순서 → 대화 내용 → 메모 → 녹음 중 메모", () => {
    const docs = [doc("c-0000000a", "직접 요약"), doc("todo", "할 일 중심"), doc("enhanced", "노트 완성", "enhanced"), doc("meeting", "회의록"), doc("brief", "핵심 요약"), doc("minutes", "회의록"), doc("c-0000000b", "직접 요약")];
    const items = exportItems(docs, [tpl("meeting"), tpl("brief"), tpl("todo")], ALL);
    expect(items.map((i) => [i.id, i.label])).toEqual([
      ["minutes", "회의록"],
      ["enhanced", "완성된 노트"],
      ["meeting", "이전 형식의 회의록"],
      ["brief", "핵심 요약"],
      ["todo", "할 일 중심"],
      ["c-0000000a", "직접 요약"],
      ["c-0000000b", "직접 요약 2"],
      ["transcript", "대화 내용"],
      ["memo", "메모"],
      ["marks", "녹음 중 메모"],
    ]);
    expect(items.filter((i) => i.summary).map((i) => i.kind)).toEqual(["minutes", "enhanced", "meeting", "brief", "todo", "custom", "custom"]);
  });

  test("없는 것은 빼고, 메모 노트는 메모 내용", () => {
    expect(exportItems([], [], { memoNote: true, transcript: true, memo: false, marks: false }).map((i) => i.label)).toEqual(["메모 내용"]);
    expect(exportItems([], [], { memoNote: false, transcript: false, memo: false, marks: true }).map((i) => i.id)).toEqual(["marks"]); // 변환 전 노트
    expect(exportItems([], [], { memoNote: false, transcript: false, memo: false, marks: false })).toEqual([]);
  });
});

describe("선택", () => {
  const items = exportItems([doc("brief", "핵심 요약"), doc("c-0000000a", "직접 요약")], [tpl("brief")], ALL);

  test("처음에는 모두, 지난번에 끈 종류만 뺀다", () => {
    expect([...initialPick(items, {})]).toEqual(["brief", "c-0000000a", "transcript", "memo", "marks"]);
    expect([...initialPick(items, { custom: false, marks: false, brief: true })]).toEqual(["brief", "transcript", "memo"]);
  });

  test("코어 인수는 항목 순서대로 요약과 부분으로 나눈다", () => {
    expect(exportSelection(items, new Set(["marks", "c-0000000a", "transcript"]))).toEqual({ summaries: ["c-0000000a"], parts: ["transcript", "marks"] });
    expect(exportSelection(items, new Set(["brief"]))).toEqual({ summaries: ["brief"], parts: [] });
  });

  test("기억: 보인 종류만 덮어쓰고, 깨진 값은 버린다", () => {
    expect(mergePicks({ minutes: false, memo: true }, items, new Set(["brief"]))).toEqual({ minutes: false, memo: false, brief: true, custom: false, transcript: false, marks: false });
    expect(parsePicks('{"memo": false, "x": 1}')).toEqual({ memo: false });
    expect(parsePicks("[1]")).toEqual({});
    expect(parsePicks("{")).toEqual({});
    expect(parsePicks(null)).toEqual({});
  });

  test("저장소가 없거나 막혀도 던지지 않는다", () => {
    const data = new Map<string, string>();
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    savePicks(items, new Set(["memo"]), store);
    expect(loadPicks(store)).toMatchObject({ memo: true, transcript: false, brief: false });
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(loadPicks(broken)).toEqual({});
    expect(() => savePicks(items, new Set(), broken)).not.toThrow();
    expect(loadPicks(null)).toEqual({});
  });
});
