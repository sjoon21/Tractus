import { describe, expect, test } from "vitest";
import { APP_ERROR, IDLE_JOB, type JobState } from "./lib";
import { exportFormatsFor } from "./memo";
import { canQueueConvert, CONVERT_FIRST, convertPanelView, deleteBlockedWhileConverting, DELETE_BLOCKED, isRecorded, noteLabel, railNotice, recordedIds, recordedStats, keptNotice, keptTitle, KEPT_WARN, WAIT_OTHER, WAIT_RECORDING } from "./recorded";
import { railTabs } from "./rail";

const job = (o: Partial<JobState> = {}): JobState => ({ ...IDLE_JOB, ...o });

describe("isRecorded", () => {
  test("녹음 노트의 state가 recorded일 때만", () => {
    expect(isRecorded({ kind: "recording", state: "recorded" })).toBe(true);
    expect(isRecorded({ state: "recorded" })).toBe(true); // 옛 노트는 kind가 없다 = 녹음
    for (const m of [{}, { kind: "recording" }, { state: null }, { state: "queued" }, { kind: "memo", state: "recorded" }]) expect(isRecorded(m)).toBe(false);
  });

  test("변환 전 노트의 ID는 만든 순서(오래된 것부터), 같으면 목록 순서", () => {
    const n = (id: string, created_at: string, state?: string, kind?: string) => ({ id, created_at, state, kind });
    const notes = [n("c", "2026-10-14T12:00:00+09:00", "recorded"), n("x", "2026-10-14T11:00:00+09:00"), n("a", "2026-10-13T09:00:00+09:00", "recorded"), n("m", "2026-10-13T08:00:00+09:00", "recorded", "memo"), n("b", "2026-10-13T09:00:00+09:00", "recorded")];
    expect(recordedIds(notes)).toEqual(["a", "b", "c"]);
    expect(recordedIds([])).toEqual([]);
  });
});

