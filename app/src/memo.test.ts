import { describe, expect, test } from "vitest";
import { answerParts, citeLabel, citeTarget, isMemoCite, isTaggedMemo } from "./ask";
import { deleteDialogText } from "./remove";
import { evidenceLabel, isMemoLineId, summaryMarkdown, type NoteMemo, type Segment } from "./lib";
import { AUTOSAVE_MS, checkTitle, citedRange, createAutosave, exportFormatsFor, flushMemos, hitView, isMemo, kindOf, lineSpans, memoLineNumbers, memoLineSegments, noteTime, registerMemo, segmentSpans, settleMemo, dropMemo, staleSentence, TITLE_EMPTY, TITLE_MAX, TITLE_TOO_LONG, type SaveState } from "./memo";
import { printDoc } from "./print";

const seg = (id: string, text: string): Segment => ({ id, start: 0, end: 0, text, corrected_text: null, speaker: null });

describe("checkTitle", () => {
  test("trims and collapses whitespace and newlines into one line", () => {
    expect(checkTitle("  주간\n\t 회의  ")).toEqual({ ok: true, title: "주간 회의" });
  });
  test("rejects empty and whitespace-only titles with a sentence", () => {
    expect(checkTitle("")).toEqual({ ok: false, error: TITLE_EMPTY });
    expect(checkTitle(" \n\t ")).toEqual({ ok: false, error: TITLE_EMPTY });
  });
  test("counts characters, not UTF-16 units: 120 emoji pass, 121 do not", () => {
    expect(checkTitle("😀".repeat(TITLE_MAX)).ok).toBe(true);
    expect(checkTitle("😀".repeat(TITLE_MAX + 1))).toEqual({ ok: false, error: TITLE_TOO_LONG });
    expect(checkTitle("가".repeat(121)).ok).toBe(false);
  });
});

describe("note kind and list rows", () => {
  test("only kind memo is a memo; old notes without kind are recordings", () => {
    expect(kindOf({ kind: "memo" })).toBe("memo");
    expect(kindOf({})).toBe("recording");
    expect(kindOf({ kind: "voice" })).toBe("recording");
    expect(isMemo({ kind: undefined })).toBe(false);
  });
  test("a recording shows its length, a memo its created time", () => {
    expect(noteTime({ kind: "recording", duration_sec: 125, created_at: "2026-10-13T09:05:00+09:00" })).toBe("2:05");
    expect(noteTime({ duration_sec: 125, created_at: "2026-10-13T09:05:00+09:00" })).toBe("2:05");
    expect(noteTime({ kind: "memo", duration_sec: 0, created_at: "2026-10-13T14:07:31+09:00" })).toBe("14:07");
    expect(noteTime({ kind: "memo", duration_sec: 0, created_at: "" })).toBe("");
  });
  test("a memo cannot be exported as SRT or WebVTT", () => {
    const f = exportFormatsFor(true).map((x) => x.format);
    expect(f).toEqual(["txt", "md", "csv", "docx", "bundle"]);
    expect(exportFormatsFor(false).map((x) => x.format)).toContain("srt");
  });
});

describe("memo lines", () => {
  const body = "첫 줄\n\n  \n셋째 줄\n끝";
  test("lineSpans: one span per non-empty line, with the body line number", () => {
    const sp = lineSpans(body);
    expect(sp.map((s) => s.line)).toEqual([1, 4, 5]);
    expect(sp.map((s) => body.slice(s.start, s.end))).toEqual(["첫 줄", "셋째 줄", "끝"]);
  });
  const segs = [seg("s0001", "첫 줄"), seg("s0004", "셋째 줄"), seg("s0005", "끝")];
  test("segmentSpans follows ids, not positions, and skips lines that no longer match", () => {
    expect([...segmentSpans(body, segs)].map(([id, s]) => [id, s.line])).toEqual([["s0001", 1], ["s0004", 4], ["s0005", 5]]);
    expect([...segmentSpans("첫 줄\n바뀐 줄\n끝", segs)].map(([id]) => id)).toEqual(["s0001", "s0005"]); // 바뀐 줄만 빠진다
  });
  test("citedRange selects the cited line; while the text drifted it finds the line by its words", () => {
    const r = citedRange(body, body, segs, "s0004");
    expect(r && body.slice(r.start, r.end)).toBe("셋째 줄");
    const typed = "새로 쓴 줄\n" + body;
    const r2 = citedRange(typed, body, segs, "s0004");
    expect(r2 && typed.slice(r2.start, r2.end)).toBe("셋째 줄");
    expect(citedRange(typed, body, segs, "s9999")).toBeNull();
    expect(citedRange("지웠다", body, segs, "s0004")).toBeNull();
  });
  test("a corrected segment text is compared by what the user sees", () => {
    const edited = [{ ...seg("s0001", "원문"), corrected_text: "첫 줄" }];
    expect(segmentSpans("첫 줄", edited).has("s0001")).toBe(true);
  });
});

