// 메뉴 막대 팝오버 (TrayPopover.tsx): 정적 마크업으로 녹음 막대의 단추·시각·목록을 본다. 상태 계산은 tray.rs `popover_state` 테스트가 맡는다.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { clock, EMPTY_POPOVER, popoverSeconds, TrayPopoverView, type PopoverState } from "./TrayPopover";

const st = (o: Partial<Omit<PopoverState, "can">> & { can?: Partial<PopoverState["can"]> } = {}): PopoverState => ({ ...EMPTY_POPOVER, ...o, can: { ...EMPTY_POPOVER.can, ...o.can } });
const html = (s: PopoverState, now = 0) => renderToStaticMarkup(createElement(TrayPopoverView, { state: s, nowMs: now, onAction: () => {} }));
const iconButtons = (h: string) => (h.match(/<button[^>]*aria-label="[^"]*"[^>]*>.*?<\/button>/g) ?? []).map((b) => ({ label: b.match(/aria-label="([^"]*)"/)![1], text: b.replace(/<[^>]+>/g, "").trim(), off: /\sdisabled=""/.test(b) }));

describe("clock", () => {
  test("메뉴 막대 제목과 같은 모양", () => {
    expect(clock(16)).toBe("00:16");
    expect(clock(754)).toBe("12:34");
    expect(clock(3723)).toBe("1:02:03");
    expect(clock(-3)).toBe("00:00");
  });
});

describe("popoverSeconds", () => {
  test("녹음 중은 시작 시각부터, 일시정지는 멈춘 값, 그 밖은 없음", () => {
    expect(popoverSeconds(st({ phase: "recording", started_at_ms: 1_000 }), 17_000)).toBe(16);
    expect(popoverSeconds(st({ phase: "paused", elapsed_ms: 754_000 }), 99_999_999)).toBe(754);
    expect(popoverSeconds(st({ phase: "starting" }), 5)).toBeNull();
    expect(popoverSeconds(st({ phase: "idle" }), 5)).toBeNull();
  });
});

describe("TrayPopoverView", () => {
  test("녹음 중: 점·시각과 글자 없는 일시정지·녹음 종료·북마크 단추", () => {
    const h = html(st({ phase: "recording", started_at_ms: 0, can: { pause: true, stop: true, bookmark: true } }), 16_000);
    expect(h).toContain("00:16");
    expect(h).toContain("animate-rec-pulse");
    const b = iconButtons(h);
    expect(b.map((x) => x.label)).toEqual(["북마크 남기기", "일시정지", "녹음 종료"]);
    for (const x of b) {
      expect(x.text).toBe("");
      expect(x.off).toBe(false);
    }
  });

  test("일시정지: 같은 자리가 계속이 되고 점이 깜빡이지 않는다", () => {
    const h = html(st({ phase: "paused", elapsed_ms: 754_000, can: { resume: true, stop: true, bookmark: true } }));
    expect(h).toContain("12:34");
    expect(h).not.toContain("animate-rec-pulse");
    expect(iconButtons(h)[1].label).toBe("계속");
  });

  test("대기 중: 상태 문구와 녹음 시작 단추 하나 (변환 중에 못 쓰면 숨김)", () => {
    const ok = iconButtons(html(st({ status: "대기 중", can: { start: true } })));
    expect(ok).toEqual([{ label: "녹음 시작", text: "", off: false }]);
    expect(html(st({ status: "대기 중" }))).toContain("대기 중");
    expect(iconButtons(html(st({ status: "변환 중 45%", phase: "converting" })))).toEqual([]);
    expect(iconButtons(html(st({ status: "변환 중 45%", phase: "converting", can: { start: true } })))[0].label).toBe("녹음 시작");
  });

  test("변환 중: 큰 진행률과 진행 막대 (모르면 끝을 모르는 막대)", () => {
    const h = html(st({ phase: "converting", status: "변환 중 45%", progress_pct: 45 }));
    expect(h).toContain("45%");
    expect(h).toContain("텍스트로 변환 중");
    expect(h).toContain("scaleX(0.45)");
    expect(html(st({ phase: "converting", status: "변환 중…" }))).toContain("progress-slide");
    expect(html(st({ status: "대기 중" }))).not.toContain("progress-slide");
  });

  test("최근 노트 목록은 없고 열기·종료만 있다", () => {
    const h = html(st({ recent: [{ id: "tray:note:01A", label: "녹음 10:02" }] }));
    expect(h).not.toContain("녹음 10:02");
    expect(h).toContain("Tractus 열기");
    expect(h).toContain("종료");
  });

  test("녹음 시작은 빨간 점, 녹음 종료는 네모: 모양이 다르다", () => {
    const idle = html(st({ can: { start: true } }));
    expect(idle).toMatch(/aria-label="녹음 시작"[^>]*><span class="[^"]*rounded-full bg-rec"/);
    const rec = html(st({ phase: "recording", started_at_ms: 0, can: { stop: true } }));
    expect(rec).toMatch(/aria-label="녹음 종료"[^>]*><svg[^>]*lucide-square/);
  });
});
