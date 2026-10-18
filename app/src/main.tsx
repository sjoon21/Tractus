// 언어를 먼저 정하고 나머지를 불러온다: 모듈 상수의 문구(t())가 그 언어로 만들어지게 (i18n.ts)
// Pretendard (SIL OFL 1.1). node_modules에서 번들에 포함한다 — CDN을 쓰지 않는다
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./theme.css";
import { invoke } from "@tauri-apps/api/core";
import { readLangPref, resolveLang, setLang } from "./i18n";

async function start() {
  const pref = readLangPref();
  const system = pref === "system" ? await invoke<string | null>("system_lang").catch(() => null) : null;
  const lang = resolveLang(pref, system);
  setLang(lang, lang === "en" ? (await import("./en")).EN : {});
  const [{ createRoot }, { initTheme }, { App }, { PanelsProvider }] = await Promise.all([import("react-dom/client"), import("./themePref"), import("./App"), import("./PanelToggle")]);
  initTheme();
  createRoot(document.getElementById("root")!).render(
    <PanelsProvider>
      <App />
    </PanelsProvider>,
  );
}

void start();
