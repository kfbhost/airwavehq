import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@radiohost/shared": fileURLToPath(
        new URL("../../packages/shared/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
      "/media": "http://localhost:8080",
      "/widgets": "http://localhost:8080",
      "/ws": { target: "ws://localhost:8080", ws: true },
      "/live-ws": { target: "ws://localhost:9002", ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
