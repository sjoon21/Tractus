import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { OK } from "../../caps";
import { EventRow } from "./WeekStrip";

const ev = { id: "E1", title: "주간 점검", start: "2026-11-05T15:00:00", end: "2026-11-05T16:00:00", calendar: "회사", attendees: [], notes: [] };
const row = (noRecord?: boolean) => renderToStaticMarkup(<EventRow ev={ev} now={new Date(2026, 10, 5, 14, 30)} gate={OK} recording={false} noRecord={noRecord} onRecord={() => {}} onPrepare={() => {}} />);

test("홈 위쪽 곧 시작 칸에 이미 녹음 단추가 있는 일정은 이번 주 줄에서 단추를 뺀다", () => {
  expect(row()).toContain("이 일정으로 녹음");
  expect(row(true)).not.toContain("이 일정으로 녹음");
  expect(row(true)).toContain("주간 점검");
});
