import { describe, expect, it } from "vitest";
import { pickMusic, weightedPick } from "../src/services/rotation.js";
import type { DbTrack } from "../src/db/schema.js";

function track(id: string, artist: string, durationSeconds = 180): DbTrack {
  return {
    id,
    title: id,
    artist,
    album: "",
    folder: null,
    kind: "music",
    durationSeconds,
    filePath: `/media/${id}.mp3`,
    fileHash: null,
    fileSize: 1,
    mime: "audio/mpeg",
    codec: "mp3",
    bitrateKbps: 128,
    loudnessGainDb: 0,
    loudnessLufs: -16,
    artworkPath: null,
    bpm: null,
    playCount: 0,
    lastPlayedAt: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const pool = (tracks: DbTrack[]) => tracks.map((t) => ({ track: t, weight: 1 }));

describe("pickMusic", () => {
  it("picks a track from a non-empty pool", () => {
    const t = track("a", "Artist A");
    const picked = pickMusic(pool([t]), [], { artistSeparation: 3, trackSeparationMinutes: 30 });
    expect(picked?.id).toBe("a");
  });

  it("avoids the same artist within artistSeparation plays", () => {
    const a1 = track("a1", "Same Artist");
    const a2 = track("a2", "Same Artist");
    const b = track("b", "Other Artist");
    const recent = [{ trackId: a1.id, artist: a1.artist, playedAt: new Date() }];
    const picked = pickMusic(pool([a1, a2, b]), recent, { artistSeparation: 3, trackSeparationMinutes: 30 });
    expect(picked?.artist).not.toBe("Same Artist");
  });

  it("avoids the same track within trackSeparationMinutes", () => {
    const t = track("t", "Artist");
    const other = track("o", "Other");
    const recent = [{ trackId: t.id, artist: t.artist, playedAt: new Date() }];
    const picked = pickMusic(pool([t, other]), recent, { artistSeparation: 0, trackSeparationMinutes: 60 });
    expect(picked?.id).toBe("o");
  });

  it("falls back when the pool is too small to satisfy rules", () => {
    const t = track("t", "Only Artist");
    const recent = [
      { trackId: t.id, artist: t.artist, playedAt: new Date() },
      { trackId: t.id, artist: t.artist, playedAt: new Date() },
    ];
    const picked = pickMusic(pool([t]), recent, { artistSeparation: 5, trackSeparationMinutes: 9999 });
    expect(picked?.id).toBe("t"); // relaxes rather than returning nothing
  });

  it("respects a maxDuration constraint when possible", () => {
    const short = track("s", "Artist", 30);
    const long = track("l", "Other", 300);
    const picked = pickMusic(pool([short, long]), [], { artistSeparation: 0, trackSeparationMinutes: 0 }, 60);
    expect(picked?.id).toBe("s");
  });

  it("returns null for an empty pool", () => {
    expect(pickMusic([], [], { artistSeparation: 1, trackSeparationMinutes: 1 })).toBeNull();
  });
});

describe("weightedPick", () => {
  it("respects weights statistically", () => {
    const a = track("a", "A");
    const b = track("b", "B");
    let aCount = 0;
    const rounds = 2000;
    for (let i = 0; i < rounds; i++) {
      const picked = weightedPick([
        { track: a, weight: 9 },
        { track: b, weight: 1 },
      ]);
      if (picked.id === "a") aCount++;
    }
    expect(aCount).toBeGreaterThan(rounds * 0.8);
  });
});
