import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { authRoutes } from "./routes/auth.js";
import { trackRoutes } from "./routes/tracks.js";
import { playlistRoutes } from "./routes/playlists.js";
import { programmingRoutes } from "./routes/programming.js";
import { rotationRoutes } from "./routes/rotations.js";
import { campaignRoutes } from "./routes/campaigns.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { requestRoutes } from "./routes/requests.js";
import { engineRoutes } from "./routes/engine.js";
import { publicRoutes } from "./routes/public.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { settingsRoutes } from "./routes/settings.js";
import { recordingRoutes } from "./routes/recordings.js";
import { backupRoutes } from "./routes/backups.js";
import { inviteRoutes } from "./routes/invites.js";
import { shareRoutes } from "./routes/share.js";
import { wsRoutes } from "./routes/ws.js";

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport:
        config.logLevel === "debug"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
    },
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: true,
  });

  await app.register(cors, {
    origin: true, // self-hosted: reflect any origin (public widgets need this)
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  await app.register(multipart, {
    limits: { fileSize: 4 * 1024 * 1024 * 1024, files: 1 },
  });

  await app.register(websocket);

  // Serve media files (tracks, artwork) with HTTP range support.
  // Resolve to an absolute path: fastify/static rejects relative roots, and
  // the API may be launched from any working directory. Ensure the directory
  // exists BEFORE registering the static handler — on a fresh install the
  // media dir may not exist yet at first boot, and once uploads create it the
  // /media/ route must still be live or artwork/previews 404.
  const mediaDir = resolve(config.dataDir, "media");
  await mkdir(mediaDir, { recursive: true });
  await app.register(fastifyStatic, {
    root: mediaDir,
    prefix: "/media/",
    decorateReply: true,
    acceptRanges: true,
    cacheControl: true,
    maxAge: "7d",
  });

  // Serve the built widgets bundle if present.
  const apiSrc = dirname(fileURLToPath(import.meta.url)); // .../apps/api/src
  const widgetsDir = resolve(apiSrc, "..", "..", "..", "apps", "widgets", "dist");
  if (existsSync(widgetsDir)) {
    await app.register(fastifyStatic, {
      root: widgetsDir,
      prefix: "/widgets/",
      decorateReply: false,
    });
  }

  // API routes.
  for (const register of [
    authRoutes,
    trackRoutes,
    playlistRoutes,
    programmingRoutes,
    rotationRoutes,
    campaignRoutes,
    analyticsRoutes,
    requestRoutes,
    engineRoutes,
    publicRoutes,
    webhookRoutes,
    settingsRoutes,
    recordingRoutes,
    backupRoutes,
    inviteRoutes,
  ]) {
    await app.register(register, { prefix: "/api" });
  }

  // Dashboard status websocket lives at /ws/* (not under /api) — this is the
  // path the dashboard client, vite dev proxy, and nginx all expect.
  await app.register(wsRoutes);

  // Per-episode social share pages live at /e/* (not under /api) so nginx can
  // proxy them straight to the API: they must return real HTML to crawlers
  // rather than the single-page-app shell.
  await app.register(shareRoutes);

  // Health check.
  app.get("/api/health", async () => ({ ok: true, time: new Date().toISOString() }));

  // Zod errors -> 400.
  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { issues?: unknown; validation?: unknown; statusCode?: number };
    if (e.issues || e.validation) {
      return reply.code(400).send({ error: "Validation failed", issues: e.issues ?? e.validation });
    }
    req.log.error(err);
    const status = typeof e.statusCode === "number" && e.statusCode < 500 ? e.statusCode : 500;
    reply.code(status).send({ error: status < 500 ? e.message : "Internal server error" });
  });

  return app;
}
