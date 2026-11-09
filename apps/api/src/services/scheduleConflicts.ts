const DOWS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface ScheduleWindow {
  id: string;
  dayOfWeek: number | null;
  startMinutes: number;
  endMinutes: number;
  showName: string;
}

export interface RotationWindow {
  id: string;
  dayOfWeek: number | null;
  startHour: number;
  endHour: number;
  name: string;
  isActive: boolean;
}

export interface CandidateScheduleWindow {
  dayOfWeek: number | null;
  startMinutes: number;
  endMinutes: number;
}

function daysOverlap(a: number | null, b: number | null): boolean {
  return a === null || b === null || a === b;
}

function windowsOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && startB < endA;
}

export function findScheduleConflict(
  candidate: CandidateScheduleWindow,
  entries: readonly ScheduleWindow[],
  excludeId?: string,
): ScheduleWindow | null {
  return entries.find((entry) =>
    entry.id !== excludeId &&
    daysOverlap(candidate.dayOfWeek, entry.dayOfWeek) &&
    windowsOverlap(candidate.startMinutes, candidate.endMinutes, entry.startMinutes, entry.endMinutes),
  ) ?? null;
}

export function findRotationConflict(
  candidate: CandidateScheduleWindow,
  rotations: readonly RotationWindow[],
): RotationWindow | null {
  return rotations.find((rotation) =>
    rotation.isActive &&
    daysOverlap(candidate.dayOfWeek, rotation.dayOfWeek) &&
    windowsOverlap(candidate.startMinutes, candidate.endMinutes, rotation.startHour * 60, rotation.endHour * 60),
  ) ?? null;
}

function formatMinutes(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function describeScheduleWindow(input: { dayOfWeek: number | null; startMinutes: number; endMinutes: number }): string {
  const day = input.dayOfWeek == null ? "Every day" : DOWS[input.dayOfWeek] ?? "Unknown day";
  return `${day} ${formatMinutes(input.startMinutes)}-${formatMinutes(input.endMinutes)}`;
}

export function describeRotationWindow(input: { dayOfWeek: number | null; startHour: number; endHour: number }): string {
  return describeScheduleWindow({
    dayOfWeek: input.dayOfWeek,
    startMinutes: input.startHour * 60,
    endMinutes: input.endHour * 60,
  });
}
