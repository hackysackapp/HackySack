import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,         // Must match tauri.conf.json devUrl port
    strictPort: true,
    host: false,        // Don't expose to network — desktop app only
    hmr: {
      protocol: "ws",
      host: "localhost",
      port: 1421,       // Separate port for Hot Module Replacement
    },
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  // 4. to make use of `TAURI_DEBUG` and other env variables
  envPrefix: ["VITE_", "TAURI_"],
}));
