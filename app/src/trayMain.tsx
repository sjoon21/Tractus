// 메뉴 막대 팝오버 창(tray.html)의 시작점. main.tsx처럼 언어를 먼저 정하고 나머지를 불러온다 (모듈 상수의 문구가 그 언어로 만들어지게)
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./theme.css";
import { invoke } from "@tauri-apps/api/core";
import { setLang, type Lang } from "./i18n";

async function start() {
  const { lang } = await invoke<{ lang: Lang }>("ui_lang").catch(() => ({ lang: "ko" as Lang }));
  setLang(lang, lang === "en" ? (await import("./en")).EN : {});
  const [{ createRoot }, { initTheme }, { TrayPopover }] = await Promise.all([import("react-dom/client"), import("./themePref"), import("./TrayPopover")]);
  initTheme();
  createRoot(document.getElementById("root")!).render(<TrayPopover />);
}

void start();
