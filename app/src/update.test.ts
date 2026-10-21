import { describe, expect, test } from "vitest";
import { IDLE_UPDATE, newVersionToast, noteExcerpt, progressPct, updateErrorView, updateReduce, updateText, versionLine, type UpdateEvent, type UpdateState, notesVersion } from "./update";

const run = (events: UpdateEvent[], from: UpdateState = IDLE_UPDATE) => events.reduce(updateReduce, from);

describe("업데이트 상태", () => {
  test("확인 → 최신 / 새 버전 (릴리스 노트는 일부만)", () => {
    expect(run([{ type: "check" }])).toEqual({ phase: "checking" });
    expect(run([{ type: "check" }, { type: "latest" }])).toEqual({ phase: "latest" });
    expect(run([{ type: "check" }, { type: "found", version: "0.1.2", body: "- 고침\n\n- 더 고침" }])).toEqual({ phase: "found", version: "0.1.2", notes: "- 고침\n- 더 고침" });
    expect(run([{ type: "found", version: "0.1.2" }])).toEqual({ phase: "found", version: "0.1.2", notes: null });
  });

  test("설치는 새 버전을 찾은 뒤에만 시작하고, 받은 양을 더한다", () => {
    expect(run([{ type: "install" }])).toEqual(IDLE_UPDATE);
    const found: UpdateEvent[] = [{ type: "found", version: "0.1.2" }, { type: "install" }];
    expect(run(found)).toEqual({ phase: "downloading", version: "0.1.2", done: 0, total: null });
    const s = run([...found, { type: "download", event: { event: "Started", data: { contentLength: 1000 } } }, { type: "download", event: { event: "Progress", data: { chunkLength: 300 } } }, { type: "download", event: { event: "Progress", data: { chunkLength: 200 } } }]);
    expect(s).toEqual({ phase: "downloading", version: "0.1.2", done: 500, total: 1000 });
    expect(run([{ type: "download", event: { event: "Finished" } }], s)).toEqual({ ...s, done: 1000 });
    expect(run([{ type: "installed" }], s)).toEqual({ phase: "installed", version: "0.1.2" });
    // 전체 크기를 모르는 채 끝나도 상태는 그대로다
    const unknown: UpdateState = { phase: "downloading", version: "0.1.2", done: 7, total: null };
    expect(run([{ type: "download", event: { event: "Finished" } }], unknown)).toEqual(unknown);
  });

  test("받는 중이 아닐 때 온 진행 이벤트는 무시한다", () => {
    expect(run([{ type: "download", event: { event: "Progress", data: { chunkLength: 5 } } }])).toEqual(IDLE_UPDATE);
    expect(run([{ type: "installed" }])).toEqual(IDLE_UPDATE);
  });

  test("실패는 단계에 따라 문장이 다르고 원래 문구는 자세히로 간다", () => {
    expect(run([{ type: "check" }, { type: "fail", error: new Error("boom") }])).toEqual({ phase: "error", text: "업데이트를 확인하지 못했습니다.", detail: "boom" });
    const dl: UpdateState = { phase: "downloading", version: "0.1.2", done: 1, total: 2 };
    expect(run([{ type: "fail", error: "disk full" }], dl)).toEqual({ phase: "error", text: "업데이트를 설치하지 못했습니다.", detail: "disk full" });
  });
});

describe("업데이트 문구", () => {
  test("상태 줄", () => {
    expect(updateText(IDLE_UPDATE)).toBeNull();
    expect(updateText({ phase: "checking" })).toBe("확인 중…");
    expect(updateText({ phase: "latest" })).toBe("최신입니다.");
    expect(updateText({ phase: "found", version: "0.1.2", notes: null })).toBe("새 버전 0.1.2");
    expect(updateText({ phase: "downloading", version: "0.1.2", done: 0, total: null })).toBe("받는 중…");
    expect(updateText({ phase: "downloading", version: "0.1.2", done: 333, total: 1000 })).toBe("받는 중 33%");
    expect(updateText({ phase: "installed", version: "0.1.2" })).toBe("설치가 끝났습니다. 다시 열면 새 버전으로 시작합니다.");
    expect(updateText({ phase: "error", text: "x", detail: null })).toBe("x");
  });

  test("지금 버전·시작 알림", () => {
    expect(versionLine("0.1.1")).toBe("지금 버전 0.1.1");
    expect(versionLine(null)).toBe("지금 버전을 읽는 중…");
    expect(newVersionToast("0.1.2")).toBe("새 버전이 있습니다: 0.1.2");
    expect(newVersionToast("0.1.1")).toBe("새 버전이 있습니다: 0.1.1"); // 받침으로 끝나는 버전에도 조사가 붙지 않는다
  });

  test("진행률은 0–100, 전체를 모르면 null", () => {
    expect(progressPct(0, null)).toBeNull();
    expect(progressPct(5, 0)).toBeNull();
    expect(progressPct(999, 1000)).toBe(99);
    expect(progressPct(1200, 1000)).toBe(100);
  });

  test("릴리스 노트는 빈 줄을 뺀 3줄·200자까지, 잘리면 …", () => {
    expect(noteExcerpt(undefined)).toBeNull();
    expect(noteExcerpt("  \n\n")).toBeNull();
    expect(noteExcerpt("a\n\nb\nc")).toBe("a\nb\nc");
    expect(noteExcerpt("a\nb\nc\nd")).toBe("a\nb\nc…");
    const long = "가".repeat(250);
    expect(noteExcerpt(long)).toBe(`${"가".repeat(200)}…`);
    expect(noteExcerpt(`${"가".repeat(198)} \nb`)).toBe(`${"가".repeat(198)}\nb`); // 줄바꿈을 포함해 꼭 200자
  });

  test("오류 문장: 연결·서명은 따로, 나머지는 단계별 기본 문장", () => {
    expect(updateErrorView(new Error("error sending request for url (https://x)"), "checking")).toEqual({ text: "업데이트 서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요.", detail: "error sending request for url (https://x)" });
    expect(updateErrorView("Network timed out", "downloading").text).toBe("업데이트 서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요.");
    expect(updateErrorView("the updater signature is invalid", "downloading").text).toBe("받은 파일의 서명이 맞지 않아 설치하지 않았습니다. 다시 받아 보세요.");
    expect(updateErrorView("Could not fetch a valid release JSON from the remote", "checking").text).toBe("업데이트 서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요.");
    expect(updateErrorView(null, "checking")).toEqual({ text: "업데이트를 확인하지 못했습니다.", detail: null });
    expect(updateErrorView("", "installed")).toEqual({ text: "업데이트를 설치하지 못했습니다.", detail: null });
  });
});

describe("notesVersion", () => {
  test("points at the version being offered, otherwise the running one", () => {
    expect(notesVersion({ phase: "found", version: "0.4.2", notes: null }, "0.4.1")).toBe("0.4.2");
    expect(notesVersion({ phase: "installed", version: "0.4.2" }, "0.4.1")).toBe("0.4.2");
    expect(notesVersion({ phase: "latest" }, "0.4.2")).toBe("0.4.2");
    expect(notesVersion({ phase: "idle" }, null)).toBeNull();
  });
});
