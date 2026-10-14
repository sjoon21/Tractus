// 요약 탭 화면이 그려지는지 (서버 렌더). 메뉴·대화상자의 상호작용은 순수 로직(summaries.test.ts, summaryQueue.test.ts)과 손으로 확인한다.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { CustomSummaryDialog } from "./CustomSummaryDialog";
import { LegacyBody, PickGroup, SectionsBody, SummariesPanel, type SummariesPanelProps } from "./SummariesPanel";
import { parseSummaryDoc, type TemplateInfo } from "./summaries";
import { TemplatesSection } from "./TemplatesSettings";

const chip = (ids: string[]) => createElement("i", { className: "chip" }, ids.join("+") || "-");
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

const V2 = parseSummaryDoc({
  key: "todo",
  template_name: "할 일 중심",
  overview: "예산을 정했다.",
  sections: [
    { heading: "할 일", style: "checklist", items: [{ text: "견적 정리", segment_ids: ["s0003"], owner: "김민수", due: "금요일" }] },
    { heading: "순서", style: "numbered", items: [{ text: "첫째", segment_ids: [], owner: null, due: null }] },
    { heading: "메모", style: "bullets", items: [{ text: "참고", segment_ids: ["m0001"], owner: null, due: null }] },
    { heading: "비어 있음", style: "bullets", items: [] },
  ],
})!;

describe("새 요약 섹션 렌더러", () => {
  const out = html(createElement(SectionsBody, { doc: V2, chip }));
  test("개요, 섹션 제목과 개수, 빈 섹션은 그리지 않는다", () => {
    expect(out).toContain('<p class="summary-lead">예산을 정했다.</p>');
    expect(out).toContain("할 일 <span");
    expect(out).not.toContain("비어 있음");
  });
  test("스타일별 목록: 체크리스트·번호·글머리", () => {
    expect(out).toContain('<ul class="rail-list is-actions">');
    expect(out).toContain('<ol class="rail-list">');
    expect(out).toContain('<ul class="rail-list is-bullets">');
  });
  test("담당·기한과 근거 칩", () => {
    expect(out).toContain('<span class="action-meta"><span>김민수</span><span>금요일</span></span>');
    expect(out).toContain('<i class="chip">s0003</i>');
    expect(out).toContain('<i class="chip">m0001</i>');
    expect(out).toContain('<i class="chip">-</i>'); // 근거가 없는 항목도 칩 자리는 호출한다 (칩이 스스로 비운다)
  });
});

describe("옛 요약은 예전 모양 그대로", () => {
  const legacy = parseSummaryDoc({ key: "meeting", summary: "옛 요약", decisions: [{ text: "10% 증액", segment_ids: ["s0002"] }], action_items: [{ task: "표 정리", owner: "김민수", due: null, segment_ids: [] }], topics: [{ title: "예산", segment_ids: ["s0001"] }] })!;
  const out = html(createElement(LegacyBody, { doc: legacy, chip }));
  test("결정 사항(번호) · 할 일(체크) · 주제(칩이 앞)", () => {
    expect(out).toContain("결정 사항 <span");
    expect(out).toContain('<ul class="rail-list is-actions">');
    expect(out).toContain('<ul class="topic-list"><li><i class="chip">s0001</i><span>예산</span></li></ul>');
    expect(out).toContain("옛 요약");
  });
});

describe("유형 고르기 목록", () => {
  const T = (id: string, name: string): TemplateInfo => ({ id, name, description: `${name} 설명`, prompt: "p", builtin: true });
  test("체크박스, 설명, 만들어짐 표시", () => {
    const out = html(createElement(PickGroup, { title: "기본 유형", items: [T("meeting", "회의록"), T("brief", "핵심 요약")], pick: ["brief"], made: new Set(["meeting"]), disabled: false, onToggle() {} }));
    expect(out).toContain("<legend>기본 유형</legend>");
    expect(out).toMatch(/<input type="checkbox"[^>]*checked=""[^>]*\/><span class="pick-text"><span class="pick-name">핵심 요약<\/span>/);
    expect(out).toContain("<em>만들어짐</em>");
    expect(out).toContain("<small>회의록 설명</small>");
  });
});

describe("요약 탭", () => {
  const props: SummariesPanelProps = {
    id: "N1", memoNote: false, rev: 0, prepare: async () => true, blocked: false, editSeq: 0, editSeqRef: { current: 0 }, editKinds: { current: [] },
    chip, starts: new Map(), memoLines: undefined, notify() {}, onRunning() {}, onSelect() {}, onChanged() {},
  };
  test("처음 그릴 때는 유형 단추와 만들기 단추만 (요약은 아직 읽는 중)", () => {
    const out = html(createElement(SummariesPanel, props));
    expect(out).toContain("요약 유형 고르기");
    expect(out).toContain('aria-haspopup="true"');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>요약 만들기<\/button>/); // 유형을 읽기 전에는 만들 수 없다
    expect(out).not.toContain("role=\"tablist\"");
  });
});

describe("직접 프롬프트 대화상자", () => {
  const out = html(createElement(CustomSummaryDialog, { onCancel() {}, onSubmit() {} }));
  test("제목·설명·예시·글자 수·저장 체크", () => {
    expect(out).toContain("직접 프롬프트로 요약");
    expect(out).toContain("원하는 요약 방법을 적으면 AI가 그대로 정리합니다.");
    expect(out).toContain('placeholder="예: 고객이 말한 불만을');
    expect(out).toContain("0 / 4,000");
    expect(out).toContain("템플릿으로 저장");
    expect(out).not.toContain("이름 (40자까지)"); // 저장을 켜기 전에는 이름 칸이 없다
  });
  test("처음부터 오류를 보이지 않는다", () => {
    expect(out).not.toContain("요약 방법을 입력하세요.");
    expect(out).toContain('aria-invalid="false"');
    expect(out).toContain('aria-disabled="true"');
  });
});

describe("설정 › 요약 템플릿", () => {
  test("읽는 동안", () => {
    const out = html(createElement(TemplatesSection));
    expect(out).toContain("요약 템플릿");
    expect(out).toContain("불러오는 중…");
  });
});
