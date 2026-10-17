// CDP 화면 녹화: 프레임(JPEG)과 시각을 남기고, 끝에 ffmpeg concat 목록을 쓴다
import fs from "node:fs";
import path from "node:path";
export async function startCast(page, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
    const f = path.join(dir, `f${String(frames.length).padStart(5, "0")}.jpg`);
    fs.writeFileSync(f, Buffer.from(data, "base64"));
    frames.push({ f, t: metadata.timestamp });
    await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
  return async () => {
    await cdp.send("Page.stopScreencast").catch(() => {});
    const end = Date.now() / 1000;
    const lines = frames.map((x, i) => `file '${x.f}'\nduration ${Math.max(0.001, (frames[i + 1]?.t ?? end) - x.t).toFixed(3)}`);
    lines.push(`file '${frames.at(-1).f}'`);
    fs.writeFileSync(path.join(dir, "list.txt"), lines.join("\n"));
    return frames.length;
  };
}
