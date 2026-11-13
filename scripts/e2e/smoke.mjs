// 미리보기 e2e 스모크: 앱 화면(가짜 데이터, preview.html)을 실제 브라우저로 눌러 보며 주요 흐름이 오류 없이 그려지는지 본다.
// 실행: scripts/e2e/smoke.sh (미리보기 서버 `cd app && pnpm dev` 필요). CI는 .github/workflows/e2e.yml
// 보는 것: 화면마다 기대한 글자가 보이고, 페이지 오류(pageerror)·console.error가 하나도 없다. 단계마다 스크린샷을 남긴다.
// 경쟁 제품 Yogurt(MIT)가 가짜 모드 e2e로 흐름을 지키는 것에서 착안했다. 코드는 가져오지 않았다.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2] ?? "e2e-shots";
const BASE = process.env.PREVIEW_URL ?? "http://localhost:1420/preview.html";
mkdirSync(OUT, { recursive: true });

const L = {
  ko: { note: "3분기 예산 계획 회의", memo: "하늘상사 인터뷰 메모", tabs: ["요약", "회의록", "AI 질문", "메모"], record: "녹음", stop: "녹음 종료", settings: "설정", checkup: "시작 점검", find: "노트 검색" },
  en: { note: "Q3 budget planning", memo: "Skyline Trading interview notes", tabs: ["Summary", "Minutes", "Ask AI", "Memo"], record: "Record", stop: "Stop recording", settings: "Settings", checkup: "Setup check", find: "Search notes" },
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const failures = [];

for (const lang of ["ko", "en"]) {
  const t = L[lang];
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // 404 같은 자원 실패는 console 문구에 주소가 없다: 응답으로 주소를 남긴다 (브라우저가 저절로 찾는 favicon은 뺀다)
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(`console: ${m.text()}`));
  page.on("response", (r) => r.status() >= 400 && !r.url().endsWith("/favicon.ico") && errors.push(`HTTP ${r.status()}: ${r.url()}`));
  await page.addInitScript(() => {
    localStorage.setItem("tractus.tips", JSON.stringify({ seen: [], off: true }));
    localStorage.setItem("tractus.onboarding", JSON.stringify({ dismissed: true, sampleOpened: true, enhancedSeen: true }));
  });

  const steps = [
    ["홈", async () => void (await page.goto(`${BASE}${lang === "en" ? "?lang=en" : ""}`), await page.waitForTimeout(1200))],
    ["녹음 노트 열기", async () => { await page.getByText(t.note).first().click(); await page.getByText("0:34").first().waitFor({ timeout: 5000 }); }],
    ...t.tabs.map((tab) => [`오른쪽 탭 ${tab}`, async () => { await page.getByRole("tab", { name: tab, exact: true }).first().click(); await page.waitForTimeout(400); }]),
    ["메모 노트 열기", async () => { await page.getByText(t.memo).first().click(); await page.waitForTimeout(600); }],
    ["녹음 시작·종료", async () => {
      await page.getByRole("button", { name: t.record, exact: true }).first().click();
      await page.getByRole("button", { name: t.stop }).first().waitFor({ timeout: 5000 });
      await page.waitForTimeout(1500);
      await page.getByRole("button", { name: t.stop }).first().click();
      await page.waitForTimeout(800);
      await page.keyboard.press("Escape");
    }],
    ["빠른 실행 ⌘K", async () => { await page.keyboard.press("Meta+k"); await page.waitForTimeout(400); await page.keyboard.type(lang === "en" ? "budget" : "예산"); await page.waitForTimeout(500); await page.keyboard.press("Escape"); }],
    ["설정", async () => { await page.getByRole("button", { name: t.settings, exact: true }).first().click(); await page.waitForTimeout(600); }],
    ["시작 점검", async () => { await page.getByRole("button", { name: t.checkup }).first().click(); await page.getByRole("dialog").first().waitFor({ timeout: 5000 }); await page.keyboard.press("Escape"); }],
  ];

  for (const [i, [name, run]] of steps.entries()) {
    const before = errors.length;
    try {
      await run();
    } catch (e) {
      errors.push(`단계 실패: ${String(e).split("\n")[0]}`);
    }
    await page.screenshot({ path: `${OUT}/${lang}-${String(i).padStart(2, "0")}-${name.replace(/[^\p{L}\p{N}]+/gu, "_")}.png` });
    const fresh = errors.slice(before);
    console.log(`${fresh.length ? "✗" : "✓"} [${lang}] ${name}`);
    for (const f of fresh) failures.push(`[${lang}] ${name}: ${f}`);
  }
  await page.close();
}
await browser.close();

if (failures.length) {
  console.error(`\n실패 ${failures.length}개:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\n모두 통과");
