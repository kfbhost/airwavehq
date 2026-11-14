/**
 * AirwaveHQ Desktop — proof of concept.
 *
 * Plays a folder as a continuous station: decodes each track with the engine's
 * own PcmStream, crossfades into the next one and writes the master mix to
 * ffplay (the speakers) or to a WAV file with --out.
 *
 * This is deliberately small. It proves the desktop audio path before any
 * Electron shell, database or UI exists.
 *
 *   node node_modules/tsx/dist/cli.mjs desktop/poc/play-folder.mts "C:\music"
 *   ... --out .tmp/poc.wav --seconds 30
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { PcmStream } from "../../apps/engine/src/decode.js";
import { CHANNELS, SAMPLE_RATE } from "../../apps/engine/src/config.js";

const run = promisify(execFile);

const TICK_MS = 20;
const FRAMES_PER_TICK = Math.round((SAMPLE_RATE * TICK_MS) / 1000);
const AUDIO_EXT = new Set([".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".aif", ".aiff"]);

type Track = {
  path: string;
  title: string;
  artist: string;
  durationMs: number;
};

type Options = {
  folder: string;
  out: string | null;
  seconds: number | null;
  crossfadeMs: number;
  shuffle: boolean;
};

function parseArgs(argv: string[]): Options {
  const opts: Options = { folder: "", out: null, seconds: null, crossfadeMs: 3000, shuffle: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--out") opts.out = argv[++i] ?? null;
    else if (arg === "--seconds") opts.seconds = Number(argv[++i] ?? 0) || null;
    else if (arg === "--crossfade") opts.crossfadeMs = Math.max(0, Number(argv[++i] ?? 3000) || 3000);
    else if (arg === "--shuffle") opts.shuffle = true;
    else if (!arg.startsWith("--")) opts.folder = arg;
  }
  if (!opts.folder) {
    console.error("usage: play-folder.mts <folder> [--out file.wav] [--seconds n] [--crossfade ms] [--shuffle]");
    process.exit(2);
  }
  return opts;
}

async function probeTrack(path: string): Promise<Track | null> {
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration:format_tags=title,artist",
      "-of", "json",
      path,
    ]);
    const info = JSON.parse(stdout) as {
      format?: { duration?: string; tags?: { title?: string; artist?: string } };
    };
    const durationMs = Math.round(Number(info.format?.duration ?? 0) * 1000);
    if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
    return {
      path,
      title: info.format?.tags?.title?.trim() || basename(path, extname(path)),
      artist: info.format?.tags?.artist?.trim() || "",
      durationMs,
    };
  } catch {
    return null;
  }
}

async function collectTracks(folder: string): Promise<Track[]> {
  const files = readdirSync(folder)
    .map((name) => join(folder, name))
    .filter((file) => AUDIO_EXT.has(extname(file).toLowerCase()) && statSync(file).isFile());
  const tracks: Track[] = [];
  for (const file of files) {
    const track = await probeTrack(file);
    if (track) tracks.push(track);
    else console.warn(`[skip] cannot read ${basename(file)}`);
  }
  return tracks;
}

/** A sink takes the master mix as 48 kHz stereo s16le and puts it somewhere. */
interface Sink {
  write(pcm: Buffer): void;
  close(): Promise<void>;
}

function ffplaySink(): Sink {
  const proc = spawn(
    "ffplay",
    ["-nodisp", "-autoexit", "-loglevel", "error", "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ch_layout", "stereo", "-"],
    { stdio: ["pipe", "ignore", "inherit"] },
  );
  return {
    write: (pcm) => {
      proc.stdin?.write(pcm);
    },
    close: async () => {
      proc.stdin?.end();
      await new Promise<void>((resolve) => proc.once("close", () => resolve()));
    },
  };
}

