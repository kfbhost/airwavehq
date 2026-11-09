import type { EngineStatus } from "@radiohost/shared";

/**
 * Latest status reported by the engine + a hub of dashboard WebSocket
 * clients that receive live updates.
 */
const state: EngineStatus = {
  online: false,
  mode: "off",
  currentItem: null,
  nextItem: null,
  upcomingItems: [],
  listeners: 0,
  liveDjName: null,
  liveShowName: null,
  encoderBitrateKbps: null,
  engineTime: new Date().toISOString(),
  uptimeSec: 0,
};

interface ProgrammingState {
  mode: "rundown" | "clockwheel" | "playlist" | "idle";
  automationSource: "show" | "rotation" | "default" | "idle";
  playlistId: string | null;
  playlistName: string | null;
  clockwheelId: string | null;
  clockwheelName: string | null;
  stationRotationId: string | null;
  stationRotationName: string | null;
  /** The source that comes on next and when. Resolved from the current wall
   *  clock, so the dashboard can show what the schedule is switching to. */
  next: {
    atMs: number | null;
    mode: "rundown" | "clockwheel" | "playlist" | "idle";
    automationSource: "show" | "rotation" | "default" | "idle";
    showName: string | null;
    playlistName: string | null;
    clockwheelName: string | null;
    stationRotationName: string | null;
  } | null;
}

let lastStatusAt = 0;
let currentShowId: string | null = null;
let currentShowName: string | null = null;
let currentItemStartedAt: string | null = null;
let programming: ProgrammingState = {
  mode: "idle",
  automationSource: "idle",
  playlistId: null,
  playlistName: null,
  clockwheelId: null,
  clockwheelName: null,
  stationRotationId: null,
  stationRotationName: null,
  next: null,
};
let programmingRevision = Date.now();
let engineRestartRequestedAt = 0;

type Listener = (payload: string) => void;
const listeners = new Set<Listener>();

export function setStatus(s: EngineStatus, show?: { id: string | null; name: string | null }): void {
  Object.assign(state, s);
  lastStatusAt = Date.now();
  if (show) {
    currentShowId = show.id;
    currentShowName = show.name;
  }
  // NB: broadcast the bare EngineStatus, NOT snapshot() — snapshot() wraps
  // status inside { status, show }, which would break dashboard clients
  // reading msg.status.online directly.
  broadcast({ type: "status", status: getStatus(), show: { id: currentShowId, name: currentShowName } });
}

export function getStatus(): EngineStatus {
  // Auto-flip to offline when the engine has not reported for 45 seconds.
  if (state.online && lastStatusAt > 0 && Date.now() - lastStatusAt > 45_000) {
    return { ...state, online: false, mode: "off" };
  }
  return state;
}

export function snapshot() {
  return { status: getStatus(), show: { id: currentShowId, name: currentShowName }, programming, currentItemStartedAt };
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function broadcast(payload: unknown): void {
  const msg = JSON.stringify(payload);
  for (const fn of listeners) fn(msg);
}

export function setCurrentShow(id: string | null, name: string | null): void {
  currentShowId = id;
  currentShowName = name;
  broadcast({ type: "show", show: { id, name } });
}

export function setCurrentProgramming(next: ProgrammingState): void {
  programming = next;
  broadcast({ type: "programming", programming });
}

export function bumpProgrammingRevision(): number {
  programmingRevision = Date.now();
  broadcast({ type: "programming-revision", programmingRevision });
  return programmingRevision;
}

export function getProgrammingRevision(): number {
  return programmingRevision;
}

export function requestEngineRestart(): number {
  engineRestartRequestedAt = Date.now();
  broadcast({ type: "engine-restart-requested", requestedAt: engineRestartRequestedAt });
  return engineRestartRequestedAt;
}

export function getEngineRestartRequestedAt(): number {
  return engineRestartRequestedAt;
}

/** The engine reports the start of each play; the public widget shows it. */
export function setCurrentItemStartedAt(startedAt: string): void {
  currentItemStartedAt = startedAt;
  broadcast({ type: "current-item-started", currentItemStartedAt });
}

export function getCurrentItemStartedAt(): string | null {
  return currentItemStartedAt;
}
