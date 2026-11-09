import { desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { basename } from "node:path";
import { db, schema } from "../db/client.js";
import type { PublicListenAgainItem } from "@radiohost/shared";

// Shared data access for the public "Listen Again" surfaces: the episode list,
// a single episode, and the crawler-friendly share page. Kept in one place so
// the list and the share page can never drift apart in how they name a DJ,
// resolve artwork, or decide what counts as published.
type EpisodeRow = {
  rec: typeof schema.recordings.$inferSelect;
  show: typeof schema.shows.$inferSelect | null;
  djRec: typeof schema.users.$inferSelect | null;
  djOwner: typeof schema.users.$inferSelect | null;
};

function mapEpisode({ rec, show, djRec, djOwner }: EpisodeRow, base: string): PublicListenAgainItem {
  // The show's owner is the fallback presenter when the recording itself has no
  // DJ attached (older recordings, or shows aired by automation).
  const dj = djRec?.id ? djRec : djOwner?.id ? djOwner : null;
  return {
    id: rec.id,
    title: rec.title,
    showId: rec.showId,
    showName: show?.name ?? null,
    presenters: show?.presenters?.trim() ? show.presenters : null,
    djName: dj?.name ?? null,
    djAvatarUrl: dj?.avatarPath ? `/media/${basename(dj.avatarPath)}` : null,
    artworkUrl: show?.imagePath ? `/media/${basename(show.imagePath)}` : null,
    color: show?.color ?? null,
    startedAt: rec.startedAt.toISOString(),
    endedAt: rec.endedAt ? rec.endedAt.toISOString() : null,
    durationSeconds: rec.durationSeconds,
    audioUrl: `${base}/api/public/podcasts/${rec.id}/audio`,
  };
}

function baseQuery() {
  const djRec = alias(schema.users, "dj_rec");
  const djOwner = alias(schema.users, "dj_owner");
  return db
    .select({ rec: schema.recordings, show: schema.shows, djRec, djOwner })
    .from(schema.recordings)
    .leftJoin(schema.shows, eq(schema.recordings.showId, schema.shows.id))
    .leftJoin(djRec, eq(schema.recordings.djId, djRec.id))
    .leftJoin(djOwner, eq(schema.shows.ownerId, djOwner.id));
}

export async function loadStationInfo(): Promise<{ stationName: string; timezone: string }> {
  const rows = await db
    .select({ stationName: schema.settings.stationName, timezone: schema.settings.timezone })
    .from(schema.settings)
    .where(eq(schema.settings.id, 1))
    .limit(1);
  return {
    stationName: rows[0]?.stationName ?? "Radio Station",
    timezone: rows[0]?.timezone ?? "UTC",
  };
}

/** "1h 41m" / "48m" — matches how the episode cards show a running time. */
export function formatEpisodeDuration(totalSeconds: number): string {
  const total = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export async function loadListenAgainEpisodes(limit = 100): Promise<PublicListenAgainItem[]> {
  const base = process.env.PUBLIC_BASE_URL ?? "";
  const rows = await baseQuery()
    .where(eq(schema.recordings.isPodcast, true))
    .orderBy(desc(schema.recordings.startedAt))
    .limit(limit);
  return rows.map((row) => mapEpisode(row, base));
}

/** Only published (podcast) recordings are publicly reachable. */
export async function loadListenAgainEpisode(id: string): Promise<PublicListenAgainItem | null> {
  const base = process.env.PUBLIC_BASE_URL ?? "";
  const rows = await baseQuery()
    .where(eq(schema.recordings.id, id))
    .orderBy(desc(schema.recordings.startedAt))
    .limit(1);
  const row = rows[0];
  if (!row || !row.rec.isPodcast) return null;
  return mapEpisode(row, base);
}
