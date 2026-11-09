import { desc, eq, lt } from "drizzle-orm";
import { unlink } from "node:fs/promises";
import { db, schema } from "../db/client.js";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h
const STALE_RECORDING_MS = 60_000; // ignore recently-started rows (still recording)

/**
 * Delete recordings (rows + files) older than the configured retention window.
 * Runs once immediately, then on a long interval so a recorded series can't
 * silently grow storage forever.
 */
export function startRetentionWorker(): void {
  void runRetention();
  const timer = setInterval(() => void runRetention(), CHECK_INTERVAL_MS);
  timer.unref?.();
}

export async function runRetention(): Promise<number> {
  try {
    const settings = await db.select().from(schema.settings).where(eq(schema.settings.id, 1)).limit(1);
    const retentionDays = settings[0]?.recordingRetentionDays ?? 60;
    if (!settings[0] || retentionDays <= 0) return 0;

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const staleCutoff = new Date(Date.now() - STALE_RECORDING_MS);

    const rows = await db
      .select()
      .from(schema.recordings)
      .where(lt(schema.recordings.startedAt, cutoff))
      .orderBy(desc(schema.recordings.startedAt));

    let removed = 0;
    for (const rec of rows) {
      // Never delete a row whose endedAt is still in the future (in-progress
      // recording with a stale/zero endedAt).
      if (rec.endedAt && rec.endedAt.getTime() > staleCutoff.getTime()) continue;

      await db.delete(schema.recordings).where(eq(schema.recordings.id, rec.id));
      try {
        await unlink(rec.filePath);
      } catch {
        // file already gone — removing the row is what matters
      }
      removed += 1;
    }

    if (removed > 0) {
      console.log(`[retention] Deleted ${removed} recording(s) older than ${retentionDays} day(s)`);
    }
    return removed;
  } catch (err) {
    console.error("[retention] Failed to prune recordings", err);
    return 0;
  }
}