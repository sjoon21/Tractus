import { describe, expect, test } from "vitest";
import { printDoc } from "./print";

const base = {
  info: { title: "주간 개발 회의", created_at: "2026-10-02T14:05:00+09:00", duration_sec: 3723 },
  speakers: { S1: { name: "김민수" }, S2: { name: null } },
  segments: [
    { id: "s0001", start: 0, end: 10, text: "시작합니다", speaker: "S1" },
    { id: "s0002", start: 10, end: 20, text: "예산은 3억", corrected_text: "예산은 3억 원", speaker: "S1" },
    { id: "s0003", start: 331, end: 340, text: "동의합니다", speaker: "S2" },
    { id: "s0004", start: 340, end: 350, text: "누군가", speaker: null },
  ],
  summary: {
    summary: "예산을 정했다.",
    topics: [{ title: "예산", segment_ids: ["s0002"] }],
    decisions: [{ text: "예산 3억", segment_ids: ["s0003", "s0002"] }],
    action_items: [{ task: "견적 받기", owner: "김민수", due: "10/9", segment_ids: [] }],
  },
};

describe("PDF 인쇄 문서", () => {
  test("머리말: 제목·날짜(회의 현지 시각)·길이·화자", () => {
    const d = printDoc(base);
    expect(d.title).toBe("주간 개발 회의");
    expect(d.date).toBe("2026년 10월 2일 (금) 14:05");
    expect(d.duration).toBe("1:02:03");
    expect(d.speakers).toEqual(["김민수", "참석자 2"]);
  });
  test("전사: 시각 + 발언이 바뀔 때만 화자 + 고친 문장", () => {
    expect(printDoc(base).rows).toEqual([
      { id: "s0001", time: "0:00", speaker: "김민수", text: "시작합니다" },
      { id: "s0002", time: "0:10", speaker: null, text: "예산은 3억 원" },
      { id: "s0003", time: "5:31", speaker: "참석자 2", text: "동의합니다" },
      { id: "s0004", time: "5:40", speaker: "알 수 없음", text: "누군가" },
    ]);
  });
  test("요약: 항목마다 가장 이른 근거 시각, 근거 없으면 null", () => {
    const s = printDoc(base).summary!;
    expect(s.lead).toBe("예산을 정했다.");
    expect(s.decisions).toEqual([{ text: "예산 3억", at: "0:10" }]);
    expect(s.actions).toEqual([{ text: "견적 받기", meta: "김민수 · 10/9", at: null }]);
    expect(s.topics).toEqual([{ text: "예산", at: "0:10" }]);
  });
  test("화자 없는 회의·요약 없는 회의·제목 없는 회의", () => {
    const d = printDoc({ ...base, info: { ...base.info, title: "", created_at: "" }, speakers: {}, summary: null, segments: [{ id: "s0001", start: 0, end: 1, text: "a" }] });
    expect(d.title).toBe("제목 없음");
    expect(d.date).toBe("");
    expect(d.speakers).toEqual([]);
    expect(d.summary).toBeNull();
    expect(d.rows).toEqual([{ id: "s0001", time: "0:00", speaker: null, text: "a" }]);
  });
});
