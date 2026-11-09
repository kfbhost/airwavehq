import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/player.ts",
    "src/nowplaying.ts",
    "src/bar.ts",
    "src/artwork.ts",
    "src/schedule.ts",
    "src/listenagain.ts",
    "src/requests.ts",
  ],
  format: ["iife"],
  target: "es2019",
  outDir: "dist",
  clean: true,
  minify: true,
  outExtension: () => ({ js: ".js" }),
});