function fileSink(out: string): Sink {
  const proc = spawn(
    "ffmpeg",
    ["-v", "error", "-y", "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS), "-i", "-", "-c:a", "pcm_s16le", out],
    { stdio: ["pipe", "ignore", "inherit"] },
  );
  return {
    write: (pcm) => {
      proc.stdin?.write(pcm);
    },
    close: async () => {
      proc.stdin?.end();
      await new Promise<void>((resolve) => proc.once("close", () => resolve()));
    },
  };
}

/**
 * Soft-knee limiter at -0.45 dBFS, then s16le. The server engine gets this
 * from the limiter in its ffmpeg encoder chain; a desktop sink has to do it
 * itself or a crossfade between two loud tracks clips.
 */
function toPcm16(frames: Float32Array): Buffer {
  const out = Buffer.allocUnsafe(frames.length * 2);
  const knee = 0.90;
  const ceiling = 0.966; // -0.3 dBFS
  for (let i = 0; i < frames.length; i++) {
    let s = frames[i]!;
    const magnitude = Math.abs(s);
    if (magnitude > knee) s = Math.sign(s) * (knee + (ceiling - knee) * Math.tanh((magnitude - knee) / (ceiling - knee)));
    const sample = Math.max(-1, Math.min(1, s));
    out.writeInt16LE(Math.round(sample * 32767), i * 2);
  }
  return out;
}

/** Reads `frames` frames, waiting for the decoder (file mode is not paced). */
async function readFramesBlocking(stream: PcmStream, frames: number): Promise<Float32Array> {
  const bytes = frames * CHANNELS * 4;
  const chunks: Buffer[] = [];
  let got = 0;
  const deadline = Date.now() + 5000;
  while (got < bytes && Date.now() < deadline) {
    const chunk = await stream.read(bytes - got, 250);
    if (!chunk) {
      if (stream.ended) break;
      continue;
    }
    chunks.push(chunk);
    got += chunk.length;
  }
  const out = new Float32Array(frames * CHANNELS);
  if (chunks.length === 0) return out;
  const buf = Buffer.concat(chunks);
  const src = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  out.set(src.subarray(0, Math.min(src.length, out.length)));
  return out;
}
type Deck = { track: Track; stream: PcmStream; playedMs: number };

/** Two decks, one mix, exactly the shape the server engine uses. */
class Station {
  private order: Track[] = [];
  private nextIndex = 0;
  private current: Deck | null = null;
  private incoming: Deck | null = null;
  private framesWritten = 0;
  private stopping = false;

  constructor(
    private readonly tracks: Track[],
    private readonly sink: Sink,
    private readonly crossfadeMs: number,
    private readonly maxFrames: number | null,
    private readonly shuffle: boolean,
    private readonly realtime: boolean,
  ) {
    this.reshuffle();
  }

  private reshuffle(): void {
    this.order = [...this.tracks];
    if (this.shuffle) this.order.sort(() => Math.random() - 0.5);
    this.nextIndex = 0;
  }

  private takeNext(): Track {
    if (this.nextIndex >= this.order.length) this.reshuffle();
    return this.order[this.nextIndex++]!;
  }

  private openDeck(track: Track): Deck {
    console.log(`[play] ${track.artist ? `${track.artist} — ` : ""}${track.title}`);
    return { track, stream: new PcmStream(track.path), playedMs: 0 };
  }

  private startCurrent(): boolean {
    if (this.tracks.length === 0) return false;
    this.current = this.openDeck(this.takeNext());
    return true;
  }

  private startIncoming(): void {
    if (this.tracks.length < 2) return;
    this.incoming = this.openDeck(this.takeNext());
  }

  private async tick(): Promise<boolean> {
    if (this.stopping) return false;
    if (!this.current && !this.startCurrent()) return false;
    const cur = this.current!;

    const remaining = cur.track.durationMs - cur.playedMs;
    if (!this.incoming && this.tracks.length > 1 && remaining <= this.crossfadeMs) this.startIncoming();

    // Equal-power crossfade across the last `crossfadeMs` of the current track.
    let curGain = 1;
    let inGain = 0;
    if (this.incoming) {
      const startedAt = cur.track.durationMs - this.crossfadeMs;
      const progress = this.crossfadeMs > 0 ? Math.min(1, Math.max(0, (cur.playedMs - startedAt) / this.crossfadeMs)) : 1;
      curGain = Math.cos((progress * Math.PI) / 2);
      inGain = Math.sin((progress * Math.PI) / 2);
    }

    const mixed = new Float32Array(FRAMES_PER_TICK * CHANNELS);
    const a = this.realtime ? await cur.stream.readFrames(FRAMES_PER_TICK) : await readFramesBlocking(cur.stream, FRAMES_PER_TICK);
    for (let i = 0; i < a.length && i < mixed.length; i++) mixed[i] = a[i]! * curGain;
    cur.playedMs += TICK_MS;

    if (this.incoming) {
      const b = this.realtime ? await this.incoming.stream.readFrames(FRAMES_PER_TICK) : await readFramesBlocking(this.incoming.stream, FRAMES_PER_TICK);
      for (let i = 0; i < b.length && i < mixed.length; i++) mixed[i] = mixed[i]! + b[i]! * inGain;
      this.incoming.playedMs += TICK_MS;
    }

    this.sink.write(toPcm16(mixed));
    this.framesWritten += FRAMES_PER_TICK;

    // Hand over when the current track runs out.
    if (cur.playedMs >= cur.track.durationMs) {
      cur.stream.kill();
      this.current = this.incoming;
      this.incoming = null;
      if (this.current && this.current.playedMs >= this.current.track.durationMs) {
        this.current.stream.kill();
        this.current = null;
      }
    }

    if (this.maxFrames !== null && this.framesWritten >= this.maxFrames) return false;
    return true;
  }

  async start(): Promise<void> {
    let running = true;
    while (running) {
      running = await this.tick();
      if (!running) break;
      if (this.realtime) await new Promise((resolve) => setTimeout(resolve, TICK_MS));
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.current?.stream.kill();
    this.incoming?.stream.kill();
    await this.sink.close();
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`[poc] scanning ${opts.folder}`);
  const tracks = await collectTracks(opts.folder);
  if (tracks.length === 0) {
    console.error("[poc] no playable audio found");
    process.exit(1);
  }
  const totalMinutes = tracks.reduce((sum, t) => sum + t.durationMs, 0) / 60000;
  console.log(`[poc] ${tracks.length} tracks, ${totalMinutes.toFixed(1)} min, crossfade ${opts.crossfadeMs} ms`);

  const sink = opts.out ? fileSink(opts.out) : ffplaySink();
  const maxFrames = opts.seconds ? Math.round((opts.seconds * SAMPLE_RATE)) : null;
  const station = new Station(tracks, sink, opts.crossfadeMs, maxFrames, opts.shuffle, !opts.out);

  const shutdown = async () => {
    await station.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await station.start();
  await station.stop();
  console.log("[poc] done");
}

void main();
