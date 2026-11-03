import { describe, expect, test } from "vitest";
import type { MeetingDetail } from "../api";
import { INITIAL_NOTE, noteReduce, viewNote } from "./noteState";

const seg = (id: string, text: string) => ({ id, start: 0, end: 1, text, corrected_text: null });
const note = (title = "제목", texts: [string, string][] = [["s0001", "안녕"], ["s0002", "하세요"]]) =>
  ({ info: { title }, segments: texts.map(([i, t]) => seg(i, t)), memos: [] }) as unknown as MeetingDetail;

describe("노트 상태", () => {
  test("읽기 전에는 노트가 없고, 낙관적 고침은 아무 일도 하지 않는다", () => {
    expect(viewNote(INITIAL_NOTE)).toBeNull();
    const s = noteReduce(INITIAL_NOTE, { type: "patch", fn: (d) => ({ ...d, memos: [] }) });
    expect(s).toBe(INITIAL_NOTE);
  });

  test("확인한 노트를 받으면 rev가 오르고, 낙관적 고침(patch)은 rev를 올리지 않는다", () => {
    let s = noteReduce(INITIAL_NOTE, { type: "commit", detail: note() });
    expect(s.rev).toBe(1);
    s = noteReduce(s, { type: "patch", fn: (d) => ({ ...d, info: { ...d.info, title: "새 제목" } }) });
    expect(s.rev).toBe(1);
    expect(viewNote(s)?.info.title).toBe("새 제목");
  });

  test("저장 중인 문장 편집은 base 위에 차례로 겹쳐 보이고, 끝나면 걷힌다", () => {
    let s = noteReduce(INITIAL_NOTE, { type: "commit", detail: note() });
    const e1 = [{ id: "s0001", text: "안녕하" }];
    const e2 = [{ id: "s0001", text: "안녕하세요" }, { id: "s0002", text: "." }];
    s = noteReduce(s, { type: "pend", edits: e1 });
    s = noteReduce(s, { type: "pend", edits: e2 });
    const shown = viewNote(s)!.segments.map((x) => x.corrected_text ?? x.text);
    expect(shown).toEqual(["안녕하세요", "."]); // 뒤의 묶음이 이긴다
    s = noteReduce(s, { type: "settle", edits: e1 });
    expect(s.pending).toEqual([e2]); // 같은 객체로 찾아 그 묶음만 걷는다
    s = noteReduce(s, { type: "settle", edits: e2 });
    expect(viewNote(s)).toBe(s.base); // 저장 중인 것이 없으면 base 그대로 (새 객체를 만들지 않는다)
  });

  test("저장이 실패해 걷어도 화면은 base의 원래 문장으로 돌아간다", () => {
    let s = noteReduce(INITIAL_NOTE, { type: "commit", detail: note() });
    const e = [{ id: "s0001", text: "고친 말" }];
    s = noteReduce(s, { type: "pend", edits: e });
    expect(viewNote(s)!.segments[0].corrected_text).toBe("고친 말");
    s = noteReduce(s, { type: "settle", edits: e });
    expect(viewNote(s)!.segments[0].corrected_text).toBeNull();
  });

  test("refresh는 rev만 올린다", () => {
    const s0 = noteReduce(INITIAL_NOTE, { type: "commit", detail: note() });
    const s1 = noteReduce(s0, { type: "refresh" });
    expect(s1.rev).toBe(s0.rev + 1);
    expect(s1.base).toBe(s0.base);
  });
});
