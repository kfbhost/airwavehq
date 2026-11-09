import { spawn, type ChildProcess } from "node:child_process";
import { SAMPLE_RATE, CHANNELS } from "./config.js";

/**
 * Wraps an ffmpeg decode process that emits 48 kHz stereo f32le PCM on stdout.
 * Consumption is backpressured by the pipe, so decoding naturally paces.
 */
export class PcmStream {
  private proc: ChildProcess;
  private queue: Buffer[] = [];
  private queuedBytes = 0;
  private eof = false;
  private failed = false;
  /** Diag: stereo frames of real audio returned by the last readFrames() call. */
  public lastRealFrames = 0;
  /** Diag: stereo frames of silence padding from the last readFrames() call (starvation only, not EOF tail). */
  public lastPaddedFrames = 0;
  /** Diag: cumulative real audio frames this stream has returned. */
  public realFrames = 0;

  constructor(filePath: string, gainDb = 0, kind?: string) {
    // NB: -af is an OUTPUT option — it must come AFTER -i, otherwise ffmpeg
    // treats it as an input option and exits immediately (silent stream).
    const filters: string[] = [];
    if (kind === "voice") {
      // Match the Live Studio mic chain so pre-produced voice links (Show
      // Builder) sound like a live mic: low-cut to remove rumble/plosives, and
      // a compressor + makeup so the voice sits forward and even instead of
      // sounding thin/raw next to the music.
      filters.push("highpass=f=90");
      filters.push("acompressor=threshold=0.079:ratio=4:attack=8:release=180:knee=6:makeup=1.35");
    }
    if (gainDb !== 0) {
      filters.push(`volume=${gainDb.toFixed(2)}dB`);
    }
    const args = ["-v", "error", "-nostdin", "-i", filePath];
    if (filters.length > 0) {
      args.push("-af", filters.join(","));
    }
    args.push("-f", "f32le", "-ac", String(CHANNELS), "-ar", String(SAMPLE_RATE), "-");
    this.proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.queue.push(chunk);
      this.queuedBytes += chunk.length;
    });
    this.proc.stderr!.on("data", () => {
      /* ffmpeg diagnostics; ignore */
    });
    this.proc.on("error", (err) => {
      this.failed = true;
      this.eof = true;
      console.error("[engine] ffmpeg spawn failed", err.message);
    });
    this.proc.on("close", () => {
      this.eof = true;
    });
  }

  /** Reads up to `maxBytes` of PCM, waiting briefly if nothing is available yet. */
  async read(maxBytes: number, timeoutMs = 200): Promise<Buffer | null> {
    if (this.queuedBytes === 0 && !this.eof) {
      // Wait for the next stdout chunk or timeout (startup / backpressure).
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          this.proc.stdout!.removeListener("data", onData);
          resolve();
        };
        const onData = () => finish();
        const timer = setTimeout(finish, timeoutMs);
        this.proc.stdout!.once("data", onData);
      });
    }
    if (this.queuedBytes === 0) return null;
    const out: Buffer[] = [];
    let total = 0;
    while (total < maxBytes && this.queue.length > 0) {
      const chunk = this.queue[0]!;
      const take = Math.min(chunk.length, maxBytes - total);
      out.push(chunk.subarray(0, take));
      if (take === chunk.length) {
        this.queue.shift();
      } else {
        this.queue[0] = chunk.subarray(take);
      }
      total += take;
      this.queuedBytes -= take;
    }
    return Buffer.concat(out);
  }

  /** Reads exactly `frameCount` stereo frames; pads with silence at EOF/failure. */
  async readFrames(frameCount: number): Promise<Float32Array> {
    const bytes = frameCount * CHANNELS * 4;
    // Never stall the master clock waiting on the decoder: if nothing is
    // buffered yet (and the stream hasn't ended), emit silence this tick and
    // catch up next tick. A blocking wait here is what let a slow/cold decode
    // make the engine fall behind real-time and cut tracks.
    if (this.queuedBytes === 0 && !this.eof) {
      this.lastRealFrames = 0;
      this.lastPaddedFrames = frameCount;
      return new Float32Array(frameCount * CHANNELS);
    }
    const buf = await this.read(bytes, 0);
    if (!buf) {
      this.lastRealFrames = 0;
      this.lastPaddedFrames = this.eof ? 0 : frameCount;
      return new Float32Array(frameCount * CHANNELS);
    }
    if (buf.length === bytes) {
      this.lastRealFrames = frameCount;
      this.lastPaddedFrames = 0;
      this.realFrames += frameCount;
      return new Float32Array(buf.buffer, buf.byteOffset, frameCount * CHANNELS).slice();
    }
    // Short read: pad with silence. At true EOF this is the normal tail; before
    // EOF it means the decoder was starved (a stall that can cut a track).
    const got = buf.length / 4 / CHANNELS;
    this.lastRealFrames = got;
    this.lastPaddedFrames = this.eof ? 0 : frameCount - got;
    this.realFrames += got;
    const out = new Float32Array(frameCount * CHANNELS);
    out.set(new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4));
    return out;
  }

  get ended(): boolean {
    return this.eof;
  }

  get error(): boolean {
    return this.failed;
  }

  kill(): void {
    try {
      this.proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}
