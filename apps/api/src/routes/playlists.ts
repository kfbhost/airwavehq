import type { FastifyInstance } from "fastify";
import { and, asc, count, eq, inArray, max } from "drizzle-orm";
import { db, schema, isoRow } from "../db/client.js";
import { authenticate, requireAdmin } from "../auth.js";
import { playlistGenerateSchema, playlistSchema, playlistPatchSchema } from "@airshift/shared";
import { bumpProgrammingRevision } from "../services/engineState.js";

export function playlistRoutes(app: FastifyInstance): void {
  app.get("/playlists", { preHandler: authenticate }, async () => {
    const playlists = await db
      .select()
      .from(schema.playlists)
      .orderBy(schema.playlists.createdAt);
    const out = [];
    for (const p of playlists) {
      const counts = await db
        .select({ n: max(schema.playlistItems.position) })
        .from(schema.playlistItems)
        .where(eq(schema.playlistItems.playlistId, p.id));
      out.push({ ...isoRow(p), itemCount: counts[0]?.n ?? 0 });
    }
    return { playlists: out };
  });

  app.post("/playlists", { preHandler: requireAdmin }, async (req, reply) => {
    const body = playlistSchema.parse(req.body);
    const [playlist] = await db
      .insert(schema.playlists)
      .values({
        name: body.name,
        description: body.description ?? null,
        artistSeparation: body.artistSeparation,
        trackSeparationMinutes: body.trackSeparationMinutes,
        shuffle: body.shuffle,
      })
      .returning();
    bumpProgrammingRevision();
    return reply.code(201).send({ playlist: isoRow(playlist) });
  });

  app.post("/playlists/generate", { preHandler: requireAdmin }, async (req, reply) => {
    const body = playlistGenerateSchema.parse(req.body);
    const musicConditions = [eq(schema.tracks.kind, "music"), eq(schema.tracks.isActive, true)];
    if (body.musicFolders.length > 0) musicConditions.push(inArray(schema.tracks.folder, body.musicFolders));
    const musicTracks = await db.select().from(schema.tracks).where(and(...musicConditions));
    if (musicTracks.length === 0) {
      return reply.code(400).send({ error: "No active music tracks matched the selected folder filters." });
    }

    const jingleConditions = [eq(schema.tracks.kind, "jingle"), eq(schema.tracks.isActive, true)];
    if (body.jingleFolder) jingleConditions.push(eq(schema.tracks.folder, body.jingleFolder));
    const jingleTracks = body.includeJingles ? await db.select().from(schema.tracks).where(and(...jingleConditions)) : [];

    const generated = buildGeneratedPlaylist({
      musicTracks,
      jingleTracks,
      targetSeconds: body.hours * 3600,
      includeJingles: body.includeJingles,
      jingleEvery: body.jingleEvery,
    });

    const [playlist] = await db
      .insert(schema.playlists)
      .values({
        name: body.name,
        description: body.description ?? null,
        artistSeparation: 3,
        trackSeparationMinutes: 30,
        shuffle: body.shuffle,
      })
      .returning();
    if (!playlist) return reply.code(500).send({ error: "Could not create playlist" });

    await db.insert(schema.playlistItems).values(
      generated.trackIds.map((trackId, index) => ({
        playlistId: playlist.id,
        trackId,
        position: index,
        weight: 1,
      })),
    );
    bumpProgrammingRevision();

    return reply.code(201).send({
      playlist: isoRow(playlist),
      itemCount: generated.trackIds.length,
      totalDurationSeconds: generated.totalDurationSeconds,
      warnings: generated.warnings,
    });
  });

  app.patch("/playlists/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = playlistPatchSchema.parse(req.body);
    const [playlist] = await db
      .update(schema.playlists)
      .set(body)
      .where(eq(schema.playlists.id, id))
      .returning();
    if (!playlist) return reply.code(404).send({ error: "Not found" });
    bumpProgrammingRevision();
    return { playlist: isoRow(playlist) };
  });

  app.delete("/playlists/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const totals = await db.select({ n: count() }).from(schema.playlists);
    const total = Number(totals[0]?.n ?? 0);
    if (total <= 1) {
      return reply.code(400).send({
        error: "Keep at least one playlist so AutoDJ still has a fallback music source. Set a default playlist in Settings.",
      });
    }
    await db
      .update(schema.settings)
      .set({ defaultPlaylistId: null })
      .where(eq(schema.settings.defaultPlaylistId, id));
    await db
      .update(schema.shows)
      .set({ playlistId: null })
      .where(eq(schema.shows.playlistId, id));
    await db
      .update(schema.clockwheelSlots)
      .set({ playlistId: null })
      .where(eq(schema.clockwheelSlots.playlistId, id));
    await db.delete(schema.playlists).where(eq(schema.playlists.id, id));
    bumpProgrammingRevision();
    return { ok: true };
  });

  /* ---------- items ---------- */

  app.get("/playlists/:id/items", { preHandler: authenticate }, async (req) => {
    const { id } = req.params as { id: string };
    const rows = await db
      .select({ item: schema.playlistItems, track: schema.tracks })
      .from(schema.playlistItems)
      .innerJoin(schema.tracks, eq(schema.playlistItems.trackId, schema.tracks.id))
      .where(eq(schema.playlistItems.playlistId, id))
      .orderBy(asc(schema.playlistItems.position));
    return {
      items: rows.map((r) => ({
        ...isoRow(r.item),
        track: isoRow(r.track),
      })),
    };
  });

  // Body: { trackIds: string[] } — appends tracks in order.
  app.post("/playlists/:id/items", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { trackIds: string[] };
    if (!Array.isArray(body.trackIds) || body.trackIds.length === 0) {
      return reply.code(400).send({ error: "trackIds required" });
    }
    const counts = await db
      .select({ m: max(schema.playlistItems.position) })
      .from(schema.playlistItems)
      .where(eq(schema.playlistItems.playlistId, id));
    const start = (counts[0]?.m ?? -1) + 1;
    await db.insert(schema.playlistItems).values(
      body.trackIds.map((trackId, i) => ({ playlistId: id, trackId, position: start + i, weight: 1 })),
    );
    bumpProgrammingRevision();
    return { ok: true };
  });

  app.delete("/playlists/:id/items/:itemId", { preHandler: requireAdmin }, async (req) => {
    const { id, itemId } = req.params as { id: string; itemId: string };
    await db
      .delete(schema.playlistItems)
      .where(and(eq(schema.playlistItems.id, itemId), eq(schema.playlistItems.playlistId, id)));
    bumpProgrammingRevision();
    return { ok: true };
  });

  // Reorder: { itemIds: string[] } — new order of items.
  app.put("/playlists/:id/items/order", { preHandler: requireAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { itemIds: string[] };
    if (!Array.isArray(body.itemIds)) return { ok: false };
    for (let i = 0; i < body.itemIds.length; i++) {
      await db
        .update(schema.playlistItems)
        .set({ position: i })
        .where(and(eq(schema.playlistItems.id, body.itemIds[i]!), eq(schema.playlistItems.playlistId, id)));
    }
    bumpProgrammingRevision();
    return { ok: true };
  });

  // Set weight (hot rotation): { itemId, weight }
  app.patch("/playlists/:id/items/:itemId", { preHandler: requireAdmin }, async (req, reply) => {
    const { id, itemId } = req.params as { id: string; itemId: string };
    const body = req.body as { weight?: number };
    const weight = Math.max(1, Math.min(20, Number(body.weight ?? 1)));
    const [item] = await db
      .update(schema.playlistItems)
      .set({ weight })
      .where(and(eq(schema.playlistItems.id, itemId), eq(schema.playlistItems.playlistId, id)))
      .returning();
    if (!item) return reply.code(404).send({ error: "Not found" });
    bumpProgrammingRevision();
    return { item: isoRow(item) };
  });
}

