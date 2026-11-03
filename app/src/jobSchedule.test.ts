import { describe, expect, test } from "vitest";
import { canStartConvert, canStartImport, canStartTranscribe, isTranscribing, type Activity } from "./jobSchedule";

const idle: Activity = {
  recording: false,
  liveRec: false,
  asking: false,
  transcribeRunning: false,
  transcribeWaiting: false,
  finishRunning: false,
  converting: false,
  convertRunning: false,
  importRunning: false,
  importWaiting: false,
};
const a = (over: Partial<Activity>): Activity => ({ ...idle, ...over });

describe("isTranscribing: 새 녹음·가져오기·창 닫기가 변환 중으로 보는 일", () => {
  test("아무 일도 없으면 아니다", () => expect(isTranscribing(idle)).toBe(false));
  test.each(["transcribeRunning", "transcribeWaiting", "finishRunning", "converting"] as const)("%s이면 변환 중이다", (k) => expect(isTranscribing(a({ [k]: true }))).toBe(true));
  test("가져오기만 도는 것은 변환 중이 아니다 (가져오기는 자기 줄이 따로 있다)", () => {
    expect(isTranscribing(a({ importRunning: true, importWaiting: true }))).toBe(false);
  });
});

describe("녹음 변환 시작", () => {
  const waiting = a({ transcribeWaiting: true });
  test("기다리는 녹음이 없으면 시작할 것이 없다", () => expect(canStartTranscribe(idle)).toBe(false));
  test("다른 일이 없으면 시작한다", () => expect(canStartTranscribe(waiting)).toBe(true));
  test.each(["transcribeRunning", "importRunning", "convertRunning"] as const)("%s가 돌면 기다린다 (변환 엔진은 하나)", (k) => expect(canStartTranscribe({ ...waiting, [k]: true })).toBe(false));
  test("녹음 중이라도 자막이 없으면 함께 돈다", () => expect(canStartTranscribe({ ...waiting, recording: true, liveRec: false })).toBe(true));
  test("자막이 도는 녹음 중에는 시작하지 않고, 녹음이 끝나면 시작한다", () => {
    expect(canStartTranscribe({ ...waiting, recording: true, liveRec: true })).toBe(false);
    expect(canStartTranscribe({ ...waiting, recording: false, liveRec: true })).toBe(true);
  });
  test("노트로 저장 중이거나 묻는 창이 떠 있어도 막지 않는다 (새 녹음만 그때 막힌다)", () => {
    expect(canStartTranscribe({ ...waiting, finishRunning: true, asking: true })).toBe(true);
  });
});

describe("변환 전 노트의 변환 시작", () => {
  const queued = a({ converting: true });
  test("줄이 비면 시작할 것이 없다", () => expect(canStartConvert(idle)).toBe(false));
  test("다른 일이 없으면 시작한다", () => expect(canStartConvert(queued)).toBe(true));
  test.each(["transcribeRunning", "transcribeWaiting", "finishRunning", "importRunning", "asking"] as const)("%s이면 기다린다 (녹음 변환이 먼저다)", (k) => expect(canStartConvert({ ...queued, [k]: true })).toBe(false));
  test("자막이 도는 녹음 중에는 시작하지 않는다", () => expect(canStartConvert({ ...queued, recording: true, liveRec: true })).toBe(false));
  test("자막이 없는 녹음 중에는 함께 돈다", () => expect(canStartConvert({ ...queued, recording: true, liveRec: false })).toBe(true));
});

describe("파일 가져오기 시작", () => {
  const queued = a({ importWaiting: true });
  test("줄이 비면 시작할 것이 없다", () => expect(canStartImport(idle)).toBe(false));
  test("다른 일이 없으면 시작한다", () => expect(canStartImport(queued)).toBe(true));
  test("가져오기가 돌면 기다린다", () => expect(canStartImport({ ...queued, importRunning: true })).toBe(false));
  test.each(["transcribeRunning", "transcribeWaiting", "finishRunning", "converting"] as const)("%s이면 기다린다 (변환이 먼저다)", (k) => expect(canStartImport({ ...queued, [k]: true })).toBe(false));
  test("녹음 중이라도 가져오기는 막지 않는다", () => expect(canStartImport({ ...queued, recording: true, liveRec: true })).toBe(true));
});

describe("우선순위: 녹음 변환 → 변환 줄 → 가져오기", () => {
  test("세 줄이 모두 기다리면 녹음 변환만 시작할 수 있다", () => {
    const all = a({ transcribeWaiting: true, converting: true, importWaiting: true });
    expect([canStartTranscribe(all), canStartConvert(all), canStartImport(all)]).toEqual([true, false, false]);
  });
  test("녹음 변환이 끝나면 변환 줄, 그다음 가져오기 차례다", () => {
    const afterTranscribe = a({ converting: true, importWaiting: true });
    expect([canStartConvert(afterTranscribe), canStartImport(afterTranscribe)]).toEqual([true, false]);
    const afterConvert = a({ importWaiting: true });
    expect(canStartImport(afterConvert)).toBe(true);
  });
});
