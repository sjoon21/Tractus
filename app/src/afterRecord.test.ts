import { describe, expect, test } from "vitest";
import { OK, type Decision } from "./caps";
import { AFTER_ASK, AFTER_SETTING, afterRecord, askView, effectiveChoice, rememberedChoice, stopAction } from "./afterRecord";

const GATED: Decision = { ok: false, reason: "변환 엔진이 없어 텍스트로 변환할 수 없습니다. 모델 화면에서 설치하세요.", missing: ["asr-std"], fix: { kind: "models", label: "모델 설치" } };

describe("afterRecord (설정 읽기)", () => {
  test("없거나 모르는 값(옛 설정 파일)은 매번 묻는다", () => {
    for (const v of [undefined, null, "", "ASK", "never", 3, {}]) expect(afterRecord(v)).toBe("ask");
    expect(afterRecord("ask")).toBe("ask");
    expect(afterRecord("convert")).toBe("convert");
    expect(afterRecord("later")).toBe("later");
  });

  test("설정 화면의 선택지는 세 가지고 값이 afterRecord가 읽는 값과 같다", () => {
    expect(AFTER_SETTING.options.map((o) => o.value)).toEqual(["ask", "convert", "later"]);
    for (const o of AFTER_SETTING.options) expect(afterRecord(o.value)).toBe(o.value);
  });
});

describe("stopAction (녹음을 끝냈을 때 무엇을 하나)", () => {
  const act = (setting: "ask" | "convert" | "later", convertOk: boolean, attach = false) => stopAction({ setting, convertOk, attach }).kind;

  test("바로 변환: 옛 흐름 그대로. 변환할 수 없으면 녹음만 남긴다", () => {
    expect(act("convert", true)).toBe("convert");
    expect(act("convert", false)).toBe("leave");
  });

  test("나중에 변환: 변환 엔진 없이도 노트로 저장한다", () => {
    expect(act("later", true)).toBe("later");
    expect(act("later", false)).toBe("later");
  });

  test("묻기: 변환할 수 있든 없든 창을 띄운다 (창이 못 쓰는 선택지를 막는다)", () => {
    expect(act("ask", true)).toBe("ask");
    expect(act("ask", false)).toBe("ask");
  });

  test("글만 있는 노트에 추가하는 녹음은 설정과 상관없이 바로 변환이다 (노트에 덧붙여야 한다)", () => {
    for (const setting of ["ask", "convert", "later"] as const) {
      expect(act(setting, true, true)).toBe("convert");
      expect(act(setting, false, true)).toBe("leave");
    }
  });

  test("어떤 조합에서도 녹음을 버리지 않는다: 결과는 변환·저장·묻기·남기기 넷 중 하나", () => {
    for (const setting of ["ask", "convert", "later"] as const)
      for (const convertOk of [true, false])
        for (const attach of [true, false]) expect(["convert", "later", "ask", "leave"]).toContain(act(setting, convertOk, attach));
  });
});

describe("묻는 창", () => {
  test("변환할 수 있으면 초점은 안전한 `바로 변환하기`", () => {
    expect(askView(OK)).toEqual({ convertEnabled: true, reason: null, focus: "convert" });
  });

  test("변환할 수 없으면 `나중에 변환하기`만 쓸 수 있고 이유를 보인다", () => {
    expect(askView(GATED)).toEqual({ convertEnabled: false, reason: GATED.reason, focus: "later" });
  });

  test("`다음부터 묻지 않기`는 체크했을 때만 고른 값을 남긴다", () => {
    expect(rememberedChoice("convert", true)).toBe("convert");
    expect(rememberedChoice("later", true)).toBe("later");
    expect(rememberedChoice("later", false)).toBeNull();
    expect(rememberedChoice("convert", false)).toBeNull();
  });

  test("창이 뜬 사이 변환할 수 없게 되었다면 `바로 변환`은 `나중에`로 바뀐다 (녹음은 노트로 남는다)", () => {
    expect(effectiveChoice("convert", true)).toBe("convert");
    expect(effectiveChoice("convert", false)).toBe("later");
    expect(effectiveChoice("later", false)).toBe("later");
  });

  test("본문에 녹음 길이를 보인다", () => {
    expect(AFTER_ASK.body(754)).toContain("12:34");
    expect(AFTER_ASK.body(0)).toContain("0:00");
  });
});
