import { createRoot } from "react-dom/client";
// Pretendard (SIL OFL 1.1). node_modules에서 번들에 포함한다 — CDN을 쓰지 않는다
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./theme.css";
import { initTheme } from "./themePref";
import { App } from "./App";
import { PanelsProvider } from "./PanelToggle";

initTheme();

createRoot(document.getElementById("root")!).render(
  <PanelsProvider>
    <App />
  </PanelsProvider>,
);
