import { describe, expect, it } from "vitest";
import {
  describeRotationWindow,
  describeScheduleWindow,
  findRotationConflict,
  findScheduleConflict,
} from "../src/services/scheduleConflicts.js";

describe("schedule conflict helpers", () => {
  it("finds overlapping show entries including daily entries", () => {
    const conflict = findScheduleConflict(
      { dayOfWeek: 1, startMinutes: 9 * 60, endMinutes: 10 * 60 },
      [
        { id: "daily", dayOfWeek: null, startMinutes: 8 * 60 + 30, endMinutes: 9 * 60 + 30, showName: "Breakfast" },
      ],
    );

    expect(conflict?.id).toBe("daily");
  });

  it("finds overlapping active rotations", () => {
    const conflict = findRotationConflict(
      { dayOfWeek: 2, startMinutes: 14 * 60, endMinutes: 15 * 60 },
      [
        { id: "weekday", dayOfWeek: 2, startHour: 13, endHour: 16, name: "Afternoons", isActive: true },
      ],
    );

    expect(conflict?.id).toBe("weekday");
  });

  it("ignores paused rotations and excluded schedule ids", () => {
    expect(
      findScheduleConflict(
        { dayOfWeek: 3, startMinutes: 10 * 60, endMinutes: 11 * 60 },
        [
          { id: "same", dayOfWeek: 3, startMinutes: 10 * 60, endMinutes: 11 * 60, showName: "Brunch" },
        ],
        "same",
      ),
    ).toBeNull();

    expect(
      findRotationConflict(
        { dayOfWeek: 3, startMinutes: 10 * 60, endMinutes: 11 * 60 },
        [
          { id: "paused", dayOfWeek: 3, startHour: 10, endHour: 12, name: "Paused", isActive: false },
        ],
      ),
    ).toBeNull();
  });

  it("formats human-readable windows", () => {
    expect(describeScheduleWindow({ dayOfWeek: null, startMinutes: 9 * 60, endMinutes: 10 * 60 + 30 })).toBe("Every day 09:00-10:30");
    expect(describeRotationWindow({ dayOfWeek: 5, startHour: 18, endHour: 22 })).toBe("Fri 18:00-22:00");
  });
});
