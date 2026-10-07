import { describe, expect, test } from "vitest";
import liveSay from "./fixtures/live_say.jsonl?raw"; // bench/live_sim.py 가상 대화로 실제 `tractus live`가 낸 이벤트
import { spkStyle } from "./Speakers";
import {
  IDLE_JOB,
  IDLE_REC,
  IDLE_LIVE,
  LIVE_CAP,
  jobReduce,
  liveHalted,
  liveReduce,
  recReduce,
  type JobEvent,
  type LiveEvent,
  type RecEvent,
  dayParts,
  evidenceStart,
  fmtTime,
  groupByDay,
  highlight,
  interleave,
  levelFraction,
  parseHms,
  parseToolResult,
  recFlags,
  recMode,
  REC_MODES,
  segmentIndexAt,
  speakerName,
  speakerSlot,
  speakerStats,
  transcriptRows,
  warningText,
  DetailedError,
  ERROR_TEXT,
  APP_ERROR,
  errorView,
  stderrTail,
  JOB_ERROR,
  statusLine,
  WARNING_TEXT,
  withRecMode,
  type Segment,
} from "./lib";

const segs: Segment[] = [
  { id: "s0001", start: 0, end: 26.1, text: "a" },
  { id: "s0002", start: 26.3, end: 53.5, text: "b" },
  { id: "s0003", start: 60, end: 85.8, text: "c" },
];

describe("fmtTime / parseHms", () => {
  test("한 시간 미만은 M:SS, 이상은 H:MM:SS", () => {
    expect(fmtTime(0)).toBe("0:00");
    expect(fmtTime(65.9)).toBe("1:05");
    expect(fmtTime(3723)).toBe("1:02:03");
    expect(fmtTime(-3)).toBe("0:00");
    expect(fmtTime(NaN)).toBe("0:00");
  });
  test("MCP 세그먼트 time 문자열을 초로", () => {
    expect(parseHms("00:05:31")).toBe(331);
    expect(parseHms("01:00:00")).toBe(3600);
    expect(parseHms("05:31")).toBe(331);
    expect(parseHms("abc")).toBe(0);
  });
});

describe("segmentIndexAt", () => {
  test("구간 안·경계·공백·범위 밖", () => {
    expect(segmentIndexAt(segs, -1)).toBe(-1);
    expect(segmentIndexAt(segs, 0)).toBe(0);
    expect(segmentIndexAt(segs, 26.2)).toBe(0); // 발화 사이 공백은 직전 세그먼트 유지
    expect(segmentIndexAt(segs, 26.3)).toBe(1);
    expect(segmentIndexAt(segs, 59.9)).toBe(1);
    expect(segmentIndexAt(segs, 999)).toBe(2);
    expect(segmentIndexAt([], 5)).toBe(-1);
  });
  test("긴 회의에서도 선형 탐색과 같다", () => {
    const many = Array.from({ length: 2000 }, (_, i) => ({ id: `s${i}`, start: i * 1.7, end: i * 1.7 + 1.5, text: "" }));
    for (const t of [0, 1.69, 1.7, 1000.3, 3399.9, 5000]) {
      const linear = many.reduce((acc, s, i) => (s.start <= t ? i : acc), -1);
      expect(segmentIndexAt(many, t)).toBe(linear);
    }
  });
});

describe("interleave", () => {
  test("메모·북마크를 시각 순으로 끼워 넣는다", () => {
    const rows = interleave(segs, [
      { t: 90, kind: "memo", text: "끝" },
      { t: 26.3, kind: "bookmark", text: null },
      { t: 10, kind: "memo", text: "예산" },
    ]);
    expect(rows.map((r) => (r.kind === "seg" ? r.seg.id : `${r.memo.kind}@${r.memo.t}`))).toEqual([
      "s0001",
      "memo@10",
      "s0002", // 같은 시각이면 세그먼트 먼저
      "bookmark@26.3",
      "s0003",
      "memo@90",
    ]);
    expect(rows.filter((r) => r.kind === "seg").map((r) => (r.kind === "seg" ? r.index : -1))).toEqual([0, 1, 2]);
  });
  test("메모만 있거나 전사만 있어도 된다", () => {
    expect(interleave([], [{ t: 1, kind: "memo", text: "x" }])).toHaveLength(1);
    expect(interleave(segs, [])).toHaveLength(3);
  });
});

test("evidenceStart: 근거 세그먼트 중 가장 이른 시각", () => {
  const starts = new Map(segs.map((s) => [s.id, s.start]));
  expect(evidenceStart(["s0003", "s0002"], starts)).toBe(26.3);
  expect(evidenceStart(["s9999"], starts)).toBeNull();
  expect(evidenceStart([], starts)).toBeNull();
});

describe("parseToolResult", () => {
  test("structuredContent 우선", () => {
    expect(parseToolResult<{ a: number }>({ content: [{ type: "text", text: '{"a":2}' }], structuredContent: { a: 1 }, isError: false })).toEqual({ a: 1 });
  });
  test("structuredContent가 없으면 text JSON", () => {
    expect(parseToolResult<{ hits: unknown[] }>({ content: [{ type: "text", text: '{"hits":[]}' }] })).toEqual({ hits: [] });
  });
  test("isError면 '검색하지 못했습니다' + 서버 메시지(자세히, SDK 접두어 제거)", () => {
    const r = { content: [{ type: "text", text: "Error executing tool search_meetings: 'x'에 맞는 전사된 회의가 없습니다" }], isError: true };
    expect(() => parseToolResult(r)).toThrow(/^검색하지 못했습니다$/);
    try {
      parseToolResult(r);
    } catch (e) {
      expect(e).toBeInstanceOf(DetailedError);
      expect((e as DetailedError).detail).toBe("'x'에 맞는 전사된 회의가 없습니다");
    }
  });
  test("스마트 검색 상태 줄: 청크·벡터 수 대신 회의 수", () => {
    const st = { meetings: 12, indexed_chunks: 300, vectors: 300, vector_search: true };
    expect(statusLine(st)).toBe("스마트 검색 준비 완료 (회의 12개)");
    expect(statusLine({ ...st, vectors: 10 })).toMatch(/^일부 회의가 아직 스마트 검색에 포함되지 않았습니다\. 터미널에서 tractus index를 실행하세요 \(회의 12개\)$/);
    expect(statusLine({ ...st, vector_search: false })).toMatch(/단어 일치로만 찾습니다 \(회의 12개\)$/);
  });
  test("결과가 비면 예외", () => {
    expect(() => parseToolResult(null)).toThrow();
  });
});

