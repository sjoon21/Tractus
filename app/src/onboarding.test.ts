import { describe, expect, test } from "vitest";
import type { MeetingInfo } from "./api";
import { onboardSteps, showOnboard } from "./onboarding";

const note = (over: Partial<MeetingInfo>): MeetingInfo => ({ id: "x", dir: "/d", title: "t", created_at: "", duration_sec: 0, segments: 0, has_summary: false, kind: "recording", favorite: false, tags: [], folder: null, updated_at: "", ...over }) as MeetingInfo;
const fresh = { dismissed: false, sampleOpened: false, enhancedSeen: false };

describe("시작하기 목록", () => {
  test("모델·첫 녹음은 실제 상태에서, 예시 노트·완성된 노트는 기억한 것에서 읽는다", () => {
    const done = (s = fresh, notes: MeetingInfo[] = [], ok = false) => onboardSteps(s, notes, ok).filter((x) => x.done).map((x) => x.id);
    expect(done()).toEqual([]);
    expect(done(fresh, [], true)).toEqual(["models"]);
    expect(done(fresh, [note({ sample: true })])).toEqual([]); // 예시 노트는 내 첫 녹음이 아니다
    expect(done(fresh, [note({ kind: "memo" })])).toEqual([]); // 메모도 녹음이 아니다
    expect(done(fresh, [note({})])).toEqual(["record"]);
    expect(done({ ...fresh, sampleOpened: true, enhancedSeen: true })).toEqual(["sample", "enhance"]);
  });

  test("다 했거나 닫으면 보이지 않는다", () => {
    const all = onboardSteps({ dismissed: false, sampleOpened: true, enhancedSeen: true }, [note({})], true);
    expect(showOnboard(fresh, onboardSteps(fresh, [], false))).toBe(true);
    expect(showOnboard(fresh, all)).toBe(false);
    expect(showOnboard({ ...fresh, dismissed: true }, onboardSteps(fresh, [], false))).toBe(false);
  });
});
