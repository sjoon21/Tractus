import { describe, expect, test } from "vitest";
import {
  answerParts,
  askReduce,
  citeLabel,
  citeTarget,
  historyFromEntries,
  isAsking,
  isNoteGone,
  sendNotice,
  START_ASK,
  trimHistory,
  turnsHistory,
  type AskEvent,
  type AskSource,
  type AskState,
} from "./ask";

const ID = "01K6X3ABCDEFGHJKMNPQRSTVWX";
const src = (segment_id: string, start: number, meeting_id = ID): AskSource => ({ meeting_id, title: "주간회의", date: "2026-10-02", segment_id, speaker: "김민수", start, text: "예산은 3억" });

describe("인용 파싱", () => {
  test("회의 범위 [s0012]와 전체 범위 [<id>#s0012]를 칩으로 나눈다", () => {
    expect(answerParts(`예산은 3억입니다 [s0012]. 일정은 [${ID}#s0040] 다음 주.`)).toEqual([
      { kind: "text", text: "예산은 3억입니다 " },
      { kind: "cite", meetingId: null, segId: "s0012" },
      { kind: "text", text: ". 일정은 " },
      { kind: "cite", meetingId: ID, segId: "s0040" },
      { kind: "text", text: " 다음 주." },
    ]);
  });
  test("한 괄호에 여러 개 [s0001, s0002]도 칩 여러 개", () => {
    expect(answerParts("결정 [s0001, s0002]").filter((p) => p.kind === "cite")).toEqual([
      { kind: "cite", meetingId: null, segId: "s0001" },
      { kind: "cite", meetingId: null, segId: "s0002" },
    ]);
  });
  test("인용이 아닌 대괄호는 글자 그대로, 스트리밍 중 끝에 덜 온 인용은 뗀다 (ID를 보이지 않는다)", () => {
    expect(answerParts("[참고] 값 [s12] 그리고 [s00")).toEqual([{ kind: "text", text: "[참고] 값 [s12] 그리고 " }]);
    expect(answerParts(`결정 [s0001, ${ID.slice(0, 10)}`)).toEqual([{ kind: "text", text: "결정 " }]);
    expect(answerParts("끝 [")).toEqual([{ kind: "text", text: "끝 " }]);
    expect(answerParts("")).toEqual([]);
  });
});

describe("인용 → 이동할 시각", () => {
  const starts = new Map([["s0012", 331]]);
  test("done의 citations → sources → 회의 세그먼트 순으로 찾는다", () => {
    const ctx = { meetingId: ID, citations: [{ meeting_id: ID, segment_id: "s0012", start: 330 }], sources: [], starts };
    expect(citeTarget({ meetingId: null, segId: "s0012" }, ctx)).toEqual({ meetingId: ID, segId: "s0012", t: 330 });
    expect(citeTarget({ meetingId: null, segId: "s0012" }, { meetingId: ID, citations: [], sources: [], starts })).toEqual({ meetingId: ID, segId: "s0012", t: 331 });
    expect(citeTarget({ meetingId: ID, segId: "s0040" }, { citations: [], sources: [src("s0040", 1200)] })).toEqual({ meetingId: ID, segId: "s0040", t: 1200 });
  });
  test("다른 회의의 같은 세그먼트 id와 섞이지 않고, 모르는 인용은 null", () => {
    const other = "01K6X3ZZZZZZZZZZZZZZZZZZZZ";
    expect(citeTarget({ meetingId: other, segId: "s0040" }, { citations: [], sources: [src("s0040", 1200)] })).toBeNull();
    expect(citeTarget({ meetingId: null, segId: "s9999" }, { meetingId: ID, citations: [], sources: [], starts })).toBeNull();
    expect(citeTarget({ meetingId: null, segId: "s0012" }, { citations: [], sources: [] })).toBeNull(); // 전체 범위에 회의 없는 인용
  });
});

type NoJob<T> = T extends unknown ? Omit<T, "job"> : never;
type Ev = NoJob<AskEvent>;
const ev = (e: Ev) => ({ job: "J", ...e }) as AskEvent;
const run = (events: Ev[], from: AskState = START_ASK) => events.map(ev).reduce(askReduce, from);

