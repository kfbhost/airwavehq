import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Writable, Readable } from "node:stream";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { config } from "./config.js";
import type { ProcessingPreset } from "@airshift/shared";
import { broadcastFilterArgsFor } from "./processing.js";

export interface Sink {
  write(pcm: Buffer): void;
  setMetadata(song: string): void;
  listeners(): number;
  close(): void;
  /** Hot-swap the broadcast processing filter graph (no restart needed). */
  applyFilterArgs(args: string[]): void;
}

/** Encodes PCM and pushes it to Icecast, reconnecting on failure. */
export class IcecastSink implements Sink {
  private encoder: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private sourceSock: Socket | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private currentSong = "";
  private lastListeners = 0;
  private statsTimer: NodeJS.Timeout;
  private buffered: Buffer[] = [];
  private filterArgs: string[];

  constructor(preset: ProcessingPreset = "radio") {
    this.filterArgs = broadcastFilterArgsFor(preset);
    this.startEncoder();
    this.statsTimer = setInterval(() => void this.pollStats(), 15_000);
    this.statsTimer.unref();
  }

  applyFilterArgs(args: string[]): void {
    if (args.length === this.filterArgs.length && args.every((a, i) => a === this.filterArgs[i])) return;
    this.filterArgs = args;
    console.log("[engine] broadcast processing changed — restarting encoder");
    // Immediate respawn (no 3 s wait): the ~10 s PCM buffer covers the gap.
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.respawn();
  }

  /** Kill the current encoder if any (so respawns never leave orphans). */
  private killEncoder(): void {
    if (this.encoder) {
      try {
        this.encoder.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      this.encoder = null;
    }
  }

  /**
   * Destroy the current source socket, nulling the reference first so the
   * socket's own close event doesn't trigger a spurious restart (that was the
   * cause of an infinite 3 s respawn loop during processing changes).
   */
  private teardownSocket(): void {
    if (this.sourceSock) {
      const sock = this.sourceSock;
      this.sourceSock = null;
      sock.destroy();
    }
  }

  /** Kill the encoder + close the socket, then start a fresh one. */
  private respawn(): void {
    this.killEncoder();
    this.teardownSocket();
    this.startEncoder();
  }

  private encodeArgs(): string[] {
    const args = [
      "-v", "error",
      "-f", "f32le",
      "-ar", "48000",
      "-ac", "2",
      "-i", "-",
    ];
    // Broadcast dynamics on the final output before encoding (see processing.ts).
    args.push(...this.filterArgs);
    if (config.iceCodec === "aac") {
      args.push("-c:a", "aac", "-b:a", `${config.iceBitrate}k`, "-f", "adts");
    } else {
      args.push("-c:a", "libmp3lame", "-b:a", `${config.iceBitrate}k`, "-f", "mp3");
    }
    args.push("-"); // output to stdout -> Icecast PUT body
    return args;
  }

  private startEncoder(): void {
    if (this.closed) return;
    try {
      const enc = spawn("ffmpeg", this.encodeArgs(), { stdio: ["pipe", "pipe", "pipe"] });
      this.encoder = enc;
      enc.stdin.on("error", () => {
        /* EPIPE when icecast drops us mid-write — handled by restart */
      });
      enc.stderr.on("data", () => {});
      enc.on("error", (err) => console.error("[engine] encoder error", err.message));
      enc.on("close", () => {
        // Only react to the current encoder's exit — old respawned processes
        // must not clobber the reference or trigger a restart cascade.
        if (this.encoder === enc) {
          this.encoder = null;
          this.scheduleRestart();
        }
      });

      // Raw TCP source connection (no chunked transfer encoding): Node's
      // http.request streams request bodies as HTTP chunks, and Icecast 2.4.x
      // relays those chunk-size headers to listeners — corrupting the stream.
      // libshout/ices-style: write plain headers, then pipe raw MP3 bytes.
      const sock = netConnect(config.icePort, config.iceHost);
      this.sourceSock = sock;
      const auth = Buffer.from(`source:${config.iceSourcePassword}`).toString("base64");
      const headers = [
        `PUT ${config.iceMount} HTTP/1.1`,
        `Host: ${config.iceHost}:${config.icePort}`,
        `Authorization: Basic ${auth}`,
        `Content-Type: ${config.iceCodec === "aac" ? "audio/aac" : "audio/mpeg"}`,
        `Icecast-Public: ${config.icePublic}`,
        "Icecast-Name: Airshift",
        "Icecast-Description: Airshift stream",
        "Icecast-Genre: varied",
        "User-Agent: Airshift-Studio/1.0",
        "Connection: keep-alive",
        "",
        "",
      ].join("\r\n");
      sock.write(headers);

      // Read the status line so we can log/reject bad credentials, then pipe.
      let resp = "";
      sock.on("data", (chunk) => {
        resp += chunk.toString("latin1");
        const end = resp.indexOf("\r\n\r\n");
        if (end !== -1) {
          const status = resp.slice(0, resp.indexOf("\r\n"));
          const code = Number(status.split(" ")[1] ?? 0);
          if (code >= 400) {
            console.error(`[engine] icecast rejected source: ${status}`);
            this.scheduleRestart();
          } else {
            console.log(`[engine] icecast source connected: ${status}`);
          }
          sock.removeAllListeners("data");
        }
      });
      sock.on("error", () => {
        /* close fires next — handled there */
      });
      sock.on("close", () => {
        // Only react to the current socket — sockets torn down during a
        // respawn must not trigger another restart (respawn loop).
        if (this.sourceSock === sock) {
          this.sourceSock = null;
          this.scheduleRestart();
        }
      });

      // Flush anything buffered while we were disconnected.
      for (const buf of this.buffered) {
        if (enc.stdin.writable) enc.stdin.write(buf);
      }
      this.buffered = [];
      enc.stdin.on("drain", () => {});
      enc.stdout.pipe(sock);
    } catch (err) {
      console.error("[engine] icecast sink error", err instanceof Error ? err.message : err);
      this.scheduleRestart();
    }
  }

  private scheduleRestart(): void {
    if (this.closed || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.respawn();
    }, 3000);
  }

