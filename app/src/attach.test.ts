import { describe, expect, it } from "vitest";
import type { MeetingInfo, PendingRecording } from "./api";
import { ADD_BADGE, addBlocked, attachReduce, BUSY_CONVERTING, BUSY_JOB, BUSY_RECORDING, DROP_LABEL, IDLE_ATTACH, lockOf, LOCK_NOTICE, PENDING_LABEL, pendingTarget, RECORD_LABEL, resolveTarget, type AttachState } from "./attach";
import { ERROR_TEXT, WARNING_TEXT } from "./lib";

const note = (id: string, kind?: "memo" | "recording", title = "장보기"): MeetingInfo => ({ id, dir: `/h/meetings/${id}`, title, created_at: "2026-10-13T09:30:00+09:00", duration_sec: 0, segments: 1, has_summary: false, kind });
const T = { id: "01MEMO", title: "장보기" };

describe("흐름 상태", () => {
  it("녹음 → 변환 → 끝: 같은 노트가 잠기고 끝나면 풀린다", () => {
    let s = attachReduce(IDLE_ATTACH, { type: "record", target: T });
    expect(s).toEqual({ phase: "recording", target: T });
    expect(lockOf(s, "01MEMO")).toBe("recording");
    s = attachReduce(s, { type: "convert", target: T });
    expect(s).toEqual({ phase: "converting", target: T });
    expect(lockOf(s, "01MEMO")).toBe("converting");
    expect(lockOf(s, "01OTHER")).toBeNull();
    expect(attachReduce(s, { type: "finish" })).toEqual(IDLE_ATTACH);
  });

  it("녹음 중이던 대상이 변환으로 이어진다 (다른 대상을 주어도 바뀌지 않는다)", () => {
    const rec = attachReduce(IDLE_ATTACH, { type: "record", target: T });
    expect(attachReduce(rec, { type: "convert", target: { id: "01X", title: "다른" } }).target).toEqual(T);
  });

  it("파일에서 추가·남은 녹음은 녹음 없이 바로 변환 단계다", () => {
    expect(attachReduce(IDLE_ATTACH, { type: "convert", target: T })).toEqual({ phase: "converting", target: T });
  });

  it("이미 흐름이 있으면 새로 시작하지 않는다", () => {
    const rec: AttachState = { phase: "recording", target: T };
    expect(attachReduce(rec, { type: "record", target: { id: "01X", title: "x" } })).toBe(rec);
    const conv: AttachState = { phase: "converting", target: T };
    expect(attachReduce(conv, { type: "convert", target: { id: "01X", title: "x" } })).toBe(conv);
    expect(attachReduce(conv, { type: "record", target: { id: "01X", title: "x" } })).toBe(conv);
  });

  it("녹음이 시작되지 못하면 abort로 풀린다. 노트는 그대로다", () => {
    const rec = attachReduce(IDLE_ATTACH, { type: "record", target: T });
    expect(attachReduce(rec, { type: "abort" })).toEqual(IDLE_ATTACH);
    expect(lockOf(IDLE_ATTACH, "01MEMO")).toBeNull();
  });
});

describe("대상 찾기", () => {
  const notes = [note("01MEMO", "memo"), note("01REC", "recording", "회의"), note("01OLD", undefined, "옛 녹음")];

  it("목록에 있고 글만 있는 노트만 대상이다", () => {
    expect(resolveTarget("01MEMO", notes)).toEqual(T);
    expect(resolveTarget("01REC", notes)).toBeNull(); // 이미 녹음이 있다
    expect(resolveTarget("01OLD", notes)).toBeNull(); // kind가 없으면 녹음
    expect(resolveTarget("01GONE", notes)).toBeNull(); // 지워졌다
    expect(resolveTarget(null, notes)).toBeNull();
    expect(resolveTarget(undefined, notes)).toBeNull();
  });

  it("남은 녹음은 attach_to로 그 노트를 기억한다. 노트가 없어졌거나 attach_to가 없으면 새 노트로 변환한다", () => {
    const p = (attach_to?: string | null): PendingRecording => ({ dir: "/h/recordings/01REC", started_at: "2026-10-13T10:00:00+09:00", duration: 3, attach_to });
    expect(pendingTarget(p("01MEMO"), notes)).toEqual(T);
    expect(pendingTarget(p("01GONE"), notes)).toBeNull();
    expect(pendingTarget(p("01REC"), notes)).toBeNull();
    expect(pendingTarget(p(null), notes)).toBeNull();
    expect(pendingTarget(p(), notes)).toBeNull();
  });
});

describe("추가 단추", () => {
  const idle = { recording: false, transcribing: false, lock: null, busy: false };
  it("쓸 수 있으면 이유가 없다", () => expect(addBlocked(idle)).toBeNull());
  it("이유는 하나씩, 이 노트의 잠금이 먼저다", () => {
    expect(addBlocked({ ...idle, recording: true })).toBe(BUSY_RECORDING);
    expect(addBlocked({ ...idle, transcribing: true })).toBe(BUSY_CONVERTING);
    expect(addBlocked({ ...idle, busy: true })).toBe(BUSY_JOB);
    expect(addBlocked({ ...idle, recording: true, lock: "recording" })).toBe(LOCK_NOTICE.recording);
    expect(addBlocked({ ...idle, transcribing: true, lock: "converting" })).toBe(LOCK_NOTICE.converting);
  });
});

describe("문구 (WORDS.md §4.11)", () => {
  it("노트 제목이 따옴표 안에 들어가고, 제목이 비면 ‘제목 없음’", () => {
    expect(RECORD_LABEL("장보기")).toBe("‘장보기’ 노트에 녹음 추가 중");
    expect(PENDING_LABEL("")).toBe("‘제목 없음’ 노트에 추가할 녹음");
    expect(DROP_LABEL("장보기")).toBe("파일을 놓으면 ‘장보기’ 노트에 추가합니다");
    expect(ADD_BADGE).toBe("추가하기");
    expect(LOCK_NOTICE.recording).toBe("녹음이 끝나면 다시 쓸 수 있습니다");
  });

  it("코어 코드 문장이 있다", () => {
    expect(ERROR_TEXT.append_has_audio).toBe("이미 녹음이 있는 노트에는 녹음을 추가할 수 없습니다.");
    expect(ERROR_TEXT.append_note_missing).toContain("노트를 찾을 수 없습니다");
    expect(WARNING_TEXT.append_remap_failed).toContain("옮기지 못했습니다");
  });
});
