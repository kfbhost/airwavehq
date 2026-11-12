import type { FastifyInstance } from "fastify";
import { asc, desc, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db, schema, isoRow } from "../db/client.js";
import { requireAdmin } from "../auth.js";
import { webhookSchema, webhookPatchSchema } from "@airwavehq/shared";
import { emitEvent } from "../services/webhooks.js";

export function webhookRoutes(app: FastifyInstance): void {
  app.get("/webhooks", { preHandler: requireAdmin }, async () => {
    const webhooks = await db.select().from(schema.webhooks).orderBy(asc(schema.webhooks.createdAt));
    return { webhooks: webhooks.map((w) => ({ ...isoRow(w), secret: undefined })) };
  });

  app.post("/webhooks", { preHandler: requireAdmin }, async (req, reply) => {
    const body = webhookSchema.parse(req.body);
    const secret = body.secret ?? `whsec_${randomBytes(24).toString("base64url")}`;
    const [webhook] = await db
      .insert(schema.webhooks)
      .values({ url: body.url, secret, events: [...body.events] })
      .returning();
    return reply.code(201).send({ webhook: { ...isoRow(webhook), secret: undefined }, secret });
  });

  app.patch("/webhooks/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = webhookPatchSchema.parse(req.body);
    const patch: Record<string, unknown> = {};
    if (body.url !== undefined) patch.url = body.url;
    if (body.events !== undefined) patch.events = [...body.events];
    if (body.isActive !== undefined) patch.isActive = body.isActive;
    if (body.secret !== undefined) patch.secret = body.secret;
    const [webhook] = await db
      .update(schema.webhooks)
      .set(patch)
      .where(eq(schema.webhooks.id, id))
      .returning();
    if (!webhook) return reply.code(404).send({ error: "Not found" });
    return { webhook: { ...isoRow(webhook), secret: undefined } };
  });

  app.delete("/webhooks/:id", { preHandler: requireAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    await db.delete(schema.webhooks).where(eq(schema.webhooks.id, id));
    return { ok: true };
  });

  // Deliveries log.
  app.get("/webhooks/deliveries", { preHandler: requireAdmin }, async (req) => {
    const q = req.query as { webhookId?: string };
    const where = q.webhookId ? eq(schema.webhookDeliveries.webhookId, q.webhookId) : undefined;
    const rows = await db
      .select()
      .from(schema.webhookDeliveries)
      .where(where)
      .orderBy(desc(schema.webhookDeliveries.createdAt))
      .limit(100);
    return { deliveries: rows.map(isoRow) };
  });

  app.post("/webhooks/:id/test", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = await db.select().from(schema.webhooks).where(eq(schema.webhooks.id, id)).limit(1);
    if (!rows[0]) return reply.code(404).send({ error: "Not found" });
    // Reuse the delivery queue with a synthetic event.
    await db.insert(schema.webhookDeliveries).values({
      webhookId: id,
      event: "track.start",
      payload: { test: true, at: new Date().toISOString(), message: "Test ping from AirwaveHQ" },
    });
    return { ok: true, message: "Test delivery queued" };
  });
}
