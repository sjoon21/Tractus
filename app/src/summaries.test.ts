import { describe, expect, test } from "vitest";
import {
  afterDelete,
  checkCustom,
  checkTemplate,
  copyDraft,
  customSpec,
  defaultPick,
  docMarkdown,
  MAX_PROMPT,
  orderDocs,
  parseSummaryDoc,
  parseSummaryDocs,
  pickLabel,
  pickSelected,
  printSummary,
  promptCounter,
  rerunSpec,
  specsFromPick,
  tabLabels,
  togglePick,
  type TemplateInfo,
} from "./summaries";

const T = (id: string, name: string, builtin = true, prompt = "방법"): TemplateInfo => ({ id, name, description: `${name} 설명`, prompt, builtin });
const TEMPLATES = [T("meeting", "회의록"), T("brief", "핵심 요약"), T("todo", "할 일 중심"), T("u-1a2b3c4d", "주간 보고", false, "금주 한 일")];

const V2 = {
  key: "brief",
  schema_version: 2,
  template: "brief",
  template_name: "핵심 요약",
  title: "예산 논의",
  overview: "예산을 동결했다.",
  provider: "upstage",
  model: "solar-pro4",
  sections: [
    { heading: "핵심 포인트", style: "bullets", items: [{ text: "예산 동결", segment_ids: ["s0002"], owner: null, due: null }] },
    { heading: "할 일", style: "checklist", items: [{ text: "견적 정리", segment_ids: ["s0003", "m0001"], owner: "김민수", due: "금요일" }] },
    { heading: "순서", style: "numbered", items: [{ text: "첫째", segment_ids: [], owner: null, due: null }, { text: "둘째", segment_ids: ["s0002"], owner: null, due: null }] },
    { heading: "비어 있음", style: "bullets", items: [] },
  ],
};
const LEGACY = { key: "meeting", title: "옛", summary: "예산을 정했다.", topics: [{ title: "예산", segment_ids: ["s0001"] }], decisions: [{ text: "10% 증액", segment_ids: ["s0002"] }], action_items: [{ task: "표 정리", owner: "김민수", due: "금요일", segment_ids: [] }], provider: "upstage", model: "m" };
const doc = (raw: unknown) => parseSummaryDoc(raw)!;

describe("요약 파일 읽기", () => {
  test("새 스키마: 이름·개요·섹션, 직접 요약은 직접 요약", () => {
    const d = doc(V2);
    expect(d).toMatchObject({ key: "brief", name: "핵심 요약", overview: "예산을 동결했다.", legacy: null, provider: "upstage", prompt: null, template: "brief" });
    expect(d.sections[1]).toEqual({ heading: "할 일", style: "checklist", items: [{ text: "견적 정리", segment_ids: ["s0003", "m0001"], owner: "김민수", due: "금요일" }] });
    expect(doc({ ...V2, key: "c-1a2b3c4d", template: "custom", template_name: undefined, prompt: "한 줄로" })).toMatchObject({ name: "직접 요약", prompt: "한 줄로", template: "custom" });
  });
  test("옛 스키마: legacy 원본 그대로, 이름은 회의록", () => {
    const d = doc(LEGACY);
    expect(d.name).toBe("회의록");
    expect(d.sections).toEqual([]);
    expect(d.legacy).toMatchObject({ summary: "예산을 정했다.", decisions: [{ text: "10% 증액", segment_ids: ["s0002"] }], action_items: [{ task: "표 정리", owner: "김민수", due: "금요일", segment_ids: [] }] });
  });
  test("너그럽게: 빠진 키·이상한 값·모르는 스타일", () => {
    const d = doc({ key: "todo", sections: [{ heading: "h", style: "zigzag", items: [{ text: "a" }, 3, { text: "b", segment_ids: ["s1", 7], owner: 5 }] }, "x"], overview: 3 });
    expect(d.overview).toBe("");
    expect(d.sections).toEqual([{ heading: "h", style: "bullets", items: [{ text: "a", segment_ids: [], owner: null, due: null }, { text: "b", segment_ids: ["s1"], owner: null, due: null }] }]);
    expect(doc({ key: "meeting" })).toMatchObject({ name: "회의록", legacy: { summary: "", decisions: [], topics: [], action_items: [] } });
  });
  test("key가 없거나 객체가 아니면 건너뛴다", () => {
    expect(parseSummaryDoc(null)).toBeNull();
    expect(parseSummaryDoc({ title: "x" })).toBeNull();
    expect(parseSummaryDoc([])).toBeNull();
    expect(parseSummaryDocs([V2, 3, { x: 1 }, LEGACY]).map((d) => d.key)).toEqual(["brief", "meeting"]);
    expect(parseSummaryDocs("x")).toEqual([]);
  });
});