describe("citation chip label", () => {
  test("recordings keep time (and date in the global scope)", () => {
    expect(citeLabel(331)).toBe("5:31");
    expect(citeLabel(331, { date: "2026-10-02" })).toBe("10/2 5:31");
  });
  test("memos have no time: line number when known, else 메모 (with date in the global scope)", () => {
    expect(citeLabel(0, { memo: true, line: 3 })).toBe("3번째 줄");
    expect(citeLabel(0, { memo: true })).toBe("메모");
    expect(citeLabel(0, { memo: true, date: "2026-10-13" })).toBe("10/13 메모");
    expect(citeLabel(0, { memo: true, line: 3, date: "2026-10-13" })).toBe("10/13 3번째 줄");
  });
});

describe("memo citations", () => {
  test("citeTarget carries the cited line of a memo (time is 0)", () => {
    const ctx = { citations: [{ meeting_id: "M", segment_id: "s0003", start: 0, line: 7 }], sources: [], starts: new Map([["s0003", 0]]), meetingId: "M" };
    expect(citeTarget({ meetingId: null, segId: "s0003" }, ctx)).toEqual({ meetingId: "M", segId: "s0003", t: 0, line: 7 });
    expect(citeTarget({ meetingId: null, segId: "s0009" }, ctx)).toBeNull();
  });
});

describe("memo print and delete text", () => {
  const info = { title: "메모", created_at: "2026-10-13T14:07:00+09:00", duration_sec: 0, kind: "memo" };
  test("a memo prints plain lines: no length, no times, no evidence times", () => {
    const d = printDoc({
      info,
      segments: [seg("s0001", "첫 줄"), seg("s0002", "둘째 줄")],
      speakers: {},
      summary: { summary: "요약", topics: [], decisions: [{ text: "결정", segment_ids: ["s0002"] }], action_items: [] },
    });
    expect(d.memo).toBe(true);
    expect(d.duration).toBe("");
    expect(d.rows.map((r) => [r.time, r.text])).toEqual([["", "첫 줄"], ["", "둘째 줄"]]);
    expect(d.summary?.decisions[0].at).toBeNull();
  });
  test("a recording still prints times", () => {
    const d = printDoc({ info: { ...info, kind: undefined, duration_sec: 65 }, segments: [{ ...seg("s0001", "a"), start: 5 }], speakers: {}, summary: null });
    expect([d.memo, d.duration, d.rows[0].time]).toEqual([false, "1:05", "0:05"]);
  });
  test("the delete dialog does not mention an audio file for a memo", () => {
    const t = { kind: "note" as const, id: "01A", title: "아이디어", dir: "/h/meetings/2026-10-13_아이디어_01A" };
    expect(deleteDialogText({ ...t, memo: true }).body).toMatch(/^메모 내용, 요약, 질문 기록이 휴지통으로/);
    expect(deleteDialogText(t).body).toMatch(/^녹음 파일, 대화 내용, 요약/);
  });
});

