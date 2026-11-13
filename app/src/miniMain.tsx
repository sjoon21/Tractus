// 녹음 미니 창(mini.html, mini.rs)의 시작점. trayMain.tsx처럼 언어를 먼저 정하고 나머지를 불러온다
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./theme.css";
import { invoke } from "@tauri-apps/api/core";
import { setLang, type Lang } from "./i18n";

async function start() {
  const { lang } = await invoke<{ lang: Lang }>("ui_lang").catch(() => ({ lang: "ko" as Lang }));
  setLang(lang, lang === "en" ? (await import("./en")).EN : {});
  const [{ createRoot }, { initTheme }, { MiniRecorder }] = await Promise.all([import("react-dom/client"), import("./themePref"), import("./MiniRecorder")]);
  initTheme();
  createRoot(document.getElementById("root")!).render(<MiniRecorder />);
}

void start();
