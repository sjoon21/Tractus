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

// ── 단축키·문구 (WORDS.md §8) ──

type ModKeys = { metaKey: boolean; ctrlKey: boolean };
/** 단축키의 주 수식 키: macOS ⌘(metaKey), Windows Ctrl(ctrlKey) */
export const isMod = (e: ModKeys, os: Os = OS): boolean => (os === "windows" ? e.ctrlKey : e.metaKey);
/** 주 수식 키가 아닌 쪽: macOS Ctrl, Windows ⊞(metaKey). 주 수식 키만 받는 단축키가 이것을 거른다 */
export const isOtherMod = (e: ModKeys, os: Os = OS): boolean => (os === "windows" ? e.metaKey : e.ctrlKey);

/** Windows 화면에서 바꾸는 말 (앞에서부터 차례로). macOS 문구가 원본이고 t() 키도 그대로다. Rust i18n.rs `WINDOWS_WORDS`도 같은 규칙 */
const WINDOWS_WORDS: readonly (readonly [string, string])[] = [
  ["⌥⌘", "Ctrl+Alt+"],
  ["⇧⌘", "Ctrl+Shift+"],
  ["⌘", "Ctrl+"],
  ["Meta+", "Control+"], // aria-keyshortcuts
  ["이 Mac은", "이 컴퓨터는"], // i18n-ok
  ["이 Mac이", "이 컴퓨터가"], // i18n-ok
  ["이 Mac", "이 컴퓨터"], // i18n-ok
  ["미만 Mac", "미만 컴퓨터"], // i18n-ok
  ["메뉴 막대", "알림 영역"], // i18n-ok
  ["brew install ffmpeg", "winget install Gyan.FFmpeg"],
  ["this Mac", "this computer"],
  ["This Mac", "This computer"],
  ["on Macs with", "on computers with"],
  ["menu bar", "notification area"],
  ["Menu bar", "Notification area"],
  ["Trash", "Recycle Bin"],
];

/** 화면에 보이는 문구·단축키 표기를 운영체제에 맞춘다. macOS는 그대로 돌려준다 (t()·Kbd가 부른다) */
export const forOs = (s: string, os: Os = OS): string => (os === "windows" ? WINDOWS_WORDS.reduce((acc, [a, b]) => acc.replaceAll(a, b), s) : s);
