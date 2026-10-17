import { describe, expect, test } from "vitest";
import { wants } from "./tips";

describe("기능 안내", () => {
  test("본 안내와 안내 끄기는 다시 보이지 않는다", () => {
    expect(wants({ seen: [], off: false }, "ask")).toBe(true);
    expect(wants({ seen: ["ask"], off: false }, "ask")).toBe(false);
    expect(wants({ seen: [], off: true }, "export")).toBe(false);
  });
});