describe("변환 전 노트 화면 모델", () => {
  test("쉬는 중: 변환 단추를 보인다", () => {
    expect(convertPanelView(job(), null, WAIT_OTHER)).toEqual({ phase: "idle" });
  });

  test("변환 중: 단계 문구와 진행률 (총량을 모르면 진행률 없음)", () => {
    expect(convertPanelView(job({ running: true, stage: "transcribe", done: 9, total: 20 }), "running", WAIT_OTHER)).toEqual({ phase: "running", text: "음성을 글로 변환하는 중…", pct: 45 });
    expect(convertPanelView(job({ running: true, stage: "load_model" }), "running", WAIT_OTHER)).toEqual({ phase: "running", text: "변환 엔진 시작하는 중…", pct: null });
    expect(convertPanelView(job({ running: true }), null, WAIT_OTHER)).toMatchObject({ phase: "running", text: "변환 준비 중…" });
  });

  test("줄에서 기다리는 중: 이유 문장을 보인다 (녹음 중이거나 앞선 변환)", () => {
    expect(convertPanelView(job(), "queued", WAIT_RECORDING)).toEqual({ phase: "queued", text: "녹음이 끝나면 변환을 시작합니다" });
    expect(convertPanelView(job(), "queued", WAIT_OTHER)).toEqual({ phase: "queued", text: "앞선 변환이 끝나면 시작합니다" });
  });

  test("진행 중이 기다리는 중·실패보다 먼저다", () => {
    expect(convertPanelView(job({ running: true, error: "x" }), "queued", WAIT_OTHER).phase).toBe("running");
    expect(convertPanelView(job({ error: "x" }), "queued", WAIT_OTHER).phase).toBe("queued");
  });

  test("실패: 코드 문장과 접힌 `자세히`, 코드가 없으면 기본 문장", () => {
    expect(convertPanelView(job({ error: "ffmpeg not found", errorCode: "ffmpeg_missing" }), null, WAIT_OTHER)).toMatchObject({
      phase: "error",
      text: "음성 파일을 읽는 데 필요한 ffmpeg가 없습니다. 터미널에서 brew install ffmpeg로 설치하세요.",
      detail: "ffmpeg not found",
    });
    expect(convertPanelView(job({ error: "boom" }), null, WAIT_OTHER)).toEqual({ phase: "error", text: "텍스트로 변환하지 못했습니다", detail: "boom" });
    // 앱(Rust)이 만든 오류는 첫 줄이 문장
    expect(convertPanelView(job({ error: "Tractus 엔진을 실행할 수 없습니다.\nos error 2", errorCode: APP_ERROR }), null, WAIT_OTHER)).toEqual({ phase: "error", text: "Tractus 엔진을 실행할 수 없습니다.", detail: "os error 2" });
    // 변환 전 노트가 아니라는 코어 코드
    expect(convertPanelView(job({ error: "not recorded", errorCode: "not_recorded" }), null, WAIT_OTHER)).toMatchObject({ phase: "error", text: "이미 텍스트로 변환한 노트입니다." });
  });

  test("변환 줄에 올릴 수 있는가: 차례가 없고 돌고 있지 않을 때만 (두 번 누름 방지)", () => {
    expect(canQueueConvert(null, job())).toBe(true);
    expect(canQueueConvert("queued", job())).toBe(false);
    expect(canQueueConvert("running", job({ running: true }))).toBe(false);
    expect(canQueueConvert(null, job({ running: true }))).toBe(false);
    expect(canQueueConvert(null, job({ error: "x" }))).toBe(true); // 실패 뒤 다시 변환
  });

  test("머리 통계: 대화 개수 없이 길이와 녹음 중 메모", () => {
    expect(recordedStats(754, 0)).toBe("12:34");
    expect(recordedStats(65, 2)).toBe("1:05 · 녹음 중 메모 2개");
  });

  test("변환 중이거나 줄에서 기다리는 노트는 지울 수 없다", () => {
    expect(deleteBlockedWhileConverting("running")).toBe(DELETE_BLOCKED);
    expect(deleteBlockedWhileConverting("queued")).toBe(DELETE_BLOCKED);
    expect(deleteBlockedWhileConverting(null)).toBeNull();
  });

  test("요약·AI 질문 탭은 변환 전에는 설명을 보인다, 메모 탭은 그대로", () => {
    expect(railNotice("summary", true)).toBe(CONVERT_FIRST);
    expect(railNotice("ask", true)).toBe(CONVERT_FIRST);
    expect(railNotice("memo", true)).toBeNull();
    for (const tab of railTabs(false)) expect(railNotice(tab, false)).toBeNull();
  });

  test("내보내기: 변환 전에는 자막(SRT·WebVTT)이 없고 나머지는 된다", () => {
    const formats = (memo: boolean, recorded: boolean) => exportFormatsFor(memo, recorded).map((f) => f.format);
    expect(formats(false, true)).not.toContain("srt");
    expect(formats(false, true)).not.toContain("vtt");
    for (const f of ["txt", "md", "docx", "csv", "bundle"]) expect(formats(false, true)).toContain(f);
    expect(formats(false, false)).toContain("srt"); // 변환한 녹음 노트는 그대로
  });

  test("제목이 비면 `제목 없음`", () => {
    expect(noteLabel("  ")).toBe("‘제목 없음’");
    expect(noteLabel("주간")).toBe("‘주간’");
  });
});

describe("보관 중인 원본 녹음 안내 (D5)", () => {
  const now = Date.parse("2026-10-15T12:00:00+09:00");
  const MB = 1024 ** 2;

  test("크기를 모르거나 0이면 아무것도 보이지 않는다", () => {
    expect(keptNotice(undefined, "2026-10-15T09:00:00+09:00", now)).toBeNull();
    expect(keptNotice(0, "2026-10-15T09:00:00+09:00", now)).toBeNull();
    expect(keptTitle(undefined)).toBeUndefined();
  });

  test("작고 새 노트는 크기 한 줄만, 1 GB 이상이거나 7일이 넘으면 안내도", () => {
    expect(keptNotice(300 * MB, "2026-10-15T09:00:00+09:00", now)).toEqual({ line: "원본 녹음 300 MB를 보관 중입니다. 텍스트로 변환하면 지워집니다.", warn: null });
    expect(keptNotice(1024 * MB, "2026-10-15T09:00:00+09:00", now)?.warn).toBe(KEPT_WARN);
    expect(keptNotice(1, "2026-10-07T11:00:00+09:00", now)?.warn).toBe(KEPT_WARN); // 7일 하고 1시간
    expect(keptNotice(1, "2026-10-08T12:00:00+09:00", now)?.warn).toBeNull(); // 딱 7일은 아직
    expect(keptNotice(1, "엉망", now)?.warn).toBeNull(); // 날짜를 못 읽으면 오래됐다고 보지 않는다
  });

  test("MB는 1 미만으로 내려가지 않고 천 단위로 끊는다. 배지 title도 같은 크기", () => {
    expect(keptNotice(10, "2026-10-15T09:00:00+09:00", now)?.line).toContain("1 MB");
    expect(keptTitle(1500 * MB)).toBe("원본 녹음 1,500 MB 보관 중");
  });
});
