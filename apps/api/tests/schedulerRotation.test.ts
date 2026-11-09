import { describe, expect, it } from "vitest";
import { resolveMusicSlotPlaylistId } from "../src/services/scheduler.js";

describe("resolveMusicSlotPlaylistId", () => {
  it("uses the active station rotation for default automation even when a slot has its own playlist", () => {
    const playlistId = resolveMusicSlotPlaylistId({
      slotPlaylistId: "slot-playlist",
      contextPlaylistId: "context-playlist",
      showId: null,
      stationRotationPlaylistId: "rotation-playlist",
    });

    expect(playlistId).toBe("rotation-playlist");
  });

  it("keeps slot-specific playlists for scheduled shows", () => {
    const playlistId = resolveMusicSlotPlaylistId({
      slotPlaylistId: "slot-playlist",
      contextPlaylistId: "show-playlist",
      showId: "show-123",
      stationRotationPlaylistId: "rotation-playlist",
    });

    expect(playlistId).toBe("slot-playlist");
  });

  it("falls back to the slot or context playlist when no station rotation is active", () => {
    expect(
      resolveMusicSlotPlaylistId({
        slotPlaylistId: "slot-playlist",
        contextPlaylistId: "context-playlist",
        showId: null,
        stationRotationPlaylistId: null,
      }),
    ).toBe("slot-playlist");

    expect(
      resolveMusicSlotPlaylistId({
        slotPlaylistId: null,
        contextPlaylistId: "context-playlist",
        showId: null,
        stationRotationPlaylistId: null,
      }),
    ).toBe("context-playlist");
  });
});
