import { describe, expect, it } from "vitest";
import type { Segment } from "./lib";
import { bulkAcceptIds, livePolish, nextSuggestion, pendingIds, suggestionMarks, termsFromSuggestions, wordDiff, type PolishSuggestion } from "./polish";

const seg = (id: string, text: string, corrected: string | null = null): Segment => ({ id, start: 0, end: 1, text, corrected_text: corrected });
const sug = (id: string, before: string, text: string, flags: string[] = []): PolishSuggestion => ({ id, start: 0, before, text, kind: "term", flags });

describe("livePolish", () => {
  it("keeps only suggestions whose line has not changed since", () => {
    const segs = [seg("s0001", "원술로지"), seg("s0002", "인시덤", "인시던트 등록")];
    const live = livePolish(segs, [sug("s0001", "원술로지", "온톨로지"), sug("s0002", "인시덤", "인시던트"), sug("s0009", "x", "y")]);
    expect([...live.keys()]).toEqual(["s0001"]);
  });
});

describe("bulkAcceptIds", () => {
  it("skips flagged suggestions", () => {
    const live = livePolish([seg("s0001", "a"), seg("s0002", "b")], [sug("s0001", "a", "A"), sug("s0002", "b", "B 30", ["number"])]);
    expect(bulkAcceptIds(live)).toEqual(["s0001"]);
  });
});

describe("wordDiff", () => {
  it("marks replaced words as delete then insert", () => {
    expect(wordDiff("이 로고를 보고 인계치를 넘으면", "이 로그를 보고 임계치를 넘으면")).toEqual([
      { op: "same", text: "이" },
      { op: "del", text: "로고를" },
      { op: "ins", text: "로그를" },
      { op: "same", text: "보고" },
      { op: "del", text: "인계치를" },
      { op: "ins", text: "임계치를" },
      { op: "same", text: "넘으면" },
    ]);
  });
  it("groups multi-word rewrites", () => {
    expect(wordDiff("김건지 너무 용롱만 쿼리", "임계치 넘은 목록만 쿼리")).toEqual([
      { op: "del", text: "김건지 너무 용롱만" },
      { op: "ins", text: "임계치 넘은 목록만" },
      { op: "same", text: "쿼리" },
    ]);
  });
});

describe("pendingIds", () => {
  it("is every line outside the finished ranges", () => {
    const segs = ["s0001", "s0002", "s0003", "s0004"].map((i) => seg(i, i));
    expect([...pendingIds(segs, [])]).toEqual(["s0001", "s0002", "s0003", "s0004"]);
    expect([...pendingIds(segs, [["s0003", "s0004"]])]).toEqual(["s0001", "s0002"]);
  });
});

describe("termsFromSuggestions", () => {
  it("collects corrected terms from term and name suggestions, even with filler and punctuation fixes", () => {
    const list = [
      { before: "어 그 원술로지 기반으로 묶어요", text: "온톨로지 기반으로 묶어요.", kind: "term" },
      { before: "인시덤 등록하고 쿠버 네티스도", text: "인시던트 등록하고 쿠버네티스도.", kind: "term" },
      { before: "그 그러니까 되요", text: "그러니까 돼요.", kind: "style" },
      { before: "원술로지 다시", text: "온톨로지 다시", kind: "term" },
    ];
    expect(termsFromSuggestions(list)).toEqual(["온톨로지", "인시던트", "쿠버네티스"]);
  });
});

describe("nextSuggestion·suggestionMarks", () => {
  const segs = ["a", "b", "c", "d"].map((x, i) => seg(`s000${i + 1}`, x));
  const live = livePolish(segs, [sug("s0002", "b", "B"), sug("s0004", "d", "D")]);
  it("정한 줄 다음 제안으로 가고, 끝이면 처음으로 돌아간다", () => {
    expect(nextSuggestion(segs, live)).toBe("s0002");
    expect(nextSuggestion(segs, live, "s0002")).toBe("s0004");
    expect(nextSuggestion(segs, live, "s0003")).toBe("s0004"); // 방금 정해 목록에서 빠진 줄 기준
    expect(nextSuggestion(segs, live, "s0004")).toBe("s0002");
  });
  it("남은 제안이 없으면 undefined", () => {
    expect(nextSuggestion(segs, new Map(), "s0001")).toBeUndefined();
  });
  it("눈금은 문장 순서의 상대 위치", () => {
    expect(suggestionMarks(segs, live)).toEqual([
      { id: "s0002", at: 0.375 },
      { id: "s0004", at: 0.875 },
    ]);
  });
});
