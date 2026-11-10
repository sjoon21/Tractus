import { expect, test } from "vitest";
import { HISTORY, pushLevel } from "./LevelWave";

test("pushLevel: 끝에 붙이고 길이를 지키며, dB를 0..1로 바꾼다", () => {
  const h = pushLevel(Array(HISTORY).fill(0), 0);
  expect(h).toHaveLength(HISTORY);
  expect(h.at(-1)).toBe(1);
  expect(pushLevel([0.5], -60, 2)).toEqual([0.5, 0]);
  expect(pushLevel([0.1, 0.2], null, 2)).toEqual([0.2, 0]);
});
