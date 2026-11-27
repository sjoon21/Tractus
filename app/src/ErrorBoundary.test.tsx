// @vitest-environment jsdom
// 렌더 오류 복구 화면: 흰 창 대신 안내와 `다시 불러오기`
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

afterEach(cleanup);

function Boom(): never {
  throw new Error("boom");
}

test("a render error shows the recovery screen and reloads on click", () => {
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
  const reload = vi.fn();
  render(
    <ErrorBoundary onReload={reload}>
      <Boom />
    </ErrorBoundary>,
  );
  expect(screen.getByRole("alert").textContent).toContain("화면을 그리지 못했습니다");
  fireEvent.click(screen.getByRole("button", { name: "다시 불러오기" }));
  expect(reload).toHaveBeenCalledOnce();
  quiet.mockRestore();
});

test("children render as usual without an error", () => {
  render(
    <ErrorBoundary>
      <p>ok</p>
    </ErrorBoundary>,
  );
  expect(screen.getByText("ok")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});