describe("askReduce", () => {
  test("stage → sources → delta 누적 → done (후처리된 답으로 바꾼다)", () => {
    const s = run([
      { event: "stage", stage: "retrieve" },
      { event: "sources", sources: [src("s0012", 331)] },
      { event: "stage", stage: "answer" },
      { event: "delta", text: "예산은 " },
      { event: "delta", text: "3억 [s0012][s9999]" },
    ]);
    expect(s.phase).toBe("answer");
    expect(s.answer).toBe("예산은 3억 [s0012][s9999]");
    expect(isAsking(s)).toBe(true);
    const d = run([{ event: "done", answer: "예산은 3억 [s0012]", citations: [{ meeting_id: ID, segment_id: "s0012", start: 331 }], provider: "upstage", model: "solar-pro4" }, { event: "exit", code: 0, stderr: "" }], s);
    expect(d).toMatchObject({ phase: "done", answer: "예산은 3억 [s0012]", provider: "upstage", model: "solar-pro4", error: null });
    expect(d.sources).toHaveLength(1);
    expect(isAsking(d)).toBe(false);
  });
  test("저장 실패 경고는 답을 막지 않고, 모르는 이벤트는 무시한다", () => {
    const s = run([
      { event: "warning", code: "chat_save_failed", message: "기록을 저장하지 못했습니다" },
      { event: "done", answer: "3억", citations: [], provider: "upstage", model: "solar-pro4" },
    ]);
    expect(s).toMatchObject({ phase: "done", answer: "3억", warning: "질문 기록을 저장하지 못했습니다. 답변은 그대로 볼 수 있습니다." }); // 코어는 저장(경고) 뒤에 done을 보낸다 (코드 → WORDS 문장)
    const w = run([{ event: "warning", code: "x", message: "경고" }, { event: "mystery" } as never, { event: "delta", text: "a" }]);
    expect(w).toMatchObject({ phase: "answer", answer: "a", warning: "경고" });
  });
  test("error 이벤트 메시지, 없으면 stderr 끝, 취소는 그대로", () => {
    expect(run([{ event: "error", message: "UPSTAGE_API_KEY가 없습니다", code: "llm_config" }, { event: "exit", code: 1, stderr: "Traceback" }])).toMatchObject({ phase: "error", error: "UPSTAGE_API_KEY가 없습니다", errorCode: "llm_config" });
    expect(run([{ event: "stage", stage: "answer" }, { event: "exit", code: 1, stderr: "a\nb\nError: 죽음" }])).toMatchObject({ phase: "error", error: "답변을 받지 못했습니다 (종료 코드 1)\na\nb\n죽음", errorCode: null });
    expect(run([{ event: "exit", code: null, stderr: "" }]).error).toBe("답변을 받지 못했습니다"); // 신호로 끝남: 괄호 없이
    const cancelled = { ...START_ASK, phase: "cancelled" as const, answer: "예산은" };
    expect(run([{ event: "delta", text: " 3억" }, { event: "exit", code: null, stderr: "" }], cancelled)).toEqual(cancelled);
  });
  test("멈춘 뒤에 done이 오면 답을 받는다 (코어가 이미 chat.json에 저장했다)", () => {
    const cancelled = { ...START_ASK, phase: "cancelled" as const, answer: "예산은" };
    const d = run([{ event: "done", answer: "예산은 3억 [s0012]", citations: [{ meeting_id: ID, segment_id: "s0012", start: 331 }], provider: "upstage", model: "solar-pro4" }, { event: "exit", code: null, stderr: "" }], cancelled);
    expect(d).toMatchObject({ phase: "done", answer: "예산은 3억 [s0012]", provider: "upstage" });
  });
});

