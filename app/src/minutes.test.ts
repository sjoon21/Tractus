import { describe, expect, test } from "vitest";
import { missing, parseShown, setActionField, setLine, whoOf, type Minutes } from "./minutes";

const M: Minutes = {
  agenda: "안건",
  topics: [
    {
      title: "해외 카드",
      open: false,
      discussed: [{ text: "환율 하루 1회", segment_ids: ["s0003"] }],
      agreed: [{ text: "2.1에서 다시 봄", segment_ids: ["s0005"] }],
      points: [{ label: "기술적 이슈", details: [{ text: "계약 아직", segment_ids: ["s0003"], children: [{ text: "공급사", segment_ids: ["s0003"] }] }] }],
      approach: [],
    },
  ],
  actions: [{ text: "문서 정리", segment_ids: ["s0021"], team: "정산팀", owner: "김지훈", due: null, note: null }],
  next_meeting: [],
};

describe("parseShown", () => {
  test("reads the core's show output and keeps number marks", () => {
    const raw = { minutes: { ...M, topics: [{ ...M.topics[0], agreed: [{ text: "12개", segment_ids: ["s0002"], unverified: ["12"] }] }] }, attendees: ["기획팀"], title: "T", generated_at: "g", edited_at: null, markdown: "# T", short: "[회의록] T" };
    const s = parseShown(raw)!;
    expect(s.minutes.topics[0].agreed[0].unverified).toEqual(["12"]);
    expect(s.minutes.actions[0]).toMatchObject({ team: "정산팀", owner: "김지훈", due: null });
    expect([s.attendees, s.edited_at, s.markdown, s.short]).toEqual([["기획팀"], null, "# T", "[회의록] T"]);
  });

  test("no minutes or a broken shape is null", () => {
    expect(parseShown({ minutes: null })).toBeNull();
    expect(parseShown("x")).toBeNull();
  });
});

describe("editing fields", () => {
  test("setLine changes one line and leaves the original alone", () => {
    const next = setLine(M, { kind: "child", topic: 0, point: 0, i: 0, child: 0 }, "공급사 계약");
    expect(next.topics[0].points[0].details[0].children[0]).toEqual({ text: "공급사 계약", segment_ids: ["s0003"] });
    expect(M.topics[0].points[0].details[0].children[0].text).toBe("공급사");
    expect(setLine(M, { kind: "agreed", topic: 0, i: 0 }, "").topics[0].agreed[0].text).toBe(""); // 비우면 코어가 지운다
    expect(setLine(M, { kind: "title", topic: 0 }, "해외 결제").topics[0].title).toBe("해외 결제");
  });

  test("the owner field is one box: what the person typed replaces team and name", () => {
    const next = setActionField(M, 0, "who", " 박서연 ");
    expect([next.actions[0].owner, next.actions[0].team, whoOf(next.actions[0])]).toEqual(["박서연", null, "박서연"]);
    expect(setActionField(M, 0, "due", "금요일").actions[0].due).toBe("금요일");
    expect(setActionField(M, 0, "due", "  ").actions[0].due).toBeNull();
  });

  test("missing counts to-dos without an owner or a due date", () => {
    expect(whoOf(M.actions[0])).toBe("정산팀 · 김지훈");
    expect(missing(M)).toBe(1);
    expect(missing(setActionField(M, 0, "due", "금요일"))).toBe(0);
  });
});
