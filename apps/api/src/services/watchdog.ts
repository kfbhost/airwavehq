import { and, count, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { snapshot, requestEngineRestart, getCurrentItemStartedAt } from "./engineState.js";

/**
 * Engine watchdog. The playout engine can occasionally stall (stop producing
 * audio / advancing) without the process crashing, which would leave the station
 * silently off-air indefinitely. We can't always pin the exact trigger, so this
 * guarantees it can never stay down: if the engine is online, NOT broadcasting
 * live, a default playlist is set with real music available, and no new track
 * has started for SILENCE_MS, we ask the engine to restart itself (it exits and
 * Docker restarts it fresh). A cooldown prevents restart loops.
 */

const CHECK_MS = 30_000;
const SILENCE_MS = 10 * 60_000; // restart if no new play has started in 10 min
const COOLDOWN_MS = 5 * 60_000; // don't fire again within 5 min of a restart

let lastRestartAt = 0;

export function startEngineWatchdog(): void {
  const timer = setInterval(() => void check(), CHECK_MS);
  timer.unref();
}

async function check(): Promise<void> {
  try {
    const status = snapshot().status;
    if (!status.online || status.mode === "live") return; // offline / a live DJ = don't act
    if (Date.now() - lastRestartAt < COOLDOWN_MS) return; // just restarted → back off

    const lastStart = getCurrentItemStartedAt();
    if (!lastStart) return; // engine hasn't started a play yet — give it time
    const ageMs = Date.now() - new Date(lastStart).getTime();
    if (ageMs < SILENCE_MS) return; // played recently → healthy

    // Only enforce when the station SHOULD be playing: a default playlist set
    // AND at least one active music track (otherwise silence is legitimate).
    const settings = (await db.select().from(schema.settings).where(eq(schema.settings.id, 1)).limit(1))[0];
    if (!settings?.defaultPlaylistId) return;
    const activeMusic = await db
      .select({ n: count() })
      .from(schema.tracks)
      .where(and(eq(schema.tracks.kind, "music"), eq(schema.tracks.isActive, true)));
    if (Number(activeMusic[0]?.n ?? 0) === 0) return;

    console.warn(`[watchdog] engine has been silent for ${Math.round(ageMs / 60000)} min — requesting restart`);
    lastRestartAt = Date.now();
    requestEngineRestart();
  } catch (err) {
    console.error("[watchdog] check failed", err instanceof Error ? err.message : err);
  }
}
