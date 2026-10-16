import { describe, expect, it } from "vitest";
import { enhancedView, findEnhanced, memoTabShowing } from "./enhanced";
import { parseSummaryDoc, parseSummaryDocs, rerunSpec } from "./summaries";

const raw = {
  key: "enhanced",
  kind: "enhanced",
  template: "enhanced",
  template_name: "노트 완성",
  title: "주간 개발",
  overview: "",
  sections: [
    { heading: "예산 다시 확인", part: "memo", source: "m0001", style: "bullets", items: [{ text: "p95 800ms", segment_ids: ["s0002"], owner: null, due: null }] },
    { heading: "북마크 1:35", part: "memo", source: "r0002", at: 95, style: "bullets", items: [] },
    { heading: "릴리스 일정", part: "extra", source: null, style: "bullets", items: [{ text: "다음 릴리스", segment_ids: ["s0005"], owner: null, due: null }] },
    { heading: "할 일", part: "todos", source: null, style: "checklist", items: [{ text: "분석 공유", segment_ids: ["s0004"], owner: "김민수", due: "수요일" }] },
  ],
};

describe("노트 완성 문서", () => {
  it("reads kind, part, source and at; other summaries keep them undefined", () => {
    const d = parseSummaryDoc(raw)!;
    expect(d.kind).toBe("enhanced");
    expect(d.sections.map((s) => [s.part, s.source, s.at])).toEqual([
      ["memo", "m0001", undefined],
      ["memo", "r0002", 95],
      ["extra", undefined, undefined],
      ["todos", undefined, undefined],
    ]);
    const plain = parseSummaryDoc({ key: "brief", sections: [{ heading: "핵심", style: "bullets", items: [], part: "weird", at: -3 }] })!;
    expect(plain.kind).toBeNull();
    expect(plain.sections[0]).toEqual({ heading: "핵심", style: "bullets", items: [] });
  });

  it("groups sections for the memo tab and finds the enhanced doc among summaries", () => {
    const docs = parseSummaryDocs([{ key: "meeting", summary: "x" }, raw]);
    const d = findEnhanced(docs)!;
    const v = enhancedView(d);
    expect(v.memo.map((s) => s.heading)).toEqual(["예산 다시 확인", "북마크 1:35"]);
    expect(v.extra.map((s) => s.heading)).toEqual(["릴리스 일정"]);
    expect(v.todos[0].items[0].owner).toBe("김민수");
    expect(v.noMemo).toBe(false);
    expect(findEnhanced(docs.filter((x) => x.kind !== "enhanced"))).toBeNull();
    expect(enhancedView({ ...d, sections: d.sections.filter((s) => s.part !== "memo") }).noMemo).toBe(true);
  });

  it("can be made again from the summary tab even though it is not in the template list", () => {
    expect(rerunSpec(parseSummaryDoc(raw)!, [])).toEqual({ template: "enhanced", label: "노트 완성", key: "enhanced" });
  });

  it("shows my memo when a memo line is requested after the last view change, otherwise the chosen view", () => {
    expect(memoTabShowing(false, "done", 0, null)).toBe("mine"); // 아직 없으면 언제나 내 메모
    expect(memoTabShowing(true, "done", 0, null)).toBe("done");
    expect(memoTabShowing(true, "done", 0, { segId: null, nonce: 50 })).toBe("done"); // 탭을 눌러 연 것은 줄 요청이 아니다
    expect(memoTabShowing(true, "done", 100, { segId: "m0003", nonce: 200 })).toBe("mine"); // 칩으로 줄을 가리킴
    expect(memoTabShowing(true, "done", 300, { segId: "m0003", nonce: 200 })).toBe("done"); // 그 뒤 사용자가 완성된 노트로 바꿈
    expect(memoTabShowing(true, "mine", 300, null)).toBe("mine");
  });
});
