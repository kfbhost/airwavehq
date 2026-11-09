import type { FastifyInstance } from "fastify";
import { and, count, gte, lte } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { authenticate } from "../auth.js";
import {
  listenerSeries,
  listenerSummary,
  topTracks,
  countryTotals,
  playsForExport,
  playLogCsv,
} from "../services/analytics.js";

function range(q: Record<string, string | undefined>, daysDefault = 7): { from: Date; to: Date } {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - daysDefault * 86_400_000);
  return { from, to };
}

export function analyticsRoutes(app: FastifyInstance): void {
  app.get("/analytics/summary", { preHandler: authenticate }, async (req) => {
    const { from, to } = range(req.query as Record<string, string | undefined>, 7);
    const summary = await listenerSummary(from, to);
    const counts = await db
      .select({ n: count() })
      .from(schema.playLog)
      .where(sqlBetween(from, to));
    const plays = counts[0]?.n ?? 0;
    return {
      avgListeners: Math.round(summary.avgListeners * 10) / 10,
      maxListeners: summary.maxListeners,
      listeningHours: Math.round(summary.listeningHours * 10) / 10,
      plays,
      from: from.toISOString(),
      to: to.toISOString(),
    };
  });

  app.get("/analytics/listeners", { preHandler: authenticate }, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const { from, to } = range(q, 7);
    const bucket = Math.max(5, Math.min(240, Number(q.bucket ?? 15) || 15));
    const series = await listenerSeries(from, to, bucket);
    return { series };
  });

  app.get("/analytics/top-tracks", { preHandler: authenticate }, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const { from, to } = range(q, 7);
    const limit = Math.min(100, Number(q.limit ?? 20) || 20);
    const tracks = await topTracks(from, to, limit);
    return { tracks };
  });

  app.get("/analytics/countries", { preHandler: authenticate }, async (req) => {
    const { from, to } = range(req.query as Record<string, string | undefined>, 7);
    const countries = await countryTotals(from, to);
    return { countries };
  });

  app.get("/analytics/export", { preHandler: authenticate }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const { from, to } = range(q, 7);
    const rows = await playsForExport(from, to);
    const csv = playLogCsv(rows);
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", "attachment; filename=playlog.csv");
    return reply.send(csv);
  });
}

function sqlBetween(from: Date, to: Date) {
  return and(gte(schema.playLog.startedAt, from), lte(schema.playLog.startedAt, to));
}