/** 손으로 돌리는 시계와 저장 두 개 (한 번에 하나만 도는지 보려고 저장을 직접 끝낸다) */
function harness(initial = "") {
  const timers = new Map<number, () => void>();
  let next = 1;
  const saves: { body: string; ok: () => void; fail: (e: unknown) => void }[] = [];
  const states: SaveState[] = [];
  let running = 0;
  let maxRunning = 0;
  const auto = createAutosave({
    initial,
    save: (body) =>
      new Promise<void>((resolve, reject) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        saves.push({
          body,
          ok: () => {
            running--;
            resolve();
          },
          fail: (e) => {
            running--;
            reject(e);
          },
        });
      }),
    onState: (s) => states.push(s),
    setTimer: (fn) => {
      timers.set(next, fn);
      return next++;
    },
    clearTimer: (h) => void timers.delete(h as number),
  });
  const fire = () => {
    const [id, fn] = [...timers][0] ?? [];
    if (id === undefined) throw new Error("no timer");
    timers.delete(id);
    fn();
  };
  const tick = () => new Promise((r) => setTimeout(r, 0)); // 약속이 풀리게
  return { auto, timers, saves, states, fire, tick, maxRunning: () => maxRunning, last: () => states[states.length - 1]?.status };
}

describe("autosave", () => {
  test("debounces: only the last text is saved after the quiet period", async () => {
    const h = harness("a");
    h.auto.change("ab");
    h.auto.change("abc");
    expect(h.timers.size).toBe(1); // 입력마다 타이머를 다시 건다
    expect(AUTOSAVE_MS).toBe(1200);
    expect(h.last()).toBe("dirty");
    h.fire();
    expect(h.saves.map((s) => s.body)).toEqual(["abc"]);
    expect(h.last()).toBe("saving");
    h.saves[0].ok();
    await h.tick();
    expect(h.last()).toBe("saved");
    expect(h.auto.isDirty()).toBe(false);
  });

  test("typing back to the saved text cancels the pending save", () => {
    const h = harness("a");
    h.auto.change("ab");
    h.auto.change("a");
    expect(h.timers.size).toBe(0);
    expect(h.last()).toBe("saved");
    expect(h.saves).toHaveLength(0);
  });

  test("flush saves right away, cancelling the timer, and resolves true when clean", async () => {
    const h = harness();
    h.auto.change("메모");
    const p = h.auto.flush();
    expect(h.timers.size).toBe(0);
    expect(h.saves.map((s) => s.body)).toEqual(["메모"]);
    h.saves[0].ok();
    expect(await p).toBe(true);
    expect(await h.auto.flush()).toBe(true); // 깨끗하면 저장하지 않는다
    expect(h.saves).toHaveLength(1);
  });

  test("saves are serialised: text typed while saving is saved after it, never in parallel", async () => {
    const h = harness();
    h.auto.change("1");
    h.fire();
    h.auto.change("12"); // 저장 중에 더 썼다
    h.auto.change("123");
    expect(h.saves).toHaveLength(1);
    h.saves[0].ok();
    await h.tick();
    expect(h.timers.size).toBe(1); // 끝난 뒤 다시 잡는다
    h.fire();
    expect(h.saves.map((s) => s.body)).toEqual(["1", "123"]);
    h.saves[1].ok();
    await h.tick();
    expect(h.maxRunning()).toBe(1);
    expect(h.last()).toBe("saved");
  });

  test("flush while saving waits for it and then saves the newer text", async () => {
    const h = harness();
    h.auto.change("1");
    h.fire();
    h.auto.change("12");
    const p = h.auto.flush();
    h.saves[0].ok();
    await h.tick();
    expect(h.saves.map((s) => s.body)).toEqual(["1", "12"]);
    h.saves[1].ok();
    expect(await p).toBe(true);
    expect(h.maxRunning()).toBe(1);
  });

  test("a failure keeps the text dirty, does not retry by itself, and the next change retries", async () => {
    const h = harness();
    h.auto.change("글");
    h.fire();
    h.saves[0].fail(new Error("디스크"));
    await h.tick();
    expect(h.last()).toBe("failed");
    expect((h.states[h.states.length - 1].error as Error).message).toBe("디스크");
    expect(h.timers.size).toBe(0); // 스스로 두드리지 않는다
    expect(h.auto.isDirty()).toBe(true);
    h.auto.change("글자");
    expect(h.last()).toBe("failed"); // 성공할 때까지 실패로 보인다
    expect(h.timers.size).toBe(1);
    h.fire();
    expect(h.saves.map((s) => s.body)).toEqual(["글", "글자"]);
    h.saves[1].ok();
    await h.tick();
    expect(h.last()).toBe("saved");
  });

  test("flush retries a failed save and reports false when it fails again", async () => {
    const h = harness();
    h.auto.change("x");
    const p1 = h.auto.flush();
    h.saves[0].fail("boom");
    expect(await p1).toBe(false);
    expect(h.auto.isDirty()).toBe(true);
    const p2 = h.auto.flush();
    expect(h.saves).toHaveLength(2);
    h.saves[1].ok();
    expect(await p2).toBe(true);
  });

  test("going back to the saved text clears an earlier failure", async () => {
    const h = harness("a");
    h.auto.change("ab");
    h.fire();
    h.saves[0].fail("x");
    await h.tick();
    h.auto.change("a");
    expect(h.last()).toBe("saved");
  });

  test("dispose stops everything", async () => {
    const h = harness();
    h.auto.change("x");
    h.auto.dispose();
    expect(h.timers.size).toBe(0);
    expect(await h.auto.flush()).toBe(false);
    expect(h.saves).toHaveLength(0);
  });
});

