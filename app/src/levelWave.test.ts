import { expect, test } from "vitest";
import { levelHeight, waveValue } from "./LevelWave";

test("levelHeight: 조용하면 바닥값, 0 dB는 1, 말소리는 쉼보다 확실히 높다", () => {
  expect(levelHeight(null)).toBe(0.05);
  expect(levelHeight(0)).toBe(1);
  expect(levelHeight(-20)).toBeGreaterThan(levelHeight(-50) * 4);
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
