import { describe, expect, it } from "vitest";
import { detectOs } from "./platform";

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