describe("open memos", () => {
  test("flushMemos waits for every open memo and is false if any fails", async () => {
    const calls: string[] = [];
    const off1 = registerMemo("A", { flush: async () => (calls.push("A"), true), drop: () => {} });
    const off2 = registerMemo("B", { flush: async () => (calls.push("B"), false), drop: () => {} });
    expect(await flushMemos()).toBe(false);
    expect(calls.sort()).toEqual(["A", "B"]);
    off2();
    expect(await flushMemos()).toBe(true);
    off1();
    expect(await flushMemos()).toBe(true);
  });
  test("settleMemo only saves; the memo is dropped by dropMemo after the delete succeeded", async () => {
    const calls: string[] = [];
    const off = registerMemo("C", { flush: async () => (calls.push("flush"), false), drop: () => void calls.push("drop") });
    await settleMemo("C");
    await settleMemo("nope");
    expect(calls).toEqual(["flush"]);
    dropMemo("C");
    dropMemo("nope");
    expect(calls).toEqual(["flush", "drop"]);
    off();
  });
  test("a failed delete leaves the editor saving: settleMemo does not dispose it", async () => {
    const saved: string[] = [];
    const a = createAutosave({ initial: "", save: async (b) => void saved.push(b), onState: () => {}, setTimer: () => 0, clearTimer: () => {} });
    const off = registerMemo("D", { flush: () => a.flush(), drop: () => a.dispose() });
    a.change("before");
    await settleMemo("D");
    a.change("typed after failed delete");
    expect(await a.flush()).toBe(true);
    expect(saved).toEqual(["before", "typed after failed delete"]);
    off();
  });
});

// ── 녹음 노트의 메모 (오른쪽 패널의 메모 탭) ──

const NOTE_MEMO: NoteMemo = {
  body: "첫 줄\n\n  \n셋째 줄\n끝",
  lines: [
    { id: "m0001", line: 1, text: "첫 줄" },
    { id: "m0004", line: 4, text: "셋째 줄" },
    { id: "m0005", line: 5, text: "끝" },
  ],
};

describe("note memo lines", () => {
  test("memo ids are their own namespace: m0003 is a memo line, s0003 is not", () => {
    expect(isMemoLineId("m0003")).toBe(true);
    expect(isMemoLineId("m12345")).toBe(true);
    expect(isMemoLineId("s0003")).toBe(false);
    expect(isMemoLineId("m3")).toBe(false);
    expect(isMemoLineId("xm0003")).toBe(false);
  });
  test("a memo with no lines gives empty maps (old notes have no memo)", () => {
    expect(memoLineSegments(null)).toEqual([]);
    expect(memoLineSegments(undefined)).toEqual([]);
    expect(memoLineNumbers(null).size).toBe(0);
  });
  test("memoLineNumbers maps ids to body line numbers (blank lines counted)", () => {
    expect([...memoLineNumbers(NOTE_MEMO)]).toEqual([["m0001", 1], ["m0004", 4], ["m0005", 5]]);
  });
  test("the line range of a cited memo line is found with the same code as memo notes", () => {
    const segs = memoLineSegments(NOTE_MEMO);
    const r = citedRange(NOTE_MEMO.body, NOTE_MEMO.body, segs, "m0004");
    expect(r && NOTE_MEMO.body.slice(r.start, r.end)).toBe("셋째 줄");
    // 저장 전에 앞에 줄을 더 쓰면 글로 찾는다. 줄이 지워졌으면 null
    const typed = "새로 쓴 줄\n" + NOTE_MEMO.body;
    const r2 = citedRange(typed, NOTE_MEMO.body, segs, "m0005");
    expect(r2 && typed.slice(r2.start, r2.end)).toBe("끝");
    expect(citedRange("첫 줄", NOTE_MEMO.body, segs, "m0004")).toBeNull();
    expect(citedRange(NOTE_MEMO.body, NOTE_MEMO.body, segs, "m0099")).toBeNull();
  });
});

