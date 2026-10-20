// 창 위쪽 녹음 단추 (RecHeaderControls.tsx): 정적 마크업으로 보이는 때·단추 이름·글자 없는 아이콘 단추인지를 본다.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { RecPhase } from "./lib";
import { RecHeaderControls } from "./RecHeaderControls";

const html = (phase: RecPhase) => renderToStaticMarkup(createElement(RecHeaderControls, { phase, seconds: 754, send: async () => {} }));
const buttons = (h: string) => h.match(/<button[^>]*>.*?<\/button>/g) ?? [];

describe("RecHeaderControls (창 위쪽 녹음 단추)", () => {
  test("녹음 중이 아니면 아무것도 그리지 않는다", () => {
    for (const p of ["idle", "starting", "stopping", "stopped", "error"] as RecPhase[]) expect(html(p)).toBe("");
  });

  test("녹음 중: 일시정지와 녹음 종료", () => {
    const b = buttons(html("recording"));
    expect(b).toHaveLength(2);
    expect(b[0]).toContain('aria-label="일시정지"');
    expect(b[1]).toContain('aria-label="녹음 종료"');
  });

  test("일시정지 중: 일시정지 자리가 계속이 된다", () => {
    const b = buttons(html("paused"));
    expect(b[0]).toContain('aria-label="계속"');
    expect(b[1]).toContain('aria-label="녹음 종료"');
  });

  test("단추에는 글자가 없고 아이콘만 있다 (이름은 aria-label·title)", () => {
    for (const b of buttons(html("recording"))) {
      expect(b.replace(/<[^>]+>/g, "").trim()).toBe("");
      expect(b).toContain("<svg");
      expect(b).toContain("title=");
    }
  });

  test("녹음 시각을 보인다 (글자 없이 숫자만)", () => {
    expect(html("recording")).toContain("12:34");
    expect(html("paused")).toContain("12:34");
  });

  test("녹음 화면에서는 그리지 않는다 (녹음 화면에 같은 단추가 있다)", () => {
    expect(readFileSync(new URL("./App.tsx", import.meta.url), "utf8")).toContain('{view.kind !== "record" && <RecHeaderControls');
  });
});
