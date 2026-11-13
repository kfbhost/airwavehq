import type { FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import { eq, sql } from "drizzle-orm";
import { APP_NAME, APP_VERSION } from "@airwavehq/shared";
import { db, schema } from "../db/client.js";
import { requireAdmin } from "../auth.js";

const run = promisify(execFile);

/** First line of `ffmpeg -version`, or null when ffmpeg isn't on PATH. */
async function ffmpegVersion(): Promise<string | null> {
  try {
    const { stdout } = await run("ffmpeg", ["-version"], { timeout: 5_000 });
    return stdout.split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}

async function databaseVersion(): Promise<string | null> {
  try {
    const rows = (await db.execute(sql`select version() as version`)) as unknown as Array<{ version?: string }>;
    return rows?.[0]?.version ?? null;
  } catch {
    return null;
  }
}

export function aboutRoutes(app: FastifyInstance): void {
  // What a bug report needs: which build runs, on what machine, with which
  // dependencies and how the station is configured. Admin-only because the
  // configuration is included (no secrets are — settings holds none).
  app.get("/about", { preHandler: requireAdmin }, async () => {
    const settings =
      (await db.select().from(schema.settings).where(eq(schema.settings.id, 1)).limit(1))[0] ?? null;

    return {
      app: { name: APP_NAME, version: APP_VERSION },
      // Supplied by the build when it can be (see docs/VPS_SETUP.md); null otherwise.
      build: {
        revision: process.env.BUILD_REVISION ?? null,
        builtAt: process.env.BUILD_DATE ?? null,
      },
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        os: `${os.type()} ${os.release()}`,
        uptimeSeconds: Math.round(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      database: { version: await databaseVersion() },
      ffmpeg: await ffmpegVersion(),
      settings: settings
        ? {
            stationName: settings.stationName,
            timezone: settings.timezone,
            streamUrl: settings.streamUrl,
            mount: settings.mount,
            streamBitrate: settings.streamBitrate,
            publicPageEnabled: settings.publicPageEnabled,
            geoMode: settings.geoMode,
          }
        : null,
    };
  });
}
