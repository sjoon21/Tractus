import { describe, expect, test } from "vitest";
import {
  IDLE_JOB,
  IDLE_REC,
  jobReduce,
  recReduce,
  type JobEvent,
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
  warningText,
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
  test("isError면 서버 메시지로 예외 (SDK 접두어 제거)", () => {
    const r = { content: [{ type: "text", text: "Error executing tool search_meetings: 'x'에 맞는 전사된 회의가 없습니다" }], isError: true };
    expect(() => parseToolResult(r)).toThrow(/^'x'에 맞는 전사된 회의가 없습니다$/);
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
    const s = run([{ job: "j", event: "exit", code: 0, stderr: "a\nb\nc\nd\n" }]);
    expect(s).toMatchObject({ running: false, error: "b\nc\nd" });
  });

  test("error 이벤트 메시지가 stderr보다 우선이고, stderr도 없으면 종료 코드", () => {
    expect(run([{ job: "j", event: "error", message: "키 없음" }, { job: "j", event: "exit", code: 1, stderr: "trace" }]).error).toBe("키 없음");
    expect(run([{ job: "j", event: "exit", code: null, stderr: " " }]).error).toBe("종료 코드 null");
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
    expect(run([started, { event: "exit", code: 9, stderr: "" }])).toMatchObject({ phase: "error", error: "녹음 헬퍼가 종료되었습니다 (코드 9)" });
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
    expect(warningText({ code: "echo_cancel_failed", message: "에코 제거를 켜지 못했습니다" })).toMatch(/^에코 제거를 켜지 못했습니다 — .*두 번 전사/);
    expect(warningText({ code: "new_code", message: "새 경고" })).toBe("새 경고");
  });
  test("녹음 상태는 시작할 때 고른 방식을 유지한다", () => {
    const s = recReduce({ ...IDLE_REC, phase: "starting", mode: "hybrid" }, { event: "started", dir: "/r", tracks: ["mic", "system"], started_at: "" });
    expect(s.mode).toBe("hybrid");
    expect(IDLE_REC.mode).toBe("in_person");
  });
});
