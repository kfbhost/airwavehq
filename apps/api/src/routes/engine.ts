import type { FastifyInstance } from "fastify";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { db, schema, isoRow } from "../db/client.js";
import { requireEngine } from "../auth.js";
import { computeNextSequence, nextBreakTime, resolveProgrammingContext } from "../services/scheduler.js";
import { getEngineRestartRequestedAt, getProgrammingRevision, setStatus, snapshot, setCurrentShow, setCurrentItemStartedAt } from "../services/engineState.js";
import { recordListenerSnapshot } from "../services/listenerPresence.js";
import { emitEvent } from "../services/webhooks.js";
import type { EnginePlayEvent, EngineStatus } from "@radiohost/shared";
import { zonedParts } from "@radiohost/shared";

export function engineRoutes(app: FastifyInstance): void {
  app.get("/engine/next", { preHandler: requireEngine }, async (req) => {
    const q = req.query as { after?: string; count?: string };
    const after = Number(q.after ?? Date.now());
    const count = Math.min(24, Math.max(1, Number(q.count ?? 8) || 8));
    const at = Number.isFinite(after) ? after : Date.now();
    const [sequence, ctx] = await Promise.all([
      computeNextSequence(at, count),
      resolveProgrammingContext(at),
    ]);

    setCurrentShow(ctx.showId, ctx.showName);

    // Track the current show for recording timing basics.
    const settings = await db.select().from(schema.settings).where(eq(schema.settings.id, 1)).limit(1);
    const tz = settings[0]?.timezone || "UTC";

    return { ...sequence, nextBreak: nextBreakTime(at, tz) };
  });

  // Engine reports play events (start and end share the same playId; upsert).
  app.post("/engine/play-log", { preHandler: requireEngine }, async (req) => {
    const body = req.body as { events: EnginePlayEvent[] };
    if (!body || !Array.isArray(body.events)) return { ok: false };
    const applied: string[] = [];

    for (const ev of body.events) {
      const existing = await db
        .select()
        .from(schema.playLog)
        .where(eq(schema.playLog.playId, ev.playId))
        .limit(1);
      const row = existing[0];
      const isEnd = Boolean(ev.endedAt);

      if (row) {
        // Update end-of-play fields (idempotent).
        await db
          .update(schema.playLog)
          .set({
            endedAt: ev.endedAt ? new Date(ev.endedAt) : row.endedAt,
            durationSeconds: ev.durationSeconds || row.durationSeconds,
            listenersAtEnd: ev.listenersAtEnd ?? row.listenersAtEnd,
          })
          .where(eq(schema.playLog.playId, ev.playId));
        if (!ev.endedAt) setCurrentItemStartedAt(ev.startedAt);
        if (isEnd && row.trackId && !row.endedAt) {
          await touchTrack(row.trackId, ev.startedAt);
        }
        if (isEnd && ev.source === "ad" && ev.campaignId && ev.trackId) {
          await confirmAiring(ev);
        }
      } else {
        if (!ev.endedAt) setCurrentItemStartedAt(ev.startedAt);
        const [inserted] = await db
          .insert(schema.playLog)
          .values({
            playId: ev.playId,
            trackId: ev.trackId,
            title: ev.title,
            artist: ev.artist,
            startedAt: new Date(ev.startedAt),
            endedAt: ev.endedAt ? new Date(ev.endedAt) : null,
            durationSeconds: ev.durationSeconds,
            source: ev.source,
            listenersAtStart: ev.listenersAtStart ?? null,
            listenersAtEnd: ev.listenersAtEnd ?? null,
            showId: ev.showId,
            campaignId: ev.campaignId,
            voiceTrackId: ev.voiceTrackId,
          })
          .returning();
        applied.push(inserted?.id ?? "");
        if (ev.endedAt) {
          if (ev.trackId) await touchTrack(ev.trackId, ev.startedAt);
          if (ev.source === "ad" && ev.campaignId && ev.trackId) await confirmAiring(ev);
        }
        if (!ev.endedAt) {
          await emitEvent("track.start", { trackId: ev.trackId, title: ev.title, artist: ev.artist, at: ev.startedAt, showId: ev.showId });
        } else {
          await emitEvent("track.end", { trackId: ev.trackId, title: ev.title, artist: ev.artist, at: ev.endedAt, showId: ev.showId });
        }
      }

      // Approved request played.
      if (isEnd && ev.trackId) {
        await db
          .update(schema.requests)
          .set({ status: "played", playedAt: new Date(ev.startedAt) })
          .where(and(eq(schema.requests.trackId, ev.trackId), eq(schema.requests.status, "approved")));
      }
    }

    return { ok: true, applied: applied.length };
  });

  app.post("/engine/status", { preHandler: requireEngine }, async (req) => {
    const body = req.body as EngineStatus;
    const prev = snapshot();
    const prevMode = prev.status.mode;
    setStatus(body);
    await recordListenerSnapshot(body.listeners);

    if (prevMode !== body.mode) {
      if (body.mode === "live") {
        await emitEvent("live.on", { dj: body.liveDjName });
      } else if (prevMode === "live") {
        await emitEvent("live.off", { dj: prev.status.liveDjName });
      }
    }
    return { ok: true };
  });

  app.post("/engine/recording-complete", { preHandler: requireEngine }, async (req) => {
    const body = req.body as { showId: string | null; djId?: string | null; title: string; startedAt: string; endedAt: string; filePath: string; durationSeconds: number };
    if (!body) return { ok: false };
    // Attribute the recording to a DJ: prefer the id the engine sent (live set),
    // otherwise fall back to the scheduled show's owner.
    let djId = body.djId ?? null;
    if (!djId && body.showId) {
      const rows = await db.select({ ownerId: schema.shows.ownerId }).from(schema.shows).where(eq(schema.shows.id, body.showId)).limit(1);
      djId = rows[0]?.ownerId ?? null;
    }
    const [rec] = await db
      .insert(schema.recordings)
      .values({
        showId: body.showId,
        djId,
        title: body.title,
        startedAt: new Date(body.startedAt),
        endedAt: new Date(body.endedAt),
        filePath: body.filePath,
        durationSeconds: body.durationSeconds,
        isPodcast: true,
      })
      .returning();
    return { ok: true, recording: isoRow(rec) };
  });

  // What the engine needs to know: current recording target + timing basics.
  app.get("/engine/config", { preHandler: requireEngine }, async () => {
    const settings = await db.select().from(schema.settings).where(eq(schema.settings.id, 1)).limit(1);
    const s = settings[0];
    if (!s) return { record: null };
    const now = Date.now();
    const p = zonedParts(now, s.timezone || "UTC");
    // Active recording must match BOTH the time window AND the day of week
    // (mirroring scheduler resolveContext), otherwise a Friday-only show can
    // start a bogus recording on any other day that shares its minute range.
    const entries = await db
      .select()
      .from(schema.scheduleEntries)
      .where(and(lte(schema.scheduleEntries.startMinutes, p.minutesOfDay)))
      .orderBy(schema.scheduleEntries.startMinutes);
    const active = entries.find(
      (e) =>
        p.minutesOfDay < e.endMinutes &&
        (e.dayOfWeek === null || e.dayOfWeek === p.dayOfWeek),
    );
    let record = null;
    if (s.recordShows && active) {
      const shows = await db.select().from(schema.shows).where(eq(schema.shows.id, active.showId)).limit(1);
      if (shows[0]) {
        record = { showId: shows[0].id, title: shows[0].name, startedAt: new Date(now).toISOString() };
      }
    }
    return {
      record,
      recordShows: s.recordShows,
      timezone: s.timezone || "UTC",
      crossfadeMs: s.crossfadeMs,
      bitrate: s.streamBitrate,
      processingPreset: s.audioProcessingPreset || "radio",
      nextBreak: nextBreakTime(now, s.timezone || "UTC"),
      programmingRevision: getProgrammingRevision(),
      engineRestartRequestedAt: getEngineRestartRequestedAt(),
    };
  });
}

