import { expect, test } from "vitest";
import { barJitter, levelHeight, waveValue } from "./LevelWave";

test("levelHeight: 조용하면 바닥값, 0 dB는 1, 말소리는 쉼보다 확실히 높다", () => {
  expect(levelHeight(null)).toBe(0.05);
  expect(levelHeight(-100)).toBe(0.05);
  expect(levelHeight(0)).toBe(1);
  expect(levelHeight(-20)).toBeGreaterThan(levelHeight(-50) * 4);
  // 실제 말소리 구간(-40~-20 dB)이 높이의 절반 이상을 오르내린다
  expect(levelHeight(-20) - levelHeight(-40)).toBeGreaterThanOrEqual(0.5);
});

test("barJitter: 칸마다 같은 값(0.5~1)이고 이웃 칸은 서로 다르다", () => {
  const v = Array.from({ length: 200 }, (_, k) => barJitter(k));
  expect(v.every((x) => x >= 0.5 && x <= 1)).toBe(true);
  expect(barJitter(37)).toBe(barJitter(37));
  expect(Math.max(...v) - Math.min(...v)).toBeGreaterThan(0.4);
});

test("waveValue: 두 값 사이를 부드럽게 잇고, 끝값을 지킨다", () => {
  const s = [{ at: 0, v: 0.2 }, { at: 0.25, v: 0.6 }];
  expect(waveValue([], 1)).toBe(0.05);
  expect(waveValue(s, -1)).toBe(0.05);
  expect(waveValue(s, 0)).toBe(0.2);
  expect(waveValue(s, 0.125)).toBeCloseTo(0.4);
  expect(waveValue(s, 0.25)).toBe(0.6);
  expect(waveValue(s, 9)).toBe(0.6);
});
