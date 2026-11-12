import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { db, schema, isoRow } from "../db/client.js";
import { authenticate, requireAdmin } from "../auth.js";
import { bumpProgrammingRevision } from "../services/engineState.js";
import { probeAudio, scanLoudness } from "../services/ffprobe.js";
import { describeRotationWindow, describeScheduleWindow, findRotationConflict, findScheduleConflict } from "../services/scheduleConflicts.js";
import { config } from "../config.js";
import {
  clockwheelSchema,
  clockSlotSchema,
  showSchema,
  showPatchSchema,
  scheduleEntrySchema,
  djSlotSchema,
  djSlotPatchSchema,
  voiceTrackSchema,
  rundownItemSchema,
  rundownAutoSchema,
  VOICE_LINK_OVERLAP_IN_MS,
  VOICE_LINK_OVERLAP_OUT_MS,
  VOICE_SLOT_ESTIMATE_SEC,
  SHOW_OVERRUN_TARGET_SEC,
  zonedParts,
  zonedMidnight,
} from "@airwavehq/shared";

export function programmingRoutes(app: FastifyInstance): void {
  async function deleteShowVoiceArchive(showId: string): Promise<void> {
    const voices = await db.select().from(schema.voiceTracks).where(eq(schema.voiceTracks.showId, showId));
    if (voices.length === 0) return;
    await db.delete(schema.voiceTracks).where(eq(schema.voiceTracks.showId, showId));
    await Promise.all(voices.map((voice) => unlink(voice.filePath).catch(() => {})));
  }

  async function isShowAccessible(showId: string, user: { sub: string; role: "admin" | "dj" }): Promise<boolean> {
    const rows = await db
      .select({ ownerId: schema.shows.ownerId })
      .from(schema.shows)
      .where(eq(schema.shows.id, showId))
      .limit(1);
    const show = rows[0];
    return !!show && (user.role === "admin" || show.ownerId === user.sub);
  }

  async function isRundownItemAccessible(itemId: string, user: { sub: string; role: "admin" | "dj" }): Promise<boolean> {
    const rows = await db
      .select({ showId: schema.rundownItems.showId })
      .from(schema.rundownItems)
      .where(eq(schema.rundownItems.id, itemId))
      .limit(1);
    const item = rows[0];
    return !!item && await isShowAccessible(item.showId, user);
  }

  async function validateDjScheduleSlot(
    candidate: { dayOfWeek: number | null; startMinutes: number; endMinutes: number },
    djId: string,
  ): Promise<boolean> {
    const slots = await db
      .select()
      .from(schema.djSlots)
      .where(eq(schema.djSlots.djId, djId));
    return slots.some((slot) =>
      (slot.dayOfWeek === null || slot.dayOfWeek === candidate.dayOfWeek) &&
      slot.startMinutes <= candidate.startMinutes &&
      slot.endMinutes >= candidate.endMinutes,
    );
  }

  async function validateScheduleConflict(
    candidate: { dayOfWeek: number | null; startMinutes: number; endMinutes: number },
    excludeId?: string,
  ): Promise<string | null> {
    const [entries, rotations] = await Promise.all([
      db
        .select({ entry: schema.scheduleEntries, show: schema.shows })
        .from(schema.scheduleEntries)
        .innerJoin(schema.shows, eq(schema.scheduleEntries.showId, schema.shows.id)),
      db.select().from(schema.stationRotations),
    ]);

    const scheduleConflict = findScheduleConflict(
      candidate,
      entries.map((row) => ({
        id: row.entry.id,
        dayOfWeek: row.entry.dayOfWeek,
        startMinutes: row.entry.startMinutes,
        endMinutes: row.entry.endMinutes,
        showName: row.show.name,
      })),
      excludeId,
    );
    if (scheduleConflict) {
      return `That time already has the show "${scheduleConflict.showName}" scheduled (${describeScheduleWindow(scheduleConflict)}).`;
    }

    const rotationConflict = findRotationConflict(
      candidate,
      rotations.map((rotation) => ({
        id: rotation.id,
        dayOfWeek: rotation.dayOfWeek,
        startHour: rotation.startHour,
        endHour: rotation.endHour,
        name: rotation.name,
        isActive: rotation.isActive,
      })),
    );
    if (rotationConflict) {
      return `That time already has the rotation "${rotationConflict.name}" set up (${describeRotationWindow(rotationConflict)}).`;
    }

    return null;
  }

  /* ---------------- Clockwheels ---------------- */

  app.get("/clockwheels", { preHandler: authenticate }, async () => {
    const clockwheels = await db
      .select()
      .from(schema.clockwheels)
      .orderBy(schema.clockwheels.createdAt);
    return { clockwheels: clockwheels.map(isoRow) };
  });

  app.post("/clockwheels", { preHandler: requireAdmin }, async (req, reply) => {
    const body = clockwheelSchema.parse(req.body);
    const [clockwheel] = await db
      .insert(schema.clockwheels)
      .values({ name: body.name })
      .returning();
    bumpProgrammingRevision();
    return reply.code(201).send({ clockwheel: isoRow(clockwheel) });
  });

  app.patch("/clockwheels/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = clockwheelSchema.parse(req.body);
    const [clockwheel] = await db
      .update(schema.clockwheels)
      .set({ name: body.name })
      .where(eq(schema.clockwheels.id, id))
      .returning();
    if (!clockwheel) return reply.code(404).send({ error: "Not found" });
    bumpProgrammingRevision();
    return { clockwheel: isoRow(clockwheel) };
  });

  app.delete("/clockwheels/:id", { preHandler: requireAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    await db
      .update(schema.settings)
      .set({ defaultClockwheelId: null })
      .where(eq(schema.settings.defaultClockwheelId, id));
    await db
      .update(schema.shows)
      .set({ clockwheelId: null })
      .where(eq(schema.shows.clockwheelId, id));
    await db
      .update(schema.stationRotations)
      .set({ clockwheelId: null })
      .where(eq(schema.stationRotations.clockwheelId, id));
    await db.delete(schema.clockwheels).where(eq(schema.clockwheels.id, id));
    bumpProgrammingRevision();
    return { ok: true };
  });

  app.get("/clockwheels/:id/slots", { preHandler: authenticate }, async (req) => {
    const { id } = req.params as { id: string };
    const slots = await db
      .select()
      .from(schema.clockwheelSlots)
      .where(eq(schema.clockwheelSlots.clockwheelId, id))
      .orderBy(asc(schema.clockwheelSlots.position));
    return { slots: slots.map(isoRow) };
  });

  app.post("/clockwheels/:id/slots", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = clockSlotSchema.parse(req.body);
    const [slot] = await db
      .insert(schema.clockwheelSlots)
      .values({
        clockwheelId: id,
        position: body.position,
        type: body.type,
        playlistId: body.playlistId ?? null,
        trackId: body.trackId ?? null,
        label: body.label ?? null,
        durationSeconds: body.durationSeconds ?? null,
      })
      .returning();
    bumpProgrammingRevision();
    return reply.code(201).send({ slot: isoRow(slot) });
  });

  app.patch("/clockwheels/:id/slots/:slotId", { preHandler: requireAdmin }, async (req, reply) => {
    const { id, slotId } = req.params as { id: string; slotId: string };
    const body = clockSlotSchema.partial().parse(req.body);
    const [slot] = await db
      .update(schema.clockwheelSlots)
      .set(body)
      .where(and(eq(schema.clockwheelSlots.id, slotId), eq(schema.clockwheelSlots.clockwheelId, id)))
      .returning();
    if (!slot) return reply.code(404).send({ error: "Not found" });
    bumpProgrammingRevision();
    return { slot: isoRow(slot) };
  });

  app.delete("/clockwheels/:id/slots/:slotId", { preHandler: requireAdmin }, async (req) => {
    const { id, slotId } = req.params as { id: string; slotId: string };
    await db
      .delete(schema.clockwheelSlots)
      .where(and(eq(schema.clockwheelSlots.id, slotId), eq(schema.clockwheelSlots.clockwheelId, id)));
    bumpProgrammingRevision();
    return { ok: true };
  });

  /* ---------------- DJ show slots ---------------- */

  app.get("/dj-slots/current", { preHandler: authenticate }, async (req, reply) => {
    if (req.user!.role !== "dj") return reply.code(403).send({ error: "DJ slot verification unavailable" });
    const settings = await db.select({ timezone: schema.settings.timezone }).from(schema.settings).where(eq(schema.settings.id, 1)).limit(1);
    const now = zonedParts(Date.now(), settings[0]?.timezone || "UTC");
    const day = now.dayOfWeek;
    const minutes = now.minutesOfDay;
    const rows = await db
      .select({ slot: schema.djSlots, show: schema.shows })
      .from(schema.djSlots)
      .leftJoin(schema.shows, eq(schema.djSlots.showId, schema.shows.id))
      .where(and(eq(schema.djSlots.djId, req.user!.sub), or(eq(schema.djSlots.dayOfWeek, day), isNull(schema.djSlots.dayOfWeek)), lte(schema.djSlots.startMinutes, minutes), gte(schema.djSlots.endMinutes, minutes + 1)))
      .orderBy(asc(schema.djSlots.startMinutes));
    const active = rows[0];
    if (!active) return reply.code(403).send({ ok: false, showName: null, showId: null, reason: "No DJ slot is active right now" });
    return { ok: true, showName: active.show?.name ?? null, showId: active.slot.showId ?? null, slotId: active.slot.id };
  });

  app.get("/dj-slots", { preHandler: authenticate }, async (req) => {
    const slots = await db
      .select({ slot: schema.djSlots, dj: schema.users, show: schema.shows })
      .from(schema.djSlots)
      .innerJoin(schema.users, eq(schema.djSlots.djId, schema.users.id))
      .leftJoin(schema.shows, eq(schema.djSlots.showId, schema.shows.id))
      .where(req.user!.role === "admin" ? undefined : eq(schema.djSlots.djId, req.user!.sub))
      .orderBy(asc(schema.djSlots.dayOfWeek), asc(schema.djSlots.startMinutes));
    return { slots: slots.map((r) => ({ ...isoRow(r.slot), dj: { id: r.dj.id, name: r.dj.name, email: r.dj.email }, show: r.show ? isoRow(r.show) : null })) };
  });

  app.post("/dj-slots", { preHandler: requireAdmin }, async (req, reply) => {
    const body = djSlotSchema.parse(req.body);
    const dj = await db.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.id, body.djId), eq(schema.users.role, "dj"))).limit(1);
    if (!dj[0]) return reply.code(400).send({ error: "DJ account not found" });
    if (body.showId && !(await isShowAccessible(body.showId, { sub: req.user!.sub, role: "admin" }))) return reply.code(404).send({ error: "Show not found" });
    const [slot] = await db.insert(schema.djSlots).values({
      djId: body.djId,
      showId: body.showId ?? null,
      dayOfWeek: body.dayOfWeek,
      startMinutes: body.startMinutes,
      endMinutes: body.endMinutes,
    }).returning();
    bumpProgrammingRevision();
    return reply.code(201).send({ slot: isoRow(slot) });
  });

  app.patch("/dj-slots/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = djSlotPatchSchema.parse(req.body);
    const [slot] = await db.update(schema.djSlots).set({ ...body, updatedAt: new Date() }).where(eq(schema.djSlots.id, id)).returning();
    if (!slot) return reply.code(404).send({ error: "Slot not found" });
    bumpProgrammingRevision();
    return { slot: isoRow(slot) };
  });

  app.delete("/dj-slots/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = await db.delete(schema.djSlots).where(eq(schema.djSlots.id, id)).returning({ id: schema.djSlots.id });
    if (deleted.length === 0) return reply.code(404).send({ error: "Slot not found" });
    bumpProgrammingRevision();
    return { ok: true };
  });

  /* ---------------- Shows ---------------- */

  app.get("/shows", { preHandler: authenticate }, async (req) => {
    const shows = await db
      .select()
      .from(schema.shows)
      .where(req.user!.role === "admin" ? undefined : eq(schema.shows.ownerId, req.user!.sub))
      .orderBy(schema.shows.createdAt);
    const showIds = shows.map((s) => s.id);
    const items = showIds.length
      ? await db
          .select({
            showId: schema.rundownItems.showId,
            dur: sql<number>`coalesce(${schema.tracks.durationSeconds}, ${schema.voiceTracks.durationSeconds}, 0)`,
            trackKind: schema.tracks.kind,
          })
          .from(schema.rundownItems)
          .leftJoin(schema.tracks, eq(schema.rundownItems.trackId, schema.tracks.id))
          .leftJoin(schema.voiceTracks, eq(schema.rundownItems.voiceTrackId, schema.voiceTracks.id))
          .where(inArray(schema.rundownItems.showId, showIds))
      : [];
    const durByShow = new Map<string, number>();
    const recordedByShow = new Set<string>();
    for (const it of items) {
      durByShow.set(it.showId, (durByShow.get(it.showId) ?? 0) + Number(it.dur || 0));
      if (it.trackKind === "recording") recordedByShow.add(it.showId);
    }
    return {
      shows: shows.map((s) => ({
        ...isoRow(s),
        plannedDurationSec: Math.round(durByShow.get(s.id) ?? 0),
        isRecorded: recordedByShow.has(s.id),
      })),
    };
  });

  // Dashboard view of every show: whether it has been built in the Show
  // Builder (rundown item count) and its next scheduled air slot.
  app.get("/shows/dashboard", { preHandler: authenticate }, async (req) => {
    const tzRow = await db
      .select({ timezone: schema.settings.timezone })
      .from(schema.settings)
      .where(eq(schema.settings.id, 1))
      .limit(1);
    const tz = tzRow[0]?.timezone || "UTC";
    const now = Date.now();

    const showRows = await db
      .select()
      .from(schema.shows)
      .where(req.user!.role === "admin" ? undefined : eq(schema.shows.ownerId, req.user!.sub))
      .orderBy(desc(schema.shows.createdAt));
    const showIds = showRows.map((s) => s.id);

    const [rundownRows, entryRows] = await Promise.all([
      showIds.length
        ? db
            .select({ showId: schema.rundownItems.showId, count: sql<number>`count(*)::int` })
            .from(schema.rundownItems)
            .where(inArray(schema.rundownItems.showId, showIds))
            .groupBy(schema.rundownItems.showId)
        : Promise.resolve([]),
      showIds.length
        ? db
            .select()
            .from(schema.scheduleEntries)
            .where(inArray(schema.scheduleEntries.showId, showIds))
        : Promise.resolve([]),
    ]);

    const countByShow = new Map(rundownRows.map((r) => [r.showId, r.count]));
    const entriesByShow = new Map<string, typeof entryRows>();
    for (const e of entryRows) {
      const arr = entriesByShow.get(e.showId) ?? [];
      arr.push(e);
      entriesByShow.set(e.showId, arr);
    }

    const base = zonedParts(now, tz);
    const nextAirFor = (entries: typeof entryRows) => {
      let best: { startMs: number; endMinutes: number; startMinutes: number; dayOfWeek: number | null } | null = null;
      for (const e of entries) {
        for (let d = 0; d <= 7; d++) {
          const dt = new Date(Date.UTC(base.year, base.month - 1, base.day + d));
          const dow = dt.getUTCDay();
          if (e.dayOfWeek !== null && dow !== e.dayOfWeek) continue;
          const startMs = zonedMidnight(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), tz) + e.startMinutes * 60_000;
          if (startMs <= now) continue;
          if (!best || startMs < best.startMs) {
            best = { startMs, endMinutes: e.endMinutes, startMinutes: e.startMinutes, dayOfWeek: e.dayOfWeek };
          }
          break;
        }
      }
      return best;
    };

    const shows = showRows.map((s) => {
      const count = countByShow.get(s.id) ?? 0;
      const next = nextAirFor(entriesByShow.get(s.id) ?? []);
      return {
        ...isoRow(s),
        rundownCount: count,
        built: count > 0,
        nextAir: next
          ? {
              startIso: new Date(next.startMs).toISOString(),
              endIso: new Date(next.startMs + (next.endMinutes - next.startMinutes) * 60_000).toISOString(),
              dayOfWeek: next.dayOfWeek,
              startMinutes: next.startMinutes,
              endMinutes: next.endMinutes,
            }
          : null,
      };
    });

    return { shows, timezone: tz };
  });

  app.post("/shows", { preHandler: authenticate }, async (req, reply) => {
    if (req.user!.role === "dj") {
      const slots = await db.select({ id: schema.djSlots.id }).from(schema.djSlots).where(eq(schema.djSlots.djId, req.user!.sub)).limit(1);
      if (slots.length === 0) return reply.code(403).send({ error: "Your administrator must allocate a show slot before you can create a show." });
    }
    const body = showSchema.parse(req.body);
    const [show] = await db
      .insert(schema.shows)
      .values({
        ownerId: req.user!.role === "admin" ? null : req.user!.sub,
        name: body.name,
        description: body.description ?? null,
        color: body.color,
        imagePath: body.imagePath ?? null,
        playlistId: body.playlistId ?? null,
        clockwheelId: body.clockwheelId ?? null,
        presenters: body.presenters ?? "",
      })
      .returning();
    bumpProgrammingRevision();
    return reply.code(201).send({ show: isoRow(show) });
  });

  app.patch("/shows/:id", { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = showPatchSchema.parse(req.body);
    const [show] = await db
      .update(schema.shows)
      .set(body)
      .where(req.user!.role === "admin"
        ? eq(schema.shows.id, id)
        : and(eq(schema.shows.id, id), eq(schema.shows.ownerId, req.user!.sub)))
      .returning();
    if (!show) return reply.code(404).send({ error: "Not found" });
    bumpProgrammingRevision();
    return { show: isoRow(show) };
  });

  app.delete("/shows/:id", { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = await db
      .delete(schema.shows)
      .where(req.user!.role === "admin"
        ? eq(schema.shows.id, id)
        : and(eq(schema.shows.id, id), eq(schema.shows.ownerId, req.user!.sub)))
      .returning({ id: schema.shows.id });
    if (deleted.length === 0) return reply.code(404).send({ error: "Show not found" });
    await deleteShowVoiceArchive(id);
    bumpProgrammingRevision();
    return { ok: true };
  });

  /* ---------------- Show rundowns (pre-produced voice-tracked shows) ---------------- */

  app.get("/shows/:id/rundown", { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await isShowAccessible(id, req.user!))) return reply.code(404).send({ error: "Show not found" });
    const rows = await db
      .select()
      .from(schema.rundownItems)
      .where(eq(schema.rundownItems.showId, id))
      .orderBy(asc(schema.rundownItems.position));
    const trackIds = rows.filter((r) => r.kind === "track" && r.trackId).map((r) => r.trackId!) as string[];
    const voiceIds = rows.filter((r) => r.kind === "voice" && r.voiceTrackId).map((r) => r.voiceTrackId!) as string[];
    const [tracks, voices] = await Promise.all([
      trackIds.length > 0 ? db.select().from(schema.tracks).where(inArray(schema.tracks.id, trackIds)) : Promise.resolve([]),
      voiceIds.length > 0 ? db.select().from(schema.voiceTracks).where(inArray(schema.voiceTracks.id, voiceIds)) : Promise.resolve([]),
    ]);
    const tById = new Map(tracks.map((t) => [t.id, t]));
    const vById = new Map(voices.map((v) => [v.id, v]));
    const items = rows.map((r) => ({
      ...isoRow(r),
      track: r.trackId && tById.get(r.trackId)
        ? { id: r.trackId, title: tById.get(r.trackId)!.title, artist: tById.get(r.trackId)!.artist, durationSeconds: tById.get(r.trackId)!.durationSeconds, kind: tById.get(r.trackId)!.kind, filePath: tById.get(r.trackId)!.filePath }
        : null,
      voice: r.voiceTrackId && vById.get(r.voiceTrackId)
        ? { id: r.voiceTrackId, title: vById.get(r.voiceTrackId)!.title, durationSeconds: vById.get(r.voiceTrackId)!.durationSeconds }
        : null,
    }));
    return { items };
  });

  app.post("/shows/:id/rundown", { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await isShowAccessible(id, req.user!))) return reply.code(404).send({ error: "Show not found" });
    const body = rundownItemSchema.parse(req.body);
    if (body.kind === "track" && !body.trackId) return reply.code(400).send({ error: "trackId is required for a track item" });
    const rows = await db
      .select({ id: schema.rundownItems.id, position: schema.rundownItems.position })
      .from(schema.rundownItems)
      .where(eq(schema.rundownItems.showId, id))
      .orderBy(asc(schema.rundownItems.position));
    const insertAt = Math.max(0, Math.min(body.position ?? rows.length, rows.length));
    const position = rows[insertAt]?.position ?? ((rows.at(-1)?.position ?? -1) + 1);

    if (insertAt < rows.length) {
      await db
        .update(schema.rundownItems)
        .set({ position: sql`${schema.rundownItems.position} + 1` })
        .where(and(eq(schema.rundownItems.showId, id), sql`${schema.rundownItems.position} >= ${position}`));
    }

    const [item] = await db
      .insert(schema.rundownItems)
      .values({
        showId: id,
        position,
        kind: body.kind,
        trackId: body.kind === "track" ? body.trackId ?? null : null,
        voiceTrackId: body.kind === "voice" ? body.voiceTrackId ?? null : null,
      })
      .returning();
    bumpProgrammingRevision();
    return reply.code(201).send({ item: isoRow(item) });
  });

  // Auto-build a rundown: fill a target-length show from a genre folder,
  // with blank voice slots spaced through it for the DJ to record into.
  app.post("/shows/:id/rundown/auto", { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await isShowAccessible(id, req.user!))) return reply.code(404).send({ error: "Show not found" });
    const body = rundownAutoSchema.parse(req.body);

    const folder = body.folder && body.folder !== "" ? body.folder : null;
    const where = and(
      eq(schema.tracks.kind, "music"),
      eq(schema.tracks.isActive, true),
      folder === "unfiled" ? isNull(schema.tracks.folder) : folder ? eq(schema.tracks.folder, folder) : undefined,
    );
    const rows = await db.select().from(schema.tracks).where(where);
    if (rows.length === 0) {
      return reply.code(400).send({ error: folder && folder !== "unfiled" ? `No music tracks in the "${folder}" folder.` : "No music tracks available." });
    }

    // Shuffle in JS so the same pick never repeats run to run.
    const pool = [...rows].sort(() => Math.random() - 0.5);
    const overlapSec = (VOICE_LINK_OVERLAP_IN_MS + VOICE_LINK_OVERLAP_OUT_MS) / 1000;
    // Aim slightly OVER the requested length so the last track always fades into
    // the top-of-hour jingle, and so blank/short voice links never leave the
    // show short of its slot (the fade covers the final few seconds on air).
    const targetSec = body.targetMinutes * 60 + SHOW_OVERRUN_TARGET_SEC;
    const maxTracks = Math.min(pool.length, 80);

    // aired(T) mirrors the dashboard: sum of track durations plus the 15s
    // voice-slot rule, minus the crossfade overlap each slot pulls out of its
    // neighbours — so the built hour lands on time once links are recorded.
    const aired = (t: number) => {
      const music = pool.slice(0, t).reduce((acc, tr) => acc + (tr.durationSeconds || 0), 0);
      const voices = t > 0 ? Math.floor((t - 1) / body.voiceEvery) : 0;
      return music + voices * VOICE_SLOT_ESTIMATE_SEC - voices * overlapSec;
    };
    let bestT = 1;
    let bestDelta = Infinity;
    for (let t = 1; t <= maxTracks; t++) {
      const delta = Math.abs(aired(t) - targetSec);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestT = t;
      }
    }
    const chosen = pool.slice(0, bestT);
    const musicSeconds = chosen.reduce((acc, tr) => acc + (tr.durationSeconds || 0), 0);
    const voiceCount = bestT > 0 ? Math.floor((bestT - 1) / body.voiceEvery) : 0;

    const values: Array<{ showId: string; position: number; kind: "track" | "voice"; trackId: string | null; voiceTrackId: null }> = [];
    let position = 0;
    for (let i = 0; i < chosen.length; i++) {
      values.push({ showId: id, position: position++, kind: "track", trackId: chosen[i]!.id, voiceTrackId: null });
      if ((i + 1) % body.voiceEvery === 0 && i < chosen.length - 1) {
        values.push({ showId: id, position: position++, kind: "voice", trackId: null, voiceTrackId: null });
      }
    }
    if (values.length === 0) return reply.code(400).send({ error: "Could not build a rundown from that folder." });

    await db.transaction(async (tx) => {
      if (body.mode === "replace") {
        await tx.delete(schema.rundownItems).where(eq(schema.rundownItems.showId, id));
      } else {
        const existing = await tx
          .select({ position: schema.rundownItems.position })
          .from(schema.rundownItems)
          .where(eq(schema.rundownItems.showId, id))
          .orderBy(desc(schema.rundownItems.position))
          .limit(1);
        const base = (existing[0]?.position ?? -1) + 1;
        for (const v of values) v.position += base;
      }
      await tx.insert(schema.rundownItems).values(values);
    });
    bumpProgrammingRevision();

    return reply.code(201).send({
      summary: {
        tracksAdded: chosen.length,
        voiceSlotsAdded: voiceCount,
        musicSeconds: Math.round(musicSeconds),
        airedSeconds: Math.max(0, Math.round(aired(bestT))),
        targetMinutes: body.targetMinutes,
      },
    });
  });

  app.post("/shows/:id/rundown/reorder", { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await isShowAccessible(id, req.user!))) return reply.code(404).send({ error: "Show not found" });
    const body = req.body as { ids?: string[] };
    const ids = body.ids ?? [];
    const rows = await db.select().from(schema.rundownItems).where(eq(schema.rundownItems.showId, id));
    if (ids.length !== rows.length || new Set(ids).size !== rows.length) {
      return reply.code(400).send({ error: "ids must list every rundown item exactly once" });
    }
    const byId = new Set(rows.map((r) => r.id));
    if (!ids.every((x) => byId.has(x))) return reply.code(400).send({ error: "unknown item id" });
    for (let i = 0; i < ids.length; i++) {
      await db.update(schema.rundownItems).set({ position: i }).where(eq(schema.rundownItems.id, ids[i]!));
    }
    bumpProgrammingRevision();
    return { ok: true };
  });

  app.patch("/rundown/:itemId", { preHandler: authenticate }, async (req, reply) => {
    const { itemId } = req.params as { itemId: string };
    if (!(await isRundownItemAccessible(itemId, req.user!))) return reply.code(404).send({ error: "Rundown item not found" });
    const body = rundownItemSchema.partial().parse(req.body);
    const rows = await db.select().from(schema.rundownItems).where(eq(schema.rundownItems.id, itemId)).limit(1);
    const item = rows[0];
    if (!item) return reply.code(404).send({ error: "Not found" });
    if (body.voiceTrackId !== undefined) {
      if (item.kind !== "voice" || !body.voiceTrackId) {
        return reply.code(400).send({ error: "voiceTrackId only applies to voice items" });
      }
      const [updated] = await db
        .update(schema.rundownItems)
        .set({ voiceTrackId: body.voiceTrackId })
        .where(eq(schema.rundownItems.id, itemId))
        .returning();
      bumpProgrammingRevision();
      return { item: isoRow(updated) };
    }
    if (body.trackId !== undefined) {
      if (item.kind !== "track" || !body.trackId) {
        return reply.code(400).send({ error: "trackId only applies to track items" });
      }
      const [updated] = await db
        .update(schema.rundownItems)
        .set({ trackId: body.trackId })
        .where(eq(schema.rundownItems.id, itemId))
        .returning();
      bumpProgrammingRevision();
      return { item: isoRow(updated) };
    }
    return reply.code(400).send({ error: "Nothing to update" });
  });

  app.delete("/rundown/:itemId", { preHandler: authenticate }, async (req, reply) => {
    const { itemId } = req.params as { itemId: string };
    if (!(await isRundownItemAccessible(itemId, req.user!))) return reply.code(404).send({ error: "Rundown item not found" });
    await db.delete(schema.rundownItems).where(eq(schema.rundownItems.id, itemId));
    bumpProgrammingRevision();
    return { ok: true };
  });

  /* ---------------- Schedule ---------------- */

  app.get("/schedule", { preHandler: authenticate }, async (req) => {
    const rows = await db
      .select({ entry: schema.scheduleEntries, show: schema.shows })
      .from(schema.scheduleEntries)
      .innerJoin(schema.shows, eq(schema.scheduleEntries.showId, schema.shows.id))
      .where(req.user!.role === "admin" ? undefined : eq(schema.shows.ownerId, req.user!.sub))
      .orderBy(asc(schema.scheduleEntries.startMinutes));
    return { entries: rows.map((r) => ({ ...isoRow(r.entry), show: isoRow(r.show) })) };
  });

  app.post("/schedule", { preHandler: authenticate }, async (req, reply) => {
    const body = scheduleEntrySchema.parse(req.body);
    const showRows = await db.select({ ownerId: schema.shows.ownerId }).from(schema.shows).where(eq(schema.shows.id, body.showId)).limit(1);
    const show = showRows[0];
    if (!show) return reply.code(404).send({ error: "Show not found" });
    if (req.user!.role !== "admin") {
      if (show.ownerId !== req.user!.sub) return reply.code(403).send({ error: "You can only schedule your own shows." });
      if (!(await validateDjScheduleSlot(body, req.user!.sub))) {
        return reply.code(403).send({ error: "That show time is outside your administrator-allocated slots." });
      }
    }
    if (body.endMinutes <= body.startMinutes) {
      return reply.code(400).send({ error: "End must be after start" });
    }
    const conflict = await validateScheduleConflict(body);
    if (conflict) {
      return reply.code(409).send({ error: conflict });
    }
    const [entry] = await db
      .insert(schema.scheduleEntries)
      .values({
        showId: body.showId,
        dayOfWeek: body.dayOfWeek,
        startMinutes: body.startMinutes,
        endMinutes: body.endMinutes,
      })
      .returning();
    bumpProgrammingRevision();
    return reply.code(201).send({ entry: isoRow(entry) });
  });

  app.patch("/schedule/:id", { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = scheduleEntrySchema.partial().parse(req.body);
    const currentRows = await db.select().from(schema.scheduleEntries).where(eq(schema.scheduleEntries.id, id)).limit(1);
    const current = currentRows[0];
    if (!current) return reply.code(404).send({ error: "Not found" });
    const currentShow = await db.select({ ownerId: schema.shows.ownerId }).from(schema.shows).where(eq(schema.shows.id, current.showId)).limit(1);
    if (req.user!.role !== "admin") {
      if (currentShow[0]?.ownerId !== req.user!.sub) return reply.code(403).send({ error: "You can only edit your own show schedule." });
    }
    const nextValues = {
      showId: body.showId ?? current.showId,
      dayOfWeek: body.dayOfWeek ?? current.dayOfWeek,
      startMinutes: body.startMinutes ?? current.startMinutes,
      endMinutes: body.endMinutes ?? current.endMinutes,
    };
    if (nextValues.endMinutes <= nextValues.startMinutes) {
      return reply.code(400).send({ error: "End must be after start" });
    }
    if (req.user!.role !== "admin") {
      if (nextValues.showId !== current.showId) {
        const replacement = await db.select({ ownerId: schema.shows.ownerId }).from(schema.shows).where(eq(schema.shows.id, nextValues.showId)).limit(1);
        if (replacement[0]?.ownerId !== req.user!.sub) return reply.code(403).send({ error: "You can only schedule your own shows." });
      }
      if (!(await validateDjScheduleSlot(nextValues, req.user!.sub))) return reply.code(403).send({ error: "That show time is outside your administrator-allocated slots." });
    }
    const conflict = await validateScheduleConflict(nextValues, id);
    if (conflict) {
      return reply.code(409).send({ error: conflict });
    }
    const [entry] = await db
      .update(schema.scheduleEntries)
      .set(nextValues)
      .where(eq(schema.scheduleEntries.id, id))
      .returning();
    bumpProgrammingRevision();
    return { entry: isoRow(entry) };
  });

  app.delete("/schedule/:id", { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (req.user!.role !== "admin") {
      const rows = await db.select({ ownerId: schema.shows.ownerId }).from(schema.scheduleEntries).innerJoin(schema.shows, eq(schema.scheduleEntries.showId, schema.shows.id)).where(eq(schema.scheduleEntries.id, id)).limit(1);
      if (rows[0]?.ownerId !== req.user!.sub) return reply.code(403).send({ error: "You can only remove your own show schedule." });
    }
    await db.delete(schema.scheduleEntries).where(eq(schema.scheduleEntries.id, id));
    bumpProgrammingRevision();
    return { ok: true };
  });

  /* ---------------- Voice tracks ---------------- */

  app.get("/voice", { preHandler: authenticate }, async () => {
    const rows = await db
      .select({ voice: schema.voiceTracks, show: schema.shows })
      .from(schema.voiceTracks)
      .leftJoin(schema.shows, eq(schema.voiceTracks.showId, schema.shows.id))
      .orderBy(schema.voiceTracks.createdAt);
    return { voiceTracks: rows.map((r) => ({ ...isoRow(r.voice), show: r.show ? isoRow(r.show) : null })) };
  });

  // Stream a voice track's audio (used by the Show Builder preview).
  app.get("/voice/:id/audio", { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = await db.select().from(schema.voiceTracks).where(eq(schema.voiceTracks.id, id)).limit(1);
    const v = rows[0];
    if (!v) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile(basename(v.filePath), dirname(v.filePath));
  });

  app.post("/voice/upload", { preHandler: authenticate }, async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "No file uploaded" });

    await mkdir(join(config.dataDir, "voice"), { recursive: true });
    const ext = extname(file.filename || ".mp3").toLowerCase() || ".mp3";
    const filePath = join(config.dataDir, "voice", `${crypto.randomUUID()}${ext}`);
    try {
      await pipeline(file.file, createWriteStream(filePath, { flags: "wx" }));
    } catch {
      await unlink(filePath).catch(() => {});
      return reply.code(400).send({ error: "Upload failed" });
    }
    const probe = await probeAudio(filePath);
    // Loudness-normalise the voice link (to the same -16 LUFS target as music)
    // so pre-produced shows sit at a consistent level instead of playing raw.
    const loudness = await scanLoudness(filePath).catch(() => ({ lufs: null, gainDb: 0 }));
    const fields = file.fields as Record<string, { value: string } | undefined>;
    const title = fields.title?.value?.trim() || "Voice link";
    const showId = fields.showId?.value || null;
    const playEvery = Math.max(1, Number(fields.playEvery?.value ?? 3) || 3);
    if (showId && !(await isShowAccessible(showId, req.user!))) {
      await unlink(filePath).catch(() => {});
      return reply.code(404).send({ error: "Show not found" });
    }

    const [voice] = await db
      .insert(schema.voiceTracks)
      .values({
        title,
        showId,
        filePath,
        durationSeconds: probe.durationSeconds,
        loudnessGainDb: loudness.gainDb,
        playEvery,
      })
      .returning();
    bumpProgrammingRevision();
    return reply.code(201).send({ voiceTrack: isoRow(voice) });
  });

  app.patch("/voice/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = voiceTrackSchema.partial().parse(req.body);
    const [voice] = await db
      .update(schema.voiceTracks)
      .set(body)
      .where(eq(schema.voiceTracks.id, id))
      .returning();
    if (!voice) return reply.code(404).send({ error: "Not found" });
    bumpProgrammingRevision();
    return { voiceTrack: isoRow(voice) };
  });

  app.delete("/voice/:id", { preHandler: requireAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    const rows = await db.select().from(schema.voiceTracks).where(eq(schema.voiceTracks.id, id)).limit(1);
    const v = rows[0];
    if (v) {
      await db.delete(schema.voiceTracks).where(eq(schema.voiceTracks.id, id));
      await unlink(v.filePath).catch(() => {});
      bumpProgrammingRevision();
    }
    return { ok: true };
  });
}

export { or, isNull };
