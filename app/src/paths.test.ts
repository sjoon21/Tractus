import { describe, expect, test } from "vitest";
import type { DoctorReport } from "./caps";
import { binView, fixPatch, isPathFix } from "./paths";

const rep = (over: Partial<DoctorReport> = {}): DoctorReport => ({
  doctor: null,
  core_error: null,
  tractus_bin: "/a/tractus",
  tractus_bin_exists: true,
  rec_bin: "/a/tractus-rec",
  rec_bin_exists: true,
  ...over,
});

describe("binView", () => {
  test("점검을 못 읽으면 없다", () => {
    expect(binView(null, "tractus")).toBeNull();
  });
  test("출처마다 직접 지정인지와 한 줄 설명이 정해진다", () => {
    const v = (tractus_source: string) => binView(rep({ tractus_source }), "tractus")!;
    expect(v("custom")).toMatchObject({ custom: true, found: true, path: "/a/tractus" });
    expect(v("env").note).toBe("환경변수 TRACTUS_BIN에서 찾았습니다");
    expect(binView(rep({ rec_source: "env" }), "rec")!.note).toContain("TRACTUS_REC_BIN");
    expect(v("bundle")).toMatchObject({ custom: false, note: "앱 안에서 찾았습니다" });
    expect(v("repo").note).toContain("저장소");
    expect(binView(rep({ tractus_bin_exists: false, tractus_source: "none" }), "tractus")).toMatchObject({ found: false, custom: false, note: "찾지 못했습니다" });
  });
  test("옛 앱은 출처가 없다: 찾았으면 자동으로 본다", () => {
    expect(binView(rep(), "tractus")).toMatchObject({ custom: false, found: true });
  });
});

describe("fixPatch: 고치는 단추가 설정에 쓰는 값", () => {
  test("고른 경로를 저장하고, 취소하면 아무것도 쓰지 않는다", () => {
    expect(fixPatch("pick-tractus", "/x/t")).toEqual({ tractus_bin: "/x/t" });
    expect(fixPatch("pick-rec", "/x/r")).toEqual({ rec_bin: "/x/r" });
    expect(fixPatch("pick-home", "/x/home")).toEqual({ home: "/x/home" });
    for (const k of ["pick-tractus", "pick-rec", "pick-home"] as const) expect(fixPatch(k, null)).toBeNull();
  });
  test("자동으로 되돌리면 빈 값을 저장한다", () => {
    expect(fixPatch("auto-tractus", null)).toEqual({ tractus_bin: "" });
    expect(fixPatch("auto-rec", null)).toEqual({ rec_bin: "" });
  });
  test("다른 고치는 단추는 여기서 처리하지 않는다", () => {
    expect(fixPatch("models", "/x")).toBeNull();
    expect(["models", "checkup", "settings"].some((k) => isPathFix(k as never))).toBe(false);
    expect(isPathFix("pick-home") && isPathFix("auto-rec")).toBe(true);
  });
});
