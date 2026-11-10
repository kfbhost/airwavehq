import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  or,
  type SQL,
} from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, schema } from "../db/client.js";
import { pickMusic, pickRandom } from "./rotation.js";
import type { WeightedTrack, RotationRecent } from "./rotation.js";
import {
  advanceShufflePass,
  seededShuffle,
  shuffleMusicOnly,
  shuffleSeedFor,
  stepPlaylistCursor,
} from "./playlistShuffle.js";
import {
  findNextStationRotationBoundary,
  resolveStationRotation,
  rotationPlaylistForDay,
} from "./stationRotations.js";
import { DEFAULT_BREAKS, zonedDate, zonedParts, zonedDayStart } from "@airshift/shared";
import type { EngineItem, EngineSequence } from "@airshift/shared";

const BREAK_TARGET_SEC = 120;
const BREAK_MARGIN_MS = 1500; // within this of a break, insert it now
const TAIL_MARGIN_MS = 300; // music truncated this far before a break

// In-memory cursor per playlist so plain playlist automation walks the stored
// item order (music AND jingles) across the engine's repeated fetch windows
// instead of restarting at position 0 every time. Seeded from the play log on
// first use so a process restart continues where it left off too.
const playlistCursorByPlaylist = new Map<string, number>();


interface Ctx {
  tz: string;
  showId: string | null;
  showName: string | null;
  clockwheelId: string | null;
  playlistId: string | null;
  stationRotationPlaylistId: string | null;
  stationRotationId: string | null;
  stationRotationName: string | null;
  /** When the active station rotation has shufflePlaylist on, the curated
   *  playlist is played in a fresh shuffled music order each airing (jingles
   *  and cues stay where they were placed). True only for a rotation using a
   *  real curated playlist (mutually exclusive with autoGenerate). */
  rotationShuffle: boolean;
  /** When a station rotation has autoGenerate on, the config used to build a
   *  fresh daily track list from the configured folders. Null otherwise. */
  rotationAutoGen: {
    rotationId: string;
    musicFolders: string[];
    includeJingles: boolean;
    jingleEvery: number;
    jingleFolder: string | null;
    hours: number;
  } | null;
  voiceTracks: { id: string; filePath: string; durationSeconds: number; playEvery: number; gainDb: number }[];
  rundown: RundownRef[];
  /** For a show created from a recording: the instant its single recording finishes,
   *  after which the station hands back to default automation. Null for normal shows. */
  recordedEndMs: number | null;
}

export interface ProgrammingContext {
  mode: "rundown" | "clockwheel" | "playlist" | "idle";
  automationSource: "show" | "rotation" | "default" | "idle";
  showId: string | null;
  showName: string | null;
  playlistId: string | null;
  playlistName: string | null;
  clockwheelId: string | null;
  clockwheelName: string | null;
  stationRotationId: string | null;
  stationRotationName: string | null;
}

export function resolveMusicSlotPlaylistId(input: {
  slotPlaylistId: string | null;
  contextPlaylistId: string | null;
  showId: string | null;
  stationRotationPlaylistId: string | null;
}): string | null {
  if (!input.showId && input.stationRotationPlaylistId) {
    return input.stationRotationPlaylistId;
  }
  return input.slotPlaylistId ?? input.contextPlaylistId;
}

/** One entry of a pre-produced show rundown, resolved against live rows. */
interface RundownRef {
  id: string;
  kind: "track" | "voice";
  track: {
    id: string;
    artworkPath: string | null;
    kind: string;
    title: string;
    artist: string;
    durationSeconds: number;
    loudnessGainDb: number;
    filePath: string;
    isActive: boolean;
  } | null;
  voice: {
    id: string;
    title: string;
    filePath: string;
    durationSeconds: number;
    gainDb: number;
    isActive: boolean;
  } | null;
}

/**
 * Computes the next sequence of items for the engine starting at `afterMs`.
 * The API decides WHAT plays; the engine decides HOW (decode, gain, timing).
 */