async function touchTrack(trackId: string, startedAt: string): Promise<void> {
  await db
    .update(schema.tracks)
    .set({
      playCount: sql`play_count + 1`,
      lastPlayedAt: new Date(startedAt),
    })
    .where(eq(schema.tracks.id, trackId));
}

async function confirmAiring(ev: EnginePlayEvent): Promise<void> {
  const start = new Date(ev.startedAt);
  const airings = await db
    .select()
    .from(schema.adAirings)
    .where(
      and(
        eq(schema.adAirings.campaignId, ev.campaignId!),
        eq(schema.adAirings.trackId, ev.trackId!),
        gte(schema.adAirings.scheduledFor, new Date(start.getTime() - 120_000)),
        lte(schema.adAirings.scheduledFor, new Date(start.getTime() + 120_000)),
      ),
    )
    .limit(1);
  const airing = airings[0];
  if (airing && !airing.confirmed) {
    await db
      .update(schema.adAirings)
      .set({
        airedAt: start,
        listeners: ev.listenersAtStart ?? ev.listenersAtEnd ?? airing.listeners,
        confirmed: true,
      })
      .where(eq(schema.adAirings.id, airing.id));
    await emitEvent("campaign.airing", {
      campaignId: ev.campaignId,
      trackId: ev.trackId,
      airedAt: ev.startedAt,
      listeners: ev.listenersAtStart ?? ev.listenersAtEnd ?? null,
    });
  }
}
