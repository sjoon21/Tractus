import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 개발 서버 포트는 tauri.conf.json의 devUrl과 맞춘다
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "safari17" },
});