type TrackRow = typeof schema.tracks.$inferSelect;

function buildGeneratedPlaylist(input: {
  musicTracks: TrackRow[];
  jingleTracks: TrackRow[];
  targetSeconds: number;
  includeJingles: boolean;
  jingleEvery: number;
}): { trackIds: string[]; totalDurationSeconds: number; warnings: string[] } {
  const warnings: string[] = [];
  const trackIds: string[] = [];
  const musicCycle = createCycle(input.musicTracks);
  const jingleCycle = createCycle(input.jingleTracks);
  const shortestMusic = Math.min(...input.musicTracks.map((track) => track.durationSeconds));
  const toleranceSeconds = 90;
  let totalDurationSeconds = 0;
  let musicSinceJingle = 0;
  let guard = 0;

  if (input.includeJingles && input.jingleTracks.length === 0) {
    warnings.push("No jingles matched the selected jingle folder, so the generated playlist uses music only.");
  }

  while (guard < 20000 && totalDurationSeconds < input.targetSeconds) {
    guard++;
    const remaining = input.targetSeconds - totalDurationSeconds;

    if (input.includeJingles && input.jingleTracks.length > 0 && musicSinceJingle >= input.jingleEvery) {
      const jingle = nextFromCycle(jingleCycle);
      if (jingle && (totalDurationSeconds + jingle.durationSeconds <= input.targetSeconds + toleranceSeconds || totalDurationSeconds < input.targetSeconds * 0.9)) {
        trackIds.push(jingle.id);
        totalDurationSeconds += jingle.durationSeconds;
        musicSinceJingle = 0;
        continue;
      }
    }

    const musicTrack =
      remaining <= shortestMusic + toleranceSeconds
        ? bestFitTrack(input.musicTracks, remaining)
        : nextFromCycle(musicCycle);

    if (!musicTrack) break;
    if (trackIds.length > 0 && remaining < shortestMusic / 2 && totalDurationSeconds + musicTrack.durationSeconds > input.targetSeconds + toleranceSeconds) {
      break;
    }

    trackIds.push(musicTrack.id);
    totalDurationSeconds += musicTrack.durationSeconds;
    musicSinceJingle++;
  }

  if (guard >= 20000) {
    warnings.push("Playlist generation hit a safety limit before reaching the target length.");
  }

  return { trackIds, totalDurationSeconds, warnings };
}

function createCycle<T>(items: T[]): { order: T[]; index: number } {
  return { order: shuffle(items), index: 0 };
}

function nextFromCycle<T>(cycle: { order: T[]; index: number }): T | null {
  if (cycle.order.length === 0) return null;
  if (cycle.index >= cycle.order.length) {
    cycle.order = shuffle(cycle.order);
    cycle.index = 0;
  }
  const item = cycle.order[cycle.index] ?? null;
  cycle.index += 1;
  return item;
}

function bestFitTrack<T extends { durationSeconds: number }>(items: T[], remainingSeconds: number): T | null {
  if (items.length === 0) return null;
  let best = items[0]!;
  let bestDiff = Math.abs(best.durationSeconds - remainingSeconds);
  for (const item of items.slice(1)) {
    const diff = Math.abs(item.durationSeconds - remainingSeconds);
    if (diff < bestDiff) {
      best = item;
      bestDiff = diff;
    }
  }
  return best;
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
