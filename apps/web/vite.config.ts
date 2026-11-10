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
      // The admin Widgets page is an SPA route (/widgets), but the embeddable
      // scripts the page hands out live at /widgets/<name>.js on the API. Without
      // this bypass the proxy swallowed the page itself and a direct visit or
      // reload returned the API's 404 JSON. nginx already does exactly this with
      // `location = /widgets` and `location = /widgets/` -> index.html.
      "/widgets": {
        target: "http://localhost:8080",
        bypass(req) {
          const path = (req.url ?? "").split("?")[0];
          if (path === "/widgets" || path === "/widgets/") return "/index.html";
        },
      },
      "/ws": { target: "ws://localhost:8080", ws: true },
      "/live-ws": { target: "ws://localhost:9002", ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
