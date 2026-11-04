// @vitest-environment jsdom
// 사전 화면: 목록(최근 추가 먼저)·Enter로 더하기·붙여 넣기 미리보기·지우기와 되돌리기·고치기·엔진 안내.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  glossaryList: vi.fn(),
  glossaryAdd: vi.fn(),
  glossaryRemove: vi.fn(),
  glossaryRename: vi.fn(),
  modelsList: vi.fn(),
  getSettings: vi.fn(),
}));
vi.mock("./api", () => ({ api, errText: (e: unknown) => String(e), errDetail: () => null }));
vi.mock("./useCapabilities", () => ({ useCapabilities: () => ({ report: null }) }));

import { DictionaryView } from "./DictionaryView";

const flush = () => act(async () => {});
async function setup(terms = ["쿠버네티스", "OKR"]) {
  api.glossaryList.mockResolvedValue({ terms, max: 50 });
  const notify = vi.fn();
  render(<DictionaryView onBack={() => {}} notify={notify} />);
  await flush();
  return notify;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.modelsList.mockResolvedValue({ models: [{ id: "asr-std", engine: "qwen3", installed: true }] });
  api.getSettings.mockResolvedValue({ asr_engine: "" });
});
afterEach(cleanup);

describe("사전 화면", () => {
  test("단어와 개수를 보이고, Enter로 더한다", async () => {
    const notify = await setup();
    expect(screen.getByText("단어 2개")).toBeTruthy();
    expect(screen.getAllByRole("listitem").map((x) => x.textContent)).toEqual(["쿠버네티스", "OKR"]);
    api.glossaryAdd.mockResolvedValue({ added: 1, skipped: 0 });
    const input = screen.getByLabelText("사전에 단어 추가");
    fireEvent.change(input, { target: { value: " Project Atlas " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await flush();
    expect(api.glossaryAdd).toHaveBeenCalledWith(["Project Atlas"]);
    expect(notify).toHaveBeenCalledWith({ text: expect.stringContaining("사전에 추가했습니다 — Project Atlas") });
    expect(api.glossaryList).toHaveBeenCalledTimes(2); // 더한 뒤 다시 읽는다
  });

  test("여러 줄을 붙여 넣으면 칩으로 보이고 한 번에 더한다. 못 넣은 것은 알린다", async () => {
    const notify = await setup([]);
    expect(screen.getByText(/아직 단어가 없습니다/)).toBeTruthy();
    fireEvent.paste(screen.getByLabelText("사전에 단어 추가"), { clipboardData: { getData: () => "a, b\nc" } });
    api.glossaryAdd.mockResolvedValue({ added: 2, skipped: 1 });
    fireEvent.click(screen.getByText("3개 추가"));
    await flush();
    expect(api.glossaryAdd).toHaveBeenCalledWith(["a", "b", "c"]);
    expect(notify).toHaveBeenCalledWith({ text: "1개는 추가하지 못했습니다 (40자가 넘거나 사전이 가득 찼습니다)", error: true });
  });

  test("지우면 되돌리기 알림을 주고, 되돌리면 다시 더한다", async () => {
    const notify = await setup();
    api.glossaryRemove.mockResolvedValue({ removed: 1 });
    fireEvent.click(screen.getByLabelText("‘OKR’ 지우기"));
    await flush();
    expect(api.glossaryRemove).toHaveBeenCalledWith(["OKR"]);
    const toast = notify.mock.calls.at(-1)![0];
    expect(toast.text).toBe("사전에서 지웠습니다 — OKR");
    api.glossaryAdd.mockResolvedValue({ added: 1, skipped: 0 });
    await act(async () => toast.action.run());
    expect(api.glossaryAdd).toHaveBeenCalledWith(["OKR"]);
  });

  test("고치기: Enter로 저장, 같거나 비면 부르지 않는다, Esc는 취소", async () => {
    await setup();
    api.glossaryRename.mockResolvedValue({ changed: true });
    fireEvent.click(screen.getByLabelText("‘쿠버네티스’ 고치기"));
    let box = screen.getByRole("textbox", { name: "‘쿠버네티스’ 고치기" });
    fireEvent.change(box, { target: { value: "Kubernetes" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await flush();
    expect(api.glossaryRename).toHaveBeenCalledWith("쿠버네티스", "Kubernetes");

    fireEvent.click(screen.getByLabelText("‘OKR’ 고치기"));
    box = screen.getByRole("textbox", { name: "‘OKR’ 고치기" });
    fireEvent.keyDown(box, { key: "Enter" });
    await flush();
    expect(api.glossaryRename).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText("‘OKR’ 고치기"));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "‘OKR’ 고치기" }), { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "‘OKR’ 고치기" })).toBeNull();
  });

  test("찾기는 10개를 넘을 때만, 50개를 넘으면 변환에 쓰는 개수를 말한다", async () => {
    await setup(Array.from({ length: 51 }, (_, i) => `w${i}`));
    expect(screen.getByText(/최근에 추가한 단어부터 50개까지/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("사전에서 찾기"), { target: { value: "w5" } });
    expect(screen.getAllByRole("listitem").map((x) => x.textContent)).toEqual(["w5", "w50"]);
  });

  test("Qwen이 아닌 엔진을 고르면 안내한다", async () => {
    api.modelsList.mockResolvedValue({ models: [{ id: "asr-ko-mix", engine: "whisper", installed: true }] });
    api.getSettings.mockResolvedValue({ asr_engine: "asr-ko-mix" });
    await setup();
    expect(screen.getByRole("note").textContent).toContain("사전 단어를 쓰지 않습니다");
  });
});
