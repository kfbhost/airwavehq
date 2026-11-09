/**
 * Timezone helpers. Everything is stored as UTC timestamps; all
 * "what time is it at the station" logic uses these helpers so we
 * never pull in a timezone database dependency.
 */

const CACHE = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = CACHE.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    CACHE.set(tz, f);
  }
  return f;
}

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  dayOfWeek: number; // 0=Sunday..6=Saturday
  hour: number;
  minute: number;
  second: number;
  /** minutes since midnight in the zone */
  minutesOfDay: number;
  /** epoch ms of the zone's midnight for that local date */
  localMidnightMs: number;
}

const DOW: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Returns the wall-clock parts of `tsMs` in `tz`.
 * The zone offset is derived from the formatter itself: for the instant tsMs,
 * formatToParts gives local fields; comparing those fields as UTC yields the offset.
 */
export function zonedParts(tsMs: number, tz: string): ZonedParts {
  const parts = formatter(tz).formatToParts(new Date(tsMs));
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  const hour = Number(map.hour);
  const minute = Number(map.minute);
  const second = Number(map.second);
  const dow = DOW[map.weekday ?? "Sun"] ?? 0;
  // Offset of this zone at tsMs: local fields interpreted as UTC, minus actual instant.
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetMs = asUtc - tsMs;
  return {
    year,
    month,
    day,
    dayOfWeek: dow,
    hour,
    minute,
    second,
    minutesOfDay: hour * 60 + minute,
    localMidnightMs: Date.UTC(year, month - 1, day) - offsetMs,
  };
}

/** Epoch ms of local midnight for a given local date in `tz`. */
export function zonedMidnight(year: number, month: number, day: number, tz: string): number {
  // Derive the offset at 12:00 local (midday is never within an hour of a
  // DST jump in practice) without recursion.
  const noonUtc = Date.UTC(year, month - 1, day, 12);
  const p = zonedParts(noonUtc, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offsetMs = asUtc - noonUtc;
  return Date.UTC(year, month - 1, day) - offsetMs;
}

/** ISO date (YYYY-MM-DD) of `tsMs` in `tz`. */
export function zonedDate(tsMs: number, tz: string): string {
  const p = zonedParts(tsMs, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** The station-local midnight (epoch ms) for the local date containing `tsMs`. */
export function zonedDayStart(tsMs: number, tz: string): number {
  const p = zonedParts(tsMs, tz);
  return p.localMidnightMs;
}

/** Formats a UTC timestamp as an ISO string (with ms). */
export function iso(tsMs: number): string {
  return new Date(tsMs).toISOString();
}

/** Parses "HH:MM" to minutes. */
export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Formats minutes-since-midnight as "HH:MM" (24h). */
export function minutesToHHMM(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
