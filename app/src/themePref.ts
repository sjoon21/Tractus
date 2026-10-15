// 화면 테마: 시스템 설정을 따르기 | 라이트 | 다크. 이 Mac의 브라우저 저장소에 둔다 (앱 설정 파일과 별개, 못 쓰면 시스템)
// <html data-theme="light|dark">를 정하고 macOS 창 테두리(신호등·스크롤 막대)도 맞춘다
import { getCurrentWindow } from "@tauri-apps/api/window";

export type ThemePref = "system" | "light" | "dark";
export const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "system", label: "시스템 설정" },
  { value: "light", label: "라이트" },
  { value: "dark", label: "다크" },
];

const KEY = "tractus.theme";
const media = () => window.matchMedia("(prefers-color-scheme: dark)");

export function readTheme(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export const resolveTheme = (p: ThemePref, systemDark: boolean): "light" | "dark" => (p === "system" ? (systemDark ? "dark" : "light") : p);

let current: ThemePref = "system";

function paint() {
  document.documentElement.dataset.theme = resolveTheme(current, media().matches);
}

export function applyTheme(p: ThemePref) {
  current = p;
  paint();
  getCurrentWindow()
    .setTheme(p === "system" ? null : p)
    .catch(() => {}); // 창 테두리는 못 바꿔도 화면은 이미 바뀌었다
}

export function saveTheme(p: ThemePref) {
  try {
    localStorage.setItem(KEY, p);
  } catch {
    /* 저장하지 못해도 이번 실행에서는 적용한다 */
  }
  applyTheme(p);
}

/** 시작할 때 한 번: 저장된 선택을 적용하고, `시스템 설정`이면 macOS 모드가 바뀔 때 따라간다 */
export function initTheme() {
  applyTheme(readTheme());
  media().addEventListener("change", paint);
}
