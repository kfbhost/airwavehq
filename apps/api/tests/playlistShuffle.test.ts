import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceShufflePass,
  seededShuffle,
  shuffleMusicOnly,
  shufflePassOf,
  shuffleSeedFor,
  stepPlaylistCursor,
} from "../src/services/playlistShuffle.js";

type Row = { track: { id: string; kind: string } };

function rows(spec: Array<[string, string]>): Row[] {
  return spec.map(([id, kind]) => ({ track: { id, kind } }));
}

const music = (n: number) => Array.from({ length: n }, (_, i) => `m${i + 1}` as string);

describe("seededShuffle", () => {
  it("gives the same order for the same seed", () => {
    const a = seededShuffle(music(20), "seed-1");
    const b = seededShuffle(music(20), "seed-1");
    expect(a).toEqual(b);
  });

  it("gives a different order for a different seed", () => {
    const a = seededShuffle(music(20), "seed-1");
    const b = seededShuffle(music(20), "seed-2");
    expect(a).not.toEqual(b);
  });

  it("never loses or duplicates an entry", () => {
    const input = music(25);
    const out = seededShuffle(input, "seed-3");
    expect(out).toHaveLength(input.length);
    expect([...out].sort()).toEqual([...input].sort());
  });
});

describe("shuffleMusicOnly", () => {
  it("keeps jingles and other production items exactly where they were placed", () => {
    const input = rows([
      ["music-a", "music"],
      ["jingle-1", "jingle"],
      ["music-b", "music"],
      ["music-c", "music"],
      ["sweeper-1", "sweeper"],
      ["music-d", "music"],
    ]);

    const out = shuffleMusicOnly(input, "pass-1");
    const jinglePositions = (rs: Row[]) => rs.flatMap((r, i) => (r.track.kind === "music" ? [] : [i]));
    expect(jinglePositions(out)).toEqual(jinglePositions(input));
    expect(out[1]!.track.id).toBe("jingle-1");
    expect(out[4]!.track.id).toBe("sweeper-1");
  });

  it("reorders the same music set differently on another seed", () => {
    const input = rows(music(12).map((id) => [id, "music"] as [string, string]));
    const a = shuffleMusicOnly(input, "pass-1").map((r) => r.track.id);
    const b = shuffleMusicOnly(input, "pass-2").map((r) => r.track.id);
    expect([...a].sort()).toEqual([...b].sort());
    expect(a).not.toEqual(b);
  });

  it("leaves a playlist with no music untouched", () => {
    const input = rows([
      ["jingle-1", "jingle"],
      ["jingle-2", "jingle"],
    ]);
    expect(shuffleMusicOnly(input, "pass-1")).toEqual(input);
  });
});

describe("stepPlaylistCursor", () => {
  it("walks the whole playlist and only then reports the pass as finished", () => {
    let cursor = 0;
    let completions = 0;
    for (let i = 0; i < 4; i++) {
      const step = stepPlaylistCursor(cursor, 4);
      cursor = step.cursor;
      if (step.completed) completions++;
    }
    expect(cursor).toBe(0);
    expect(completions).toBe(1);
  });

  it("completes the pass on the step that wraps back to the top", () => {
    expect(stepPlaylistCursor(2, 3)).toEqual({ cursor: 0, completed: true });
    expect(stepPlaylistCursor(1, 3)).toEqual({ cursor: 2, completed: false });
  });

  it("never divides by zero on an empty playlist", () => {
    expect(stepPlaylistCursor(0, 0)).toEqual({ cursor: 0, completed: true });
  });
});

describe("shuffle pass tracking", () => {
  const playlistId = `pl-${Math.random().toString(36).slice(2, 8)}`;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("starts on pass 0 and advances one pass at a time", () => {
    expect(shufflePassOf(playlistId)).toBe(0);
    expect(advanceShufflePass(playlistId)).toBe(1);
    expect(advanceShufflePass(playlistId)).toBe(2);
    expect(shufflePassOf(playlistId)).toBe(2);
  });

  it("keeps one stable seed for the whole pass and changes it for the next", () => {
    const first = shuffleSeedFor(playlistId);
    expect(shuffleSeedFor(playlistId)).toBe(first);
    advanceShufflePass(playlistId);
    const second = shuffleSeedFor(playlistId);
    expect(second).not.toBe(first);
  });

  it("produces a different running order for the next pass", () => {
    const input = rows(music(30).map((id) => [id, "music"] as [string, string]));
    const passOne = shuffleMusicOnly(input, shuffleSeedFor(playlistId)).map((r) => r.track.id);
    advanceShufflePass(playlistId);
    const passTwo = shuffleMusicOnly(input, shuffleSeedFor(playlistId)).map((r) => r.track.id);
    expect(passTwo).not.toEqual(passOne);
  });

  it("tracks playlists independently", () => {
    const other = `${playlistId}-b`;
    advanceShufflePass(playlistId);
    expect(shufflePassOf(other)).toBe(0);
  });
});
