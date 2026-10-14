import { describe, expect, test } from "vitest";
import { convertAdvance, convertEnqueue, convertProgress, convertSlot, IDLE_CONVERT } from "./convertQueue";

describe("변환 줄", () => {
  test("쉬는 중에 올리면 첫 노트가 바로 차례다", () => {
    expect(convertEnqueue(IDLE_CONVERT, ["a", "b", "c"])).toEqual({ current: "a", pending: ["b", "c"], finished: 0, total: 3 });
    expect(convertEnqueue(IDLE_CONVERT, ["a"])).toEqual({ current: "a", pending: [], finished: 0, total: 1 });
  });

  test("빈 목록·이미 줄에 있는 노트·중복은 더하지 않는다", () => {
    expect(convertEnqueue(IDLE_CONVERT, [])).toBe(IDLE_CONVERT);
    const s = convertEnqueue(IDLE_CONVERT, ["a", "b"]);
    expect(convertEnqueue(s, ["a", "b"])).toBe(s);
    expect(convertEnqueue(IDLE_CONVERT, ["a", "a", "b", "a"])).toMatchObject({ current: "a", pending: ["b"], total: 2 });
  });

  test("도는 중에 더하면 뒤에 붙고 전체 수가 는다", () => {
    const s = convertEnqueue(convertEnqueue(IDLE_CONVERT, ["a", "b"]), ["b", "c"]);
    expect(s).toEqual({ current: "a", pending: ["b", "c"], finished: 0, total: 3 });
  });

  test("차례대로 넘어가고, 끝나면 쉰다", () => {
    let s = convertEnqueue(IDLE_CONVERT, ["a", "b", "c"]);
    s = convertAdvance(s);
    expect(s).toEqual({ current: "b", pending: ["c"], finished: 1, total: 3 });
    s = convertAdvance(s);
    expect(s).toEqual({ current: "c", pending: [], finished: 2, total: 3 });
    expect(convertAdvance(s)).toBe(IDLE_CONVERT);
    expect(convertAdvance(IDLE_CONVERT)).toBe(IDLE_CONVERT);
  });

  test("실패한 노트도 줄은 이어진다: 넘어가는 규칙이 성공과 같다 (실패 알림은 화면이 따로 한다)", () => {
    // 실패는 상태를 바꾸지 않고 advance만 부른다
    const s = convertAdvance(convertEnqueue(IDLE_CONVERT, ["bad", "good"]));
    expect(s.current).toBe("good");
  });

  test("쉰 뒤에 다시 올리면 새로 센다", () => {
    const done = convertAdvance(convertEnqueue(IDLE_CONVERT, ["a"]));
    expect(convertEnqueue(done, ["b"])).toEqual({ current: "b", pending: [], finished: 0, total: 1 });
  });

  test("노트의 자리: 지금 것은 돌면 running, 아직 시작 전이면 queued, 기다리는 것은 queued", () => {
    const s = convertEnqueue(IDLE_CONVERT, ["a", "b"]);
    expect(convertSlot(s, "a", true)).toBe("running");
    expect(convertSlot(s, "a", false)).toBe("queued");
    expect(convertSlot(s, "b", false)).toBe("queued");
    expect(convertSlot(s, "b", true)).toBe("queued"); // 돌고 있는 것은 a다
    expect(convertSlot(s, "z", true)).toBeNull();
    expect(convertSlot(IDLE_CONVERT, "a", false)).toBeNull();
  });

  test("진행 줄은 여럿일 때만 `n / 전체`", () => {
    expect(convertProgress(IDLE_CONVERT)).toBeNull();
    expect(convertProgress(convertEnqueue(IDLE_CONVERT, ["a"]))).toBeNull();
    const s = convertEnqueue(IDLE_CONVERT, ["a", "b", "c"]);
    expect(convertProgress(s)).toEqual({ n: 1, total: 3 });
    expect(convertProgress(convertAdvance(s))).toEqual({ n: 2, total: 3 });
  });
});
