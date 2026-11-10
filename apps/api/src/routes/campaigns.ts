import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db, schema, isoRow } from "../db/client.js";
import { authenticate, requireAdmin } from "../auth.js";
import { feasibility, planCampaign } from "../services/planner.js";
import { proposalPdf } from "../services/report.js";
import { BREAK_NAMES, campaignSchema, campaignPatchSchema, zonedDate } from "@airshift/shared";

const RULE_LABELS: Record<string, string> = BREAK_NAMES;

async function settingsTz(): Promise<string> {
  const rows = await db.select().from(schema.settings).where(eq(schema.settings.id, 1)).limit(1);
  return rows[0]?.timezone || "UTC";
}

async function deliverySummary(c: typeof schema.adCampaigns.$inferSelect) {
  const tz = await settingsTz();
  const plan = planCampaign({
    startDate: c.startDate,
    endDate: c.endDate,
    spotsPerDay: c.spotsPerDay,
    rule: c.whenRule,
    customDays: c.customDays ?? [],
    ratePerSpot: c.ratePerSpot,
    currency: c.currency,
    tz,
  });

  const airings = await db
    .select()
    .from(schema.adAirings)
    .where(eq(schema.adAirings.campaignId, c.id));

  const delivered = airings.filter((a) => a.confirmed).length;
  const booked = airings.length;
  const daysElapsed = Math.min(
    plan.days,
    Math.max(0, Math.floor((Date.now() - Date.parse(`${c.startDate}T00:00:00Z`)) / 86_400_000) + 1),
  );
  const expectedToday = c.spotsPerDay * daysElapsed;
  const behind = Math.max(0, expectedToday - delivered);
  const valueDelivered = Math.round(delivered * c.ratePerSpot * 100) / 100;

  return {
    days: plan.days,
    daysElapsed,
    expectedSpots: plan.expectedSpots,
    booked,
    delivered,
    behind,
    valueDelivered,
    totalValue: plan.totalValue,
    currency: c.currency,
    windows: plan.windows,
  };
}

export function campaignRoutes(app: FastifyInstance): void {
  app.get("/campaigns", { preHandler: authenticate }, async () => {
    const campaigns = await db
      .select()
      .from(schema.adCampaigns)
      .orderBy(desc(schema.adCampaigns.createdAt));
    const out = [];
    for (const c of campaigns) {
      out.push({ ...isoRow(c), summary: await deliverySummary(c) });
    }
    return { campaigns: out };
  });

  app.post("/campaigns", { preHandler: requireAdmin }, async (req, reply) => {
    const body = campaignSchema.parse(req.body);
    const check = feasibility(body.startDate, body.endDate, body.spotsPerDay, body.whenRule, body.customDays ?? []);
    const [campaign] = await db
      .insert(schema.adCampaigns)
      .values({
        advertiser: body.advertiser,
        startDate: body.startDate,
        endDate: body.endDate,
        spotsPerDay: body.spotsPerDay,
        maxPerHour: body.maxPerHour,
        whenRule: body.whenRule,
        customDays: body.customDays ?? [],
        ratePerSpot: body.ratePerSpot,
        currency: body.currency,
        audioTrackId: body.audioTrackId ?? null,
        status: body.status ?? "draft",
      })
      .returning();
    return reply.code(201).send({ campaign: isoRow(campaign), feasibility: check });
  });

  app.get("/campaigns/:id", { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = await db.select().from(schema.adCampaigns).where(eq(schema.adCampaigns.id, id)).limit(1);
    const c = rows[0];
    if (!c) return reply.code(404).send({ error: "Not found" });
    return { campaign: isoRow(c), summary: await deliverySummary(c) };
  });

  app.patch("/campaigns/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = campaignPatchSchema.parse(req.body);
    const [campaign] = await db
      .update(schema.adCampaigns)
      .set(body)
      .where(eq(schema.adCampaigns.id, id))
      .returning();
    if (!campaign) return reply.code(404).send({ error: "Not found" });
    const check = feasibility(
      campaign.startDate,
      campaign.endDate,
      campaign.spotsPerDay,
      campaign.whenRule,
      campaign.customDays ?? [],
    );
    return { campaign: isoRow(campaign), feasibility: check };
  });

  app.delete("/campaigns/:id", { preHandler: requireAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    await db.delete(schema.adCampaigns).where(eq(schema.adCampaigns.id, id));
    return { ok: true };
  });

  app.get("/campaigns/:id/airings", { preHandler: authenticate }, async (req) => {
    const { id } = req.params as { id: string };
    const airings = await db
      .select()
      .from(schema.adAirings)
      .where(eq(schema.adAirings.campaignId, id))
      .orderBy(desc(schema.adAirings.scheduledFor));
    return { airings: airings.map(isoRow) };
  });

  // Expected schedule from the planner (for reporting / reconciliation).
  app.post("/campaigns/:id/plan", { preHandler: requireAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    const rows = await db.select().from(schema.adCampaigns).where(eq(schema.adCampaigns.id, id)).limit(1);
    const c = rows[0];
    if (!c) return { plan: null };
    const tz = await settingsTz();
    const plan = planCampaign({
      startDate: c.startDate,
      endDate: c.endDate,
      spotsPerDay: c.spotsPerDay,
      rule: c.whenRule,
      customDays: c.customDays ?? [],
      ratePerSpot: c.ratePerSpot,
      currency: c.currency,
      tz,
    });
    return { plan };
  });

  app.get("/campaigns/:id/proposal", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = await db.select().from(schema.adCampaigns).where(eq(schema.adCampaigns.id, id)).limit(1);
    const c = rows[0];
    if (!c) return reply.code(404).send({ error: "Not found" });
    const tz = await settingsTz();
    const plan = planCampaign({
      startDate: c.startDate,
      endDate: c.endDate,
      spotsPerDay: c.spotsPerDay,
      rule: c.whenRule,
      customDays: c.customDays ?? [],
      ratePerSpot: c.ratePerSpot,
      currency: c.currency,
      tz,
    });
    const settings = await db.select().from(schema.settings).where(eq(schema.settings.id, 1)).limit(1);
    const stationName = settings[0]?.stationName || "Radio Station";
    const pdf = await proposalPdf({
      stationName,
      advertiser: c.advertiser,
      startDate: c.startDate,
      endDate: c.endDate,
      spotsPerDay: c.spotsPerDay,
      ruleLabel: RULE_LABELS[c.whenRule] ?? c.whenRule,
      ratePerSpot: c.ratePerSpot,
      currency: c.currency,
      plan,
    });
    reply.header("Content-Type", "application/pdf");
    reply.header("Content-Disposition", `attachment; filename="${slugify(c.advertiser)}-proposal.pdf"`);
    return reply.send(pdf);
  });
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "campaign";
}

export { zonedDate, and, gte, lte };
