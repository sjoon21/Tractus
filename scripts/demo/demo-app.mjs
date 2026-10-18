// 데모 1부: 앱 (미리보기 가짜 데이터). 노트 열기 → 메모 탭 → 노트 완성 → 완성된 노트
import { chromium } from "playwright-core";
import { startCast } from "./screencast.mjs";
const OUT = process.argv[2];
const EN = process.argv[3] === "en"; // en: 영어 화면 + 영어 가짜 데이터 (preview.html?lang=en)
const L = EN
  ? { home: "Recent notes", note: "Q3 budget planning", memo: "Memo", enhance: /Enhance/,
      c1: "A recording, turned into text on this Mac", c2: "Rough memos jotted while recording",
      c3: "Enhance — your memos become the outline, filled in from the transcript" }
  : { home: "최근 노트", note: "3분기 예산 계획 회의", memo: "메모", enhance: /노트 완성/,
      c1: "이 Mac에서 텍스트로 바꾼 녹음 노트", c2: "녹음하며 대충 적은 메모",
      c3: "노트 완성 — 메모를 뼈대로 대화 내용의 세부를 붙입니다" };
const b = await chromium.launch({ channel: "chrome", headless: true, args: ["--window-size=1280,800"] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "light" });
await ctx.addInitScript(() => {
  localStorage.setItem("tractus.tips", JSON.stringify({ seen: [], off: true })); // 깨끗한 화면: 기능 안내 끔
  localStorage.setItem("tractus.onboarding", JSON.stringify({ dismissed: true, sampleOpened: true, enhancedSeen: true }));
  window.addEventListener("DOMContentLoaded", () => {
    const c = document.createElement("div");
    c.id = "demo-cursor";
    c.style.cssText = "position:fixed;z-index:99999;left:0;top:0;width:18px;height:18px;pointer-events:none;transition:transform .05s linear";
    c.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 2l14 9-6.5 1.5L9 19z" fill="#111" stroke="#fff" stroke-width="1.5"/></svg>';
    document.body.appendChild(c);
    const cap = document.createElement("div");
    cap.id = "demo-caption";
    cap.style.cssText = "position:fixed;z-index:99998;left:50%;bottom:28px;transform:translateX(-50%);padding:10px 18px;border-radius:999px;background:rgba(17,17,17,.88);color:#fff;font:600 16px/1.3 -apple-system,'Apple SD Gothic Neo',sans-serif;letter-spacing:-.01em;opacity:0;transition:opacity .3s;pointer-events:none;white-space:nowrap";
    document.body.appendChild(cap);
    document.addEventListener("mousemove", (e) => (c.style.transform = `translate(${e.clientX - 3}px, ${e.clientY - 2}px)`));
  });
});
const p = await ctx.newPage();
await p.goto(`http://localhost:1420/preview.html${EN ? "?lang=en" : ""}`);
await p.getByRole("heading", { name: L.home }).waitFor();  // 홈이 다 그려진 뒤에 녹화를 시작한다
await p.waitForTimeout(1200);
const stop = await startCast(p, OUT);
const caption = (t) => p.evaluate((t) => { const c = document.getElementById("demo-caption"); c.textContent = t; c.style.opacity = t ? "1" : "0"; }, t);
const moveTo = async (loc, steps = 25) => {
  const bx = await loc.boundingBox();
  await p.mouse.move(bx.x + bx.width / 2, bx.y + bx.height / 2, { steps });
  await p.waitForTimeout(250);
};
await p.mouse.move(640, 420);
await p.waitForTimeout(700);
const note = p.getByText(L.note).first();
await moveTo(note); await note.click(); await p.waitForTimeout(400);
await caption(L.c1); await p.waitForTimeout(1100);
await p.mouse.move(900, 600, { steps: 15 });
await p.mouse.wheel(0, 260); await p.waitForTimeout(900);
await p.mouse.wheel(0, -260); await p.waitForTimeout(500);
const memoTab = p.getByRole("tab", { name: L.memo });
await moveTo(memoTab); await memoTab.click();
await caption(L.c2); await p.waitForTimeout(1600);
const btn = p.getByRole("button", { name: L.enhance }).first();
await moveTo(btn); await p.waitForTimeout(300); await btn.click();
await caption(L.c3); await p.waitForTimeout(2600);
await p.mouse.move(1150, 700, { steps: 20 });
await p.waitForTimeout(2600);
console.log("frames:", await stop());
await ctx.close(); await b.close();