export async function computeNextSequence(
  afterMs: number,
  count: number,
): Promise<EngineSequence> {
  const s = await db.select().from(schema.settings).where(eq(schema.settings.id, 1)).limit(1);
  const settings = s[0];
  if (!settings) return { items: [], mode: "idle", fetchedAt: Date.now() };

  const tz = settings.timezone || "UTC";
  let ctx = await resolveContext(afterMs, tz, settings);
  let programmingBoundary = await nextProgrammingBoundary(afterMs, tz, ctx.showId);
  // A recorded show ends when its audio ends, not at the schedule slot edge.
  if (ctx.recordedEndMs != null) {
    programmingBoundary = programmingBoundary == null ? ctx.recordedEndMs : Math.min(programmingBoundary, ctx.recordedEndMs);
  }
  const recent = await recentPlays();


  const items: EngineItem[] = [];
  let cursor = afterMs;
  let slotIndex = 0;
  // The engine fetches several windows over the life of a show. Derive the
  // rundown position from the show slot start instead of resetting to item 0
  // on every request; otherwise a short prefix repeats near the end of the
  // hour. For a request that begins inside the slot, skip the elapsed items.
  let rundownIndex = 0;
  if (ctx.rundown.length > 0 && ctx.showId) {
    const showStart = await currentShowStart(afterMs, tz, ctx.showId);
    if (showStart != null && afterMs > showStart) {
      let elapsed = 0;
      while (rundownIndex < ctx.rundown.length && elapsed < afterMs - showStart) {
        const ref = ctx.rundown[rundownIndex]!;
        const duration = ref.kind === "voice" ? ref.voice?.durationSeconds : ref.track?.durationSeconds;
        if (!duration || duration <= 0) break;
        elapsed += duration * 1000;
        rundownIndex++;
      }
      if (rundownIndex >= ctx.rundown.length) rundownIndex = ctx.rundown.length;
    }
  }
  let rundownMisses = 0;
  let slots: typeof schema.clockwheelSlots.$inferSelect[] = [];

  if (ctx.clockwheelId) {
    slots = await clockwheelSlots(ctx.clockwheelId);
  }

  // Plain playlist automation: walk the playlist's stored items in position
  // order (music AND jingles interleaved, exactly as the admin arranged them).
  // Tracks a per-playlist cursor so the engine's repeated fetch windows continue
  // the sequence instead of restarting at item 0 each time.
  let playlistOrdered: OrderedPlaylistItem[] = [];
  let playlistCursor = 0;
  // Auto-generating rotations get a synthetic cursor key of rotation+date so
  // every engine fetch within one day continues the same daily list, while a
  // new day naturally starts a fresh one.
  let playlistCursorKey: string | null = null;
  // Set when the active ordered source is a playlist with "shuffle each pass"
  // on, so a completed loop can advance to a new shuffled order.
  let playlistShuffledPass = false;
  // Whether this window walked off the end of the playlist (a finished pass).
  let playlistPassCompleted = false;
  const orderedPlaylistMode = ctx.rundown.length === 0 && !(ctx.clockwheelId && slots.length > 0);
  if (orderedPlaylistMode && ctx.rotationAutoGen) {
    playlistOrdered = await loadAutoGenOrdered(ctx.rotationAutoGen, afterMs, ctx.tz);
    if (playlistOrdered.length > 0) {
      playlistCursorKey = `autogen:${ctx.rotationAutoGen.rotationId}:${zonedDate(afterMs, ctx.tz)}`;
      playlistCursor = await replayCursorFor(playlistCursorKey, playlistOrdered);
    } else {
      // No music matched the folders — fall back to the rotation's normal
      // playlist (or default automation) so the block still airs something.
      ctx = { ...ctx, rotationAutoGen: null };
    }
  }
  // Shuffle-enabled rotation: play its curated playlist with the MUSIC in a
  // fresh, seeded order each airing (jingles/cues stay placed). Seeded by
  // rotation + local date so every engine fetch within one airing continues
  // the same order while a new airing (new day) starts a fresh one. Only when
  // the rotation resolved its own curated playlist, not the default fallback.
  if (
    orderedPlaylistMode &&
    ctx.rotationShuffle &&
    ctx.stationRotationId &&
    ctx.stationRotationPlaylistId &&
    playlistOrdered.length === 0
  ) {
    const dateKey = zonedDate(afterMs, ctx.tz);
    const cursorKey = `shuffle:${ctx.stationRotationId}:${dateKey}`;
    playlistOrdered = await loadOrderedPlaylistShuffled(ctx.playlistId, `${ctx.stationRotationId}|music|${dateKey}`);
    if (playlistOrdered.length > 0) {
      playlistCursorKey = cursorKey;
      playlistCursor = await replayCursorFor(cursorKey, playlistOrdered);
    }
  }
  if (orderedPlaylistMode && ctx.playlistId && playlistOrdered.length === 0) {
    // "Shuffle each pass" playlists (typically the long-running default
    // automation) resolve the music into a fresh order for every loop of the
    // playlist, so the same running order never plays twice in a row. Jingles
    // and other production items stay exactly where they were placed.
    playlistShuffledPass = await playlistShuffleEnabled(ctx.playlistId);
    playlistOrdered = playlistShuffledPass
      ? await loadOrderedPlaylistShuffled(ctx.playlistId, shuffleSeedFor(ctx.playlistId))
      : await loadOrderedPlaylist(ctx.playlistId);
    playlistCursor = await replayCursorFor(ctx.playlistId, playlistOrdered);
    playlistCursorKey = ctx.playlistId;
  }
  let playlistMisses = 0;

  while (items.length < count) {
    const nextBreak = nextBreakTime(cursor, tz);
    const nextHour = nextHourTime(cursor, tz);
    const nextWall = programmingBoundary != null ? Math.min(nextBreak, nextHour, programmingBoundary) : Math.min(nextBreak, nextHour);
    const timeToBreak = nextBreak - cursor;
    const timeToHour = nextHour - cursor;
    const timeToWall = nextWall - cursor;

    // 0) Top of the hour: the previous track was already cut via maxDur to
    // end just before the hour, so fire the top-of-hour jingle exactly on it.
    if (timeToHour <= BREAK_MARGIN_MS) {
      const top = await produceTopOfHour(nextHour, ctx, settings);
      for (const item of top.items) {
        items.push(item);
        cursor = Math.max(cursor, (item.airAt ?? cursor) + item.durationSec * 1000);
      }
      if (top.items.length === 0) {
        cursor = nextHour + 1; // no jingle configured: step past the hour
      }
      // If the hour is also a programming boundary, stop after the jingle so
      // the next fetch resolves the new context on time.
      if (programmingBoundary != null && nextHour >= programmingBoundary - BREAK_MARGIN_MS) break;
      continue;
    }

    // 1) Stop at the next programming boundary so the next fetch resolves the
    // new context instead of letting buffered items drift past the slot edge.
    if (programmingBoundary != null && nextWall === programmingBoundary && timeToWall <= BREAK_MARGIN_MS) {
      break;
    }

    // 2) Hit the wall-clock break.
    if (timeToBreak <= BREAK_MARGIN_MS) {
      const br = await produceBreak(nextBreak, ctx, count - items.length);
      for (const item of br.items) {
        items.push(item);
        cursor = Math.max(cursor, (item.airAt ?? cursor) + item.durationSec * 1000);
      }
      if (br.items.length === 0) {
        cursor = nextBreak + 1; // no campaigns: skip past so we don't loop
      }
      continue;
    }

    // 3) Produce one music/jingle item. When a break or the top of the hour
    // is approaching, constrain track length so we land on it (or truncate
    // the last track via cutoffAt so it fades out before the boundary).
    const maxDur = timeToWall > BREAK_MARGIN_MS ? (timeToWall - TAIL_MARGIN_MS) / 1000 : undefined;
    const produced = ctx.rundown.length > 0
      ? await produceFromRundown(ctx, cursor, nextWall, maxDur, rundownIndex)
      : ctx.clockwheelId && slots.length > 0
        ? await produceSlot(slots[slotIndex % slots.length]!, ctx, recent, cursor, nextWall, maxDur)
        : await produceFromOrderedPlaylist(ctx, playlistOrdered, playlistCursor, recent, cursor, nextWall, maxDur);

    if (ctx.rundown.length > 0) rundownIndex++;
    else if (ctx.clockwheelId) slotIndex++;
    else {
      const step = stepPlaylistCursor(playlistCursor, playlistOrdered.length);
      playlistPassCompleted = playlistPassCompleted || step.completed;
      playlistCursor = step.cursor;
    }

    if (!produced.item) {
      if (ctx.rundown.length > 0) {
        rundownMisses++;
        // A rundown is never allowed to loop inside a scheduled slot. If all
        // remaining entries have been consumed/unavailable, stop this window;
        // the next programming boundary will hand over to the next show or
        // the configured default automation.
        if (rundownMisses >= Math.max(1, ctx.rundown.length - rundownIndex)) break;
        continue;
      }
      if (orderedPlaylistMode) {
        playlistMisses++;
        if (playlistMisses >= Math.max(1, playlistOrdered.length)) break;
        continue;
      }
      // Nothing to play at all (empty pools) — stop to avoid a hot loop.
      if (items.length === 0) break;
      cursor += 1000; // step forward, try again
      continue;
    }

    rundownMisses = 0;

    items.push(produced.item);
    // Feed the pick back into the rotation state so rules hold *within* the
    // sequence being built, not just against historical plays. Newest first.
    if (produced.item.source === "automation" && produced.item.trackId) {
      recent.unshift({
        trackId: produced.item.trackId,
        artist: produced.item.artist,
        playedAt: new Date(produced.item.airAt ?? cursor),
      });
    }
    const endsAt = produced.item.cutoffAt ?? cursor + produced.item.durationSec * 1000;
    cursor = endsAt;
    if (programmingBoundary != null && cursor >= programmingBoundary - BREAK_MARGIN_MS) break;
  }

  // Persist where we got to in the playlist so the next fetch continues here.
  if (orderedPlaylistMode && playlistCursorKey && playlistOrdered.length > 0) {
    playlistCursorByPlaylist.set(playlistCursorKey, playlistCursor % playlistOrdered.length);
  }
  // A finished pass rolls the shuffle on: the next fetch reshuffles the music,
  // so the loop that starts now is a different running order from the last one.
  if (playlistShuffledPass && playlistPassCompleted && ctx.playlistId) {
    advanceShufflePass(ctx.playlistId);
  }

  // A rundown already places voice links explicitly — skip the every-N counter.
  let finalItems = items;
  const clockwheelActive = Boolean(ctx.clockwheelId && slots.length > 0);
  // Station "auto jingle" layer (off until enabled): applies to plain curated
  // playlist automation and pre-produced/rundown shows — but NOT where jingles
  // already run (clockwheels, auto-generate-with-jingles) to avoid doubling.
  if (
    settings.autoJingleEvery > 0 &&
    !ctx.rotationAutoGen &&
    !clockwheelActive &&
    (ctx.rundown.length > 0 || orderedPlaylistMode)
  ) {
    finalItems = await autoInsertJingles(items, settings.autoJingleEvery, settings.autoJingleFolder);
  }
  const withVoice = ctx.rundown.length > 0 ? finalItems : insertVoiceTracks(finalItems, ctx);

  return {
    items: withVoice.slice(0, count),
    mode: ctx.rundown.length > 0 ? "rundown" : ctx.clockwheelId ? "clockwheel" : ctx.playlistId || ctx.rotationAutoGen ? "playlist" : "idle",
    fetchedAt: Date.now(),
  };
}

