import { chromium } from "playwright-core";
import { startCast } from "./screencast.mjs";
const OUT = process.argv[2];
const EN = process.argv[3] === "en";
const b = await chromium.launch({ channel: "chrome", headless: true, args: ["--window-size=1280,800"] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
await p.goto("file://" + new URL("./terminal.html", import.meta.url).pathname + (EN ? "?lang=en" : "")); // 실제 Claude Code 답(가상 회의, tests/fixtures/eval)을 줄여 다시 그린다
await p.waitForTimeout(500);
const stop = await startCast(p, OUT);
await p.evaluate(() => window.play());
await p.waitForFunction(() => window.done === true, null, { timeout: 60000 });
await p.waitForTimeout(3500);
console.log("frames:", await stop());
await b.close();