describe("탭 순서와 이름", () => {
  const docs = ["u-1a2b3c4d", "c-00000001", "todo", "meeting", "brief", "c-00000002"].map((key) => doc({ key, template_name: key, summary: "" }));
  test("기본 유형은 목록 순서, 내 유형·직접 요약은 들어온 순서로 뒤에", () => {
    expect(orderDocs(docs, TEMPLATES).map((d) => d.key)).toEqual(["meeting", "brief", "todo", "u-1a2b3c4d", "c-00000001", "c-00000002"]);
  });
  test("유형 목록을 못 읽어도 들어온 순서를 지킨다", () => {
    expect(orderDocs(docs, []).map((d) => d.key)).toEqual(docs.map((d) => d.key));
  });
  test("같은 이름은 둘째부터 번호", () => {
    const named = ["직접 요약", "회의록", "직접 요약", "직접 요약"].map((n, i) => doc({ key: `c-0000000${i}`, template_name: n, sections: [] }));
    expect(tabLabels(named)).toEqual(["직접 요약", "회의록", "직접 요약 2", "직접 요약 3"]);
  });
  test("고른 요약: 없으면 첫 번째, 지운 뒤에는 옆 탭", () => {
    const three = ["meeting", "brief", "todo"].map((key) => doc({ key, sections: [] }));
    expect(pickSelected(three, "brief")?.key).toBe("brief");
    expect(pickSelected(three, "gone")?.key).toBe("meeting");
    expect(pickSelected([], "x")).toBeNull();
    expect(afterDelete(three, "brief")).toBe("todo");
    expect(afterDelete(three, "todo")).toBe("brief");
    expect(afterDelete(three.slice(0, 1), "meeting")).toBeNull();
  });
});

describe("복사 마크다운", () => {
  const starts = new Map([["s0002", 65], ["s0003", 331]]);
  test("새 스키마: 개요 + 섹션, 체크리스트·번호·담당·기한·근거(메모 줄 포함), 빈 섹션은 뺀다", () => {
    expect(docMarkdown(doc(V2), starts, new Map([["m0001", 3]]))).toBe(
      ["## 요약", "", "예산을 동결했다.", "", "## 핵심 포인트", "", "- 예산 동결 (1:05)", "",
        "## 할 일", "", "- [ ] 견적 정리 — 김민수, 금요일 (5:31, 메모 3번째 줄)", "", "## 순서", "", "1. 첫째", "2. 둘째 (1:05)", ""].join("\n"),
    );
  });
  test("개요가 비면 요약 절을 만들지 않는다", () => {
    expect(docMarkdown(doc({ ...V2, overview: " ", sections: [V2.sections[0]] }), starts)).toBe(["## 핵심 포인트", "", "- 예산 동결 (1:05)", ""].join("\n"));
  });
  test("옛 요약은 옛 형식 그대로", () => {
    expect(docMarkdown(doc(LEGACY), starts)).toBe(
      ["## 요약", "", "예산을 정했다.", "", "## 결정 사항", "", "- 10% 증액 (1:05)", "", "## 할 일", "", "- [ ] 표 정리 — 김민수, 금요일", "", "## 주제", "", "- 예산", ""].join("\n"),
    );
  });
});

describe("인쇄 모델", () => {
  test("선택한 새 요약만: 이름·개요·섹션(빈 섹션 제외), 항목 meta는 담당 · 기한", () => {
    const p = printSummary(doc(V2), (ids) => (ids.length ? ids.join("+") : null));
    expect(p.name).toBe("핵심 요약");
    expect(p.lead).toBe("예산을 동결했다.");
    expect(p.sections.map((s) => s.title)).toEqual(["핵심 포인트", "할 일", "순서"]);
    expect(p.sections[1].items).toEqual([{ text: "견적 정리", meta: "김민수 · 금요일", at: "s0003+m0001" }]);
    expect(p.sections[2].items[0].at).toBeNull();
  });
});

describe("유형 고르기", () => {
  test("처음 고른 것: 아직 없는 첫 기본 유형, 다 있으면 회의록", () => {
    const made = (...keys: string[]) => keys.map((key) => doc({ key, sections: [] }));
    expect(defaultPick([], TEMPLATES)).toEqual(["meeting"]);
    expect(defaultPick(made("meeting"), TEMPLATES)).toEqual(["brief"]);
    expect(defaultPick(made("meeting", "brief", "todo"), TEMPLATES)).toEqual(["meeting"]);
    expect(defaultPick([], [])).toEqual(["meeting"]);
  });
  test("켜고 끄기는 새 배열", () => {
    const a = ["meeting"];
    expect(togglePick(a, "brief")).toEqual(["meeting", "brief"]);
    expect(togglePick(["meeting", "brief"], "meeting")).toEqual(["brief"]);
    expect(a).toEqual(["meeting"]);
  });
  test("만들 일은 목록 순서대로, 지운 유형은 뺀다", () => {
    expect(specsFromPick(["u-1a2b3c4d", "gone", "brief"], TEMPLATES)).toEqual([
      { template: "brief", label: "핵심 요약", key: "brief" },
      { template: "u-1a2b3c4d", label: "주간 보고", key: "u-1a2b3c4d" },
    ]);
  });
  test("단추 글자", () => {
    expect(pickLabel([], TEMPLATES)).toBe("요약 유형 고르기");
    expect(pickLabel(["gone"], TEMPLATES)).toBe("요약 유형 고르기");
    expect(pickLabel(["brief"], TEMPLATES)).toBe("요약 유형: 핵심 요약");
    expect(pickLabel(["brief", "todo", "meeting"], TEMPLATES)).toBe("요약 유형: 3개 선택");
  });
});

