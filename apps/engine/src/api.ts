import { config } from "./config.js";
import type { EngineItem, EnginePlayEvent, EngineSequence, EngineStatus } from "@radiohost/shared";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${config.apiUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Engine-Key": config.engineKey,
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`API ${path} -> ${res.status} ${await res.text().catch(() => "")}`);
  }
  return res.json() as Promise<T>;
}

export interface EngineConfig {
  record: { showId: string; title: string; startedAt: string } | null;
  recordShows: boolean;
  timezone: string;
  crossfadeMs: number;
  bitrate: number;
  processingPreset: string;
  nextBreak: number;
  programmingRevision: number;
  engineRestartRequestedAt: number;
}

export const api = {
  next: (after: number, count = 8): Promise<EngineSequence> =>
    request(`/engine/next?after=${after}&count=${count}`),

  playLog: (events: EnginePlayEvent[]) =>
    request("/engine/play-log", { method: "POST", body: JSON.stringify({ events }) }),

  status: (status: EngineStatus) =>
    request("/engine/status", { method: "POST", body: JSON.stringify(status) }).catch(() => null),

  recordingComplete: (body: { showId: string | null; djId: string | null; title: string; startedAt: string; endedAt: string; filePath: string; durationSeconds: number }) =>
    request("/engine/recording-complete", { method: "POST", body: JSON.stringify(body) }),

  config: (): Promise<EngineConfig> => request("/engine/config"),

  get nextBreak(): number {
    return 0;
  },
};

/** Re-exported so other engine modules can reference the item type. */
export type { EngineItem };