describe("stale summary sentence", () => {
  test("names what was edited", () => {
    expect(staleSentence(["text"])).toBe("대화 내용을 수정했습니다");
    expect(staleSentence(["memo"])).toBe("메모를 수정했습니다");
    expect(staleSentence(["text", "memo", "text"])).toBe("대화 내용과 메모를 수정했습니다");
  });
});

describe("memo citations in recording notes", () => {
  test("answerParts reads [m0003] and mixes it with [s0012], also in groups and the global form", () => {
    const ID = "01K6X3ABCDEFGHJKMNPQRSTVWX";
    expect(answerParts("예산 [s0012] 메모 [m0003]").filter((p) => p.kind === "cite")).toEqual([
      { kind: "cite", meetingId: null, segId: "s0012" },
      { kind: "cite", meetingId: null, segId: "m0003" },
    ]);
    expect(answerParts(`[s0001, m0002] 와 [${ID}#m0007]`).filter((p) => p.kind === "cite")).toEqual([
      { kind: "cite", meetingId: null, segId: "s0001" },
      { kind: "cite", meetingId: null, segId: "m0002" },
      { kind: "cite", meetingId: ID, segId: "m0007" },
    ]);
  });
  test("a half-streamed memo id never shows", () => {
    expect(answerParts("메모 [m00")).toEqual([{ kind: "text", text: "메모 " }]);
    expect(answerParts("결정 [s0001, m")).toEqual([{ kind: "text", text: "결정 " }]);
    expect(answerParts("[참고] [m1]")).toEqual([{ kind: "text", text: "[참고] [m1]" }]); // 숫자가 모자라면 글 그대로
  });
  test("citeTarget resolves a memo citation (no start) with time 0 and the line", () => {
    const ctx = { meetingId: "M", citations: [{ meeting_id: "M", segment_id: "m0003", source: "memo", line: 3 } as never], sources: [], starts: new Map([["s0001", 5]]) };
    expect(citeTarget({ meetingId: null, segId: "m0003" }, ctx)).toEqual({ meetingId: "M", segId: "m0003", t: 0, line: 3 });
    expect(citeTarget({ meetingId: null, segId: "m0009" }, ctx)).toBeNull(); // 근거에 없는 줄은 풀리지 않는다
  });
  test("chip text: 메모 3번째 줄 in a recording, plain 3번째 줄 in a memo note; with a date in the global scope", () => {
    expect(citeLabel(0, { memo: true, line: 3, tagged: true })).toBe("메모 3번째 줄");
    expect(citeLabel(0, { memo: true, line: 3, tagged: true, date: "2026-10-13" })).toBe("10/13 메모 3번째 줄");
    expect(citeLabel(0, { memo: true, line: 3 })).toBe("3번째 줄");
    expect(citeLabel(0, { memo: true, tagged: true })).toBe("메모"); // 줄을 모르면 그냥 메모
    expect(citeLabel(331)).toBe("5:31"); // 시각 칩은 그대로
  });
  test("isMemoCite / isTaggedMemo", () => {
    expect(isTaggedMemo({ segment_id: "m0003" })).toBe(true);
    expect(isTaggedMemo({ segment_id: "s0003", source: "memo" })).toBe(true);
    expect(isTaggedMemo({ segment_id: "s0003" })).toBe(false);
    expect(isMemoCite({ segment_id: "s0003" }, true)).toBe(true); // 메모 노트의 줄
    expect(isMemoCite({ segment_id: "s0003" }, false)).toBe(false); // 녹음의 대화
    expect(isMemoCite({ segment_id: "m0003" }, false)).toBe(true); // 녹음 노트의 메모 줄
  });
  test("evidence label combines the time and the memo line; copy markdown shows 메모 n번째 줄", () => {
    const starts = new Map([["s0002", 65]]);
    const lines = new Map([["m0004", 4], ["m0001", 1]]);
    expect(evidenceLabel(["s0002", "m0004", "m0001"], starts, lines)).toBe("1:05, 메모 1번째 줄");
    expect(evidenceLabel(["m0004"], starts, lines)).toBe("메모 4번째 줄");
    expect(evidenceLabel(["s0002"], starts, lines)).toBe("1:05");
    expect(evidenceLabel(["m0009"], starts, lines)).toBeNull();
    expect(evidenceLabel(["s0002"], starts)).toBe("1:05"); // 메모가 없는 옛 노트
    const md = summaryMarkdown({ summary: "요약", topics: [], decisions: [{ text: "결정", segment_ids: ["m0004"] }], action_items: [] }, starts, lines);
    expect(md).toContain("- 결정 (메모 4번째 줄)");
    expect(summaryMarkdown({ summary: "요약", topics: [], decisions: [{ text: "결정", segment_ids: ["m0004"] }], action_items: [] }, starts)).toContain("- 결정\n");
  });
});

