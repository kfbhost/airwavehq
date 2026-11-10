import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db, schema, isoRow } from "../db/client.js";
import { requireAdmin, authenticate } from "../auth.js";
import { settingsSchema } from "@airshift/shared";
import { bumpProgrammingRevision, requestEngineRestart } from "../services/engineState.js";

export function settingsRoutes(app: FastifyInstance): void {
  app.get("/settings", { preHandler: authenticate }, async () => {
    const rows = await db.select().from(schema.settings).where(eq(schema.settings.id, 1)).limit(1);
    return { settings: rows[0] ? isoRow(rows[0]) : null };
  });

  app.put("/settings", { preHandler: requireAdmin }, async (req) => {
    const body = settingsSchema.parse(req.body);
    const existing = await db.select().from(schema.settings).where(eq(schema.settings.id, 1)).limit(1);
    if (existing[0]) {
      const [settings] = await db
        .update(schema.settings)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(schema.settings.id, 1))
        .returning();
      bumpProgrammingRevision();
      return { settings: isoRow(settings) };
    }
    const [settings] = await db
      .insert(schema.settings)
      .values({ ...body })
      .returning();
    bumpProgrammingRevision();
    return { settings: isoRow(settings) };
  });

  app.post("/settings/apply-stream", { preHandler: requireAdmin }, async (req) => {
    const body = settingsSchema.parse(req.body);
    const existing = await db.select().from(schema.settings).where(eq(schema.settings.id, 1)).limit(1);
    const settings = existing[0]
      ? (await db
          .update(schema.settings)
          .set({ ...body, updatedAt: new Date() })
          .where(eq(schema.settings.id, 1))
          .returning())[0]
      : (await db.insert(schema.settings).values({ ...body }).returning())[0];

    const revision = bumpProgrammingRevision();
    const requestedAt = requestEngineRestart();
    return {
      settings: isoRow(settings),
      revision,
      requestedAt,
      message:
        "Stream settings saved. Crossfade will refresh on the running engine, and the playout engine restart has been requested so bitrate changes take effect too.",
    };
  });

  app.post("/settings/recovery/reload-automation", { preHandler: requireAdmin }, async () => {
    const revision = bumpProgrammingRevision();
    return {
      ok: true,
      revision,
      message: "Automation refresh requested. The engine will rebuild its queue within a few seconds.",
    };
  });

  app.post("/settings/recovery/restart-engine", { preHandler: requireAdmin }, async () => {
    const requestedAt = requestEngineRestart();
    return {
      ok: true,
      requestedAt,
      message: "Engine restart requested. If the service is supervised, it should come back automatically within a few seconds.",
    };
  });
}
