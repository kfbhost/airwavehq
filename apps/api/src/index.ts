import { eq } from "drizzle-orm";
import { db, schema } from "./db/client.js";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { hashPassword } from "./auth.js";
import { startWebhookWorker } from "./services/webhooks.js";
import { startRetentionWorker } from "./services/retention.js";
import { startEngineWatchdog } from "./services/watchdog.js";
import { startProgrammingRefresher } from "./services/programmingRefresh.js";

async function ensureSettings(): Promise<void> {
  const rows = await db.select().from(schema.settings).where(eq(schema.settings.id, 1)).limit(1);
  if (rows.length === 0) {
    await db.insert(schema.settings).values({
      id: 1,
      stationName: process.env.STATION_NAME ?? "My Radio Station",
      timezone: process.env.STATION_TIMEZONE ?? "UTC",
      streamBitrate: Number(process.env.STREAM_BITRATE ?? 128),
      streamUrl: process.env.PUBLIC_STREAM_URL ?? "",
    });
    console.log("[bootstrap] Created default station settings");
  }
}

async function bootstrapAdmin(): Promise<void> {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  const admins = await db.select().from(schema.users).where(eq(schema.users.role, "admin")).limit(1);
  if (admins.length > 0) return;
  await db.insert(schema.users).values({
    email: email.toLowerCase(),
    name: process.env.ADMIN_NAME ?? "Station Owner",
    passwordHash: hashPassword(password),
    role: "admin",
  });
  console.log(`[bootstrap] Created admin account for ${email}`);
}

async function main(): Promise<void> {
  await ensureSettings();
  await bootstrapAdmin();
  startWebhookWorker();
  startRetentionWorker();
  startEngineWatchdog();
  startProgrammingRefresher();

  const app = await buildApp();
  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log(`[api] listening on :${config.port}  data=${config.dataDir}`);

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[api] fatal", err);
  process.exit(1);
});
