import { describe, expect, it } from "vitest";
import {
  findNextStationRotationBoundary,
  pickActiveStationRotation,
  rotationPlaylistForDay,
} from "../src/services/stationRotations.js";

describe("pickActiveStationRotation", () => {
  it("prefers an exact weekday rule over an all-days rule", () => {
    const rules = [
      {
        id: "daily",
        dayOfWeek: null,
        startHour: 9,
        endHour: 12,
        playlistId: "pl-day",
        clockwheelId: null,
        isActive: true,
        priority: 0,
      },
      {
        id: "mon",
        dayOfWeek: 1,
        startHour: 9,
        endHour: 12,
        playlistId: "pl-monday",
        clockwheelId: null,
        isActive: true,
        priority: 0,
      },
    ];

    const chosen = pickActiveStationRotation(rules, { dayOfWeek: 1, hour: 10 });
    expect(chosen?.playlistId).toBe("pl-monday");
  });

  it("prefers higher priority within the same coverage window", () => {
    const rules = [
      {
        id: "low",
        dayOfWeek: null,
        startHour: 6,
        endHour: 10,
        playlistId: "pl-low",
        clockwheelId: null,
        isActive: true,
        priority: 1,
      },
      {
        id: "high",
        dayOfWeek: null,
        startHour: 6,
        endHour: 10,
        playlistId: "pl-high",
        clockwheelId: null,
        isActive: true,
        priority: 5,
      },
    ];

    const chosen = pickActiveStationRotation(rules, { dayOfWeek: 2, hour: 7 });
    expect(chosen?.playlistId).toBe("pl-high");
  });

  it("returns null when no active rule covers the current hour", () => {
    const rules = [
      {
        id: "drive",
        dayOfWeek: null,
        startHour: 6,
        endHour: 10,
        playlistId: "pl-drive",
        clockwheelId: null,
        isActive: false,
        priority: 0,
      },
    ];

    const chosen = pickActiveStationRotation(rules, { dayOfWeek: 1, hour: 13 });
    expect(chosen).toBeNull();
  });
});

describe("findNextStationRotationBoundary", () => {
  it("returns the next hour when a rotation is about to start", () => {
    const rules = [
      {
        id: "morning",
        dayOfWeek: null,
        startHour: 9,
        endHour: 12,
        playlistId: "pl-morning",
        clockwheelId: null,
        isActive: true,
        priority: 0,
      },
    ];

    const boundary = findNextStationRotationBoundary(rules, Date.parse("2026-08-31T08:45:00Z"), "UTC");
    expect(boundary).toBe(Date.parse("2026-08-31T09:00:00Z"));
  });

  it("returns the next hour when a rotation is about to end", () => {
    const rules = [
      {
        id: "morning",
        dayOfWeek: null,
        startHour: 9,
        endHour: 12,
        playlistId: "pl-morning",
        clockwheelId: null,
        isActive: true,
        priority: 0,
      },
    ];

    const boundary = findNextStationRotationBoundary(rules, Date.parse("2026-08-31T11:15:00Z"), "UTC");
    expect(boundary).toBe(Date.parse("2026-08-31T12:00:00Z"));
  });

  it("fires a boundary at local midnight for an auto-generating daily block", () => {
    const rules = [
      {
        id: "overnight",
        dayOfWeek: null,
        startHour: 0,
        endHour: 5,
        playlistId: "pl-fallback",
        clockwheelId: null,
        autoGenerate: true,
        isActive: true,
        priority: 0,
      },
    ];

    // 23:30 on the 31st → the key (rotation id + date) flips at the 1st midnight.
    const boundary = findNextStationRotationBoundary(rules, Date.parse("2026-08-31T23:30:00Z"), "UTC");
    expect(boundary).toBe(Date.parse("2026-09-01T00:00:00Z"));
  });
});

describe("rotationPlaylistForDay", () => {
  const daily = {
    id: "daily",
    dayOfWeek: null,
    startHour: 0,
    endHour: 5,
    playlistId: "pl-main",
    clockwheelId: null,
    sundayPlaylistId: null,
    mondayPlaylistId: "pl-mon",
    tuesdayPlaylistId: "pl-tue",
    wednesdayPlaylistId: null,
    thursdayPlaylistId: "pl-thu",
    fridayPlaylistId: null,
    saturdayPlaylistId: "pl-sat",
    isActive: true,
    priority: 0,
  };

  const specificDay = { ...daily, dayOfWeek: 3, playlistId: "pl-wed-specific" };

  it("uses the per-day playlist when set on a daily block", () => {
    expect(rotationPlaylistForDay(daily, 1)).toBe("pl-mon");
    expect(rotationPlaylistForDay(daily, 2)).toBe("pl-tue");
    expect(rotationPlaylistForDay(daily, 4)).toBe("pl-thu");
    expect(rotationPlaylistForDay(daily, 6)).toBe("pl-sat");
  });

  it("falls back to the block playlist on days left blank", () => {
    expect(rotationPlaylistForDay(daily, 0)).toBe("pl-main");
    expect(rotationPlaylistForDay(daily, 3)).toBe("pl-main");
    expect(rotationPlaylistForDay(daily, 5)).toBe("pl-main");
  });

  it("always uses its own playlist for a specific-day block", () => {
    expect(rotationPlaylistForDay(specificDay, 3)).toBe("pl-wed-specific");
    expect(rotationPlaylistForDay(specificDay, 1)).toBe("pl-wed-specific");
  });
});