describe("search hit routing", () => {
  test("an ordinary hit keeps its time and seeks there", () => {
    expect(hitView({ id: "s0012", time: "00:05:31", text: "예산" }, false)).toEqual({ memo: false, tagged: false, label: "5:31", seek: { segId: "s0012", t: 331 } });
  });
  test("a memo line of a recording is tagged, labelled by its line and has no time", () => {
    const v = hitView({ id: "m0003", time: "3번째 줄", text: "메모 내용", source: "memo", line: 3 }, false);
    expect(v).toEqual({ memo: true, tagged: true, label: "3번째 줄", seek: { segId: "m0003", t: 0 } });
  });
  test("the m-id alone marks a memo line even when the core sends no source", () => {
    expect(hitView({ id: "m0007", time: "7번째 줄", text: "x" }, false)).toMatchObject({ tagged: true, label: "7번째 줄" });
  });
  test("a line in a memo note is a memo but not tagged (the whole note is a memo)", () => {
    expect(hitView({ id: "s0002", time: "2번째 줄", text: "x" }, true)).toEqual({ memo: true, tagged: false, label: "2번째 줄", seek: { segId: "s0002", t: 0 } });
    expect(hitView({ id: "s0002", time: "00:00:00", text: "x", line: 5 }, true).label).toBe("5번째 줄");
  });
  test("a memo line with no line information is just 메모", () => {
    expect(hitView({ id: "m0003", time: "", text: "x", source: "memo" }, false).label).toBe("메모");
  });
});

describe("print with a note memo", () => {
  const info = { title: "회의", created_at: "2026-10-13T14:07:00+09:00", duration_sec: 65 };
  test("a recording prints its memo in its own section and cites memo lines in the summary", () => {
    const d = printDoc({
      info,
      segments: [{ ...seg("s0001", "안녕"), start: 5 }],
      speakers: {},
      summary: { summary: "요약", topics: [], decisions: [{ text: "결정", segment_ids: ["s0001", "m0004"] }], action_items: [] },
      note_memo: NOTE_MEMO,
    });
    expect(d.memoLines.map((l) => l.text)).toEqual(["첫 줄", "셋째 줄", "끝"]);
    expect(d.summary?.decisions[0].at).toBe("0:05, 메모 4번째 줄");
  });
  test("no memo, no section; a memo note never prints a second memo section", () => {
    expect(printDoc({ info, segments: [], speakers: {}, summary: null }).memoLines).toEqual([]);
    expect(printDoc({ info, segments: [], speakers: {}, summary: null, note_memo: null }).memoLines).toEqual([]);
    expect(printDoc({ info: { ...info, kind: "memo" }, segments: [seg("s0001", "a")], speakers: {}, summary: null, note_memo: NOTE_MEMO }).memoLines).toEqual([]);
  });
});
