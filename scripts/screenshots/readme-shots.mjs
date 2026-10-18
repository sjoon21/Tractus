// README 스크린샷: 미리보기(가짜 데이터)를 찍고 macOS 창 테두리를 입혀 투명 배경 PNG로 저장
// 실행: scripts/screenshots/make_shots.sh [--lang en]  (→ docs/images/*.png, 영어는 docs/images/en/*.png)
// 직접: node readme-shots.mjs <출력 폴더> [ko|en]  (playwright-core가 있는 폴더에서, 미리보기 서버 `cd app && pnpm dev` 필요)
import { chromium } from "playwright-core";
const OUT = process.argv[2];
const EN = process.argv[3] === "en";
const W = 1360, H = 850, DPR = 1.5;
const L = EN
  ? { note: "Q3 budget planning", ask: "Ask AI", record: "Start recording", memo: "Skyline Trading interview notes", settings: "Settings" }
  : { note: "3분기 예산 계획 회의", ask: "AI 질문", record: "녹음 시작", memo: "하늘상사 인터뷰 메모", settings: "설정" };
const scenes = [
  { name: "note", steps: [["text", L.note], ["wait", 700], ["text", "0:34"], ["wait", 300]] },
  { name: "home", steps: [["wait", 900]] },
  { name: "ask", steps: [["text", L.note], ["wait", 600], ["role", "tab", L.ask], ["wait", 500]] },
  { name: "record", steps: [["text", L.record], ["wait", 700]] },
  { name: "memo", steps: [["text", L.memo], ["wait", 700]] },
  { name: "settings", steps: [["text", L.settings], ["wait", 700]] },
];
const browser = await chromium.launch({ channel: "chrome", headless: true });
for (const scheme of ["light", "dark"]) {
  for (const sc of scenes) {
    const page = await browser.newPage({ viewport: { width: W, height: H }, colorScheme: scheme, deviceScaleFactor: DPR });
    await page.addInitScript(() => { // 깨끗한 화면: 기능 안내·시작 안내 카드 끔 (demo-app.mjs와 같다)
      localStorage.setItem("tractus.tips", JSON.stringify({ seen: [], off: true }));
      localStorage.setItem("tractus.onboarding", JSON.stringify({ dismissed: true, sampleOpened: true, enhancedSeen: true }));
    });
    await page.goto(`http://localhost:1420/preview.html${EN ? "?lang=en" : ""}`);
    await page.waitForTimeout(1000);
    for (const [k, a, b] of sc.steps) {
      if (k === "wait") await page.waitForTimeout(a);
      else if (k === "text") await page.getByText(a, { exact: false }).first().click();
      else if (k === "role") await page.getByRole(a, { name: b }).first().click();
    }
    await page.mouse.move(W - 5, H - 5);
    await page.waitForTimeout(300);
    const shot = (await page.screenshot()).toString("base64");
    await page.close();
    // 창 테두리: 둥근 모서리, 얇은 선, 그림자, 사이드바 위의 신호등 단추
    const frame = await browser.newPage({ viewport: { width: W + 120, height: H + 120 }, deviceScaleFactor: DPR });
    const border = scheme === "dark" ? "rgba(255,255,255,.14)" : "rgba(0,0,0,.14)";
    await frame.setContent(`<html><body style="margin:0;background:transparent">
      <div id="w" style="position:relative;margin:50px 60px 70px;width:${W}px;height:${H}px;border-radius:12px;overflow:hidden;
        box-shadow:0 0 0 1px ${border},0 24px 60px -12px rgba(0,0,0,.35),0 8px 20px -8px rgba(0,0,0,.2)">
        <img src="data:image/png;base64,${shot}" style="display:block;width:${W}px;height:${H}px">
        <div style="position:absolute;left:18px;top:18px;display:flex;gap:8px">
          ${["#ff5f57", "#febc2e", "#28c840"].map((c) => `<span style="width:12px;height:12px;border-radius:50%;background:${c};box-shadow:inset 0 0 0 .5px rgba(0,0,0,.2)"></span>`).join("")}
        </div></div></body></html>`);
    await frame.waitForTimeout(150);
    await frame.screenshot({ path: `${OUT}/${sc.name}-${scheme}.png`, omitBackground: true, fullPage: true });
    await frame.close();
    console.log(sc.name, scheme);
  }
}
await browser.close();