test("groupByDay: 최신순 목록을 날짜별로", () => {
  const g = groupByDay([
    { created_at: "2026-10-02T14:00:00+09:00", id: 1 },
    { created_at: "2026-10-02T09:00:00+09:00", id: 2 },
    { created_at: "2026-09-30T10:00:00+09:00", id: 3 },
  ]);
  expect(g.map((x) => [x.day, x.items.length])).toEqual([
    ["2026-10-02", 2],
    ["2026-09-30", 1],
  ]);
});

test("dayParts: 요일 계산", () => {
  expect(dayParts("2026-10-02")).toEqual({ month: "2026년 10월", day: "2", weekday: "금" });
  expect(dayParts("2026-07-08").weekday).toBe("수");
});

test("highlight: 질의 단어 표시, 정규식 문자 안전", () => {
  expect(highlight("릴리스 일정은 10월", "일정 릴리스")).toEqual([
    { text: "릴리스", hit: true },
    { text: " ", hit: false },
    { text: "일정", hit: true },
    { text: "은 10월", hit: false },
  ]);
  expect(highlight("API (v2)", "(v2)")).toEqual([
    { text: "API ", hit: false },
    { text: "(v2)", hit: true },
  ]);
  expect(highlight("abc", " ")).toEqual([{ text: "abc", hit: false }]);
});

test("levelFraction", () => {
  expect(levelFraction(0)).toBe(1);
  expect(levelFraction(-30)).toBe(0.5);
  expect(levelFraction(-90)).toBe(0);
  expect(levelFraction(null)).toBe(0);
});

describe("jobReduce", () => {
  const run = (events: JobEvent[]) => events.reduce(jobReduce, { ...IDLE_JOB, running: true });

  test("stage → progress → done → exit 0이면 성공", () => {
    const s = run([
      { job: "j", event: "stage", stage: "transcribe" },
      { job: "j", event: "progress", done: 3, total: 10 },
      { job: "j", event: "done", meeting_id: "01K", meeting_dir: "/m" },
      { job: "j", event: "exit", code: 0, stderr: "" },
    ]);
    expect(s).toMatchObject({ running: false, stage: "transcribe", done: 3, total: 10, meetingId: "01K", error: null });
  });

  test("새 stage는 진행률을 0으로 되돌린다", () => {
    const s = run([
      { job: "j", event: "progress", done: 5, total: 5 },
      { job: "j", event: "stage", stage: "index" },
    ]);
    expect(s).toMatchObject({ stage: "index", done: 0, total: 0 });
  });

  test("exit 0인데 done이 없으면 stderr 끝 세 줄이 오류다", () => {
    const s = run([{ job: "j", event: "exit", code: 0, stderr: "a\nb\nc\nError: d\n" }]);
    expect(s).toMatchObject({ running: false, error: "작업이 예기치 않게 끝났습니다 (종료 코드 0)\nb\nc\nd" });
    expect(errorView(s.error, s.errorCode, JOB_ERROR.transcribe)).toEqual({ text: "작업이 예기치 않게 끝났습니다 (종료 코드 0)", detail: "b\nc\nd" });
  });

  test("stderrTail은 typer 접두어를 뗀다 (resolve_meeting은 param_hint가 따옴표 없는 MEETING)", () => {
    const real = "Try 'tractus speakers --help' for help.\n\nError: Invalid value for MEETING: ‘x’에 해당하는 회의가 없습니다. 삭제되었거나 옮겨졌을 수 있습니다.";
    expect(stderrTail(real, "").split("\n").at(-1)).toBe("‘x’에 해당하는 회의가 없습니다. 삭제되었거나 옮겨졌을 수 있습니다.");
    expect(stderrTail("Error: Invalid value for '--recording': 녹음된 소리가 없습니다", "")).toBe("녹음된 소리가 없습니다");
  });

  test("error 이벤트 메시지가 stderr보다 우선이고, stderr도 없으면 종료 코드", () => {
    expect(run([{ job: "j", event: "error", message: "키 없음" }, { job: "j", event: "exit", code: 1, stderr: "trace" }])).toMatchObject({ error: "키 없음", errorCode: null });
    expect(run([{ job: "j", event: "exit", code: null, stderr: " " }]).error).toBe("작업이 예기치 않게 끝났습니다"); // 신호로 끝남: 괄호 없이
    expect(errorView("작업이 예기치 않게 끝났습니다\nKilled", null, JOB_ERROR.transcribe)).toEqual({ text: "작업이 예기치 않게 끝났습니다", detail: "Killed" });
    const coded = run([{ job: "j", event: "error", message: "ASR model not found: /m/qwen3", code: "model_missing" }, { job: "j", event: "exit", code: 1, stderr: "" }]);
    expect(coded).toMatchObject({ error: "ASR model not found: /m/qwen3", errorCode: "model_missing" });
  });

  test("errorView: 코드 문장 > 앱 종료 문장 > 작업별 기본 문장, 코어 문구는 자세히", () => {
    expect(errorView("ASR model not found", "model_missing", JOB_ERROR.transcribe)).toEqual({ text: ERROR_TEXT.model_missing, detail: "ASR model not found" });
    expect(errorView("키 없음", "unknown_code", JOB_ERROR.summarize)).toEqual({ text: "요약하지 못했습니다", detail: "키 없음" });
    expect(errorView("답변을 받지 못했습니다 (종료 코드 1)", null, JOB_ERROR.ask)).toEqual({ text: "답변을 받지 못했습니다 (종료 코드 1)", detail: null });
    expect(errorView(null, null, JOB_ERROR.align)).toEqual({ text: "단어 싱크를 맞추지 못했습니다", detail: null });
    const spawn = "Tractus 엔진을 실행할 수 없습니다. 설정에서 tractus 실행 파일 경로를 확인하세요 (/x/tractus): 없음";
    expect(errorView(spawn, APP_ERROR, JOB_ERROR.summarize)).toEqual({ text: spawn, detail: null });
  });
});