export async function resolveProgrammingContext(afterMs: number): Promise<ProgrammingContext> {
  const s = await db.select().from(schema.settings).where(eq(schema.settings.id, 1)).limit(1);
  const settings = s[0];
  if (!settings) {
    return {
      mode: "idle",
      automationSource: "idle",
      showId: null,
      showName: null,
      playlistId: null,
      playlistName: null,
      clockwheelId: null,
      clockwheelName: null,
      stationRotationId: null,
      stationRotationName: null,
    };
  }

  const ctx = await resolveContext(afterMs, settings.timezone || "UTC", settings);
  const [playlist, clockwheel] = await Promise.all([
    ctx.playlistId ? db.select().from(schema.playlists).where(eq(schema.playlists.id, ctx.playlistId)).limit(1) : Promise.resolve([]),
    ctx.clockwheelId ? db.select().from(schema.clockwheels).where(eq(schema.clockwheels.id, ctx.clockwheelId)).limit(1) : Promise.resolve([]),
  ]);

  return {
    mode: ctx.rundown.length > 0 ? "rundown" : ctx.clockwheelId ? "clockwheel" : ctx.playlistId || ctx.rotationAutoGen ? "playlist" : "idle",
    automationSource: ctx.showId ? "show" : ctx.stationRotationId ? "rotation" : ctx.playlistId ? "default" : "idle",
    showId: ctx.showId,
    showName: ctx.showName,
    playlistId: ctx.playlistId,
    playlistName: playlist[0]?.name ?? null,
    clockwheelId: ctx.clockwheelId,
    clockwheelName: clockwheel[0]?.name ?? null,
    stationRotationId: ctx.stationRotationId,
    stationRotationName: ctx.stationRotationName,
  };
}

/**
 * Resolves the CURRENT programming context for the wall clock (not the engine's
 * fetch-ahead time) and the source scheduled to come on next, plus when. This
 * is what drives the dashboard's "Automation source" / "coming up" labels so
 * they always match what is actually on air now.
 */
export async function resolveNowAndNext(
  afterMs: number,
): Promise<{ current: ProgrammingContext; next: { atMs: number; context: ProgrammingContext } | null }> {
  const current = await resolveProgrammingContext(afterMs);
  const s = await db.select().from(schema.settings).where(eq(schema.settings.id, 1)).limit(1);
  const tz = s[0]?.timezone || "UTC";
  const nextAt = await nextProgrammingBoundary(afterMs, tz, current.showId);
  if (nextAt == null) return { current, next: null };
  const context = await resolveProgrammingContext(nextAt);
  return { current, next: { atMs: nextAt, context } };
}

/* ------------------------------------------------------------------ */
/* Context resolution                                                 */
/* ------------------------------------------------------------------ */

async function resolveContext(
  afterMs: number,
  tz: string,
  settings: typeof schema.settings.$inferSelect,
): Promise<Ctx> {
  const p = zonedParts(afterMs, tz);
  const entries = await db
    .select()
    .from(schema.scheduleEntries)
    .where(
      and(
        lte(schema.scheduleEntries.startMinutes, p.minutesOfDay),
        or(
          eq(schema.scheduleEntries.dayOfWeek, p.dayOfWeek),
          isNull(schema.scheduleEntries.dayOfWeek),
        ),
      ),
    )
    .orderBy(asc(schema.scheduleEntries.endMinutes));

  const active = entries.find(
    (e) => e.startMinutes <= p.minutesOfDay && p.minutesOfDay < e.endMinutes,
  );

  if (active) {
    const show = await db
      .select()
      .from(schema.shows)
      .where(eq(schema.shows.id, active.showId))
      .limit(1);
    const sh = show[0];
    if (sh) {
      const rundown = await loadRundown(sh.id);
      const recTrack = singleRecordingTrack(rundown);
      if (recTrack) {
        // A show created from a recording plays its audio once, then hands back
        // to default automation — even if the schedule slot is longer.
        const showStartMs = p.localMidnightMs + active.startMinutes * 60_000;
        const recEndMs = showStartMs + Math.max(1, Math.round(recTrack.durationSeconds)) * 1000;
        if (afterMs < recEndMs) {
          const ctx = ctxFrom(sh.id, sh.name, sh.clockwheelId, sh.playlistId, null, null, null, settings, [], rundown);
          ctx.recordedEndMs = recEndMs;
          return ctx;
        }
        // Recording already aired in this slot → fall through to default automation.
      } else {
        const voiceTracks = await db
          .select()
          .from(schema.voiceTracks)
          .where(and(eq(schema.voiceTracks.isActive, true), eq(schema.voiceTracks.showId, sh.id)));
        return ctxFrom(sh.id, sh.name, sh.clockwheelId, sh.playlistId, null, null, null, settings, voiceTracks, rundown);
      }
    }
  }

  const activeRotation = await resolveStationRotation(afterMs, tz);
  const rotationPlaylist = activeRotation
    ? rotationPlaylistForDay(activeRotation, p.dayOfWeek)
    : null;
  let rotationAutoGen: Ctx["rotationAutoGen"] = null;
  if (activeRotation?.autoGenerate) {
    const folders = parseAutoGenFolders(activeRotation.musicFolders);
    const hours =
      activeRotation.endHour > activeRotation.startHour
        ? activeRotation.endHour - activeRotation.startHour
        : 24 - activeRotation.startHour + activeRotation.endHour;
    rotationAutoGen = {
      rotationId: activeRotation.id,
      musicFolders: folders,
      includeJingles: activeRotation.includeJingles,
      jingleEvery: activeRotation.jingleEvery,
      jingleFolder: activeRotation.jingleFolder,
      hours: Math.max(1, hours),
    };
  }
  return ctxFrom(
    null,
    null,
    activeRotation?.clockwheelId ?? settings.defaultClockwheelId,
    rotationPlaylist ?? settings.defaultPlaylistId,
    rotationPlaylist ?? null,
    activeRotation?.id ?? null,
    activeRotation?.name ?? null,
    settings,
    [],
    [],
    rotationAutoGen,
    activeRotation ? activeRotation.shufflePlaylist && !activeRotation.autoGenerate : false,
  );
}

