import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MiniRecorderView, miniLevel } from "./MiniRecorder";
import { EMPTY_POPOVER, type PopoverState } from "./TrayPopover";

const rec: PopoverState = { ...EMPTY_POPOVER, phase: "recording", started_at_ms: 1_000, can: { start: false, pause: true, resume: false, stop: true, bookmark: true } };

describe("녹음 미니 창", () => {
  it("녹음 시각과 단추 셋, 시각은 Tractus를 연다", () => {
    const html = renderToStaticMarkup(<MiniRecorderView state={rec} nowMs={1_000 + 75_000} level={0.5} onAction={() => {}} />);
    expect(html).toContain("01:15");
    for (const name of ["북마크 남기기", "일시정지", "녹음 종료", "Tractus 열기"]) expect(html).toContain(name);
    expect(html).toContain("data-tauri-drag-region");
  });

  it("일시정지면 멈춘 시각과 계속 단추, 막대는 바닥", () => {
    const paused: PopoverState = { ...rec, phase: "paused", elapsed_ms: 30_000, can: { ...rec.can, pause: false, resume: true } };
    const html = renderToStaticMarkup(<MiniRecorderView state={paused} nowMs={999_999} level={1} onAction={() => {}} />);
    expect(html).toContain("00:30");
    expect(html).toContain("계속");
    expect(html).not.toContain("height:20px");
  });

  it("소리 크기는 두 트랙 중 큰 쪽", () => {
    expect(miniLevel(-60, null)).toBe(0);
    expect(miniLevel(-30, -6)).toBeCloseTo(0.9);
    expect(miniLevel(null, null)).toBe(0);
  });
});
