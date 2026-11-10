import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { db, schema, isoRow } from "../db/client.js";
import { authenticate, requireAdmin } from "../auth.js";
import { requestPatchSchema } from "@airshift/shared";
import { emitEvent } from "../services/webhooks.js";

export function requestRoutes(app: FastifyInstance): void {
  app.get("/requests", { preHandler: authenticate }, async (req) => {
    const q = req.query as { status?: string };
    const where = q.status && q.status !== "all" ? eq(schema.requests.status, q.status) : undefined;
    const rows = await db
      .select()
      .from(schema.requests)
      .where(where)
      .orderBy(desc(schema.requests.createdAt))
      .limit(200);
    return { requests: rows.map(isoRow) };
  });

  app.patch("/requests/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = requestPatchSchema.parse(req.body);
    const [entry] = await db
      .update(schema.requests)
      .set({ status: body.status })
      .where(eq(schema.requests.id, id))
      .returning();
    if (!entry) return reply.code(404).send({ error: "Not found" });
    if (body.status === "approved") {
      await emitEvent("request.approved", { requestId: entry.id, song: entry.songQuery, trackId: entry.trackId });
    }
    return { request: isoRow(entry) };
  });

  app.delete("/requests/:id", { preHandler: requireAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    await db.delete(schema.requests).where(eq(schema.requests.id, id));
    return { ok: true };
  });
}
