import { describe, expect, test } from "vitest";
import { engineSkipsVocab, isMulti, matchTerms, splitTerms, suggestFromCorrections } from "./dictionary";

describe("사전 화면", () => {
  test("붙여 넣은 글을 쉼표·줄바꿈으로 나누고 머리·빈 값·중복을 뺀다", () => {
    expect(splitTerms(" 쿠버네티스, Project  Atlas\n- 온보딩\n* OKR\n\n,쿠버네티스")).toEqual(["쿠버네티스", "Project Atlas", "온보딩", "OKR"]);
    expect(splitTerms("p95")).toEqual(["p95"]);
    expect(splitTerms("-WTO")).toEqual(["-WTO"]); // 공백 없는 `-`는 단어의 일부
    expect(isMulti("a, b")).toBe(true);
    expect(isMulti("Project Atlas")).toBe(false);
  });

  test("찾기는 대소문자를 가리지 않고, 빈 찾기는 전부", () => {
    const terms = ["Kubernetes", "OKR", "kubectl"];
    expect(matchTerms(terms, " kube")).toEqual(["Kubernetes", "kubectl"]);
    expect(matchTerms(terms, "")).toEqual(terms);
  });

  test("Qwen이 아닌 엔진을 쓸 때만 안내한다", () => {
    const models = [
      { id: "asr-std", engine: "qwen3", installed: true },
      { id: "asr-ko-mix", engine: "whisper", installed: true },
    ];
    expect(engineSkipsVocab(models, "asr-ko-mix", null)).toBe(true);
    expect(engineSkipsVocab(models, null, null)).toBe(false);
    expect(engineSkipsVocab([], null, null)).toBe(false);
  });

  test("고친 문장에서 사전 단어를 제안한다: 많이 고친 순, 사전에 있거나 무시한 것은 빼고, 말투 고침은 빼고", () => {
    const pairs: [string, string][] = [
      ["언톨로지 설계", "온톨로지 설계"],
      ["그 언톨로지를", "그 온톨로지를"],
      ["Grafna 대시보드", "Grafana 대시보드"],
      ["했습니다", "했어요"],
      ["쿠버내티스", "쿠버네티스"],
    ];
    expect(suggestFromCorrections(pairs, ["쿠버네티스"], new Set())).toEqual([{ term: "온톨로지", count: 2 }, { term: "Grafana", count: 1 }]);
    expect(suggestFromCorrections(pairs, ["GRAFANA", "쿠버네티스"], new Set(["온톨로지"]))).toEqual([]);
    expect(suggestFromCorrections(pairs, [], new Set(), 1)).toHaveLength(1);
  });
});
