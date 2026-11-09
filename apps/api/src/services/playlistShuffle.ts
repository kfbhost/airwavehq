/**
 * Helpers for the per-playlist "shuffle each pass" option.
 *
 * A long playlist (a 24-hour "default" for example) is walked in stored order
 * and then loops from the top. With shuffle on, the MUSIC is resolved into a
 * fresh order for every pass, so the same running order never plays twice in a
 * row. Jingles, sweepers, voice links and station IDs keep the exact slots the
 * admin placed them in — only music swaps places with other music.
 */

/** FNV-1a string hash → PRNG seed. */
export function hashSeed(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Small deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic Fisher–Yates shuffle: the same seed always gives the same order. */
export function seededShuffle<T>(arr: readonly T[], seed: string): T[] {
  const copy = [...arr];
  const rand = mulberry32(hashSeed(seed));
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/**
 * Shuffles only the music rows, leaving every other kind (jingle, sweeper,
 * voice, station id) in the position it was placed. The result is always the
 * same length as the input and contains each row exactly once.
 */
export function shuffleMusicOnly<T extends { track: { kind: string } }>(
  rows: readonly T[],
  seedKey: string,
): T[] {
  const shuffled = seededShuffle(
    rows.filter((r) => r.track.kind === "music"),
    seedKey,
  );
  let mi = 0;
  return rows.map((r) => (r.track.kind === "music" ? shuffled[mi++]! : r));
}

/**
 * Advances one step through an ordered playlist, reporting whether that step
 * walked off the end — which is what marks a pass as finished.
 */
export function stepPlaylistCursor(
  cursor: number,
  length: number,
): { cursor: number; completed: boolean } {
  const size = Math.max(1, length);
  const next = cursor + 1;
  return { cursor: next % size, completed: next >= size };
}

/* ------------------------------------------------------------------ */
/* Pass tracking                                                       */
/*                                                                     */
/* One shuffled order is kept for the whole of a pass so every engine  */
/* fetch window continues the same sequence. When the cursor wraps     */
/* past the end the pass is advanced, so the next pass resolves a      */
/* different order instead of replaying the previous one.              */
/* ------------------------------------------------------------------ */

const passByPlaylist = new Map<string, number>();

/** Randomised per process: a restart never replays the previous order. */
const SESSION_SALT = Math.random().toString(36).slice(2, 10);

export function shufflePassOf(playlistId: string): number {
  return passByPlaylist.get(playlistId) ?? 0;
}

/** Marks the current pass as finished and returns the new pass number. */
export function advanceShufflePass(playlistId: string): number {
  const next = shufflePassOf(playlistId) + 1;
  passByPlaylist.set(playlistId, next);
  return next;
}

/**
 * Seed for the current pass. Stable for every fetch within a pass, and
 * different for the next pass, the next playlist, and the next process.
 */
export function shuffleSeedFor(playlistId: string): string {
  return `${playlistId}|music|pass:${shufflePassOf(playlistId)}|${SESSION_SALT}`;
}