/** Parses the JSON music_folders text column into an array of folder names. */
function parseAutoGenFolders(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function ctxFrom(
  showId: string | null,
  showName: string | null,
  clockwheelId: string | null,
  playlistId: string | null,
  stationRotationPlaylistId: string | null,
  stationRotationId: string | null,
  stationRotationName: string | null,
  settings: typeof schema.settings.$inferSelect,
  voiceRows: typeof schema.voiceTracks.$inferSelect[],
  rundown: RundownRef[],
  rotationAutoGen: Ctx["rotationAutoGen"] = null,
  rotationShuffle = false,
): Ctx {
  return {
    tz: settings.timezone || "UTC",
    showId,
    showName,
    clockwheelId: clockwheelId ?? settings.defaultClockwheelId,
    playlistId: playlistId ?? settings.defaultPlaylistId,
    stationRotationPlaylistId,
    stationRotationId,
    stationRotationName,
    rotationAutoGen,
    rotationShuffle,
    voiceTracks: voiceRows.map((v) => ({
      id: v.id,
      filePath: v.filePath,
      durationSeconds: v.durationSeconds,
      playEvery: v.playEvery,
      gainDb: v.loudnessGainDb,
    })),
    rundown,
    recordedEndMs: null,
  };
}

/** If a show's rundown is exactly one active "recording" item, return that track. */
function singleRecordingTrack(rundown: RundownRef[]) {
  if (rundown.length !== 1) return null;
  const it = rundown[0]!;
  if (it.kind === "track" && it.track && it.track.kind === "recording" && it.track.isActive) return it.track;
  return null;
}

/** Loads a show's rundown, resolving each entry against current track/voice rows. */
async function loadRundown(showId: string): Promise<RundownRef[]> {
  const rows = await db
    .select()
    .from(schema.rundownItems)
    .where(eq(schema.rundownItems.showId, showId))
    .orderBy(asc(schema.rundownItems.position));
  if (rows.length === 0) return [];
  const trackIds = rows.filter((r) => r.kind === "track" && r.trackId).map((r) => r.trackId!) as string[];
  const voiceIds = rows.filter((r) => r.kind === "voice" && r.voiceTrackId).map((r) => r.voiceTrackId!) as string[];
  const [tracks, voices] = await Promise.all([
    trackIds.length > 0 ? db.select().from(schema.tracks).where(inArray(schema.tracks.id, trackIds)) : Promise.resolve([]),
    voiceIds.length > 0 ? db.select().from(schema.voiceTracks).where(inArray(schema.voiceTracks.id, voiceIds)) : Promise.resolve([]),
  ]);
  const tById = new Map(tracks.map((t) => [t.id, t]));
  const vById = new Map(voices.map((v) => [v.id, v]));
  return rows.map((r) => {
    if (r.kind === "voice") {
      const v = r.voiceTrackId ? vById.get(r.voiceTrackId) : undefined;
      return {
        id: r.id,
        kind: "voice" as const,
        track: null,
        voice: v
          ? {
              id: v.id,
              title: v.title,
              filePath: v.filePath,
              durationSeconds: v.durationSeconds,
              gainDb: v.loudnessGainDb,
              isActive: v.isActive,
            }
          : null,
      };
    }
    const t = r.trackId ? tById.get(r.trackId) : undefined;
    return {
      id: r.id,
      kind: "track" as const,
      voice: null,
      track: t
        ? {
            id: t.id,
            artworkPath: t.artworkPath,
            kind: t.kind,
            title: t.title,
            artist: t.artist,
            durationSeconds: t.durationSeconds,
            loudnessGainDb: t.loudnessGainDb,
            filePath: t.filePath,
            isActive: t.isActive,
          }
        : null,
    };
  });
}

async function recentPlays(): Promise<RotationRecent[]> {
  const rows = await db
    .select()
    .from(schema.playLog)
    .orderBy(desc(schema.playLog.startedAt))
    .limit(100);
  return rows.map((r) => ({
    trackId: r.trackId,
    artist: r.artist,
    playedAt: r.startedAt,
  }));
}

/* ------------------------------------------------------------------ */
/* Item production                                                    */
/* ------------------------------------------------------------------ */

async function produceSlot(
  slot: typeof schema.clockwheelSlots.$inferSelect,
  ctx: Ctx,
  recent: RotationRecent[],
  cursor: number,
  nextWall: number,
  maxDur: number | undefined,
): Promise<{ item: EngineItem | null }> {
  switch (slot.type) {
    case "music":
      return produceMusic(
        resolveMusicSlotPlaylistId({
          slotPlaylistId: slot.playlistId,
          contextPlaylistId: ctx.playlistId,
          showId: ctx.showId,
          stationRotationPlaylistId: ctx.stationRotationPlaylistId,
        }),
        ctx,
        recent,
        cursor,
        nextWall,
        maxDur,
      );
    case "jingle":
    case "sweeper":
    case "station_id": {
      const track = await pickKindTrack(slot.type);
      if (!track) return { item: null };
      return {
        item: makeItem({
          trackId: track.id,
          kind: track.kind,
          title: track.title,
          artist: track.artist,
          durationSec: track.durationSeconds,
          gainDb: track.loudnessGainDb,
          filePath: track.filePath,
          artworkPath: track.artworkPath,
          source: "automation",
          showId: ctx.showId,
        }),
      };
    }
    case "anchored": {
      if (!slot.trackId) return { item: null };
      const track = await db
        .select()
        .from(schema.tracks)
        .where(eq(schema.tracks.id, slot.trackId))
        .limit(1);
      const t = track[0];
      if (!t) return { item: null };
      return {
        item: makeItem({
          trackId: t.id,
          kind: t.kind,
          title: t.title,
          artist: t.artist,
          durationSec: t.durationSeconds,
          gainDb: t.loudnessGainDb,
          filePath: t.filePath,
          artworkPath: t.artworkPath,
          source: "automation",
          showId: ctx.showId,
        }),
      };
    }
    default:
      return { item: null };
  }
}

async function produceMusic(
  playlistId: string | null,
  ctx: Ctx,
  recent: RotationRecent[],
  cursor: number,
  nextWall: number,
  maxDur: number | undefined,
): Promise<{ item: EngineItem | null }> {
  const pool = await trackPool(playlistId ?? ctx.playlistId);
  if (pool.length === 0) return { item: null };
  const track = pickMusic(
    pool,
    recent,
    { artistSeparation: 3, trackSeparationMinutes: 30 },
    maxDur,
    cursor,
  );
  if (!track) return { item: null };

  const durMs = track.durationSeconds * 1000;
  // If the track would end at/after the break (nextBreakTime is strictly
  // after `cursor`, so landing exactly on the break would skip it), truncate
  // it TAIL_MARGIN_MS early so the next loop iteration fires the break.
  const overrunsBreak = maxDur !== undefined && durMs > maxDur * 1000;
  const cutoffAt = overrunsBreak ? nextWall - TAIL_MARGIN_MS : null;
  return {
    item: makeItem({
      trackId: track.id,
      kind: track.kind,
      title: track.title,
      artist: track.artist,
      durationSec: track.durationSeconds,
      gainDb: track.loudnessGainDb,
      filePath: track.filePath,
      artworkPath: track.artworkPath,
      source: "automation",
      showId: ctx.showId,
      cutoffAt,
    }),
  };
}

/** One playable entry in an ordered sequence, in air order. */
interface OrderedPlaylistItem {
  track: {
    id: string;
    kind: string;
    title: string;
    artist: string;
    durationSeconds: number;
    loudnessGainDb: number;
    filePath: string;
    artworkPath: string | null;
  };
}

/** True when the playlist is set to reshuffle its music on every loop. */
async function playlistShuffleEnabled(playlistId: string): Promise<boolean> {
  const rows = await db
    .select({ shuffle: schema.playlists.shuffle })
    .from(schema.playlists)
    .where(eq(schema.playlists.id, playlistId))
    .limit(1);
  return rows[0]?.shuffle ?? false;
}

/** Loads a playlist's items in position order, resolving against live tracks. */
async function loadOrderedPlaylist(playlistId: string | null): Promise<OrderedPlaylistItem[]> {
  if (!playlistId) return [];
  const rows = await db
    .select({ track: schema.tracks })
    .from(schema.playlistItems)
    .innerJoin(schema.tracks, eq(schema.playlistItems.trackId, schema.tracks.id))
    .where(and(eq(schema.playlistItems.playlistId, playlistId), eq(schema.tracks.isActive, true)))
    .orderBy(asc(schema.playlistItems.position));
  return rows.map((r) => ({ track: r.track }));
}

/**
 * Loads a curated playlist but plays its MUSIC in a shuffled order (seeded by
 * rotation + airing date) while every jingle/sweeper/voice stays in the exact
 * position the admin placed it. Only the music items swap slots with each other,
 * so production cues remain anchored and the music varies each airing.
 */
async function loadOrderedPlaylistShuffled(
  playlistId: string | null,
  seedKey: string,
): Promise<OrderedPlaylistItem[]> {
  if (!playlistId) return [];
  const rows = await db
    .select({ track: schema.tracks })
    .from(schema.playlistItems)
    .innerJoin(schema.tracks, eq(schema.playlistItems.trackId, schema.tracks.id))
    .where(and(eq(schema.playlistItems.playlistId, playlistId), eq(schema.tracks.isActive, true)))
    .orderBy(asc(schema.playlistItems.position));

  const ordered: OrderedPlaylistItem[] = rows.map((r) => ({ track: r.track }));
  return shuffleMusicOnly(ordered, seedKey);
}

/* ------------------------------------------------------------------ */
/* Auto-generate: a daily rotation rebuilds a fresh ordered list each  */
/* local day from the configured music folders (with jingles every N). */
/* The shuffle is seeded by rotation + date so the same day always     */
/* resolves to the same order across engine fetch windows, but each    */
/* new day produces a brand-new list.                                  */
/* ------------------------------------------------------------------ */

/**
 * Builds the day's ordered track list for an auto-generating rotation.
 * Returns an empty list when no music matches the configured folders, in
 * which case the caller falls back to the block's normal playlist.
 */
async function loadAutoGenOrdered(
  config: NonNullable<Ctx["rotationAutoGen"]>,
  afterMs: number,
  tz: string,
): Promise<OrderedPlaylistItem[]> {
  const musicConditions = [eq(schema.tracks.kind, "music"), eq(schema.tracks.isActive, true)];
  if (config.musicFolders.length > 0) musicConditions.push(inArray(schema.tracks.folder, config.musicFolders));
  // Deterministic source order: the date-seeded shuffle below must produce the
  // SAME daily list on every fetch so the in-memory cursor can continue across
  // engine requests. Postgres does not guarantee row order without ORDER BY.
  const musicTracks = await db.select().from(schema.tracks).where(and(...musicConditions)).orderBy(asc(schema.tracks.id));
  if (musicTracks.length === 0) return [];

  const jingleConditions = [eq(schema.tracks.kind, "jingle"), eq(schema.tracks.isActive, true)];
  if (config.jingleFolder) jingleConditions.push(eq(schema.tracks.folder, config.jingleFolder));
  const jingleTracks = config.includeJingles
    ? await db.select().from(schema.tracks).where(and(...jingleConditions)).orderBy(asc(schema.tracks.id))
    : [];

  const dateKey = zonedDate(afterMs, tz);
  const music = seededShuffle(musicTracks, `${config.rotationId}|music|${dateKey}`);
  const jingles = seededShuffle(jingleTracks, `${config.rotationId}|jingles|${dateKey}`);

  const ordered: OrderedPlaylistItem[] = [];
  const targetSeconds = config.hours * 3600;
  const shortestMusic = Math.min(...musicTracks.map((t) => t.durationSeconds));
  const toleranceSeconds = 60;
  let totalSeconds = 0;
  let musicIndex = 0;
  let jingleIndex = 0;
  let musicSinceJingle = 0;
  let guard = 0;

  while (guard < 50000 && totalSeconds < targetSeconds) {
    guard++;
    const remaining = targetSeconds - totalSeconds;

    if (jingles.length > 0 && musicSinceJingle >= config.jingleEvery) {
      const jingle = jingles[jingleIndex % jingles.length]!;
      jingleIndex++;
      if (
        totalSeconds + jingle.durationSeconds <= targetSeconds + toleranceSeconds ||
        totalSeconds < targetSeconds * 0.9
      ) {
        ordered.push({ track: jingle });
        totalSeconds += jingle.durationSeconds;
        musicSinceJingle = 0;
        continue;
      }
    }

    const musicTrack = music[musicIndex % music.length]!;
    musicIndex++;
    if (
      ordered.length > 0 &&
      remaining < shortestMusic / 2 &&
      totalSeconds + musicTrack.durationSeconds > targetSeconds + toleranceSeconds
    ) {
      break;
    }
    ordered.push({ track: musicTrack });
    totalSeconds += musicTrack.durationSeconds;
    musicSinceJingle++;
  }

  return ordered;
}

/**
 * Derives where to resume in an ordered playlist. Prefers the in-memory cursor
 * (set as the sequence advances); on a fresh process seeds from the play log so
 * we continue after the most recently aired item from this playlist.
 */
async function replayCursorFor(playlistId: string, ordered: OrderedPlaylistItem[]): Promise<number> {
  const cursor = playlistCursorByPlaylist.get(playlistId);
  if (cursor !== undefined) return cursor;
  if (ordered.length === 0) return 0;
  const orderById = new Map(ordered.map((o, i) => [o.track.id, i]));
  const recent = await recentPlays();
  for (const r of recent) {
    if (r.trackId != null && orderById.has(r.trackId)) {
      const at = (orderById.get(r.trackId)! + 1) % ordered.length;
      playlistCursorByPlaylist.set(playlistId, at);
      return at;
    }
  }
  return 0;
}

/**
 * Produces the next playlist item in stored order (music AND jingles exactly as
 * arranged), applying the same break/top-of-hour cut discipline as music. Helps
 * avoid hot-loops on short items while still stepping through the sequence.
 */
async function produceFromOrderedPlaylist(
  ctx: Ctx,
  ordered: OrderedPlaylistItem[],
  cursorIndex: number,
  _recent: RotationRecent[],
  cursor: number,
  nextWall: number,
  maxDur: number | undefined,
): Promise<{ item: EngineItem | null }> {
  if (ordered.length === 0) return { item: null };
  const entry = ordered[cursorIndex % ordered.length]!;
  const t = entry.track;
  const durMs = t.durationSeconds * 1000;
  const overrunsBreak = maxDur !== undefined && durMs > maxDur * 1000;
  const cutoffAt = overrunsBreak ? nextWall - TAIL_MARGIN_MS : null;
  return {
    item: makeItem({
      trackId: t.id,
      kind: t.kind as EngineItem["kind"],
      title: t.title,
      artist: t.artist,
      durationSec: t.durationSeconds,
      gainDb: t.loudnessGainDb,
      filePath: t.filePath,
      artworkPath: t.artworkPath,
      source: "automation",
      showId: ctx.showId,
      cutoffAt,
    }),
  };
}

/**
 * Plays a pre-produced show rundown in order (looping): each entry is either
 * a specific library track or an uploaded voice link, so a DJ can build a
 * "recorded live" hour with their links exactly where they want them.
 */
async function produceFromRundown(
  ctx: Ctx,
  _cursor: number,
  nextWall: number,
  maxDur: number | undefined,
  index: number,
): Promise<{ item: EngineItem | null }> {
  if (ctx.rundown.length === 0) return { item: null };
  const ref = ctx.rundown[index % ctx.rundown.length]!;

  if (ref.kind === "voice") {
    const v = ref.voice;
    if (!v || !v.isActive) return { item: null };
    return {
      item: makeItem({
        trackId: null,
        kind: "voice",
        title: v.title,
        artist: "",
        durationSec: v.durationSeconds,
        gainDb: v.gainDb,
        filePath: v.filePath,
        source: "voice",
        showId: ctx.showId,
        voiceTrackId: v.id,
      }),
    };
  }

  const t = ref.track;
  if (!t || !t.isActive) return { item: null };
  const durMs = t.durationSeconds * 1000;
  // Same break discipline as playlist music: truncate early so ads still air on time.
  const overrunsBreak = maxDur !== undefined && durMs > maxDur * 1000;
  const cutoffAt = overrunsBreak ? nextWall - TAIL_MARGIN_MS : null;
  return {
    item: makeItem({
      trackId: t.id,
      kind: t.kind as EngineItem["kind"],
      title: t.title,
      artist: t.artist,
      durationSec: t.durationSeconds,
      gainDb: t.loudnessGainDb,
      filePath: t.filePath,
      artworkPath: t.artworkPath,
      source: "automation",
      showId: ctx.showId,
      cutoffAt,
    }),
  };
}

async function currentShowStart(afterMs: number, tz: string, showId: string): Promise<number | null> {
  const entries = await db
    .select()
    .from(schema.scheduleEntries)
    .where(eq(schema.scheduleEntries.showId, showId));
  const p = zonedParts(afterMs, tz);
  let best: number | null = null;
  for (const entry of entries) {
    if (entry.dayOfWeek !== null && entry.dayOfWeek !== p.dayOfWeek) continue;
    const start = p.localMidnightMs + entry.startMinutes * 60_000;
    const candidate = start <= afterMs ? start : start - 24 * 3600_000;
    if (best == null || candidate > best) best = candidate;
  }
  return best;
}

async function nextProgrammingBoundary(
  afterMs: number,
  tz: string,
  currentShowId: string | null,
): Promise<number | null> {
  const entries = await db.select().from(schema.scheduleEntries);
  let nextAt: number | null = null;

  if (entries.length > 0) {
    for (let offset = 0; offset < 8; offset++) {
      const probe = zonedParts(afterMs + offset * 24 * 3600_000, tz);
      const midnight = probe.localMidnightMs;
      for (const entry of entries) {
        if (entry.dayOfWeek !== null && entry.dayOfWeek !== probe.dayOfWeek) continue;
        const startAt = midnight + entry.startMinutes * 60_000;
        const endAt = midnight + entry.endMinutes * 60_000;

        if (currentShowId && entry.showId === currentShowId) {
          if (afterMs >= startAt && afterMs < endAt && (nextAt == null || endAt < nextAt)) nextAt = endAt;
          continue;
        }

        if (startAt > afterMs && (nextAt == null || startAt < nextAt)) nextAt = startAt;
      }
    }
  }

  if (!currentShowId) {
    const rules = await db
      .select()
      .from(schema.stationRotations)
      .where(eq(schema.stationRotations.isActive, true));
    const rotationBoundary = findNextStationRotationBoundary(rules, afterMs, tz);
    if (rotationBoundary != null && (nextAt == null || rotationBoundary < nextAt)) {
      nextAt = rotationBoundary;
    }
  }

  return nextAt;
}

/* ------------------------------------------------------------------ */
/* Ad breaks                                                          */
/* ------------------------------------------------------------------ */

async function produceBreak(
  breakAt: number,
  ctx: Ctx,
  remaining: number,
): Promise<{ items: EngineItem[] }> {
  if (remaining <= 0) return { items: [] };

  const dateStr = zonedDate(breakAt, ctx.tz);
  const p = zonedParts(breakAt, ctx.tz);
  const hourStart = breakAt - p.minute * 60_000 - p.second * 1000;

  const campaigns = await db
    .select()
    .from(schema.adCampaigns)
    .where(eq(schema.adCampaigns.status, "active"));

  const eligible = campaigns.filter(
    (c) => c.startDate <= dateStr && c.endDate >= dateStr && ruleMatches(c, p.dayOfWeek, p.hour),
  );
  if (eligible.length === 0) return { items: [] };

  const trackIds = eligible
    .map((c) => c.audioTrackId)
    .filter((id): id is string => Boolean(id));
  const tracks = await db
    .select()
    .from(schema.tracks)
    .where(inArray(schema.tracks.id, trackIds));
  const trackById = new Map(tracks.map((t) => [t.id, t]));

  const dayStart = zonedDayStart(breakAt, ctx.tz);
  const dayEnd = dayStart + 24 * 3600_000;
  const airings = await db
    .select()
    .from(schema.adAirings)
    .where(inArray(schema.adAirings.campaignId, eligible.map((c) => c.id)));

  const dayCount = new Map<string, number>();
  const hourCount = new Map<string, number>();
  const bookedThisBreak = new Map<string, number>();
  for (const a of airings) {
    const at = a.scheduledFor.getTime();
    if (at >= dayStart && at < dayEnd) dayCount.set(a.campaignId, (dayCount.get(a.campaignId) ?? 0) + 1);
    if (at >= hourStart && at < hourStart + 3600_000) hourCount.set(a.campaignId, (hourCount.get(a.campaignId) ?? 0) + 1);
    if (Math.abs(at - breakAt) < 120_000) bookedThisBreak.set(a.campaignId, (bookedThisBreak.get(a.campaignId) ?? 0) + 1);
  }

  // Last advertiser played, to avoid the same advertiser twice in a row.
  const aired = airings.filter((a) => a.airedAt).sort((a, b) => b.airedAt!.getTime() - a.airedAt!.getTime());
  const lastCampaignId = aired[0]?.campaignId;

  const items: EngineItem[] = [];
  const scheduled: { campaignId: string; trackId: string; at: number }[] = [];
  let cursor = breakAt;
  let durationUsed = 0;
  let placed = 0;
  let firstSpot = true;

  for (const c of eligible) {
    if (items.length >= remaining) break;
    const track = c.audioTrackId ? trackById.get(c.audioTrackId) : undefined;
    if (!track) continue;
    if (firstSpot && c.id === lastCampaignId) continue;
    if ((dayCount.get(c.id) ?? 0) >= c.spotsPerDay) continue;
    if ((hourCount.get(c.id) ?? 0) >= c.maxPerHour) continue;
    if ((bookedThisBreak.get(c.id) ?? 0) > 0) continue; // idempotent across engine fetches

    items.push(
      makeItem({
        trackId: track.id,
        kind: "ad",
        title: track.title,
        artist: track.artist,
        durationSec: track.durationSeconds,
        gainDb: track.loudnessGainDb,
        filePath: track.filePath,
        artworkPath: track.artworkPath,
        source: "ad",
        showId: ctx.showId,
        campaignId: c.id,
        airAt: cursor,
      }),
    );
    scheduled.push({ campaignId: c.id, trackId: track.id, at: cursor });
    cursor += track.durationSeconds * 1000;
    durationUsed += track.durationSeconds;
    placed++;
    firstSpot = false;
    if (durationUsed >= BREAK_TARGET_SEC || placed >= 4) break;
  }

  if (scheduled.length > 0) {
    await db
      .insert(schema.adAirings)
      .values(
        scheduled.map((s) => ({
          campaignId: s.campaignId,
          trackId: s.trackId,
          scheduledFor: new Date(s.at),
          source: "ad",
        })),
      )
      .onConflictDoNothing();
  }

  return { items };
}

function ruleMatches(c: typeof schema.adCampaigns.$inferSelect, dow: number, hour: number): boolean {
  switch (c.whenRule) {
    case "weekday_drivetime":
      return dow >= 1 && dow <= 5 && hour >= 6 && hour <= 19;
    case "weekends":
      return dow === 0 || dow === 6;
    case "custom":
      return (c.customDays ?? []).includes(dow);
    default:
      return true;
  }
}

/**
 * The top-of-hour jingle: the admin-picked station ID plays exactly at the
 * top of the hour (airAt), after the previous track has been faded out.
 * Returns an empty list when none is configured — the hour is still a hard
 * wall, it just isn't voiced.
 */
async function produceTopOfHour(
  hourAt: number,
  ctx: Ctx,
  settings: typeof schema.settings.$inferSelect,
): Promise<{ items: EngineItem[] }> {
  const id = settings.topOfHourTrackId;
  if (!id) return { items: [] };
  const rows = await db
    .select()
    .from(schema.tracks)
    .where(and(eq(schema.tracks.id, id), eq(schema.tracks.isActive, true)))
    .limit(1);
  const track = rows[0];
  if (!track) return { items: [] };
  return {
    items: [
      makeItem({
        trackId: track.id,
        kind: track.kind,
        title: track.title,
        artist: track.artist,
        durationSec: track.durationSeconds,
        gainDb: track.loudnessGainDb,
        filePath: track.filePath,
        artworkPath: track.artworkPath,
        source: "automation",
        showId: ctx.showId,
        airAt: hourAt,
      }),
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeItem(input: {
  trackId: string | null;
  kind: string;
  title: string;
  artist: string;
  durationSec: number;
  gainDb: number;
  filePath: string;
  artworkPath?: string | null;
  source: "automation" | "ad" | "voice" | "live";
  showId: string | null;
  campaignId?: string | null;
  voiceTrackId?: string | null;
  airAt?: number | null;
  cutoffAt?: number | null;
}): EngineItem {
  return {
    id: randomUUID(),
    trackId: input.trackId,
    artworkPath: input.artworkPath ?? null,
    kind: input.kind as EngineItem["kind"],
    title: input.title,
    artist: input.artist,
    durationSec: input.durationSec,
    gainDb: input.gainDb,
    filePath: input.filePath,
    airAt: input.airAt ?? null,
    cutoffAt: input.cutoffAt ?? null,
    source: input.source,
    showId: input.showId,
    campaignId: input.campaignId ?? null,
    voiceTrackId: input.voiceTrackId ?? null,
  };
}

async function trackPool(playlistId: string | null): Promise<WeightedTrack[]> {
  if (!playlistId) return [];
  const rows = await db
    .select({ item: schema.playlistItems, track: schema.tracks })
    .from(schema.playlistItems)
    .innerJoin(schema.tracks, eq(schema.playlistItems.trackId, schema.tracks.id))
    .where(and(eq(schema.playlistItems.playlistId, playlistId), eq(schema.tracks.isActive, true)))
    .orderBy(asc(schema.playlistItems.position));
  return rows
    .filter((r) => r.track.kind === "music")
    .map((r) => ({ track: r.track, weight: r.item.weight }));
}

async function pickKindTrack(kind: string): Promise<typeof schema.tracks.$inferSelect | null> {
  const recent = await recentPlays();
  const recentIds = recent.map((r) => r.trackId).filter(Boolean) as string[];
  const rows = await db
    .select()
    .from(schema.tracks)
    .where(and(eq(schema.tracks.kind, kind), eq(schema.tracks.isActive, true)))
    .limit(50);
  return pickRandom(rows, recentIds);
}

/** Voice links are not used here; see insertVoiceTracks below. */
function clockwheelSlots(clockwheelId: string) {
  return db
    .select()
    .from(schema.clockwheelSlots)
    .where(eq(schema.clockwheelSlots.clockwheelId, clockwheelId))
    .orderBy(asc(schema.clockwheelSlots.position));
}

/** Active jingle pool for the automatic jingle layer (optional folder filter). */
async function autoJinglePool(folder: string | null): Promise<Array<typeof schema.tracks.$inferSelect>> {
  const f = folder && folder.trim().length > 0 ? folder.trim() : null;
  const cond = f
    ? and(eq(schema.tracks.kind, "jingle"), eq(schema.tracks.folder, f), eq(schema.tracks.isActive, true))
    : and(eq(schema.tracks.kind, "jingle"), eq(schema.tracks.isActive, true));
  return db.select().from(schema.tracks).where(cond).orderBy(asc(schema.tracks.id)).limit(200);
}

/**
 * Station "auto jingle" layer: drops a jingle before every Nth music track in
 * plain curated playlist automation and pre-produced (rundown) shows, so the
 * output breathes like a radio station. Skips jingles that have already aired
 * recently, never stacks a jingle next to an existing one, and never inserts
 * right before a track that's been trimmed to land on a break/hour.
 */
async function autoInsertJingles(items: EngineItem[], every: number, folder: string | null): Promise<EngineItem[]> {
  if (every <= 0 || items.length < 2) return items;
  const pool = await autoJinglePool(folder);
  if (pool.length === 0) return items;

  const recent = await recentPlays();
  const recentIds = new Set(recent.map((r) => r.trackId).filter((x): x is string => Boolean(x)));
  const fresh = pool.filter((p) => !recentIds.has(p.id));
  const src = fresh.length > 0 ? fresh : pool;

  const out: EngineItem[] = [];
  let musicSeen = 0;
  let lastIdx = -1;
  for (const item of items) {
    const isMusic = item.kind === "music" && item.source === "automation";
    if (isMusic) {
      musicSeen++;
      const prev = out[out.length - 1];
      const wantJingle =
        musicSeen % every === 0 &&
        out.length > 0 &&
        prev != null &&
        prev.kind === "music" &&
        item.cutoffAt == null;
      if (wantJingle) {
        const pick =
          src.length === 1
            ? 0
            : lastIdx < 0
              ? Math.floor(Math.random() * src.length)
              : (lastIdx + 1 + Math.floor(Math.random() * (src.length - 1))) % src.length;
        const t = src[pick]!;
        lastIdx = pick;
        out.push({
          id: randomUUID(),
          trackId: t.id,
          artworkPath: t.artworkPath ?? null,
          kind: "jingle",
          title: t.title || "Jingle",
          artist: t.artist ?? "",
          durationSec: Math.max(0.2, t.durationSeconds),
          gainDb: t.loudnessGainDb,
          filePath: t.filePath,
          airAt: null,
          cutoffAt: null,
          source: "automation",
          showId: item.showId,
          campaignId: null,
          voiceTrackId: null,
        });
      }
    }
    out.push(item);
  }
  return out;
}

/** Inserts voice tracks before every Nth music item while a show is on air. */
function insertVoiceTracks(items: EngineItem[], ctx: Ctx): EngineItem[] {
  if (ctx.voiceTracks.length === 0) return items;
  const out: EngineItem[] = [];
  let musicSeen = 0;
  let vi = 0;
  for (const item of items) {
    const isMusic = item.kind === "music" && item.source === "automation";
    if (isMusic) {
      musicSeen++;
      const vt = ctx.voiceTracks[vi % ctx.voiceTracks.length]!;
      const shouldInsert =
        musicSeen % vt.playEvery === 0 &&
        out.length > 0 &&
        out[out.length - 1]!.kind !== "voice";
      if (shouldInsert) {
        out.push({
          id: randomUUID(),
          trackId: null,
          artworkPath: null,
          kind: "voice",
          title: `Voice link`,
          artist: "",
          durationSec: vt.durationSeconds,
          gainDb: vt.gainDb,
          filePath: vt.filePath,
          airAt: null,
          cutoffAt: null,
          source: "voice",
          showId: ctx.showId,
          campaignId: null,
          voiceTrackId: vt.id,
        });
        vi++;
      }
    }
    out.push(item);
  }
  return out;
}

/**
 * Wall-clock boundary helpers. zonedParts derives localMidnightMs from the
 * instant, which inherits its sub-second component — floor it so boundaries
 * land on whole seconds (otherwise the top of the hour drifts by up to ~1s).
 */
function zonedMidnightFloor(ts: number, tz: string): number {
  const p = zonedParts(ts, tz);
  return Math.floor(p.localMidnightMs / 1000) * 1000;
}

/** Next :15 or :45 break strictly after `ts`, in the station timezone. */
export function nextBreakTime(ts: number, tz: string): number {
  const p = zonedParts(ts, tz);
  let targetMinute = DEFAULT_BREAKS.find((b) => b > p.minute);
  let delta = 0;
  if (targetMinute === undefined) {
    targetMinute = DEFAULT_BREAKS[0]!;
    delta = 1;
  }
  const breakMinutesOfDay = p.minutesOfDay - p.minute + targetMinute + delta * 60;
  return zonedMidnightFloor(ts, tz) + breakMinutesOfDay * 60_000;
}

/** Next top-of-hour (HH:00:00.000) strictly after `ts`, in the station timezone. */
export function nextHourTime(ts: number, tz: string): number {
  const p = zonedParts(ts, tz);
  let hourStart = zonedMidnightFloor(ts, tz) + (p.minutesOfDay - p.minute) * 60_000;
  if (hourStart <= ts) hourStart += 3600_000;
  return hourStart;
}

/** Filler for the play_log SQL ordering. */
export { desc as orderDesc, type SQL };
