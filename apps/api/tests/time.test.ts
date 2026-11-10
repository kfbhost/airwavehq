import { describe, expect, it } from "vitest";
import { zonedParts, minutesToHHMM, hhmmToMinutes } from "@airshift/shared";
import { nextBreakTime, nextHourTime } from "../src/services/scheduler.js";

describe("zonedParts", () => {
  it("returns wall-clock parts in the given zone", () => {
    // 2026-09-01T12:00:00Z = 13:00 BST (London, UTC+1)
    const p = zonedParts(Date.parse("2026-09-01T12:00:00Z"), "Europe/London");
    expect(p.hour).toBe(13);
    expect(p.minute).toBe(0);
    expect(p.dayOfWeek).toBe(2); // Tuesday
  });

  it("computes local midnight correctly", () => {
    const p = zonedParts(Date.parse("2026-09-01T12:00:00Z"), "UTC");
    const midnight = new Date(p.localMidnightMs).toISOString();
    expect(midnight).toBe("2026-09-01T00:00:00.000Z");
  });
});

describe("nextBreakTime", () => {
  const tz = "UTC";
  it("returns the next :15 break", () => {
    const at = Date.parse("2026-09-01T12:00:00Z");
    expect(new Date(nextBreakTime(at, tz)).toISOString()).toBe("2026-09-01T12:15:00.000Z");
  });
  it("returns the next :45 after :15", () => {
    const at = Date.parse("2026-09-01T12:16:00Z");
    expect(new Date(nextBreakTime(at, tz)).toISOString()).toBe("2026-09-01T12:45:00.000Z");
  });
  it("wraps to the next hour", () => {
    const at = Date.parse("2026-09-01T12:50:00Z");
    expect(new Date(nextBreakTime(at, tz)).toISOString()).toBe("2026-09-01T13:15:00.000Z");
  });
  it("works in a non-UTC zone", () => {
    const at = Date.parse("2026-09-01T11:00:00Z"); // 12:00 BST
    const b = nextBreakTime(at, "Europe/London");
    expect(new Date(b).toISOString()).toBe("2026-09-01T11:15:00.000Z");
  });
});

describe("nextHourTime", () => {
  const tz = "UTC";
  it("returns the top of the next hour after a mid-hour time", () => {
    const at = Date.parse("2026-09-01T12:34:56Z");
    expect(new Date(nextHourTime(at, tz)).toISOString()).toBe("2026-09-01T13:00:00.000Z");
  });
  it("returns the next hour when exactly on the hour", () => {
    const at = Date.parse("2026-09-01T12:00:00Z");
    expect(new Date(nextHourTime(at, tz)).toISOString()).toBe("2026-09-01T13:00:00.000Z");
  });
  it("returns the next hour just before the hour", () => {
    const at = Date.parse("2026-09-01T12:59:59Z");
    expect(new Date(nextHourTime(at, tz)).toISOString()).toBe("2026-09-01T13:00:00.000Z");
  });
  it("respects the station timezone", () => {
    // 12:00 UTC = 13:00 BST; top of the local hour is 13:00 BST = 12:00 UTC.
    const at = Date.parse("2026-09-01T12:30:00Z");
    expect(new Date(nextHourTime(at, "Europe/London")).toISOString()).toBe("2026-09-01T13:00:00.000Z");
  });
});

describe("time formatting", () => {
  it("round-trips HH:MM", () => {
    expect(hhmmToMinutes("13:45")).toBe(825);
    expect(minutesToHHMM(825)).toBe("13:45");
    expect(minutesToHHMM(0)).toBe("00:00");
    expect(minutesToHHMM(1440)).toBe("00:00"); // wraps
  });
});