describe("recReduce", () => {
  const run = (events: RecEvent[]) => events.reduce(recReduce, { ...IDLE_REC, phase: "starting" });
  const started: RecEvent = { event: "started", dir: "/r/01X", tracks: ["mic", "system"], started_at: "2026-10-02T14:00:00+09:00" };

  test("started → level → mark → stopped", () => {
    const s = run([
      started,
      { event: "level", t: 1.25, mic: -20, system: null },
      { event: "mark", t: 1.5, kind: "memo", text: "예산" },
      { event: "stopped", dir: "/r/01X", duration: 2.0 },
      { event: "exit", code: 0, stderr: "" },
    ]);
    expect(s).toMatchObject({ phase: "stopped", dir: "/r/01X", t: 2.0, mic: -20, system: null, error: null });
    expect(s.marks).toEqual([{ t: 1.5, kind: "memo", text: "예산" }]);
  });

  test("같은 경고 코드는 한 번만", () => {
    const w: RecEvent = { event: "warning", code: "system_zero", message: "권한 확인" };
    expect(run([started, w, w, { event: "warning", code: "mic_denied", message: "마이크" }]).warnings.map((x) => x.code)).toEqual(["system_zero", "mic_denied"]);
  });

  test("stopped 없이 exit하면 오류, error 이벤트 뒤의 exit는 메시지를 덮지 않는다", () => {
    expect(run([started, { event: "exit", code: 9, stderr: "" }])).toMatchObject({ phase: "error", error: "녹음이 예기치 않게 끝났습니다 (종료 코드 9)" });
    expect(run([started, { event: "error", message: "장치 없음" }, { event: "exit", code: 1, stderr: "x" }])).toMatchObject({ phase: "error", error: "장치 없음" });
  });
});

describe("녹음 방식", () => {
  test("대면 회의는 마이크만, 화상·하이브리드는 시스템 오디오 + 에코 제거", () => {
    expect(recFlags("in_person")).toEqual(["--no-system"]);
    expect(recFlags("hybrid")).toEqual(["--echo-cancel"]);
  });
  test("저장된 값이 없거나 모르는 값이면 대면 회의", () => {
    expect(recMode("hybrid")).toBe("hybrid");
    expect(recMode("in_person")).toBe("in_person");
    expect(recMode(undefined)).toBe("in_person");
    expect(recMode("video")).toBe("in_person");
    expect(REC_MODES[0].mode).toBe("in_person"); // 스위치 첫 칸 = 기본값
  });
  test("설정은 녹음 방식만 바꾼 사본으로 저장한다", () => {
    const s = { home: "/h", rec_mode: "in_person", fake_recorder: true };
    const next = withRecMode(s, "hybrid");
    expect(next).toEqual({ home: "/h", rec_mode: "hybrid", fake_recorder: true });
    expect(s.rec_mode).toBe("in_person");
    expect(recMode(next.rec_mode)).toBe("hybrid");
  });
  test("헤드폰을 쓰라는 안내가 없다", () => {
    for (const m of REC_MODES) expect(m.note).not.toMatch(/헤드폰|이어폰/);
  });
  test("echo_cancel_failed는 설명을 덧붙이고, 모르는 코드는 메시지 그대로", () => {
    expect(warningText({ code: "echo_cancel_failed", message: "에코 제거를 켜지 못했습니다" })).toMatch(/^에코 제거를 켜지 못했습니다 — .*두 번 기록될/);
    expect(warningText({ code: "new_code", message: "새 경고" })).toBe("새 경고");
    // 코드 문장이 있으면 코어 문구 대신 그것 (WORDS.md §4.7)
    expect(warningText({ code: "system_zero", message: "system 트랙이 5초 동안 정확히 0입니다" })).toBe(WARNING_TEXT.system_zero);
    expect(warningText({ code: "diarizer_missing", message: "화자 분리 모델이 없습니다" })).toMatch(/^참석자 구분에 필요한 파일이 없어/);
  });
  test("녹음 상태는 시작할 때 고른 방식을 유지한다", () => {
    const s = recReduce({ ...IDLE_REC, phase: "starting", mode: "hybrid" }, { event: "started", dir: "/r", tracks: ["mic", "system"], started_at: "" });
    expect(s.mode).toBe("hybrid");
    expect(IDLE_REC.mode).toBe("in_person");
  });
});

// ── 화자 (transcript.json schema_version 2. v1에는 speakers·segment.speaker가 없다) ──

