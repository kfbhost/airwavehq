import { and, asc, count, desc, gte, lte, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";

const LISTENER_SAMPLE_SECONDS = 15;

export async function listenerSeries(from: Date, to: Date, bucketMinutes = 15) {
  const rows = await db
    .select({
      bucket: sql<string>`date_trunc('minute', at) - (date_part('minute', at)::int % ${bucketMinutes}) * interval '1 minute'`,
      listeners: sql<number>`max(listeners)`,
    })
    .from(schema.listenerStats)
    .where(and(gte(schema.listenerStats.at, from), lte(schema.listenerStats.at, to)))
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  return rows.map((r) => ({
    at: new Date(r.bucket).toISOString(),
    listeners: Math.round(r.listeners),
  }));
}

export async function listenerSummary(from: Date, to: Date) {
  const rows = await db
    .select({
      avgListeners: sql<number>`coalesce(avg(listeners), 0)`,
      maxListeners: sql<number>`coalesce(max(listeners), 0)`,
      listenerSeconds: sql<number>`coalesce(sum(listeners), 0) * ${LISTENER_SAMPLE_SECONDS}`,
    })
    .from(schema.listenerStats)
    .where(and(gte(schema.listenerStats.at, from), lte(schema.listenerStats.at, to)));

  const summary = rows[0];
  return {
    avgListeners: Number(summary?.avgListeners ?? 0),
    maxListeners: Math.round(Number(summary?.maxListeners ?? 0)),
    listeningHours: Number(summary?.listenerSeconds ?? 0) / 3600,
  };
}

export async function topTracks(from: Date, to: Date, limit = 20) {
  const rows = await db
    .select({
      title: schema.playLog.title,
      artist: schema.playLog.artist,
      plays: count(),
    })
    .from(schema.playLog)
    .where(and(gte(schema.playLog.startedAt, from), lte(schema.playLog.startedAt, to)))
    .groupBy(schema.playLog.title, schema.playLog.artist)
    .orderBy(desc(count()))
    .limit(limit);
  return rows;
}

export async function countryTotals(from: Date, to: Date) {
  const rows = await db
    .select({ countries: schema.listenerStats.countries })
    .from(schema.listenerStats)
    .where(and(gte(schema.listenerStats.at, from), lte(schema.listenerStats.at, to)));
  const totals: Record<string, number> = {};
  for (const r of rows) {
    for (const [code, n] of Object.entries(r.countries ?? {})) {
      totals[code] = (totals[code] ?? 0) + n;
    }
  }
  return Object.entries(totals)
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count);
}

export async function playsForExport(from: Date, to: Date) {
  return db
    .select()
    .from(schema.playLog)
    .where(and(gte(schema.playLog.startedAt, from), lte(schema.playLog.startedAt, to)))
    .orderBy(asc(schema.playLog.startedAt));
}

/** CSV of every play, formatted for royalty declarations to collection societies. */
export function playLogCsv(rows: Awaited<ReturnType<typeof playsForExport>>): string {
  const header = [
    "Started (UTC)", "Ended (UTC)", "Duration (s)", "Title", "Artist",
    "Source", "Track ID", "Show ID", "Listeners at start", "Listeners at end",
  ];
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((r) =>
    [
      r.startedAt.toISOString(),
      r.endedAt ? r.endedAt.toISOString() : "",
      r.durationSeconds,
      r.title,
      r.artist,
      r.source,
      r.trackId ?? "",
      r.showId ?? "",
      r.listenersAtStart ?? "",
      r.listenersAtEnd ?? "",
    ]
      .map(esc)
      .join(","),
  );
  return [header.join(","), ...lines].join("\n");
}
