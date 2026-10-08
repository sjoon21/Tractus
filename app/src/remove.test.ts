import { describe, expect, test } from "vitest";
import { deleteDialogText, deletedText, deleteFailure, deleteReduce, IDLE_DELETE, noteTitle, recordingLabel, type DeleteTarget } from "./remove";

const note: DeleteTarget = { kind: "note", id: "01ABC", title: "3분기 예산", dir: "/Users/me/Tractus/meetings/2026-10-08_3분기_예산_01ABC" };
const rec: DeleteTarget = { kind: "recording", dir: "/Users/me/Tractus/recordings/01REC", startedAt: "2026-10-07T14:05:12+09:00" };

describe("deleteReduce", () => {
  test("ask opens the dialog on the safe side (not busy); cancel closes it", () => {
    const open = deleteReduce(IDLE_DELETE, { type: "ask", target: note });
    expect(open).toEqual({ target: note, busy: false });
    expect(deleteReduce(open, { type: "cancel" })).toBe(IDLE_DELETE);
  });

  test("start marks busy once; Esc/cancel and a second ask are ignored while busy", () => {
    const busy = deleteReduce(deleteReduce(IDLE_DELETE, { type: "ask", target: note }), { type: "start" });
    expect(busy.busy).toBe(true);
    expect(deleteReduce(busy, { type: "start" })).toBe(busy);
    expect(deleteReduce(busy, { type: "cancel" })).toBe(busy);
    expect(deleteReduce(busy, { type: "ask", target: rec })).toBe(busy);
    expect(deleteReduce(busy, { type: "finish" })).toBe(IDLE_DELETE);
  });

  test("start without a target does nothing", () => {
    expect(deleteReduce(IDLE_DELETE, { type: "start" })).toBe(IDLE_DELETE);
  });
});

describe("dialog text", () => {
  test("note: title names the note, body says what moves and where to restore from", () => {
    const t = deleteDialogText(note);
    expect(t.title).toBe("‘3분기 예산’ 노트를 삭제할까요?");
    expect(t.body).toContain("휴지통");
    expect(t.body).toContain("‘2026-10-08_3분기_예산_01ABC’ 폴더");
    expect(t.body).toContain("/Users/me/Tractus/meetings 폴더에 다시 넣으세요");
    expect([t.cancel, t.confirm, t.busy]).toEqual(["취소", "휴지통으로 이동", "옮기는 중…"]);
  });

  test("a note without a title is still named", () => {
    expect(noteTitle("  ")).toBe("제목 없음");
    expect(deleteDialogText({ ...note, title: "" }).title).toBe("‘제목 없음’ 노트를 삭제할까요?");
  });

  test("recording: says it is not converted yet and restores into recordings", () => {
    const t = deleteDialogText(rec);
    expect(t.title).toBe("변환 대기 중인 녹음을 삭제할까요?");
    expect(t.body).toContain("녹음 2026-10-07 14:05에 시작한 녹음");
    expect(t.body).toContain("/Users/me/Tractus/recordings 폴더에 다시 넣으세요");
  });

  test("recording label matches the sidebar row", () => {
    expect(recordingLabel("2026-10-07T14:05:12+09:00")).toBe("녹음 2026-10-07 14:05");
  });

  test("no banned words reach the screen", () => {
    // 경로는 파일 이름이라 검사에서 뺀다 (폴더 이름에 meetings가 있다)
    const plain = [{ ...note, dir: "/a/b" }, { ...rec, dir: "/a/b" }, { ...note, dir: "/a/b", title: "" }];
    const all = plain.flatMap((t) => Object.values(deleteDialogText(t)).concat(deletedText(t), deleteFailure(t, "x").text));
    expect(all.join("\n")).not.toMatch(/회의|전사|세그먼트|화자|색인|\bID\b|meeting/);
  });
});

describe("toasts", () => {
  test("success", () => {
    expect(deletedText(note)).toBe("‘3분기 예산’ 노트를 휴지통으로 옮겼습니다");
    expect(deletedText(rec)).toBe("녹음을 휴지통으로 옮겼습니다");
  });

  test("failure: first Rust line is the sentence, the rest folds into 자세히", () => {
    expect(deleteFailure(note, "이 노트를 처리하는 중이라 지금은 삭제할 수 없습니다. 끝난 뒤에 다시 시도하세요.")).toEqual({
      text: "‘3분기 예산’ 노트를 삭제하지 못했습니다. 이 노트를 처리하는 중이라 지금은 삭제할 수 없습니다. 끝난 뒤에 다시 시도하세요.",
      detail: null,
    });
    expect(deleteFailure(rec, "휴지통으로 옮기지 못했습니다\nPermission denied\n(os error 13)")).toEqual({
      text: "녹음을 삭제하지 못했습니다. 휴지통으로 옮기지 못했습니다",
      detail: "Permission denied\n(os error 13)",
    });
    expect(deleteFailure(note, "")).toEqual({ text: "‘3분기 예산’ 노트를 삭제하지 못했습니다", detail: null });
  });
});
