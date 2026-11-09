import { createHmac } from "node:crypto";
import { and, asc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import type { WebhookEvent } from "@radiohost/shared";

/**
 * Queues a webhook delivery for every active webhook subscribed to `event`.
 * Delivery happens in a background worker with exponential backoff.
 */
export async function emitEvent(event: WebhookEvent, payload: unknown): Promise<void> {
  try {
    const hooks = await db
      .select()
      .from(schema.webhooks)
      .where(and(eq(schema.webhooks.isActive, true), sql`${schema.webhooks.events} @> ${JSON.stringify([event])}::jsonb`));
    if (hooks.length === 0) return;
    await db.insert(schema.webhookDeliveries).values(
      hooks.map((h) => ({ webhookId: h.id, event, payload })),
    );
  } catch (err) {
    console.error("[webhooks] emit failed", err);
  }
}

const MAX_ATTEMPTS = 8;

export function startWebhookWorker(intervalMs = 3000): NodeJS.Timeout {
  const timer = setInterval(workerTick, intervalMs);
  timer.unref();
  return timer;
}

async function workerTick(): Promise<void> {
  const due = await db
    .select()
    .from(schema.webhookDeliveries)
    .where(
      and(
        inArray(schema.webhookDeliveries.status, ["pending", "failed"]),
        lte(schema.webhookDeliveries.nextAttemptAt, new Date()),
        ne(schema.webhookDeliveries.attempts, MAX_ATTEMPTS),
      ),
    )
    .orderBy(asc(schema.webhookDeliveries.createdAt))
    .limit(20);
  if (due.length === 0) return;

  const hooks = await db.select().from(schema.webhooks);
  const hookById = new Map(hooks.map((h) => [h.id, h]));

  for (const d of due) {
    const hook = hookById.get(d.webhookId);
    if (!hook) {
      await db.update(schema.webhookDeliveries).set({ status: "dead" }).where(eq(schema.webhookDeliveries.id, d.id));
      continue;
    }
    const body = JSON.stringify(d.payload);
    const signature = createHmac("sha256", hook.secret).update(body).digest("hex");
    try {
      const res = await fetch(hook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-RadioHost-Event": d.event,
          "X-RadioHost-Signature": `sha256=${signature}`,
          "User-Agent": "RadioHost-Studio/1.0",
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        await db
          .update(schema.webhookDeliveries)
          .set({ status: "delivered", attempts: d.attempts + 1 })
          .where(eq(schema.webhookDeliveries.id, d.id));
      } else {
        await backoff(d, `HTTP ${res.status}`);
      }
    } catch (err) {
      await backoff(d, err instanceof Error ? err.message : String(err));
    }
  }
}

async function backoff(d: typeof schema.webhookDeliveries.$inferSelect, error: string): Promise<void> {
  const attempts = d.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await db
      .update(schema.webhookDeliveries)
      .set({ status: "dead", attempts })
      .where(eq(schema.webhookDeliveries.id, d.id));
    console.error(`[webhooks] delivery ${d.id} dead: ${error}`);
    return;
  }
  const delayMs = Math.min(3600_000, 30_000 * 2 ** attempts);
  await db
    .update(schema.webhookDeliveries)
    .set({
      status: "failed",
      attempts,
      nextAttemptAt: new Date(Date.now() + delayMs),
    })
    .where(eq(schema.webhookDeliveries.id, d.id));
}
