import { resolveNowAndNext, type ProgrammingContext } from "./scheduler.js";
import { setCurrentProgramming, subscribe, snapshot } from "./engineState.js";

/**
 * Keeps the dashboard's programming snapshot honest.
 *
 * The playout engine calls /engine/next with an "after" timestamp that advances
 * to the end of each buffered window, so if we labelled the dashboard from that
 * we'd show whatever block comes LATER rather than what's on air now. Instead we
 * recompute the context from the current wall clock on a timer, on config
 * changes, and when a dashboard connects.
 */

const REFRESH_MS = 20_000;

function signature(p: ReturnType<typeof snapshot>["programming"]): string {
  return [
    p.mode,
    p.automationSource,
    p.playlistId,
    p.playlistName,
    p.clockwheelId,
    p.clockwheelName,
    p.stationRotationId,
    p.stationRotationName,
    p.next?.atMs,
    p.next?.mode,
    p.next?.automationSource,
    p.next?.showName,
    p.next?.playlistName,
    p.next?.clockwheelName,
    p.next?.stationRotationName,
  ].join("\u0001");
}

function pickContext(
  c: ProgrammingContext,
): {
  mode: ProgrammingContext["mode"];
  automationSource: ProgrammingContext["automationSource"];
  playlistId: string | null;
  playlistName: string | null;
  clockwheelId: string | null;
  clockwheelName: string | null;
  stationRotationId: string | null;
  stationRotationName: string | null;
} {
  return {
    mode: c.mode,
    automationSource: c.automationSource,
    playlistId: c.playlistId,
    playlistName: c.playlistName,
    clockwheelId: c.clockwheelId,
    clockwheelName: c.clockwheelName,
    stationRotationId: c.stationRotationId,
    stationRotationName: c.stationRotationName,
  };
}

export async function refreshProgramming(): Promise<void> {
  try {
    const { current, next } = await resolveNowAndNext(Date.now());
    const nextProgramming = next
      ? {
          ...pickContext(next.context),
          atMs: next.atMs,
          showName: next.context.showName,
        }
      : null;

    const program = {
      ...pickContext(current),
      next: nextProgramming,
    };

    if (signature(program) === signature(snapshot().programming)) return;
    setCurrentProgramming(program);
  } catch (err) {
    console.error("[programming] refresh failed", err instanceof Error ? err.message : err);
  }
}

export function startProgrammingRefresher(): void {
  subscribe((msg) => {
    let type = "";
    try {
      type = (JSON.parse(msg) as { type?: string }).type ?? "";
    } catch {
      // ignore
    }
    if (type === "programming-revision" || type === "engine-restart-requested") void refreshProgramming();
  });
  const timer = setInterval(() => void refreshProgramming(), REFRESH_MS);
  timer.unref();
  void refreshProgramming();
}