describe("화자", () => {
  const speakers = { S1: { name: "김민수" }, S2: { name: null }, S3: { name: "  " } };
  const v2: Segment[] = [
    { id: "s0001", start: 0, end: 10, text: "a", speaker: "S1" },
    { id: "s0002", start: 10, end: 14, text: "b", speaker: "S1" },
    { id: "s0003", start: 14, end: 20, text: "c", speaker: "S2" },
    { id: "s0004", start: 20, end: 30, text: "d", speaker: "S1" },
    { id: "s0005", start: 30, end: 32, text: "e", speaker: null },
  ];

  test("표시 이름: 이름 > 참석자 N, 화자 없음은 null", () => {
    expect(speakerName("S1", speakers)).toBe("김민수");
    expect(speakerName("S2", speakers)).toBe("참석자 2");
    expect(speakerName("S3", speakers)).toBe("참석자 3"); // 공백 이름은 없는 것
    expect(speakerName("X", {})).toBe("X"); // 라벨 꼴이 아니면 그대로
    expect(speakerName("S9", speakers)).toBe("참석자 9"); // speakers에 없는 라벨도 번호로
    expect(speakerName(null, speakers)).toBeNull();
    expect(speakerName(undefined, {})).toBeNull();
  });

  test("색은 라벨 번호로 정해져 이름·순서·병합과 무관하다", () => {
    expect(["S1", "S2", "S8", "S9", "S16"].map(speakerSlot)).toEqual([0, 1, 7, 0, 7]);
    expect(speakerSlot("S3")).toBe(speakerSlot("S3"));
    expect(speakerSlot(null)).toBe(-1);
    expect(speakerSlot("화자")).toBe(-1);
  });

  test("색 슬롯: 라벨 번호 우선, 겹치면 빈 슬롯 (S2를 합친 뒤 새 화자 S9가 S1과 같은 색이 되지 않게)", () => {
    const slots = (labels: string[]) => speakerStats([], Object.fromEntries(labels.map((l) => [l, { name: null }]))).map((s) => s.slot);
    expect(slots(["S1", "S2", "S3"])).toEqual([0, 1, 2]);
    expect(slots(["S1", "S3", "S9"])).toEqual([0, 2, 1]);
    // 9명 이상(fluid 화자 분리): 잉크 8개를 다 쓰면 두 번째 표시(속 빈 점·빗금) 슬롯 8..15
    const nine = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"];
    expect(slots(nine)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const seventeen = Array.from({ length: 17 }, (_, i) => `S${i + 1}`);
    expect(slots(seventeen)).toEqual([...Array(16).keys(), 0]); // 16명이 넘으면 겹친다
  });

  test("화자 스타일: 슬롯 8..15는 같은 잉크에 속 빈 점·빗금 막대, 미상은 무채색", () => {
    const st = (slot: number | undefined) => spkStyle(slot) as Record<string, string>;
    expect(st(1)).toEqual({ "--spk": "var(--spk-1)", "--spk-fill": "var(--spk-1)", "--spk-bar": "var(--spk-1)" });
    expect(st(9)["--spk"]).toBe("var(--spk-1)");
    expect(st(9)["--spk-fill"]).toBe("transparent");
    expect(st(9)["--spk-bar"]).toContain("repeating-linear-gradient");
    expect(st(-1)["--spk"]).toBe("var(--ink-3)");
    expect(st(undefined)["--spk-fill"]).toBe("var(--ink-3)");
  });

  test("말한 시간 비율, 라벨 번호 순 (S10은 S2 뒤)", () => {
    const st = speakerStats([...v2, { id: "s0006", start: 40, end: 42, text: "f", speaker: "S10" }], { ...speakers, S10: { name: null } });
    expect(st.map((x) => x.label)).toEqual(["S1", "S2", "S3", "S10"]);
    expect(st[0]).toMatchObject({ display: "김민수", segments: 3, talkSec: 24 });
    expect(st[0].share).toBeCloseTo(24 / 32);
    expect(st[0].named).toBe(true);
    expect(st[2]).toMatchObject({ display: "참석자 3", named: false, segments: 0, talkSec: 0, share: 0 });
    expect(st[3].display).toBe("참석자 10");
  });

  test("schema v1(화자 필드 없음)은 화자가 없고 그대로 그린다", () => {
    expect(speakerStats(segs, {})).toEqual([]);
    expect(transcriptRows(segs, [], null).map((r) => r.kind === "seg" && r.turnStart)).toEqual([true, false, false]);
  });

  test("같은 화자가 이어지면 이름은 처음 한 번만, 메모가 끼면 다시", () => {
    const rows = transcriptRows(v2, [{ t: 5, kind: "memo", text: "m" }], null);
    expect(rows.map((r) => (r.kind === "seg" ? `${r.seg.id}${r.turnStart ? "*" : ""}` : "memo"))).toEqual(["s0001*", "memo", "s0002*", "s0003*", "s0004*", "s0005*"]);
    expect(transcriptRows(v2, [], null).map((r) => r.kind === "seg" && r.turnStart)).toEqual([true, false, true, true, true]);
  });

  test("화자 필터: 그 화자 세그먼트만, 메모는 숨기고, 원래 index를 유지(플레이어 강조용)", () => {
    const rows = transcriptRows(v2, [{ t: 12, kind: "memo", text: "m" }], "S1");
    expect(rows.map((r) => (r.kind === "seg" ? [r.index, r.turnStart] : "memo"))).toEqual([
      [0, true],
      [1, false],
      [3, true], // 사이에 다른 화자가 있었으니 새 발언
    ]);
    expect(transcriptRows(v2, [], "S7")).toEqual([]);
  });
});

test("jobReduce: warning은 진행을 멈추지 않고 코드별로 한 번만 모은다", () => {
  const w: JobEvent = { job: "j", event: "warning", code: "diarizer_missing", message: "화자 분리 모델이 없습니다" };
  const s = [{ job: "j", event: "stage", stage: "vad" } as JobEvent, w, w, { job: "j", event: "stage", stage: "encode" } as JobEvent].reduce(jobReduce, { ...IDLE_JOB, running: true });
  expect(s).toMatchObject({ running: true, stage: "encode", error: null });
  expect(s.warnings).toEqual([{ code: "diarizer_missing", message: "화자 분리 모델이 없습니다" }]);
  expect(IDLE_JOB.warnings).toEqual([]);
});

// ── Phase 5 (docs/roadmap.md §2) ──

import {
  applyEdits,
  baseName,
  EXPORT_FORMATS,
  exportFilename,
  findMatches,
  inverseEdits,
  isImeKey,
  isImportable,
  oneLine,
  parseRate,
  RATES,
  replaceEdits,
  segText,
  silenceSkip,
  stepRate,
  summaryMarkdown,
} from "./lib";

describe("재생 속도 (5.1)", () => {
  test("목록 안에서 한 칸씩, 끝에서는 멈춘다", () => {
    expect(RATES).toEqual([0.8, 1, 1.2, 1.5, 1.8, 2]);
    expect(stepRate(1, 1)).toBe(1.2);
    expect(stepRate(1, -1)).toBe(0.8);
    expect(stepRate(2, 1)).toBe(2);
    expect(stepRate(0.8, -1)).toBe(0.8);
  });
  test("목록에 없는 값은 그 방향의 가장 가까운 값으로", () => {
    expect(stepRate(1.1, 1)).toBe(1.2);
    expect(stepRate(1.1, -1)).toBe(1);
    expect(stepRate(3, -1)).toBe(2);
  });
  test("localStorage 값은 목록에 있을 때만 쓴다", () => {
    expect(parseRate("1.5")).toBe(1.5);
    expect(parseRate(null)).toBe(1);
    expect(parseRate("7")).toBe(1);
    expect(parseRate("abc")).toBe(1);
  });
});

describe("무음 건너뛰기 (5.2)", () => {
  // 0–26.1, 26.3–53.5, 60–85.8: 두 번째 공백(6.5초)만 1초를 넘는다
  test("1초 넘는 공백에 들어서면 다음 발화 0.2초 전으로", () => {
    expect(silenceSkip(segs, 54)).toBeCloseTo(59.8);
    expect(silenceSkip(segs, 53.5)).toBeCloseTo(59.8);
  });
  test("발화 중, 짧은 공백, 남은 공백이 1초 이하, 마지막 뒤에는 그대로", () => {
    expect(silenceSkip(segs, 10)).toBeNull();
    expect(silenceSkip(segs, 26.2)).toBeNull();
    expect(silenceSkip(segs, 59.1)).toBeNull();
    expect(silenceSkip(segs, 59.8)).toBeNull(); // 건너뛴 자리에서 다시 건너뛰지 않는다
    expect(silenceSkip(segs, 90)).toBeNull();
  });
  test("첫 발화 전 무음", () => {
    expect(silenceSkip([{ id: "s1", start: 5, end: 6, text: "" }], 0)).toBeCloseTo(4.8);
  });
  test("화자 필터: 그 화자의 세그먼트만 넘기면 다른 화자의 발화도 건너뛴다", () => {
    const mixed: Segment[] = [
      { id: "s1", start: 0, end: 3, text: "", speaker: "S1" },
      { id: "s2", start: 3.1, end: 9, text: "", speaker: "S2" },
      { id: "s3", start: 9.1, end: 12, text: "", speaker: "S1" },
    ];
    expect(silenceSkip(mixed, 3.5)).toBeNull();
    expect(silenceSkip(mixed.filter((s) => s.speaker === "S1"), 3.5)).toBeCloseTo(8.9);
  });
});

const ed = (over: Partial<Segment>[]): Segment[] => over.map((o, i) => ({ id: `s000${i + 1}`, start: i * 10, end: i * 10 + 5, text: "", corrected_text: null, ...o }));

describe("텍스트 편집 (5.3)", () => {
  test("표시 텍스트는 corrected_text 우선", () => {
    expect(segText({ id: "s", start: 0, end: 1, text: "원문", corrected_text: "고침" })).toBe("고침");
    expect(segText({ id: "s", start: 0, end: 1, text: "원문", corrected_text: null })).toBe("원문");
    expect(segText({ id: "s", start: 0, end: 1, text: "원문" })).toBe("원문");
  });
  test("편집 반영은 코어와 같다: 공백을 한 칸으로, 원문과 같으면 해제", () => {
    const s = ed([{ text: "버짓 보겠습니다" }, { text: "네", corrected_text: "예" }, { text: "원문  두 칸" }]);
    const out = applyEdits(s, [
      { id: "s0001", text: " budget   보겠습니다 " },
      { id: "s0002", text: "네" },
      { id: "s0003", text: "원문 두 칸" }, // 코어도 원문을 한 줄로 줄여 비교한다
    ]);
    expect(out[0].corrected_text).toBe("budget 보겠습니다");
    expect(out[1].corrected_text).toBeNull();
    expect(out[2].corrected_text).toBeNull();
    expect(s[0].corrected_text).toBeNull(); // 원본은 그대로
  });
  test("되돌리기 묶음은 편집 직전의 표시 텍스트이고, 적용하면 원래대로", () => {
    const s = ed([{ text: "a" }, { text: "b", corrected_text: "B" }, { text: "c" }]);
    const edits = [
      { id: "s0001", text: "A" },
      { id: "s0002", text: "BB" },
    ];
    const inv = inverseEdits(s, edits);
    expect(inv).toEqual([
      { id: "s0001", text: "a" },
      { id: "s0002", text: "B" },
    ]);
    expect(applyEdits(applyEdits(s, edits), inv)).toEqual(s);
  });
  test("한 줄로: 코어 store.one_line과 같다 (공백·줄바꿈은 한 칸, 제어 문자 제거)", () => {
    expect(oneLine(" 첫 줄\n둘째  줄 \r\n")).toBe("첫 줄 둘째 줄");
    expect(oneLine("a\tb\u3000c\u0007d")).toBe("a b cd");
    expect(oneLine(" \u0001 ")).toBe("");
  });
  test("한글 조합 중 키는 무시한다 (WebKit은 compositionend 뒤 keyCode 229 keydown이 온다)", () => {
    expect(isImeKey({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isImeKey({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeKey({ isComposing: false, keyCode: 13 }, true)).toBe(true);
    expect(isImeKey({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});

describe("찾기·바꾸기 (5.4)", () => {
  const s = ed([
    { text: "Budget 예산 budget", speaker: "S1" },
    { text: "없음", corrected_text: "예산 확정", speaker: "S2" },
    { text: "예산" },
  ]);
  test("표시 텍스트에서 대소문자 없이 찾는다 (화자 이름은 찾지 않는다)", () => {
    expect(findMatches(s, "budget")).toEqual([
      { id: "s0001", start: 0, length: 6 },
      { id: "s0001", start: 10, length: 6 },
    ]);
    expect(findMatches(s, "예산").map((m) => m.id)).toEqual(["s0001", "s0002", "s0003"]);
    expect(findMatches(s, "없음")).toEqual([]); // 원문이 아니라 고친 문장에서 찾는다
    expect(findMatches(s, "S1")).toEqual([]);
    expect(findMatches(s, "")).toEqual([]);
    expect(findMatches(ed([{ text: "a.b axb" }]), ".")).toEqual([{ id: "s0001", start: 1, length: 1 }]); // 정규식이 아니다
  });
  test("모두 바꾸기는 편집 묶음 하나, 되돌리기도 묶음 하나", () => {
    const edits = replaceEdits(s, "예산", "$&비용");
    expect(edits).toEqual([
      { id: "s0001", text: "Budget $&비용 budget" },
      { id: "s0002", text: "$&비용 확정" },
      { id: "s0003", text: "$&비용" },
    ]);
    const inv = inverseEdits(s, edits);
    expect(inv).toHaveLength(3);
    expect(applyEdits(applyEdits(s, edits), inv)).toEqual(s);
  });
  test("200개 세그먼트도 편집 1회", () => {
    const many = ed(Array.from({ length: 200 }, () => ({ text: "버짓 회의" })));
    expect(replaceEdits(many, "버짓", "budget")).toHaveLength(200);
  });
  test("하나만 바꾸기는 그 위치만", () => {
    const [, second] = findMatches(s, "budget");
    expect(replaceEdits(s, "budget", "예산", second)).toEqual([{ id: "s0001", text: "Budget 예산 예산" }]);
  });
  test("바꿔도 같거나 빈 문장이 되는 세그먼트는 뺀다", () => {
    expect(replaceEdits(s, "예산", "예산")).toEqual([]);
    expect(replaceEdits(ed([{ text: "음" }, { text: "음 네" }]), "음", "")).toEqual([{ id: "s0002", text: " 네" }]);
    expect(replaceEdits(ed([{ text: "a  b" }]), "  ", " ")).toEqual([]); // 코어 기준으로 같은 문장
    expect(replaceEdits(ed([{ text: "a" }]), "a", "\u0001")).toEqual([]); // 코어가 빈 문장으로 거부한다
  });
});

describe("파일 가져오기 (5.5)", () => {
  test("확장자 allowlist는 대소문자를 가리지 않는다", () => {
    for (const p of ["/a/회의.M4A", "/a/b.mp3", "/a/c.WAV", "/x/y.mov", "/x/y.Mp4", "/x/z.webm", "/x/z.opus"]) expect(isImportable(p)).toBe(true);
    for (const p of ["/a/b.txt", "/a/mp3", "/a/b.mp3.exe", "/a/.m4a", ""]) expect(isImportable(p)).toBe(false);
  });
  test("파일 이름", () => {
    expect(baseName("/Users/me/회의 녹음.m4a")).toBe("회의 녹음.m4a");
  });
});

describe("내보내기 (5.6)", () => {
  test("기본 파일 이름은 <날짜>_<제목>.<확장자>", () => {
    expect(exportFilename("2026-10-02T14:00:00+09:00", "주간회의", "docx")).toBe("2026-10-02_주간회의.docx");
    expect(exportFilename("2026-10-02T14:00:00+09:00", " a/b: c? ", "txt")).toBe("2026-10-02_a b c.txt");
    expect(exportFilename("", "", "srt")).toBe("회의_제목 없음.srt");
  });
  test("형식 목록: bundle은 zip", () => {
    expect(EXPORT_FORMATS.map((f) => f.format)).toEqual(["txt", "md", "srt", "vtt", "csv", "docx", "bundle"]);
    expect(EXPORT_FORMATS.find((f) => f.format === "bundle")?.ext).toBe("zip");
  });
  test("요약 복사는 마크다운", () => {
    const md = summaryMarkdown(
      {
        summary: "예산을 정했다.",
        topics: [{ title: "예산", segment_ids: ["s0001"] }],
        decisions: [{ text: "10% 증액", segment_ids: ["s0002"] }],
        action_items: [{ task: "표 정리", owner: "김민수", due: "금요일", segment_ids: [] }],
      },
      new Map([["s0002", 65]]),
    );
    expect(md).toBe(
      ["## 요약", "", "예산을 정했다.", "", "## 결정 사항", "", "- 10% 증액 (1:05)", "", "## 할 일", "", "- [ ] 표 정리 — 김민수, 금요일", "", "## 주제", "", "- 예산", ""].join("\n"),
    );
  });
});

// ── Phase 6.1·6.2: 단어 타이밍, 가라오케, 단어 클릭 ──

import { clickSeekTime, tokenOffsets, usableWords, wordIndexAt, type Word } from "./lib";

describe("단어 타이밍", () => {
  const words: Word[] = [
    { text: "예산은", start: 10, end: 10.4 },
    { text: "3억", start: 10.5, end: 10.9 },
    { text: "원입니다.", start: 11, end: 11.6, approx: true },
  ];
  const seg: Segment = { id: "s0001", start: 9.8, end: 12, text: "예산은  3억 원입니다.", words };

  test("wordIndexAt: start <= t인 마지막 단어, 첫 단어 전이면 -1", () => {
    expect(wordIndexAt(words, 9.9)).toBe(-1);
    expect(wordIndexAt(words, 10)).toBe(0);
    expect(wordIndexAt(words, 10.45)).toBe(0); // 단어 사이 공백은 직전 단어
    expect(wordIndexAt(words, 10.5)).toBe(1);
    expect(wordIndexAt(words, 99)).toBe(2);
    expect(wordIndexAt([], 1)).toBe(-1);
  });

  test("tokenOffsets: 공백 토큰의 글자 위치 (연속 공백·앞뒤 공백)", () => {
    expect(tokenOffsets(" 예산은  3억 원입니다.")).toEqual([
      { start: 1, end: 4 },
      { start: 6, end: 8 },
      { start: 9, end: 14 },
    ]);
    expect(tokenOffsets("")).toEqual([]);
  });

  test("usableWords: 표시 텍스트(corrected_text 우선)와 수·글자가 맞을 때만", () => {
    expect(usableWords(seg)).toBe(words);
    expect(usableWords({ ...seg, words: null })).toBeNull();
    expect(usableWords({ ...seg, words: undefined })).toBeNull();
    expect(usableWords({ ...seg, words: [] })).toBeNull();
    // 저장 중인 편집(낙관적 반영): 단어 수가 달라졌다
    expect(usableWords({ ...seg, corrected_text: "예산은 3억 원입니다. 맞죠" })).toBeNull();
    // 수는 같지만 글자가 다르다
    expect(usableWords({ ...seg, corrected_text: "예산은 4억 원입니다." })).toBeNull();
    // 코어가 다시 맞춘 단어(교정문 기준)는 쓴다
    const fixed = [...words.slice(0, 1), { text: "4억", start: 10.5, end: 10.9, approx: true }, words[2]];
    expect(usableWords({ ...seg, corrected_text: "예산은 4억 원입니다.", words: fixed })).toBe(fixed);
  });

  test("clickSeekTime: 누른 단어의 시작, 보간한 단어·단어 밖·타이밍 없음은 세그먼트 시작", () => {
    expect(clickSeekTime(seg, 0)).toBe(10); // "예"
    expect(clickSeekTime(seg, 3)).toBe(10); // 단어 끝(오른쪽 반)
    expect(clickSeekTime(seg, 4)).toBe(10); // 사이 공백은 앞 단어
    expect(clickSeekTime(seg, 5)).toBe(10.5);
    expect(clickSeekTime(seg, 10)).toBe(9.8); // approx
    expect(clickSeekTime(seg, null)).toBe(9.8); // 키보드·시간 칸
    expect(clickSeekTime({ ...seg, words: null }, 6)).toBe(9.8);
    expect(clickSeekTime({ ...seg, text: " 예산은 3억 원입니다.", words }, 0)).toBe(9.8); // 첫 단어 앞
  });
});

test("jobReduce: event 없는 결과 줄({\"aligned\": N})과 모르는 이벤트는 무시한다", () => {
  const s = { ...IDLE_JOB, running: true, stage: "align" };
  expect(jobReduce(s, { job: "j", aligned: 3, failed: 0, skipped: 1 } as unknown as JobEvent)).toBe(s);
  expect(jobReduce(s, { job: "j", event: "later" } as unknown as JobEvent)).toBe(s);
});

import { renameRemembering, renameRequest, STAGE_LABEL, suggestionOf, suggestionText, type Speakers } from "./lib";

describe("목소리 제안 (7.1)", () => {
  const sug = { person_id: "01P", name: "홍길동", score: 0.823 };
  const speakers: Speakers = {
    S1: { name: null, suggested: sug },
    S2: { name: "김민수", suggested: sug }, // 확정한 이름이 이긴다
    S3: { name: null },
    S4: { name: null, suggested: { person_id: "x", name: " ", score: 0.9 } },
  };

  test("제안은 표시 이름이 아니다", () => {
    expect(speakerName("S1", speakers)).toBe("참석자 1");
    expect(speakerStats([], speakers).map((s) => [s.display, s.suggested?.name ?? null])).toEqual([
      ["참석자 1", "홍길동"],
      ["김민수", null],
      ["참석자 3", null],
      ["참석자 4", null],
    ]);
  });

  test("이름이 없을 때만, 이름이 빈 제안은 버린다", () => {
    expect(suggestionOf("S1", speakers)).toBe(sug);
    expect(suggestionOf("S2", speakers)).toBeNull();
    expect(suggestionOf("S4", speakers)).toBeNull();
    expect(suggestionOf("S9", speakers)).toBeNull();
  });

  test("배지 글", () => {
    expect(suggestionText(sug)).toBe("홍길동 님인가요? (일치율 82%)");
    expect(suggestionText({ ...sug, score: 1.4 })).toBe("홍길동 님인가요? (일치율 100%)");
  });

  test("기억하기는 이름과 동의 확인이 모두 있어야 한다", () => {
    expect(renameRequest(" 홍길동 ", false, false)).toEqual({ name: "홍길동", remember: false });
    expect(renameRequest("", false, false)).toEqual({ name: "", remember: false }); // 이름 지우기
    expect(renameRequest("홍길동", true, false)).toHaveProperty("error");
    expect(renameRequest("  ", true, true)).toHaveProperty("error");
    expect(renameRequest("홍길동", true, true)).toEqual({ name: "홍길동", remember: true });
  });

  test("목소리 등록이 실패해도 입력한 이름은 바꾼다", async () => {
    const calls: string[] = [];
    const rename = async () => (calls.push("rename"), "renamed");
    const fail = (msg: string) => async () => {
      throw new Error(msg);
    };
    expect(await renameRemembering(async () => ({ samples: 2, meeting: "enrolled" }), rename)).toEqual({ meeting: "enrolled", samples: 2 });
    expect(calls).toEqual([]); // 코어 enroll이 이름도 바꿨다
    const r = await renameRemembering(fail("목소리 모델이 없습니다"), rename);
    expect(r).toMatchObject({ meeting: "renamed" });
    expect((r as { voiceError: Error }).voiceError.message).toBe("목소리 모델이 없습니다");
    expect(calls).toEqual(["rename"]);
    expect(await renameRemembering(fail("v"), fail("r"))).toMatchObject({ voiceError: { message: "v" }, renameError: { message: "r" } });
  });

  test("stage voices", () => {
    expect(STAGE_LABEL.voices).toBe("등록된 참석자 확인 중…");
  });

  // 실제 코어 출력 (가상 `say` 회의 통합 실행, 경로만 줄였다)
  test("실제 transcribe·match 이벤트와 화자 맵", () => {
    const run = (evs: object[]) => evs.map((e) => ({ job: "j", ...e }) as JobEvent).reduce(jobReduce, { ...IDLE_JOB, running: true });
    const stages = ["decode", "vad", "diarize", "voices", "encode", "load_model", "transcribe", "align", "index"];
    const evs = [
      ...stages.map((stage) => ({ event: "stage", stage })),
      { event: "done", meeting_id: "01M4ABVPTZ4KVT6M6V9RDYRDHB", meeting_dir: "/h/meetings/x" },
      { event: "exit", code: 0, stderr: "" },
    ];
    expect(run(evs.slice(0, 4)).stage).toBe("voices");
    expect(stages.filter((s) => !STAGE_LABEL[s])).toEqual([]);
    expect(run(evs)).toMatchObject({ running: false, error: null, meetingId: "01M4ABVPTZ4KVT6M6V9RDYRDHB" });

    // voices match --progress-json: done에 suggested가 붙어도 성공
    expect(run([{ event: "stage", stage: "decode" }, { event: "stage", stage: "voices" }, { event: "done", meeting_id: "01M", meeting_dir: "/h", suggested: 1 }, { event: "exit", code: 0, stderr: "" }]).error).toBeNull();

    // 모델이 없으면 경고만 남기고 끝까지 간다
    const missing = run([
      { event: "stage", stage: "diarize" },
      { event: "warning", code: "voices_model_missing", message: "목소리 모델이 없어 등록된 목소리를 맞춰 보지 않습니다: /m/3dspeaker-campplus-zh-en/x.onnx\n  mkdir -p …" },
      { event: "done", meeting_id: "01M4AC0D65GG2T9NMDF4QJR9RD", meeting_dir: "/h" },
      { event: "exit", code: 0, stderr: "" },
    ]);
    expect(missing.error).toBeNull();
    expect(missing.warnings.map((w) => w.code)).toEqual(["voices_model_missing"]);

    // Rust가 직렬화한 화자 맵 (S2는 suggested: null)
    const real: Speakers = { S1: { name: null, suggested: { person_id: "01M4ABVBAA6N46V7MCV8M7DC17", name: "유나", score: 0.96 } }, S2: { name: null, suggested: null } };
    const st = speakerStats([], real);
    expect(st.map((s) => [s.display, s.suggested && suggestionText(s.suggested)])).toEqual([
      ["참석자 1", "유나 님인가요? (일치율 96%)"],
      ["참석자 2", null],
    ]);
    // 확정(= 이름 바꾸기) 뒤 코어가 suggested를 지운 맵
    expect(speakerStats([], { S1: { name: "유나" }, S2: { name: null } }).map((s) => [s.display, s.suggested])).toEqual([
      ["유나", null],
      ["참석자 2", null],
    ]);
  });
});

describe("liveReduce", () => {
  const run = (events: LiveEvent[]) => events.reduce(liveReduce, IDLE_LIVE);
  const live = (kind: "partial" | "final", id: string, start: number, text: string): LiveEvent => ({ event: "live", kind, id, start, end: start + 1, text });

  test("stages: loading then on", () => {
    expect(run([{ event: "stage", stage: "live_load" }]).status).toBe("loading");
    expect(run([{ event: "stage", stage: "live_load" }, { event: "stage", stage: "live" }]).status).toBe("on");
  });

  test("partial is replaced by a later partial, then by the final with the same id", () => {
    const s1 = run([live("partial", "l0001", 0, "안녕"), live("partial", "l0001", 0, "안녕하세요 여러")]);
    expect(s1.partial?.text).toBe("안녕하세요 여러");
    expect(s1.finals).toEqual([]);
    const s2 = liveReduce(s1, live("final", "l0001", 0, "안녕하세요 여러분"));
    expect(s2.partial).toBeNull();
    expect(s2.finals).toEqual([{ id: "l0001", start: 0, end: 1, text: "안녕하세요 여러분" }]);
    // 확정된 발화의 늦은 partial은 무시한다
    expect(liveReduce(s2, live("partial", "l0001", 0, "안녕"))).toBe(s2);
  });

  test("final of another id keeps the current partial; finals stay ordered by start", () => {
    const s = run([live("final", "l0002", 5, "둘"), live("partial", "l0003", 9, "셋"), live("final", "l0001", 1, "하나")]);
    expect(s.finals.map((f) => f.id)).toEqual(["l0001", "l0002"]);
    expect(s.partial?.id).toBe("l0003");
    expect(liveReduce(s, live("final", "l0002", 5, "둘 고침")).finals.map((f) => f.text)).toEqual(["하나", "둘 고침"]);
  });

  test("an empty final removes that id's partial and adds no line", () => {
    const s = run([live("final", "l0001", 0, "하나"), live("partial", "l0002", 2, "음")]);
    const s2 = liveReduce(s, live("final", "l0002", 2, ""));
    expect(s2.partial).toBeNull();
    expect(s2.finals.map((f) => f.id)).toEqual(["l0001"]);
  });

  test("real `tractus live` JSONL (synthetic say dialogue) reduces to its finals, in order, with no partial left", () => {
    const events = liveSay.trim().split("\n").map((l) => JSON.parse(l) as LiveEvent);
    const finals = events.filter((e): e is Extract<LiveEvent, { event: "live" }> => e.event === "live" && e.kind === "final");
    const s = run([...events, { event: "exit", code: 0, stderr: "" }]);
    expect(s.status).toBe("stopped");
    expect(s.partial).toBeNull();
    expect(s.finals.map((f) => f.id)).toEqual(finals.map((f) => f.id));
    expect(s.finals.every((f, i, a) => i === 0 || a[i - 1].start <= f.start)).toBe(true);
    // 진행 중에는 partial이 보이다가 같은 id의 final이 그 자리를 바꾼다
    const mid = run(events.slice(0, events.findIndex((e) => e.event === "live" && e.kind === "final")));
    expect(mid.partial?.id).toBe(finals[0].id);
  });

  test("keeps only the last LIVE_CAP finals", () => {
    const events = Array.from({ length: LIVE_CAP + 20 }, (_, i) => live("final", `l${String(i + 1).padStart(4, "0")}`, i, `줄 ${i}`));
    const s = run(events);
    expect(s.finals).toHaveLength(LIVE_CAP);
    expect(s.finals[0].id).toBe("l0021");
    expect(s.finals.at(-1)?.text).toBe(`줄 ${LIVE_CAP + 19}`);
  });

  test("done + exit 0 is a clean stop and drops the unfinished partial", () => {
    const s = run([{ event: "stage", stage: "live" }, live("final", "l0001", 0, "끝"), live("partial", "l0002", 2, "미완"), { event: "done" }, { event: "exit", code: 0, stderr: "" }]);
    expect(s.status).toBe("stopped");
    expect(s.partial).toBeNull();
    expect(s.finals).toHaveLength(1);
    expect(s.error).toBeNull();
  });

  test("exit without done is a failure with the error message or stderr tail", () => {
    expect(run([{ event: "error", message: "메모리가 부족합니다" }, { event: "exit", code: 1, stderr: "x" }])).toMatchObject({ status: "failed", error: "메모리가 부족합니다" });
    expect(run([{ event: "stage", stage: "live" }, { event: "exit", code: null, stderr: "a\nb\nc\nTraceback" }])).toMatchObject({ status: "failed", error: "b\nc\nTraceback" });
  });

  test("a signal exit with empty stderr reads as a stopped process, not '종료 코드 null'", () => {
    expect(run([{ event: "stage", stage: "live" }, { event: "exit", code: null, stderr: "" }])).toMatchObject({ status: "failed", error: "실시간 변환이 예기치 않게 끝났습니다" });
    expect(run([{ event: "exit", code: 2, stderr: "" }]).error).toBe("실시간 변환이 예기치 않게 끝났습니다 (종료 코드 2)");
    expect(run([{ event: "error", message: "RAM 8 GB < 16 GB", code: "live_low_memory" }, { event: "exit", code: 1, stderr: "" }])).toMatchObject({ error: "RAM 8 GB < 16 GB", errorCode: "live_low_memory" });
  });

  test("liveHalted: any exit while still recording shows the notice, even a clean SIGTERM stop", () => {
    const clean = run([{ event: "stage", stage: "live" }, live("final", "l0001", 0, "끝"), { event: "done" }, { event: "exit", code: 0, stderr: "" }]);
    const crashed = run([{ event: "stage", stage: "live" }, { event: "exit", code: null, stderr: "" }]);
    expect(liveHalted(clean, true)).toBe(true);
    expect(liveHalted(crashed, true)).toBe(true);
    // 사용자가 정지한 뒤(녹음 단계를 벗어남)의 종료와 실행 중인 자막은 안내하지 않는다
    expect(liveHalted(clean, false)).toBe(false);
    expect(liveHalted(crashed, false)).toBe(false);
    expect(liveHalted(run([{ event: "stage", stage: "live" }]), true)).toBe(false);
    expect(liveHalted(IDLE_LIVE, true)).toBe(false);
  });

  test("warnings are shown once per code; unknown events are ignored", () => {
    const lag: LiveEvent = { event: "warning", code: "live_lagging", message: "늦어지고 있습니다" };
    expect(run([lag, lag]).warnings).toHaveLength(1);
    const s = run([{ event: "stage", stage: "live" }]);
    expect(liveReduce(s, { event: "progress" } as unknown as LiveEvent)).toBe(s);
  });
});
