// 화면의 운영체제 판별은 여기 한 곳에서 한다. WebView2(Windows)의 userAgent에는 "Windows"가 들어 있다.
// 미리보기(preview.html)에서는 `?os=windows`·`?os=mac`으로 강제한다(가짜 데이터로 Windows 화면 확인). 시험: platform.test.ts
export type Os = "mac" | "windows";

/** 판별 규칙 (순수 함수): 미리보기 강제 값이 먼저, 없으면 userAgent */
export function detectOs(search: string, userAgent: string): Os {
  const forced = new URLSearchParams(search).get("os");
  if (forced === "windows" || forced === "mac") return forced;
  return /Windows/i.test(userAgent) ? "windows" : "mac";
}

export const OS: Os = detectOs(globalThis.location?.search ?? "", globalThis.navigator?.userAgent ?? "");

export const isWindows = (): boolean => OS === "windows";
