import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { db, schema, isoRow } from "../db/client.js";
import { requireAdmin, verifyToken } from "../auth.js";
import { bumpProgrammingRevision } from "../services/engineState.js";
import { recordingPatchSchema } from "@radiohost/shared";

export function recordingRoutes(app: FastifyInstance): void {
  // Admin: list every recording with its show name, newest first.
  app.get("/recordings", { preHandler: requireAdmin }, async () => {
    const djRec = alias(schema.users, "dj_rec");
    const djOwner = alias(schema.users, "dj_owner");
    const rows = await db
      .select({ rec: schema.recordings, show: schema.shows, djRec, djOwner })
      .from(schema.recordings)
      .leftJoin(schema.shows, eq(schema.recordings.showId, schema.shows.id))
      .leftJoin(djRec, eq(schema.recordings.djId, djRec.id))
      .leftJoin(djOwner, eq(schema.shows.ownerId, djOwner.id))
      .orderBy(desc(schema.recordings.startedAt));
    return {
      recordings: rows.map(({ rec, show, djRec, djOwner }) => {
        const dj = djRec?.id ? djRec : djOwner?.id ? djOwner : null;
        return {
          ...isoRow(rec),
          showName: show?.name ?? null,
          djName: dj?.name ?? null,
          djAvatarUrl: dj?.avatarPath ? `/media/${basename(dj.avatarPath)}` : null,
        };
      }),
    };
  });

  // Admin: promote a recording into a replayable show. Creates a hidden media
  // item wrapping the recording audio, a show, and a one-item rundown, so the
  // show appears on the Shows page and can be scheduled to re-air. Idempotent:
  // if the recording is already linked to a show, that show is returned.
  app.post("/recordings/:id/create-show", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = await db.select().from(schema.recordings).where(eq(schema.recordings.id, id)).limit(1);
    const rec = rows[0];
    if (!rec) return reply.code(404).send({ error: "Recording not found" });

    // Idempotent: if this recording's audio already backs a promoted show, return it.
    const existingTrack = await db
      .select()
      .from(schema.tracks)
      .where(and(eq(schema.tracks.kind, "recording"), eq(schema.tracks.filePath, rec.filePath)))
      .limit(1);
    const existingTrackRow = existingTrack[0];
    if (existingTrackRow) {
      const link = await db
        .select({ showId: schema.rundownItems.showId })
        .from(schema.rundownItems)
        .where(eq(schema.rundownItems.trackId, existingTrackRow.id))
        .limit(1);
      const linkRow = link[0];
      if (linkRow) {
        const show = await db.select().from(schema.shows).where(eq(schema.shows.id, linkRow.showId)).limit(1);
        if (show[0]) return { show: isoRow(show[0]), created: false };
      }
    }

    const title = (rec.title || "").trim() || "Recorded show";
    const created = await db.transaction(async (tx) => {
      const [track] = await tx
        .insert(schema.tracks)
        .values({
          title,
          artist: "",
          album: "",
          folder: null,
          kind: "recording",
          durationSeconds: rec.durationSeconds,
          filePath: rec.filePath,
          mime: "audio/mpeg",
          codec: "mp3",
          loudnessGainDb: 0,
          isActive: true,
        })
        .returning();
      const [show] = await tx
        .insert(schema.shows)
        .values({
          ownerId: null,
          name: title,
          description: "Recorded show — replays a past broadcast.",
          color: "#8b5cf6",
          presenters: "",
          playlistId: null,
          clockwheelId: null,
        })
        .returning();
      if (!track || !show) throw new Error("Could not create the show");
      await tx
        .insert(schema.rundownItems)
        .values({ showId: show.id, position: 0, kind: "track", trackId: track.id, voiceTrackId: null });
      // Link the recording to the new show only when it had none, so an existing
      // Listen Again grouping (a scheduled show's own recording) is preserved.
      if (!rec.showId) {
        await tx.update(schema.recordings).set({ showId: show.id }).where(eq(schema.recordings.id, rec.id));
      }
      return { show, track };
    });

    bumpProgrammingRevision();
    return reply.code(201).send({ show: isoRow(created.show), created: true });
  });

  // Admin: stream a recording's audio (range requests supported). The JWT may
  // come via the Authorization header or a ?token= query param, so the plain
  // <audio> element in the dashboard can authenticate (same pattern as /ws).
  app.get("/recordings/:id/audio", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { token?: string };
    const user = req.user ?? (q.token ? await verifyToken(q.token) : null);
    if (!user || user.role !== "admin") return reply.code(401).send({ error: "Unauthorized" });
    const rows = await db.select().from(schema.recordings).where(eq(schema.recordings.id, id)).limit(1);
    const rec = rows[0];
    if (!rec) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile(basename(rec.filePath), dirname(rec.filePath));
  });

  // Admin: rename a recording or toggle podcast visibility.
  app.patch("/recordings/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = recordingPatchSchema.parse(req.body);
    const patch: Record<string, unknown> = {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.isPodcast !== undefined) patch.isPodcast = body.isPodcast;
    if (body.djId !== undefined) patch.djId = body.djId;
    const [rec] = await db
      .update(schema.recordings)
      .set(patch)
      .where(eq(schema.recordings.id, id))
      .returning();
    if (!rec) return reply.code(404).send({ error: "Not found" });
    return { recording: isoRow(rec) };
  });

  // Admin: delete a recording (database row + audio file).
  app.delete("/recordings/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = await db.select().from(schema.recordings).where(eq(schema.recordings.id, id)).limit(1);
    const rec = rows[0];
    if (!rec) return reply.code(404).send({ error: "Not found" });
    await db.delete(schema.recordings).where(eq(schema.recordings.id, id));
    try {
      await unlink(rec.filePath);
    } catch {
      // File already gone — removing the row is the important part.
    }
    return { ok: true };
  });
}