describe("다시 만들기", () => {
  test("기본 요약·유형이 있는 요약은 그 유형으로", () => {
    expect(rerunSpec(doc(LEGACY), TEMPLATES)).toEqual({ label: "회의록", key: "meeting" });
    expect(rerunSpec(doc(V2), TEMPLATES)).toEqual({ template: "brief", label: "핵심 요약", key: "brief" });
  });
  test("지운 내 유형은 저장해 둔 방법으로 (새 직접 요약), 방법을 모르면 null", () => {
    const gone = doc({ ...V2, key: "u-deadbeef", template_name: "지운 유형", prompt: "예전 방법" });
    expect(rerunSpec(gone, TEMPLATES)).toEqual({ custom: { prompt: "예전 방법", key: null }, label: "지운 유형", key: null });
    expect(rerunSpec(doc({ ...V2, key: "u-deadbeef" }), TEMPLATES)).toBeNull();
  });
  test("한 번만 쓴 직접 요약은 같은 key를 덮어쓴다", () => {
    const c = doc({ ...V2, key: "c-1a2b3c4d", template: "custom", template_name: undefined, prompt: "한 줄로" });
    expect(rerunSpec(c, TEMPLATES)).toEqual({ custom: { prompt: "한 줄로", key: "c-1a2b3c4d" }, label: "직접 요약", key: "c-1a2b3c4d" });
  });
});

describe("직접 프롬프트 입력", () => {
  test("비었거나 4,000자를 넘으면 안 된다 (코드 포인트로 센다)", () => {
    expect(checkCustom({ prompt: " \n ", save: false, name: "" })).toEqual({ ok: false, prompt: "요약 방법을 입력하세요.", name: null });
    expect(checkCustom({ prompt: "가".repeat(MAX_PROMPT), save: false, name: "" }).ok).toBe(true);
    expect(checkCustom({ prompt: "가".repeat(MAX_PROMPT + 1), save: false, name: "" }).prompt).toBe("요약 방법은 4,000자까지 쓸 수 있습니다.");
    expect(checkCustom({ prompt: "😀".repeat(MAX_PROMPT), save: false, name: "" }).ok).toBe(true);
  });
  test("템플릿으로 저장할 때만 이름을 본다 (40자까지)", () => {
    expect(checkCustom({ prompt: "p", save: false, name: "" }).ok).toBe(true);
    expect(checkCustom({ prompt: "p", save: true, name: "  " })).toEqual({ ok: false, prompt: null, name: "이름을 입력하세요." });
    expect(checkCustom({ prompt: "p", save: true, name: "가".repeat(41) }).name).toBe("이름은 40자까지 쓸 수 있습니다.");
    expect(checkCustom({ prompt: "p", save: true, name: "가".repeat(40) }).ok).toBe(true);
  });
  test("만들 일: 이름을 저장하면 탭 이름도 그 이름, 아니면 직접 요약", () => {
    expect(customSpec({ prompt: " 한 줄로 ", save: false, name: "버려짐" })).toEqual({ custom: { prompt: "한 줄로", save_as: null }, label: "직접 요약", key: null });
    expect(customSpec({ prompt: "p", save: true, name: " 주간   보고 " })).toEqual({ custom: { prompt: "p", save_as: "주간 보고" }, label: "주간 보고", key: null });
    expect(customSpec({ prompt: "p", save: true, name: " " }).custom?.save_as).toBeNull();
  });
  test("글자 수 표시", () => {
    expect(promptCounter("")).toBe("0 / 4,000");
    expect(promptCounter(` ${"가".repeat(1234)} `)).toBe("1,234 / 4,000");
  });
});

describe("내 유형 편집", () => {
  test("이름·설명·방법 한도", () => {
    expect(checkTemplate({ name: "n", description: "", prompt: "p" }).ok).toBe(true);
    expect(checkTemplate({ name: " ", description: "", prompt: "p" }).name).toBe("이름을 입력하세요.");
    expect(checkTemplate({ name: "n", description: "가".repeat(101), prompt: "p" }).description).toBe("설명은 100자까지 쓸 수 있습니다.");
    expect(checkTemplate({ name: "n", description: "", prompt: "" }).prompt).toBe("요약 방법을 입력하세요.");
    expect(checkTemplate({ name: "n", description: "", prompt: "가".repeat(4001) }).ok).toBe(false);
  });
  test("복사해서 만들기: 이름에 (복사)를 붙이고 40자를 넘지 않는다", () => {
    expect(copyDraft(T("brief", "핵심 요약"))).toEqual({ name: "핵심 요약 (복사)", description: "핵심 요약 설명", prompt: "방법" });
    expect([...copyDraft(T("x", "가".repeat(40))).name].length).toBeLessThanOrEqual(40);
  });
});