describe("대화 기록", () => {
  const m = (role: "user" | "assistant", n: number) => ({ role, content: "가".repeat(n) });
  test("마지막 6턴만, 12k자를 넘으면 오래된 것부터 버린다. 맨 앞은 질문", () => {
    const msgs = [m("user", 1), m("assistant", 1), m("user", 2), m("assistant", 2), m("user", 3), m("assistant", 3), m("user", 4), m("assistant", 4)];
    expect(trimHistory(msgs).map((x) => x.content.length)).toEqual([2, 2, 3, 3, 4, 4]);
    expect(trimHistory([m("user", 5000), m("assistant", 5000), m("user", 3000), m("assistant", 3000)]).map((x) => x.content.length)).toEqual([3000, 3000]);
    expect(trimHistory([m("assistant", 10), m("user", 1), m("assistant", 1)]).map((x) => x.role)).toEqual(["user", "assistant"]);
    expect(trimHistory([m("user", 13000), m("assistant", 1)])).toEqual([]);
  });
  test("chat.json 항목과 화면의 턴을 질문·답 쌍으로. 끝나지 않은 턴은 빼다", () => {
    expect(historyFromEntries([{ question: "예산?", answer: "3억 [s0012]" }])).toEqual([
      { role: "user", content: "예산?" },
      { role: "assistant", content: "3억 [s0012]" },
    ]);
    const done = { ...START_ASK, phase: "done" as const, answer: "3억" };
    const failed = { ...START_ASK, phase: "error" as const, error: "x" };
    expect(turnsHistory([{ question: "a", state: done }, { question: "b", state: failed }, { question: "c", state: START_ASK }])).toEqual([
      { role: "user", content: "a" },
      { role: "assistant", content: "3억" },
    ]);
  });
});

describe("전송 안내", () => {
  test("공급자·모델 이름으로 어디로 보내는지 알린다", () => {
    expect(sendNotice({ provider: "upstage", model: null, local_only: false })).toEqual({ text: "질문과 관련 대화 일부가 Upstage(solar-pro4)로 전송됩니다. 보내는 곳: api.upstage.ai", warn: false });
    expect(sendNotice({ provider: "openai", model: "gpt-x", local_only: false }).text).toBe("질문과 관련 대화 일부가 OpenAI(gpt-x)로 전송됩니다. 보내는 곳: api.openai.com");
    expect(sendNotice({ provider: "gemma-local", model: null, local_only: true })).toEqual({ text: "질문과 관련 대화 일부를 이 Mac의 AI(gemma4:31b)가 처리합니다", warn: false });
  });
  test("고른 주소의 호스트를 알린다: 서비스 기본 호스트 대신 설정한 주소", () => {
    expect(sendNotice({ provider: "claude", model: null, local_only: false }).text).toBe("질문과 관련 대화 일부가 Claude(claude-sonnet-5-5)로 전송됩니다. 보내는 곳: api.anthropic.com");
    expect(sendNotice({ provider: "openai", model: "m", local_only: false, host: "gw.example.com:8443" }).text).toBe("질문과 관련 대화 일부가 OpenAI(m)로 전송됩니다. 보내는 곳: gw.example.com:8443");
    expect(sendNotice({ provider: "custom", model: "m", local_only: false, host: "llm.corp.example" }).text).toBe("질문과 관련 대화 일부가 직접 입력(m)로 전송됩니다. 보내는 곳: llm.corp.example");
  });
  test("이 Mac 주소는 로컬 전용 모드에서도 쓸 수 있고 이 Mac의 AI로 안내한다", () => {
    expect(sendNotice({ provider: "custom", model: "llama", local_only: true, host: "localhost:11434" })).toEqual({ text: "질문과 관련 대화 일부를 이 Mac의 AI(llama)가 처리합니다", warn: false });
    expect(sendNotice({ provider: "custom", model: "m", local_only: true, host: "[::1]:8080" }).warn).toBe(false);
    expect(sendNotice({ provider: "custom", model: "m", local_only: true, host: "localhost.evil.com" }).warn).toBe(true);
    expect(sendNotice({ provider: "openai", model: "m", local_only: true, host: "127.0.0.1:1234" }).warn).toBe(false);
  });
  test("이 Mac의 AI라도 환경변수 주소가 원격이면 원격으로 안내한다", () => {
    const n = sendNotice({ provider: "gemma-local", model: "g", local_only: false, host: "api.example.com" });
    expect(n.text).toContain("로 전송됩니다");
    expect(n.text).toContain("보내는 곳: api.example.com");
    expect(sendNotice({ provider: "gemma-local", model: "g", local_only: true, host: "api.example.com" }).warn).toBe(true);
    expect(sendNotice({ provider: "gemma-local", model: "g", local_only: true }).warn).toBe(false); // 주소가 없으면 서비스 기본(이 Mac)
  });
  test("공급자 없음·로컬 전용 모드는 경고", () => {
    expect(sendNotice({ provider: null, model: null, local_only: false })).toEqual({ text: "AI 서비스가 설정되지 않았습니다. 설정에서 API 키를 등록하세요", warn: true });
    expect(sendNotice({ provider: "upstage", model: null, local_only: true })).toEqual({ text: "로컬 전용 모드(TRACTUS_LOCAL_ONLY)라 외부 AI 서비스(Upstage)로 보내지 않습니다", warn: true });
    expect(sendNotice({ provider: "mystery", model: null, local_only: false })).toEqual({ text: "알 수 없는 AI 서비스입니다: mystery", warn: true });
    expect(sendNotice({ provider: "openai", model: null, local_only: false })).toEqual({ text: "사용할 OpenAI AI 모델을 지정하세요 (TRACTUS_LLM_MODEL)", warn: true });
    expect(sendNotice({ provider: "claude", model: null, local_only: true })).toEqual({ text: "로컬 전용 모드(TRACTUS_LOCAL_ONLY)라 외부 AI 서비스(Claude)로 보내지 않습니다", warn: true });
    // Gemini는 기본 AI 모델이 있다: 모델 이름을 비워 둬도 경고하지 않는다
    expect(sendNotice({ provider: "gemini", model: null, local_only: false })).toMatchObject({ warn: false, text: expect.stringContaining("Gemini(gemini-flash-latest)") });
  });
});

