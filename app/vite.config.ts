import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri 개발 서버 포트는 tauri.conf.json의 devUrl과 맞춘다
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  // 메인 창(index.html)과 메뉴 막대 팝오버 창(tray.html, tray.rs) 두 페이지
  build: { target: "safari17", rollupOptions: { input: { main: path.resolve(__dirname, "index.html"), tray: path.resolve(__dirname, "tray.html") } } },
});
