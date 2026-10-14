import { describe, expect, test } from "vitest";
import { IDLE_QUEUE, queueAdvance, queueFail, queueLabel, queueStart } from "./summaryQueue";
import type { SummarySpec } from "./summaries";

const spec = (key: string, label = key): SummarySpec => ({ template: key, label, key });
const [A, B, C] = [spec("brief", "핵심 요약"), spec("todo", "할 일 중심"), spec("ideas", "아이디어 정리")];

describe("여러 유형 한 번에 만들기", () => {
  test("차례대로 하나씩: 첫 번째가 지금 것, 나머지는 기다린다", () => {
    const s = queueStart(IDLE_QUEUE, [A, B, C]);
    expect(s).toEqual({ current: A, pending: [B, C], finished: 0, total: 3, failed: null });
    expect(queueLabel(s)).toBe("1 / 3 · 핵심 요약");
  });
  test("끝날 때마다 다음으로, 마지막이 끝나면 쉰다", () => {
    let s = queueStart(IDLE_QUEUE, [A, B, C]);
    s = queueAdvance(s);
    expect(s.current).toBe(B);
    expect(queueLabel(s)).toBe("2 / 3 · 할 일 중심");
    s = queueAdvance(queueAdvance(s));
    expect(s).toEqual({ current: null, pending: [], finished: 3, total: 3, failed: null });
    expect(queueLabel(s)).toBeNull();
    expect(queueAdvance(s)).toBe(s);
  });
  test("하나만 만들면 번호 없이 이름만", () => {
    expect(queueLabel(queueStart(IDLE_QUEUE, [A]))).toBe("핵심 요약");
  });
  test("실패하면 남은 것은 돌리지 않고, 실패한 것을 알린다", () => {
    const s = queueFail(queueAdvance(queueStart(IDLE_QUEUE, [A, B, C])));
    expect(s).toEqual({ current: null, pending: [], finished: 1, total: 3, failed: B });
    expect(queueFail(s)).toBe(s);
  });
  test("돌고 있을 때 새로 시작하지 않는다, 빈 목록도 무시", () => {
    const s = queueStart(IDLE_QUEUE, [A, B]);
    expect(queueStart(s, [C])).toBe(s);
    expect(queueStart(IDLE_QUEUE, [])).toBe(IDLE_QUEUE);
  });
  test("실패한 뒤에는 새로 시작할 수 있다 (실패 표시는 지워진다)", () => {
    const failed = queueFail(queueStart(IDLE_QUEUE, [A]));
    expect(queueStart(failed, [B])).toEqual({ current: B, pending: [], finished: 0, total: 1, failed: null });
  });
});
