import { describe, expect, it } from "vitest";
import { EN } from "./en";
import { panelKey } from "./panels";
import { detectOs, forOs, isMod, isOtherMod, OS } from "./platform";

const WEBVIEW2 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
const WKWEBVIEW = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

describe("detectOs", () => {
  it("reads the webview user agent", () => {
    expect(detectOs("", WEBVIEW2)).toBe("windows");
    expect(detectOs("", WKWEBVIEW)).toBe("mac");
  });
  it("lets the preview force either OS", () => {
    expect(detectOs("?os=windows", WKWEBVIEW)).toBe("windows");
    expect(detectOs("?lang=en&os=mac", WEBVIEW2)).toBe("mac");
    expect(detectOs("?os=linux", WKWEBVIEW)).toBe("mac");
  });
});

/** 화면 문구 전부: 한국어 키와 영어 문장 */
const ALL = Object.entries(EN).flatMap(([k, e]) => [k, ...(typeof e === "string" ? [e] : e)]);

describe("forOs (WORDS.md §8)", () => {
  it("leaves every macOS string and shortcut as it is", () => {
    expect(OS).toBe("mac"); // 시험 환경은 macOS 화면이다: 나머지 시험이 모두 macOS 문구를 본다
    for (const s of [...ALL, "⌘K", "⌥⌘B", "⌘Enter", "Meta+S Meta+Enter Meta+B Meta+I"]) expect(forOs(s, "mac")).toBe(s);
  });
  it("turns macOS words and shortcuts into Windows ones", () => {
    expect(forOs("⌘K", "windows")).toBe("Ctrl+K");
    expect(forOs("⌥⌘B", "windows")).toBe("Ctrl+Alt+B");
    expect(forOs("Alt+Meta+B", "windows")).toBe("Alt+Control+B");
    expect(forOs("이 Mac은 메모리가", "windows")).toBe("이 컴퓨터는 메모리가");
    expect(forOs("키는 이 Mac에만 저장됩니다.", "windows")).toBe("키는 이 컴퓨터에만 저장됩니다.");
    expect(forOs("Move to Trash", "windows")).toBe("Move to Recycle Bin");
    expect(forOs("터미널에서 brew install ffmpeg로", "windows")).toBe("터미널에서 winget install Gyan.FFmpeg로");
  });
  it("leaves no macOS-only word on the Windows screen", () => {
    const left = ALL.map((s) => forOs(s, "windows")).filter((s) => /이 Mac|미만 Mac|⌘|⌥|brew install|Trash|this Mac|on Macs with|메뉴 막대|menu bar/i.test(s));
    expect(left).toEqual([]);
  });
});

describe("shortcut modifier", () => {
  const cmd = { metaKey: true, ctrlKey: false };
  const ctrl = { metaKey: false, ctrlKey: true };
  it("is ⌘ on macOS and Ctrl on Windows", () => {
    expect([isMod(cmd, "mac"), isMod(ctrl, "mac"), isOtherMod(ctrl, "mac")]).toEqual([true, false, true]);
    expect([isMod(ctrl, "windows"), isMod(cmd, "windows"), isOtherMod(cmd, "windows")]).toEqual([true, false, true]);
  });
  it("toggles panels with Ctrl+B / Ctrl+Alt+B on Windows only", () => {
    const b = { code: "KeyB", shiftKey: false, altKey: false };
    expect(panelKey({ ...b, ...ctrl }, "windows")).toBe("left");
    expect(panelKey({ ...b, ...ctrl, altKey: true }, "windows")).toBe("right");
    expect(panelKey({ ...b, ...cmd }, "windows")).toBeNull();
    expect(panelKey({ ...b, ...cmd }, "mac")).toBe("left");
    expect(panelKey({ ...b, ...ctrl }, "mac")).toBeNull();
  });
});
