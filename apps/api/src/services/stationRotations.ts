import { eq } from "drizzle-orm";
import { zonedDate, zonedParts } from "@airshift/shared";
import { db, schema } from "../db/client.js";
import type { DbStationRotation } from "../db/schema.js";

export interface StationRotationMatchInput {
  id?: string;
  dayOfWeek: number | null;
  startHour: number;
  endHour: number;
  playlistId: string | null;
  clockwheelId: string | null;
  autoGenerate?: boolean;
  isActive: boolean;
  priority: number;
}

export interface StationRotationMoment {
  dayOfWeek: number;
  hour: number;
}

const DAY_PLAYLIST_COLUMNS = [
  "sundayPlaylistId",
  "mondayPlaylistId",
  "tuesdayPlaylistId",
  "wednesdayPlaylistId",
  "thursdayPlaylistId",
  "fridayPlaylistId",
  "saturdayPlaylistId",
] as const;

type DayPlaylistRotation = {
  dayOfWeek: number | null;
  playlistId: string | null;
} & { [K in (typeof DAY_PLAYLIST_COLUMNS)[number]]: string | null };

/**
 * Resolves which playlist a rotation should actually play for a given day.
 * For a daily block (dayOfWeek === null) the per-day playlist for that day is
 * used when set, otherwise the block's main playlistId. Specific-day blocks
 * always use their own playlistId.
 */
export function rotationPlaylistForDay(rotation: DayPlaylistRotation, dayOfWeek: number): string | null {
  if (rotation.dayOfWeek !== null) return rotation.playlistId;
  const column = DAY_PLAYLIST_COLUMNS[dayOfWeek] ?? null;
  const dayId = column ? rotation[column] : null;
  return dayId ?? rotation.playlistId;
}

export function pickActiveStationRotation<T extends StationRotationMatchInput>(
  rules: readonly T[],
  now: StationRotationMoment,
): T | null {
  return [...rules]
    .filter(
      (rule) =>
        rule.isActive &&
        (rule.dayOfWeek === null || rule.dayOfWeek === now.dayOfWeek) &&
        rule.startHour <= now.hour &&
        now.hour < rule.endHour,
    )
    .sort((a, b) => {
      const specificity = Number(b.dayOfWeek !== null) - Number(a.dayOfWeek !== null);
      if (specificity !== 0) return specificity;
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.startHour - b.startHour;
    })[0] ?? null;
}

export async function resolveStationRotation(
  afterMs: number,
  tz: string,
): Promise<DbStationRotation | null> {
  const now = zonedParts(afterMs, tz);
  const rules = await db
    .select()
    .from(schema.stationRotations)
    .where(eq(schema.stationRotations.isActive, true));
  return pickActiveStationRotation(rules, { dayOfWeek: now.dayOfWeek, hour: now.hour });
}

/**
 * Effective content identity for a rule at a probe instant (per-day aware).
 * Auto-generating rules key on rotation id + local date, so the boundary
 * detector fires at each local midnight (fresh daily list) and between two
 * different auto-generating blocks.
 */
function rotationKeyAt<T extends StationRotationMatchInput>(
  rule: T | null,
  atMs: number,
  tz: string,
): string | null {
  if (!rule) return null;
  if (rule.autoGenerate) {
    return `autogen:${rule.id ?? rule.playlistId ?? "rotation"}:${zonedDate(atMs, tz)}`;
  }
  const dayOfWeek = zonedParts(atMs, tz).dayOfWeek;
  const dayPlaylist = rotationPlaylistForDay(rule as unknown as DayPlaylistRotation, dayOfWeek);
  return dayPlaylist ?? rule.playlistId ?? rule.clockwheelId;
}

export function findNextStationRotationBoundary<T extends StationRotationMatchInput>(
  rules: readonly T[],
  afterMs: number,
  tz: string,
): number | null {
  const now = zonedParts(afterMs, tz);
  const current = pickActiveStationRotation(rules, { dayOfWeek: now.dayOfWeek, hour: now.hour });
  const currentKey = rotationKeyAt(current, afterMs, tz);

  for (let offset = 0; offset < 8; offset++) {
    const probe = zonedParts(afterMs + offset * 24 * 3600_000, tz);
    const midnight = probe.localMidnightMs;
    for (let hour = 0; hour < 24; hour++) {
      const boundaryAt = midnight + hour * 3600_000;
      if (boundaryAt <= afterMs) continue;
      const boundary = zonedParts(boundaryAt, tz);
      const next = pickActiveStationRotation(rules, { dayOfWeek: boundary.dayOfWeek, hour: boundary.hour });
      const nextKey = rotationKeyAt(next, boundaryAt, tz);
      if (nextKey !== currentKey) return boundaryAt;
    }
  }

  return null;
}