describe("삭제된 노트의 인용", () => {
  const known = new Set(["01AAA", "01BBB"]);
  test("목록에 없는 노트의 인용만 삭제된 것으로 본다", () => {
    expect(isNoteGone(known, "01AAA")).toBe(false);
    expect(isNoteGone(known, "01GONE")).toBe(true);
  });
  test("목록을 아직 읽지 못했으면 판단하지 않는다 (칩이 깜빡 꺼지지 않게)", () => {
    expect(isNoteGone(null, "01AAA")).toBe(false);
    expect(isNoteGone(undefined, "01GONE")).toBe(false);
  });
  test("노트가 지워진 뒤 목록을 새로 읽으면 같은 인용이 바로 삭제됨으로 바뀐다", () => {
    const after = new Set([...known].filter((id) => id !== "01BBB"));
    expect([isNoteGone(known, "01BBB"), isNoteGone(after, "01BBB")]).toEqual([false, true]);
  });
});

describe("코어가 실제로 낸 메모 질문 이벤트", () => {
  // `tractus ask --progress-json`을 메모 노트에 실제로 돌려 받은 줄 (가상 메모, 줄 번호는 line)
  const MID = "01M4SQKXTMEQ5BPCG841527FXK";
  const lines = [
    String.raw`{"job":"j","event":"stage","stage":"retrieve"}`,
    `{"job":"j","event":"sources","sources":[{"meeting_id":"${MID}","title":"이름 바꿈 ★","date":"2026-10-13","segment_id":"s0007","speaker":null,"start":0.0,"text":"결정: 스테이징 클러스터를 10월 말까지 만든다.","line":2}]}`,
    String.raw`{"job":"j","event":"stage","stage":"answer"}`,
    `{"job":"j","event":"done","answer":"10월 말까지 만들기로 했습니다 [s0007].","citations":[{"meeting_id":"${MID}","segment_id":"s0007","start":0.0,"line":2}],"provider":"upstage","model":"solar-pro4","no_evidence":false}`,
  ];

  test("시각 없는 인용이 줄 번호로 칩이 된다", () => {
    const end = lines.map((l) => JSON.parse(l) as AskEvent).reduce(askReduce, START_ASK);
    expect(end.phase).toBe("done");
    const cite = answerParts(end.answer).find((p) => p.kind === "cite");
    expect(cite).toEqual({ kind: "cite", meetingId: null, segId: "s0007" });
    const target = citeTarget({ meetingId: null, segId: "s0007" }, { meetingId: MID, citations: end.citations, sources: end.sources });
    expect(target).toEqual({ meetingId: MID, segId: "s0007", t: 0, line: 2 });
    expect(citeLabel(target!.t, { memo: true, line: target!.line })).toBe("2번째 줄");
  });
});
