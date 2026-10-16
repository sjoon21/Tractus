import { describe, expect, test } from "vitest";
import { attendeeLine, eventWhen } from "./calendar";
import { unusedNames } from "./Speakers";

describe("곧 시작하는 일정 카드", () => {
  const at = (hhmm: string) => new Date(`2026-10-16T${hhmm}:00`);
  const ev = { start: at("10:00").toISOString(), end: at("11:00").toISOString() };
  test("시각과 진행 중·N분 뒤·곧 시작", () => {
    expect(eventWhen(ev, at("10:20"))).toBe("10:00–11:00 · 진행 중");
    expect(eventWhen(ev, at("10:00"))).toBe("10:00–11:00 · 진행 중");
    expect(eventWhen(ev, at("09:55"))).toBe("10:00–11:00 · 5분 뒤");
    expect(eventWhen(ev, new Date(at("10:00").getTime() - 30_000))).toBe("10:00–11:00 · 곧 시작");
  });
  test("참석자는 둘까지 이름, 나머지는 수", () => {
    expect(attendeeLine([])).toBeNull();
    expect(attendeeLine(["김민수"])).toBe("김민수");
    expect(attendeeLine(["김민수", "이지은", "박소연", "최도윤"])).toBe("김민수, 이지은 외 2명");
  });
});

test("일정 참석자 중 이미 다른 참석자에게 붙인 이름은 고르기에서 뺀다", () => {
  const stats = [{ named: true, display: "김민수" }, { named: false, display: "참석자 2" }];
  expect(unusedNames(["김민수", "이지은", "참석자 2"], stats)).toEqual(["이지은", "참석자 2"]);
});
