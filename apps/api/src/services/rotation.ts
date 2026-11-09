import type { DbTrack } from "../db/schema.js";

export interface RotationRecent {
  trackId: string | null;
  artist: string;
  playedAt: Date;
}

export interface RotationRules {
  artistSeparation: number; // plays between same artist
  trackSeparationMinutes: number; // minutes between same track
}

export interface WeightedTrack {
  track: DbTrack;
  weight: number;
}

/**
 * Picks the next track from a pool respecting rotation rules.
 * Falls back gracefully when the pool is too small to satisfy all rules.
 * `recent[0]` must be the most recent play. `refTimeMs` is the sequence's
 * current cursor (so planned plays in the future still respect separation).
 */
export function pickMusic(
  pool: WeightedTrack[],
  recent: RotationRecent[],
  rules: RotationRules,
  maxDurationSec?: number,
  refTimeMs = Date.now(),
): DbTrack | null {
  if (pool.length === 0) return null;

  let candidates = pool;

  // Duration constraint (used to fit a track before an ad break).
  if (maxDurationSec && maxDurationSec > 5) {
    const fitting = pool.filter((w) => w.track.durationSeconds <= maxDurationSec);
    if (fitting.length > 0) candidates = fitting;
  }

  const withinPlays = (artist: string, n: number) =>
    recent.slice(0, Math.max(0, n)).some((r) => r.artist && r.artist === artist);

  const withinMinutes = (trackId: string, mins: number) =>
    recent.some(
      (r) =>
        r.trackId === trackId &&
        mins > 0 &&
        refTimeMs - r.playedAt.getTime() < mins * 60_000,
    );

  // Strict: artist separation + track separation.
  let filtered = candidates.filter(
    (w) =>
      !withinPlays(w.track.artist, rules.artistSeparation) &&
      !withinMinutes(w.track.id, rules.trackSeparationMinutes),
  );
  if (filtered.length === 0) {
    // Relax artist separation, keep track separation.
    filtered = candidates.filter(
      (w) => !withinMinutes(w.track.id, rules.trackSeparationMinutes),
    );
  }
  if (filtered.length === 0) {
    // Even in a degenerate pool (everything recently played), never repeat
    // the immediately-last track back to back.
    const last = recent[0];
    filtered = candidates.filter((w) => !last || w.track.id !== last.trackId);
  }
  if (filtered.length === 0) {
    filtered = candidates;
  }

  return weightedPick(filtered);
}

export function weightedPick(pool: WeightedTrack[]): DbTrack {
  const total = pool.reduce((sum, w) => sum + Math.max(1, w.weight), 0);
  let roll = Math.random() * total;
  for (const w of pool) {
    roll -= Math.max(1, w.weight);
    if (roll <= 0) return w.track;
  }
  return pool[pool.length - 1]!.track;
}

/** Random pick from a pool of same-kind tracks, avoiding a recently-used one. */
export function pickRandom(
  pool: DbTrack[],
  recentIds: string[],
  recentCount = 3,
): DbTrack | null {
  if (pool.length === 0) return null;
  const avoided = new Set(recentIds.slice(0, recentCount));
  const candidates = pool.filter((t) => !avoided.has(t.id));
  const from = candidates.length > 0 ? candidates : pool;
  return from[Math.floor(Math.random() * from.length)] ?? null;
}
