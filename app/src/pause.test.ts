import { describe, expect, test } from "vitest";
import { clockAt, PAUSED_STATUS, recButton, resumedStartMs } from "./pause";

const base = { phase: "idle" as const, t: 0, saving: false, converting: false, waiting: false };

describe("사이드바 녹음 단추", () => {
  test("쉬는 중은 `녹음 시작`", () => {
    expect(recButton(base)).toEqual({ text: "녹음 시작", time: null, live: false });
  });

  test("녹음 중은 시계와 함께, 붉은 점이 깜빡인다", () => {
    expect(recButton({ ...base, phase: "recording", t: 754 })).toEqual({ text: "녹음 중", time: "12:34", live: true });
    for (const phase of ["starting", "stopping"] as const) expect(recButton({ ...base, phase, t: 5 }).live).toBe(true);
  });

  test("일시정지는 `일시정지됨 12:34`이고 깜빡이지 않는다", () => {
    expect(recButton({ ...base, phase: "paused", t: 754 })).toEqual({ text: "일시정지됨", time: "12:34", live: false });
    expect(PAUSED_STATUS(754)).toBe("일시정지됨 12:34");
    expect(PAUSED_STATUS(3723)).toBe("일시정지됨 1:02:03");
  });

  test("끝낸 녹음을 묻는 중이면 `녹음 끝남` (녹음 중보다는 뒤, 저장·변환보다는 앞)", () => {
    expect(recButton({ ...base, asking: true })).toEqual({ text: "녹음 끝남", time: null, live: false });
    expect(recButton({ ...base, asking: true, saving: true, converting: true, waiting: true }).text).toBe("녹음 끝남");
    expect(recButton({ ...base, phase: "recording", t: 3, asking: true }).text).toBe("녹음 중");
  });

  test("녹음 단계가 저장·변환보다 먼저고, 저장 > 변환 > 변환 대기", () => {
    expect(recButton({ ...base, phase: "paused", saving: true, converting: true }).text).toBe("일시정지됨");
    expect(recButton({ ...base, saving: true, converting: true, waiting: true }).text).toBe("저장 중…");
    expect(recButton({ ...base, converting: true, waiting: true }).text).toBe("변환 중…");
    expect(recButton({ ...base, waiting: true }).text).toBe("변환 대기 중…");
  });
});

describe("녹음 시계", () => {
  test("기준 뒤로 흐른 만큼 더한다. 일시정지 전후로 기준이 바뀌어도 일시정지한 시간은 세지 않는다", () => {
    // 12:34(754.2초)에 일시정지 → 10분 뒤 계속(wall 600초 뒤): 기준이 계속한 순간으로 옮겨진다
    expect(clockAt({ t: 754.2, at: 1_000 }, 1_000)).toBe(754.2);
    expect(clockAt({ t: 754.2, at: 601_000 }, 603_000)).toBeCloseTo(756.2, 5); // 계속한 지 2초 뒤
  });

  test("화면 시계가 거꾸로 가도 줄지 않는다", () => {
    expect(clockAt({ t: 10, at: 5_000 }, 4_000)).toBe(10);
  });

  test("메뉴 막대 시작 시각: 계속한 순간 경과 = 일시정지 시각", () => {
    const now = 1_760_000_600_000;
    const start = resumedStartMs(now, 754.2);
    expect(now - start).toBe(754_200);
    expect(now + 5_000 - start).toBe(759_200); // 5초 뒤
    expect(resumedStartMs(now, 0)).toBe(now);
  });
});
