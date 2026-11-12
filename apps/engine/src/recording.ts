import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Writable, Readable } from "node:stream";
import { mkdirSync } from "node:fs";
import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { api } from "./api.js";
import type { ProcessingPreset } from "@airwavehq/shared";
import { broadcastFilterArgsFor } from "./processing.js";

export interface RecordingTarget {
  showId: string | null;
  djId: string | null;
  title: string;
  startedAt: string;
}

/**
 * Records the master output for the active show. Two triggers are merged:
 *   - "scheduled": the API reports an active schedule entry (original behaviour)
 *   - "live": a DJ is broadcasting through the Live Studio (set by the live
 *     server). Because DJs may only go live inside their allocated slots, a
 *     live set is treated as a show to record even when it isn't on the weekly
 *     schedule. A scheduled show takes precedence when both apply.
 */
export class RecordingManager {
  private scheduled: RecordingTarget | null = null;
  private live: RecordingTarget | null = null;
  private recordShowsEnabled = true;
  private current: RecordingTarget | null = null;
  private currentKey: string | null = null;
  private switching = false;
  private startedMs = 0;
  private encoder: ChildProcessByStdio<Writable, Readable, null> | null = null;
  private fileStream: WriteStream | null = null;
  private outPath = "";
  private timer: NodeJS.Timeout | null = null;
  private preset: ProcessingPreset | null = null;

  constructor() {
    mkdirSync(join(config.dataDir, "recordings"), { recursive: true });
  }

  start(): void {
    this.timer = setInterval(() => void this.poll(), 20_000);
    this.timer.unref();
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    void this.finalize(true);
  }

  /** Called by the playout for every master tick (raw PCM). */
  write(pcm: Buffer): void {
    if (this.encoder && this.encoder.stdin.writable && !this.encoder.stdin.destroyed) {
      try {
        this.encoder.stdin.write(pcm);
      } catch {
        /* ignore */
      }
    }
  }

  /** Set (or clear) the live-studio recording trigger from the live server. */
  setLive(target: RecordingTarget | null): void {
    this.live = target;
    this.sync();
  }

  private async poll(): Promise<void> {
    try {
      const cfg = await api.config();
      const preset = (cfg.processingPreset as ProcessingPreset) || "radio";
      if (this.preset !== preset) {
        this.preset = preset;
        // Keep recordings matching the broadcast processing, even mid-show.
        this.respawnEncoder();
      }
      this.recordShowsEnabled = cfg.recordShows !== false;
      this.scheduled = cfg.record
        ? { showId: cfg.record.showId, djId: null, title: cfg.record.title, startedAt: cfg.record.startedAt }
        : null;
      this.sync();
    } catch (err) {
      console.error("[engine] recording poll failed", err instanceof Error ? err.message : err);
    }
  }

  /** Resolve the effective target (scheduled show wins over a live set) and act on changes. */
  private sync(): void {
    if (this.switching) return;
    const eff = this.scheduled ?? (this.recordShowsEnabled ? this.live : null);
    const key = eff ? (eff === this.scheduled ? `show:${eff.showId}` : `live:${eff.startedAt}`) : null;
    if (key === this.currentKey) return;
    void this.transition(eff, key);
  }

  private async transition(target: RecordingTarget | null, key: string | null): Promise<void> {
    if (this.switching) return;
    this.switching = true;
    try {
      if (this.current) await this.finalize(false);
      if (target) {
        this.startRecording(target);
        this.currentKey = key;
      } else {
        this.currentKey = null;
      }
    } finally {
      this.switching = false;
    }
    // Pick up any scheduled/live change that arrived while we were switching.
    this.sync();
  }

  private startRecording(target: RecordingTarget): void {
    const slug = target.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "show";
    this.startedMs = Date.now();
    this.outPath = join(
      config.dataDir,
      "recordings",
      `${slug}-${new Date(this.startedMs).toISOString().slice(0, 19).replace(/[:T]/g, "-")}.mp3`,
    );
    this.fileStream = createWriteStream(this.outPath);
    this.encoder = spawn(
      "ffmpeg",
      [
        "-v", "error",
        "-f", "f32le", "-ar", "48000", "-ac", "2", "-i", "-",
        ...broadcastFilterArgsFor(this.preset ?? "radio"),
        "-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3",
        "-",
      ],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    this.encoder.stdout.pipe(this.fileStream);
    this.current = target;
    console.log(`[engine] recording ${target.title} -> ${this.outPath}`);
  }

  /** Respawn the encoder with the current preset's filter args (mid-recording preset change). */
  private respawnEncoder(): void {
    if (!this.encoder || !this.fileStream) return;
    const stream = this.fileStream;
    const args = [
      "-v", "error",
      "-f", "f32le", "-ar", "48000", "-ac", "2", "-i", "-",
      ...broadcastFilterArgsFor(this.preset ?? "radio"),
      "-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3",
      "-",
    ];
    try {
      this.encoder.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    this.encoder = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "ignore"] });
    this.encoder.stdout.pipe(stream);
    console.log("[engine] recording encoder respawned for new processing preset");
  }

  private async finalize(force: boolean): Promise<void> {
    if (!this.current || !this.encoder || !this.fileStream) {
      this.current = null;
      return;
    }
    const endedAt = new Date().toISOString();
    const durationSeconds = (Date.now() - this.startedMs) / 1000;
    const rec = this.current;
    const enc = this.encoder;
    const path = this.outPath;
    try {
      enc.stdin.end();
      await new Promise((resolve) => enc.stdout.on("end", resolve));
      setTimeout(() => {
        void api.recordingComplete({
          showId: rec.showId,
          djId: rec.djId,
          title: rec.title,
          startedAt: rec.startedAt,
          endedAt,
          filePath: path,
          durationSeconds: Math.round(durationSeconds),
        }).catch((err) => console.error("[engine] recording-complete failed", err.message));
      }, 500);
    } catch (err) {
      console.error("[engine] recording finalize failed", err instanceof Error ? err.message : err);
    }
    this.current = null;
    this.encoder = null;
    this.fileStream = null;
  }
}
