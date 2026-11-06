import { describe, expect, test } from "vitest";
import type { MeetingInfo } from "./api";
import { addDays, dayNotes, groupWeek, linked, recordable, weekDays, weekStart, ymd, type WeekEvent } from "./week";

const ev = (title: string, start: string, end: string, all_day = false): WeekEvent => ({ id: title, title, start, end, calendar: "회사", attendees: [], all_day });
const note = (id: string, created_at: string) => ({ id, title: id, created_at }) as MeetingInfo;

describe("주", () => {
  test("주는 월요일 0시부터 7일이다 (일요일은 그 주의 마지막 날)", () => {
    expect(ymd(weekStart(new Date(2026, 10, 5, 15)))).toBe("2026-11-02"); // 목요일
    expect(ymd(weekStart(new Date(2026, 10, 8, 23)))).toBe("2026-11-02"); // 일요일
    expect(ymd(weekStart(new Date(2026, 10, 2, 0)))).toBe("2026-11-02");
    expect(weekDays(new Date(2026, 9, 26))).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
    expect(ymd(addDays(new Date(2026, 11, 28), 7))).toBe("2027-01-04");
  });
});

describe("날마다 묶기", () => {
  const days = weekDays(new Date(2026, 10, 2));
  test("일정은 걸친 날마다, 노트는 만든 날에 (주 밖은 뺀다)", () => {
    const events = [
      ev("스탠드업", "2026-11-03T09:30:00", "2026-11-03T10:00:00"),
      ev("워크숍", "2026-11-05T00:00:00", "2026-11-07T00:00:00", true), // 종일 이틀: 목·금
      ev("지난주", "2026-10-30T10:00:00", "2026-10-30T11:00:00"),
    ];
    const notes = [note("b", "2026-11-03T15:00:00"), note("a", "2026-11-03T08:00:00"), note("old", "2026-10-01T08:00:00")];
    const g = groupWeek(days, events, notes);
    expect(g.get("2026-11-03")!.events.map((e) => e.title)).toEqual(["스탠드업"]);
    expect(g.get("2026-11-03")!.notes.map((n) => n.id)).toEqual(["a", "b"]); // 이른 것부터
    expect(days.filter((d) => g.get(d)!.events.some((e) => e.title === "워크숍"))).toEqual(["2026-11-05", "2026-11-06"]);
    expect([...g.values()].flatMap((d) => d.events).some((e) => e.title === "지난주")).toBe(false);
  });
});

describe("일정과 노트 잇기", () => {
  const days = weekDays(new Date(2026, 10, 2));
  const standup = { ...ev("스탠드업", "2026-11-03T09:30:00+09:00", "2026-11-03T10:00:00+09:00"), id: "E1" };
  const withEvent = (id: string, event: MeetingInfo["event"]) => ({ ...note(id, "2026-11-03T09:31:00"), event }) as MeetingInfo;

  test("시작 시각이 같고 일정 ID가 같으면 (ID가 없는 옛 노트는 제목이 같으면) 이어진다", () => {
    expect(linked(standup, withEvent("a", { id: "E1", title: "이름을 바꿈", start: "2026-11-03T00:30:00Z" }))).toBe(true); // 같은 순간이면 표기가 달라도
    expect(linked(standup, withEvent("b", { title: "스탠드업", start: "2026-11-03T09:30:00+09:00" }))).toBe(true);
    expect(linked(standup, withEvent("c", { id: "E2", title: "스탠드업", start: "2026-11-03T09:30:00+09:00" }))).toBe(false); // 다른 일정
    expect(linked(standup, withEvent("d", { id: "E1", title: "스탠드업", start: "2026-11-10T09:30:00+09:00" }))).toBe(false); // 반복 일정의 다른 회차
    expect(linked(standup, note("e", "2026-11-03T09:31:00"))).toBe(false);
  });

  test("이어진 노트는 일정 아래로 가고 그날 노트 목록에서는 빠진다 (개수는 그대로)", () => {
    const g = groupWeek(days, [standup], [withEvent("a", { id: "E1", title: "스탠드업", start: "2026-11-03T09:30:00+09:00" }), note("b", "2026-11-03T15:00:00")]).get("2026-11-03")!;
    expect(g.events[0].notes.map((n) => n.id)).toEqual(["a"]);
    expect(g.notes.map((n) => n.id)).toEqual(["b"]);
    expect(dayNotes(g)).toBe(2);
  });
});

test("녹음 단추는 오늘 시작해 아직 끝나지 않은 일정에만 (종일 제외)", () => {
  const now = new Date(2026, 10, 5, 14, 30);
  expect(recordable(ev("진행 중", "2026-11-05T14:00:00", "2026-11-05T15:00:00"), now)).toBe(true);
  expect(recordable(ev("이따", "2026-11-05T17:00:00", "2026-11-05T18:00:00"), now)).toBe(true);
  expect(recordable(ev("끝남", "2026-11-05T09:00:00", "2026-11-05T10:00:00"), now)).toBe(false);
  expect(recordable(ev("내일", "2026-11-06T09:00:00", "2026-11-06T10:00:00"), now)).toBe(false);
  expect(recordable(ev("종일", "2026-11-05T00:00:00", "2026-11-06T00:00:00", true), now)).toBe(false);
});