  write(pcm: Buffer): void {
    if (this.closed) return;
    const enc = this.encoder;
    if (enc && enc.stdin.writable && !enc.stdin.destroyed) {
      try {
        enc.stdin.write(pcm);
      } catch {
        /* race with encoder exit — next write will buffer */
      }
    } else {
      // Keep up to ~10 s of PCM so a reconnect doesn't start silent.
      this.buffered.push(pcm);
      const MAX = 10 * 48000 * 2 * 4;
      let total = 0;
      let i = this.buffered.length - 1;
      for (; i >= 0; i--) {
        total += this.buffered[i]!.length;
        if (total > MAX) break;
      }
      if (i > 0) this.buffered.splice(0, i);
    }
  }

  async setMetadata(song: string): Promise<void> {
    if (song === this.currentSong || !config.iceHost) return;
    this.currentSong = song;
    try {
      const auth = Buffer.from(`admin:${config.iceAdminPassword}`).toString("base64");
      const url = `http://${config.iceHost}:${config.icePort}/admin/metadata?mount=${encodeURIComponent(config.iceMount)}&mode=updinfo&song=${encodeURIComponent(song)}`;
      await new Promise<void>((resolve) => {
        const req = httpRequest(url, { headers: { Authorization: `Basic ${auth}` } }, (res) => {
          res.resume();
          res.on("end", () => resolve());
        });
        req.on("error", () => resolve());
        req.end();
      });
    } catch {
      /* metadata best-effort */
    }
  }

  private async pollStats(): Promise<void> {
    if (!config.iceHost) return;
    try {
      const auth = Buffer.from(`admin:${config.iceAdminPassword}`).toString("base64");
      const stats = await new Promise<string>((resolve) => {
        const req = httpRequest(
          `http://${config.iceHost}:${config.icePort}/admin/stats`,
          { headers: { Authorization: `Basic ${auth}` } },
          (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => resolve(data));
          },
        );
        req.on("error", () => resolve(""));
        req.end();
      });
      const m = stats.match(/<listeners>(\d+)<\/listeners>/);
      this.lastListeners = m ? Number(m[1]) : 0;
    } catch {
      this.lastListeners = 0;
    }
  }

  listeners(): number {
    return this.lastListeners;
  }

  close(): void {
    this.closed = true;
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    try {
      this.sourceSock?.destroy();
      this.sourceSock = null;
      this.encoder?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

/** Writes encoded audio to a file (dev mode / testing without Icecast). */
export class FileSink implements Sink {
  private stream: WriteStream;
  private listenersValue = 0;
  private filterArgs: string[];

  constructor(preset: ProcessingPreset = "radio") {
    this.filterArgs = broadcastFilterArgsFor(preset);
    const dir = join(config.dataDir, "output");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `stream-${Date.now()}.mp3`);
    this.stream = createWriteStream(path);
    console.log(`[engine] file output -> ${path} (no ICE_HOST configured)`);
  }

  applyFilterArgs(args: string[]): void {
    if (args.length === this.filterArgs.length && args.every((a, i) => a === this.filterArgs[i])) return;
    this.filterArgs = args;
    console.log("[engine] broadcast processing changed (file sink)");
    // Lazy encoder: respawn on the next write with the new args.
    if (this.encoder) {
      try {
        this.encoder.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      this.encoder = null;
    }
  }

  write(pcm: Buffer): void {
    // Encode lazily so we don't spawn an encoder when nothing will consume it.
    if (!this.encoder) this.ensureEncoder();
    if (this.encoder && this.encoder.stdin.writable && !this.encoder.stdin.destroyed) {
      try {
        this.encoder.stdin.write(pcm);
      } catch {
        /* ignore */
      }
    }
  }

  private encoder: ChildProcessByStdio<Writable, Readable, null> | null = null;
  private ensureEncoder(): void {
    const args = [
      "-v", "error",
      "-f", "f32le", "-ar", "48000", "-ac", "2", "-i", "-",
      ...this.filterArgs,
      "-c:a", "libmp3lame", "-b:a", `${config.iceBitrate}k`, "-f", "mp3",
      "-",
    ];
    this.encoder = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "ignore"] });
    this.encoder.stdout.pipe(this.stream);
  }

  setMetadata(): void {}
  listeners(): number {
    return this.listenersValue;
  }
  close(): void {
    try {
      this.encoder?.stdin.end();
    } catch {
      /* ignore */
    }
  }
}

/** Discards audio (fully headless runs). */
export class NullSink implements Sink {
  write(): void {}
  setMetadata(): void {}
  listeners(): number {
    return 0;
  }
  applyFilterArgs(): void {}
  close(): void {}
}

export function createSink(preset: ProcessingPreset = "radio"): Sink {
  if (config.iceHost) return new IcecastSink(preset);
  if (process.env.SINK === "null") return new NullSink();
  return new FileSink(preset);
}

export { createServer };
