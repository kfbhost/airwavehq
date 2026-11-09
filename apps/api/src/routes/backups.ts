import type { FastifyInstance } from "fastify";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, readdir, stat, unlink, writeFile, readFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { config } from "../config.js";
import { db, schema } from "../db/client.js";
import { probeAudio } from "../services/ffprobe.js";
import { requireAdmin, verifyToken } from "../auth.js";

const DATA_DIR = () => resolve(config.dataDir);
const BACKUP_DIR = () => resolve(config.dataDir, "backups");

// Every backup is broken into independently creatable components, so a station
// can take a quick settings-only snapshot and keep its (potentially very large)
// media library in a separate archive. The database component already carries
// everything needed to rebuild the station's configuration on a fresh install:
// settings, users, shows, schedule, playlists, rotations, DJ slots and the
// library index. The media components carry the audio files themselves.
type Component = "db" | "media" | "recordings" | "voice" | "config";
// Media components are the ones whose files are useless without their index
// rows, so they are the ones that carry a manifest and get reindexed on restore.
const MEDIA_COMPONENTS: Array<"media" | "recordings" | "voice"> = ["media", "recordings", "voice"];
const ALL_COMPONENTS: Component[] = ["db", "media", "recordings", "voice", "config"];
// Components big enough to matter for disk space, and therefore worth being
// able to pull straight off the server without staging a file on it first.
const STREAMABLE: Array<"db" | "media" | "recordings" | "voice"> = ["db", "media", "recordings", "voice"];

export type BackupType = Component | "data";

const DB_RE = /^db-\d{4}-\d{2}-\d{2}-\d{4}\.sql\.gz$/;
const MEDIA_RE = /^media-\d{4}-\d{2}-\d{2}-\d{4}\.tar\.gz$/;
const RECORDINGS_RE = /^recordings-\d{4}-\d{2}-\d{2}-\d{4}\.tar\.gz$/;
const VOICE_RE = /^voice-\d{4}-\d{2}-\d{2}-\d{4}\.tar\.gz$/;
const CONFIG_RE = /^config-\d{4}-\d{2}-\d{2}-\d{4}\.env$/;
// Legacy: the original version wrote a single archive holding the entire data
// directory (media + recordings + voice). Still listed, downloadable and
// restorable so old snapshots keep working.
const DATA_RE = /^data-\d{4}-\d{2}-\d{2}-\d{4}\.tar\.gz$/;

function fileType(name: string): BackupType | null {
  if (DB_RE.test(name)) return "db";
  if (MEDIA_RE.test(name)) return "media";
  if (RECORDINGS_RE.test(name)) return "recordings";
  if (VOICE_RE.test(name)) return "voice";
  if (CONFIG_RE.test(name)) return "config";
  if (DATA_RE.test(name)) return "data";
  return null;
}

function parseDbUrl(url: string): { host: string; port: number; user: string; password: string; db: string } {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || "5432"),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    db: decodeURIComponent(u.pathname.replace(/^\//, "")),
  };
}

function run(cmd: string, env: Record<string, string> = {}, timeoutMs = 30 * 60 * 1000): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "sh",
      ["-c", cmd],
      { env: { ...process.env, ...env }, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || stdout || "").toString().trim().split("\n").slice(-4).join(" | ");
          reject(new Error(`${detail || err.message}`));
          return;
        }
        resolvePromise();
      }
    );
  });
}

function capture(cmd: string, env: Record<string, string> = {}, timeoutMs = 60 * 1000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "sh",
      ["-c", cmd],
      { env: { ...process.env, ...env }, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error((stderr || stdout || "").toString().trim() || err.message));
          return;
        }
        resolvePromise(stdout.toString());
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Progress reporting
//
// Archiving or restoring a media library can run for many minutes, and the
// request cannot answer until it is finished, so the page used to sit on a dead
// "Restoring…" spinner with no way to tell work from a hang. Each long job now
// gets an id: the browser sends it with the request and polls
// GET /backups/jobs/:id while it waits. Progress is measured rather than
// guessed — an archive being written is tracked against the size of the folder
// going into it, and extraction counts the archive's own bytes as they are read.
// ---------------------------------------------------------------------------
type JobKind = "backup" | "restore";

interface BackupJob {
  id: string;
  kind: JobKind;
  state: "running" | "done" | "error";
  /** 0–100, or null while the current step has no measurable size. */
  percent: number | null;
  label: string;
  detail: string | null;
  error: string | null;
  result: unknown;
  startedAt: number;
  endedAt: number | null;
}

const jobs = new Map<string, BackupJob>();
const JOB_TTL_MS = 60 * 60 * 1000;

function pruneJobs(): void {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.endedAt !== null && now - j.endedAt > JOB_TTL_MS) jobs.delete(id);
  }
}

/** Progress reporting is a no-op when the caller did not send a job id. */
function startJob(id: unknown, kind: JobKind): BackupJob | null {
  if (typeof id !== "string" || id.length < 6 || id.length > 100) return null;
  pruneJobs();
  const job: BackupJob = {
    id,
    kind,
    state: "running",
    percent: null,
    label: kind === "backup" ? "Preparing the backup…" : "Preparing the restore…",
    detail: null,
    error: null,
    result: null,
    startedAt: Date.now(),
    endedAt: null,
  };
  jobs.set(id, job);
  return job;
}

function step(job: BackupJob | null, label: string, percent: number | null = null, detail: string | null = null): void {
  if (!job) return;
  job.label = label;
  job.percent = percent;
  job.detail = detail;
}

function doneJob(job: BackupJob | null, result: unknown): void {
  if (!job) return;
  job.state = "done";
  job.percent = 100;
  job.label = "Done";
  job.detail = null;
  job.result = result;
  job.endedAt = Date.now();
}

function failJob(job: BackupJob | null, message: string): void {
  if (!job) return;
  job.state = "error";
  job.percent = null;
  job.label = "Failed";
  job.error = message;
  job.endedAt = Date.now();
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

/** Resolves when a child exits, rejecting with its last stderr lines on failure. */
function waitExit(child: ChildProcess): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => {
      stderr = (stderr + c.toString()).slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code) {
        const detail = stderr.trim().split("\n").slice(-4).join(" | ");
        reject(new Error(detail || `process exited with code ${code}`));
        return;
      }
      resolvePromise();
    });
  });
}

/** Runs `task` while sampling a value (an output file's growing size) into `onSample`. */
async function withSampling(
  task: Promise<void>,
  sample: () => Promise<number>,
  onSample: (value: number) => void,
  intervalMs = 800
): Promise<void> {
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      await new Promise((r) => setTimeout(r, intervalMs));
      if (stopped) break;
      onSample(await sample());
    }
  })();
  try {
    await task;
  } finally {
    stopped = true;
    await loop;
  }
}

/**
 * Removes the leftovers of an upload that died mid-transfer (a container restart,
 * a closed browser) so a multi-gigabyte part file cannot sit on the disk forever.
 */
async function sweepStaleUploads(): Promise<void> {
  try {
    const entries = await readdir(BACKUP_DIR());
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const f of entries) {
      if (!f.startsWith(".upload-") || !f.endsWith(".part")) continue;
      const full = join(BACKUP_DIR(), f);
      const s = await stat(full);
      if (s.mtimeMs < cutoff) await unlink(full).catch(() => {});
    }
  } catch {
    // Nothing to sweep.
  }
}

async function fileBytes(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

async function dirBytes(dir: string): Promise<number> {
  try {
    const out = await capture(`du -sk "${dir}" 2>/dev/null`);
    const kb = Number(out.trim().split(/\s+/)[0] ?? "0");
    return Number.isFinite(kb) ? kb * 1024 : 0;
  } catch {
    return 0;
  }
}

async function databaseBytes(pgArgs: string[], pgEnv: Record<string, string>): Promise<number> {
  try {
    const out = await capture(`psql ${pgArgs.join(" ")} -tAc "select pg_database_size(current_database())"`, pgEnv);
    return Number(out.trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * Archives `entries` (folders inside the data dir) plus the optional index
 * manifest. `du` gives the folder's total size up front, so the archive file's
 * own growth is a real percentage rather than a spinner.
 *
 * The manifest lives in the data dir (not /tmp) and is passed on the same `-C`
 * as the folders: tar in the api image is busybox tar, whose `-C` is global
 * rather than positional, so a second one silently changes the directory for
 * every name in the command.
 */
async function makeTar(
  outFile: string,
  entries: string[],
  manifestPath: string | null,
  job: BackupJob | null,
  label: string
): Promise<void> {
  const total = (await Promise.all(entries.map((e) => dirBytes(join(DATA_DIR(), e))))).reduce((a, b) => a + b, 0);
  const args = ["czf", outFile, "-C", DATA_DIR()];
  // Written first so a restore can read it without walking the whole archive.
  if (manifestPath) args.push(basename(manifestPath));
  args.push(...entries);
  const child = spawn("tar", args);
  await withSampling(waitExit(child), () => fileBytes(outFile), (written) => {
    step(
      job,
      label,
      total > 0 ? Math.min(99, Math.round((written / total) * 100)) : null,
      total > 0 ? `${fmtBytes(written)} of ${fmtBytes(total)}` : null
    );
  });
}

/**
 * Extracts an archive into the data dir. The bytes of the archive are counted as
 * they are fed to tar, so a 500 MB snapshot reports honest progress without a
 * second pass over it.
 */
async function extractTar(file: string, dest: string, job: BackupJob | null, label: string): Promise<void> {
  const total = await fileBytes(file);
  const child = spawn("tar", ["xzf", "-", "-C", dest]);
  const finished = waitExit(child);
  const src = createReadStream(file);
  let read = 0;
  src.on("data", (c) => {
    read += typeof c === "string" ? Buffer.byteLength(c) : c.length;
    step(
      job,
      label,
      total > 0 ? Math.min(99, Math.round((read / total) * 100)) : null,
      total > 0 ? `${fmtBytes(read)} of ${fmtBytes(total)}` : null
    );
  });
  let pipeErr: unknown = null;
  try {
    await pipeline(src, child.stdin!);
  } catch (e) {
    // tar's own stderr is surfaced by `finished` below.
    pipeErr = e;
  }
  await finished;
  if (pipeErr) throw pipeErr;
}

/** pg_dump piped to gzip, with the growing dump file reported against the DB size. */
async function dumpDb(
  outFile: string,
  pgArgs: string[],
  pgEnv: Record<string, string>,
  job: BackupJob | null,
  label: string
): Promise<void> {
  const estimate = await databaseBytes(pgArgs, pgEnv);
  const child = spawn("sh", ["-c", `pg_dump ${pgArgs.join(" ")} | gzip -1 > "${outFile}"`], {
    env: { ...process.env, ...pgEnv },
  });
  await withSampling(waitExit(child), () => fileBytes(outFile), (written) => {
    step(
      job,
      label,
      estimate > 0 ? Math.min(99, Math.round((written / estimate) * 100)) : null,
      estimate > 0 ? `${fmtBytes(written)} of ~${fmtBytes(estimate)}` : fmtBytes(written)
    );
  });
}

/**
 * Drops the session settings a newer pg_dump writes that an older server
 * rejects (Postgres 17 added `transaction_timeout`), streaming line by line so
 * the restore can be reported by bytes rather than buffering the whole dump.
 */
class StripSessionSettings extends Transform {
  private carry = "";

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (error?: Error | null, data?: Buffer) => void): void {
    const lines = (this.carry + chunk.toString("utf8")).split("\n");
    this.carry = lines.pop() ?? "";
    const kept = lines.filter((l) => !/^SET transaction_timeout = \d+;$/.test(l));
    cb(null, kept.length ? Buffer.from(`${kept.join("\n")}\n`) : undefined);
  }

  override _flush(cb: (error?: Error | null) => void): void {
    if (this.carry && !/^SET transaction_timeout = \d+;$/.test(this.carry)) this.push(`${this.carry}\n`);
    this.carry = "";
    cb();
  }
}

/** Feeds a gzipped dump into psql, counting the file as it is consumed. */
async function restoreDb(
  file: string,
  pgArgs: string[],
  pgEnv: Record<string, string>,
  job: BackupJob | null,
  label: string
): Promise<void> {
  const total = await fileBytes(file);
  const child = spawn("psql", [...pgArgs, "-v", "ON_ERROR_STOP=1"], { env: { ...process.env, ...pgEnv } });
  const finished = waitExit(child);
  const src = createReadStream(file);
  let read = 0;
  src.on("data", (c) => {
    read += typeof c === "string" ? Buffer.byteLength(c) : c.length;
    step(
      job,
      label,
      total > 0 ? Math.min(99, Math.round((read / total) * 100)) : null,
      total > 0 ? `${fmtBytes(read)} of ${fmtBytes(total)}` : null
    );
  });
  let pipeErr: unknown = null;
  try {
    await pipeline(src, createGunzip(), new StripSessionSettings(), child.stdin!);
  } catch (e) {
    pipeErr = e;
  }
  await finished;
  if (pipeErr) throw pipeErr;
}

// ---------------------------------------------------------------------------
// Making media archives self-describing
//
// An archive of /data/recordings holds only the audio files. The rows that make
// those files *visible* — the recordings list, the music library index, the
// voice tracks — live in the database, so restoring the archive on its own
// appeared to complete while changing nothing anyone could see. Each media
// archive now carries a small index manifest, and a restore rebuilds any missing
// rows from it. Archives taken before this existed (or a folder that arrived by
// other means) fall back to the files themselves.
// ---------------------------------------------------------------------------
type MediaComponent = "media" | "recordings" | "voice";

interface Manifest {
  version: number;
  component: string;
  recordings?: Array<Record<string, unknown>>;
  tracks?: Array<Record<string, unknown>>;
  voiceTracks?: Array<Record<string, unknown>>;
  folders?: Array<Record<string, unknown>>;
}

interface IndexReport {
  /** Rows the restore added, so the page can say what actually reappeared. */
  added: number;
  /** Of those, how many came from the archive's own manifest. */
  fromManifest: number;
  /** Total index rows for this component afterwards. */
  total: number;
}

function manifestFileName(comp: string): string {
  return `.restore-index-${comp}.json`;
}

const AUDIO_EXT = new Set([".mp3", ".m4a", ".aac", ".wav", ".ogg", ".flac", ".opus"]);

function mimeFor(ext: string): string {
  switch (ext) {
    case ".m4a":
    case ".aac":
      return "audio/aac";
    case ".wav":
      return "audio/wav";
    case ".ogg":
    case ".opus":
      return "audio/ogg";
    case ".flac":
      return "audio/flac";
    default:
      return "audio/mpeg";
  }
}

/** "jon-e-c-oldskool-rave" -> "Jon E C Oldskool Rave" — how the engine slugs a show title. */
function titleFromSlug(slug: string): string {
  const words = slug.split("-").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.join(" ") || "Recording";
}

function asDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

async function buildManifest(comp: MediaComponent): Promise<Manifest> {
  const base: Manifest = { version: 1, component: comp };
  if (comp === "recordings") base.recordings = await db.select().from(schema.recordings);
  else if (comp === "voice") base.voiceTracks = await db.select().from(schema.voiceTracks);
  else {
    base.tracks = await db.select().from(schema.tracks);
    base.folders = await db.select().from(schema.folders);
  }
  return base;
}

/** Writes the index manifest into the data dir so tar can put it in the archive. */
async function stageManifest(comp: MediaComponent): Promise<string | null> {
  try {
    const path = join(DATA_DIR(), manifestFileName(comp));
    await writeFile(path, JSON.stringify(await buildManifest(comp)));
    return path;
  } catch {
    // A component with no readable index still archives — just without the
    // manifest, and the file-scan fallback covers it on restore.
    return null;
  }
}

/**
 * A backup killed mid-run can leave its manifest behind. They are small, but
 * they would otherwise sit in the data directory forever.
 */
async function sweepStaleManifests(): Promise<void> {
  try {
    const entries = await readdir(DATA_DIR());
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    for (const f of entries) {
      if (!f.startsWith(".restore-index-")) continue;
      const full = join(DATA_DIR(), f);
      const s = await stat(full);
      if (s.mtimeMs < cutoff) await unlink(full).catch(() => {});
    }
  } catch {
    // Nothing to sweep.
  }
}

async function insertChunked<T extends { id: string }>(
  values: T[],
  insert: (chunk: T[]) => Promise<unknown>,
  size = 200
): Promise<number> {
  if (values.length === 0) return 0;
  for (let i = 0; i < values.length; i += size) {
    await insert(values.slice(i, i + size));
  }
  return values.length;
}

/** Index rows for recordings whose files exist on disk but are not listed yet. */
async function ingestRecordingRows(rows: Array<Record<string, unknown>>): Promise<number> {
  if (rows.length === 0) return 0;
  const existing = await db.select({ filePath: schema.recordings.filePath }).from(schema.recordings);
  const have = new Set(existing.map((r) => r.filePath));
  const djIds = new Set((await db.select({ id: schema.users.id }).from(schema.users)).map((u) => u.id));
  const values = rows
    .map((r) => ({
      id: String(r.id),
      showId: r.showId ? String(r.showId) : null,
      // A recording whose DJ no longer exists would break the foreign key, so it
      // is restored unattributed rather than rejected.
      djId: r.djId && djIds.has(String(r.djId)) ? String(r.djId) : null,
      title: String(r.title ?? "Recording"),
      startedAt: asDate(r.startedAt) ?? new Date(),
      endedAt: asDate(r.endedAt),
      filePath: String(r.filePath ?? ""),
      durationSeconds: Number(r.durationSeconds ?? 0) || 0,
      isPodcast: r.isPodcast !== false,
      createdAt: asDate(r.createdAt) ?? new Date(),
    }))
    .filter((r) => r.filePath && !have.has(r.filePath) && existsSync(r.filePath));
  return insertChunked(values, (chunk) => db.insert(schema.recordings).values(chunk).onConflictDoNothing());
}

async function ingestVoiceRows(rows: Array<Record<string, unknown>>): Promise<number> {
  if (rows.length === 0) return 0;
  const existing = await db.select({ filePath: schema.voiceTracks.filePath }).from(schema.voiceTracks);
  const have = new Set(existing.map((r) => r.filePath));
  const values = rows
    .map((r) => ({
      id: String(r.id),
      title: String(r.title ?? "Voice track"),
      showId: r.showId ? String(r.showId) : null,
      filePath: String(r.filePath ?? ""),
      durationSeconds: Number(r.durationSeconds ?? 0) || 0,
      loudnessGainDb: Number(r.loudnessGainDb ?? 0) || 0,
      playEvery: Number(r.playEvery ?? 3) || 3,
      isActive: r.isActive !== false,
      createdAt: asDate(r.createdAt) ?? new Date(),
    }))
    .filter((r) => r.filePath && !have.has(r.filePath) && existsSync(r.filePath));
  return insertChunked(values, (chunk) => db.insert(schema.voiceTracks).values(chunk).onConflictDoNothing());
}

async function ingestTrackRows(
  rows: Array<Record<string, unknown>>,
  folderRows: Array<Record<string, unknown>>
): Promise<number> {
  // Folder names first so an archived track's folder still resolves in the UI.
  const folderNames = folderRows.map((f) => String(f.name ?? "")).filter(Boolean);
  if (folderNames.length > 0) {
    await db.insert(schema.folders).values(folderNames.map((name) => ({ name }))).onConflictDoNothing();
  }
  if (rows.length === 0) return 0;
  const existing = await db.select({ filePath: schema.tracks.filePath }).from(schema.tracks);
  const have = new Set(existing.map((r) => r.filePath));
  const values = rows
    .map((r) => ({
      id: String(r.id),
      title: String(r.title ?? "Untitled"),
      artist: String(r.artist ?? ""),
      album: String(r.album ?? ""),
      folder: r.folder ? String(r.folder) : null,
      kind: (String(r.kind ?? "music")) as "music",
      durationSeconds: Number(r.durationSeconds ?? 0) || 0,
      filePath: String(r.filePath ?? ""),
      fileHash: r.fileHash ? String(r.fileHash) : null,
      fileSize: Number(r.fileSize ?? 0) || 0,
      mime: String(r.mime ?? "audio/mpeg"),
      codec: r.codec ? String(r.codec) : null,
      bitrateKbps: r.bitrateKbps === null || r.bitrateKbps === undefined ? null : Number(r.bitrateKbps) || 0,
      loudnessGainDb: Number(r.loudnessGainDb ?? 0) || 0,
      loudnessLufs: r.loudnessLufs === null || r.loudnessLufs === undefined ? null : Number(r.loudnessLufs),
      artworkPath: r.artworkPath ? String(r.artworkPath) : null,
      bpm: r.bpm === null || r.bpm === undefined ? null : Number(r.bpm),
      playCount: Number(r.playCount ?? 0) || 0,
      lastPlayedAt: asDate(r.lastPlayedAt),
      isActive: r.isActive !== false,
      createdAt: asDate(r.createdAt) ?? new Date(),
      updatedAt: asDate(r.updatedAt) ?? new Date(),
    }))
    .filter((r) => r.filePath && !have.has(r.filePath) && existsSync(r.filePath));
  return insertChunked(values, (chunk) => db.insert(schema.tracks).values(chunk).onConflictDoNothing());
}

/**
 * Last resort for archives taken before manifests existed: give every recording
 * file that nothing points at an index row again. The engine names recordings
 * "<show-slug>-YYYY-MM-DD-HH-MM-SS.mp3" in UTC, which recovers both a title and
 * an air time.
 */
async function adoptRecordingFiles(job: BackupJob | null): Promise<number> {
  const dir = join(DATA_DIR(), "recordings");
  const files = await readdir(dir).catch(() => [] as string[]);
  if (files.length === 0) return 0;
  const existing = await db.select({ filePath: schema.recordings.filePath }).from(schema.recordings);
  const have = new Set(existing.map((r) => r.filePath));
  const pending = files.filter((f) => AUDIO_EXT.has(extname(f).toLowerCase()) && !have.has(join(dir, f)));
  let added = 0;
  for (const [i, f] of pending.entries()) {
    const full = join(dir, f);
    step(job, "Rebuilding the recordings index…", Math.round(((i + 1) / pending.length) * 100), `${i + 1} of ${pending.length}`);
    const m = /^(.+)-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})\.[^.]+$/.exec(f);
    if (!m) continue;
    const startedAt = new Date(`${m[2]}-${m[3]}-${m[4]}T${m[5]}:${m[6]}:${m[7]}Z`);
    if (Number.isNaN(startedAt.getTime())) continue;
    let durationSeconds = 0;
    try {
      durationSeconds = (await probeAudio(full)).durationSeconds;
    } catch {
      // An unprobeable file is still listed, just without a running time.
    }
    const endedAt = durationSeconds > 0 ? new Date(startedAt.getTime() + durationSeconds * 1000) : null;
    try {
      await db.insert(schema.recordings).values({
        title: titleFromSlug(m[1] ?? "recording"),
        startedAt,
        endedAt,
        filePath: full,
        durationSeconds,
        isPodcast: true,
      });
      added += 1;
    } catch {
      // Anything the database rejects is skipped rather than failing the restore.
    }
  }
  return added;
}

/** Equivalent fallback for a music library restored without an index. */
async function adoptTrackFiles(job: BackupJob | null): Promise<number> {
  const dir = join(DATA_DIR(), "media");
  const files = await readdir(dir).catch(() => [] as string[]);
  if (files.length === 0) return 0;
  const existing = await db.select({ filePath: schema.tracks.filePath }).from(schema.tracks);
  const have = new Set(existing.map((r) => r.filePath));
  // Artwork (`<uuid>-artwork.jpg`) and DJ avatars share this folder, so only
  // real audio files are considered.
  const pending = files.filter((f) => AUDIO_EXT.has(extname(f).toLowerCase()) && !have.has(join(dir, f)));
  let added = 0;
  for (const [i, f] of pending.entries()) {
    const full = join(dir, f);
    step(job, "Rebuilding the music library index…", Math.round(((i + 1) / pending.length) * 100), `${i + 1} of ${pending.length}`);
    try {
      const probe = await probeAudio(full);
      await db.insert(schema.tracks).values({
        title: probe.title || basename(f).replace(/\.[^.]+$/, ""),
        artist: probe.artist,
        album: probe.album,
        kind: "music",
        durationSeconds: probe.durationSeconds,
        filePath: full,
        fileSize: await fileBytes(full),
        mime: mimeFor(extname(f).toLowerCase()),
        codec: probe.codec,
        bitrateKbps: probe.bitrateKbps,
      });
      added += 1;
    } catch {
      // Skip files the database or ffprobe rejects.
    }
  }
  return added;
}

/** Reads the archive's manifest (if any) then adopts whatever is still unlisted. */
async function reindexComponent(comp: MediaComponent, job: BackupJob | null): Promise<IndexReport> {
  const manifestPath = join(DATA_DIR(), manifestFileName(comp));
  let manifest: Manifest | null = null;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  } catch {
    manifest = null; // archive predates the manifest, or none was staged
  }
  await unlink(manifestPath).catch(() => {});

  let fromManifest = 0;
  let added = 0;
  if (comp === "recordings") {
    fromManifest = await ingestRecordingRows(manifest?.recordings ?? []);
    added = fromManifest + (await adoptRecordingFiles(job));
    const rows = await db.select({ id: schema.recordings.id }).from(schema.recordings);
    return { added, fromManifest, total: rows.length };
  }
  if (comp === "voice") {
    fromManifest = await ingestVoiceRows(manifest?.voiceTracks ?? []);
    const rows = await db.select({ id: schema.voiceTracks.id }).from(schema.voiceTracks);
    return { added: fromManifest, fromManifest, total: rows.length };
  }
  fromManifest = await ingestTrackRows(manifest?.tracks ?? [], manifest?.folders ?? []);
  added = fromManifest + (await adoptTrackFiles(job));
  const rows = await db.select({ id: schema.tracks.id }).from(schema.tracks);
  return { added, fromManifest, total: rows.length };
}

/** What each archive is called while it is being written, for the progress bar. */
const ARCHIVE_LABEL: Record<MediaComponent, string> = {
  media: "Archiving the music library…",
  recordings: "Archiving the show recordings…",
  voice: "Archiving the voice links…",
};

function extractLabelFor(comp: MediaComponent | "data"): string {
  return comp === "data" ? "Extracting the archived data files…" : ARCHIVE_LABEL[comp].replace("Archiving", "Restoring");
}

export interface BackupRow {
  id: string;
  type: BackupType;
  size: number;
  modified: string;
}

async function listBackups(): Promise<BackupRow[]> {
  await mkdir(BACKUP_DIR(), { recursive: true });
  const files = await readdir(BACKUP_DIR());
  const out: BackupRow[] = [];
  for (const f of files) {
    const type = fileType(f);
    if (!type) continue;
    const s = await stat(join(BACKUP_DIR(), f));
    out.push({ id: f, type, size: s.size, modified: s.mtime.toISOString() });
  }
  out.sort((a, b) => b.modified.localeCompare(a.modified));
  return out;
}

function safeBackupPath(id: string): string | null {
  const name = basename(id);
  if (name !== id || name.includes("..") || name.includes("/") || name.includes("\\")) return null;
  if (!fileType(name)) return null;
  return join(BACKUP_DIR(), name);
}

function stampNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// How big each component currently is, so the admin can see the cost of a
// settings-only snapshot versus one that includes the whole music library.
async function componentSizes(pgArgs: string[], pgEnv: Record<string, string>): Promise<Record<string, number | null>> {
  const sizes: Record<string, number | null> = {};
  // Free space on the volume the data (and therefore the backups) live on, so
  // the UI can warn before someone starts an archive that cannot possibly fit.
  try {
    const out = await capture(`df -kP "${DATA_DIR()}" | tail -1 | awk '{print $4}'`);
    const kb = Number(out.trim());
    sizes.free = Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    sizes.free = null;
  }
  for (const dir of MEDIA_COMPONENTS) {
    try {
      const out = await capture(`du -sk "${join(DATA_DIR(), dir)}"`);
      const kb = Number(out.trim().split(/\s+/)[0] ?? "0");
      sizes[dir] = Number.isFinite(kb) ? kb * 1024 : null;
    } catch {
      sizes[dir] = null; // folder not created yet
    }
  }
  try {
    const out = await capture(`psql ${pgArgs.join(" ")} -tAc "select pg_database_size(current_database())"`, pgEnv);
    sizes.db = Number(out.trim()) || null;
  } catch {
    sizes.db = null;
  }
  return sizes;
}

function envTextFrom(): Promise<string> {
  return (async () => {
    const candidates = [
      "/app/.env", // inside the container (mounted by compose)
      resolve(config.dataDir, "..", ".env"), // local dev: repo root
    ];
    for (const p of candidates) {
      try {
        return await readFile(p, "utf8");
      } catch {
        // try the next candidate
      }
    }
    const keys = ["DATABASE_URL", "JWT_SECRET", "ENGINE_SECRET", "PUBLIC_BASE_URL", "STATION_NAME", "STATION_TIMEZONE", "PUBLIC_STREAM_URL", "ADMIN_EMAIL", "ADMIN_NAME", "DOMAIN"];
    return keys.filter((k) => process.env[k]).map((k) => `${k}=${process.env[k]}`).join("\n") + "\n";
  })();
}

export function backupRoutes(app: FastifyInstance): void {
  const dbInfo = parseDbUrl(config.databaseUrl);
  const pgEnv = { PGPASSWORD: dbInfo.password };
  const pgArgs = ["-h", dbInfo.host, "-p", String(dbInfo.port), "-U", dbInfo.user, "-d", dbInfo.db];

  // Admin: list every backup file on disk.
  app.get("/backups", { preHandler: requireAdmin }, async () => ({ backups: await listBackups() }));

  // Admin: current size of each component, so the UI can show what each
  // choice costs before the admin commits to it.
  app.get("/backups/sizes", { preHandler: requireAdmin }, async () => ({
    sizes: await componentSizes(pgArgs, pgEnv),
  }));

  // Admin: progress of a running backup or restore. The page sends a job id with
  // the request and polls this while it waits.
  app.get("/backups/jobs/:id", { preHandler: requireAdmin }, async (req, reply) => {
    pruneJobs();
    const { id } = req.params as { id: string };
    const job = jobs.get(id);
    if (!job) return reply.code(404).send({ error: "Unknown job" });
    return { job };
  });

  // Admin: create backups. `components` selects what to write; omit it for a
  // full set. A settings-only snapshot (db + config) is quick and tiny even
  // when the music library is enormous. Runs synchronously, so a media archive
  // over a big library can take minutes.
  app.post("/backups", { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { components?: unknown; jobId?: string };
    const job = startJob(body.jobId, "backup");
    const requested = Array.isArray(body.components)
      ? ALL_COMPONENTS.filter((c) => (body.components as unknown[]).includes(c))
      : ALL_COMPONENTS;
    if (requested.length === 0) {
      failJob(job, "Choose at least one thing to back up.");
      return reply.code(400).send({ error: "Choose at least one thing to back up." });
    }

    await mkdir(BACKUP_DIR(), { recursive: true });
    await sweepStaleManifests();
    const stamp = stampNow();
    const targets: Array<{ path: string; make: () => Promise<void> }> = [];
    // Manifest temp files are only needed while tar is running.
    const staged: string[] = [];

    if (requested.includes("db")) {
      const dbFile = join(BACKUP_DIR(), `db-${stamp}.sql.gz`);
      targets.push({ path: dbFile, make: () => dumpDb(dbFile, pgArgs, pgEnv, job, "Dumping the database…") });
    }
    for (const comp of MEDIA_COMPONENTS) {
      if (!requested.includes(comp)) continue;
      const file = join(BACKUP_DIR(), `${comp}-${stamp}.tar.gz`);
      targets.push({
        path: file,
        make: async () => {
          // The folder may not exist yet on a fresh install — tar would fail,
          // so create it and archive an (empty) tree rather than erroring out.
          await mkdir(join(DATA_DIR(), comp), { recursive: true });
          // The index travels with the audio, so restoring this one archive is
          // enough to make the files show up again.
          const manifest = await stageManifest(comp);
          if (manifest) staged.push(manifest);
          await makeTar(file, [comp], manifest, job, ARCHIVE_LABEL[comp]);
        },
      });
    }
    if (requested.includes("config")) {
      const configFile = join(BACKUP_DIR(), `config-${stamp}.env`);
      targets.push({
        path: configFile,
        make: async () => {
          step(job, "Saving the config…");
          await writeFile(configFile, await envTextFrom());
        },
      });
    }

    const written: string[] = [];
    // Names are stamped to the minute, so a failed run could otherwise delete a
    // good snapshot it happened to share a name with.
    const preExisting = new Set(targets.filter((t) => existsSync(t.path)).map((t) => t.path));
    try {
      for (const t of targets) {
        await t.make();
        written.push(t.path);
      }
    } catch (e) {
      // Clean up every partial output so a half-written archive is never
      // mistaken for a good backup — but never one that was already there.
      await Promise.all(
        targets.filter((t) => !preExisting.has(t.path)).map((t) => unlink(t.path).catch(() => {}))
      );
      const message = e instanceof Error ? e.message : "unknown error";
      failJob(job, message);
      reply.code(500);
      return { error: `Backup failed: ${message}` };
    } finally {
      await Promise.all(staged.map((p) => unlink(p).catch(() => {})));
    }
    const result = {
      backups: await listBackups(),
      created: written.map((p) => basename(p)),
    };
    doneJob(job, result);
    return result;
  });

  // Admin: download a backup file. The JWT may come via the Authorization
  // header or a ?token= query param so a plain <a> download link works.
  app.get("/backups/:id/download", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { token?: string };
    const user = req.user ?? (q.token ? await verifyToken(q.token) : null);
    if (!user || user.role !== "admin") return reply.code(401).send({ error: "Unauthorized" });
    const file = safeBackupPath(id);
    if (!file) return reply.code(404).send({ error: "Not found" });
    try {
      await stat(file);
    } catch {
      return reply.code(404).send({ error: "Not found" });
    }
    // sendFile deliberately sets no Content-Disposition (it is meant for inline
    // assets), so a browser saving an <a download> link falls back to the last
    // URL segment — every snapshot arrived as "download". Send the real name as
    // an attachment. safeBackupPath has already validated the name against the
    // strict db-*.sql.gz / media-*.tar.gz / … patterns, so quoting it is safe.
    const name = basename(file);
    reply.header("Content-Disposition", `attachment; filename="${name}"`);
    return reply.sendFile(name, BACKUP_DIR());
  });

  // Admin: stream a component straight to the browser WITHOUT writing it to the
  // server first. A station whose library is larger than its free disk space
  // can never stage a media .tar.gz on disk, so tar/pg_dump writes directly
  // down the HTTP response instead. The streamed filename matches the on-disk
  // naming, so the file can be uploaded to another station and restored with no
  // conversion step.
  app.get("/backups/stream/:component", async (req, reply) => {
    const { component } = req.params as { component: string };
    const q = req.query as { token?: string };
    const user = req.user ?? (q.token ? await verifyToken(q.token) : null);
    if (!user || user.role !== "admin") return reply.code(401).send({ error: "Unauthorized" });
    const kind = STREAMABLE.find((c) => c === component);
    if (!kind) return reply.code(404).send({ error: "Not found" });

    const stamp = stampNow();
    const name = kind === "db" ? `db-${stamp}.sql.gz` : `${kind}-${stamp}.tar.gz`;

    // Once the response has started a failure can no longer be reported as a
    // JSON error — the admin would just see a broken download — so check the
    // things that commonly fail up front.
    if (kind === "db") {
      try {
        await capture(`psql ${pgArgs.join(" ")} -tAc "select 1"`, pgEnv, 15_000);
      } catch (e) {
        reply.code(500);
        return { error: `Cannot reach the database: ${e instanceof Error ? e.message : "unknown error"}` };
      }
    } else {
      // A fresh install may not have the folder yet; archive an empty tree
      // rather than failing. Also proves the path is readable before we promise
      // the browser a file.
      try {
        await mkdir(join(DATA_DIR(), kind), { recursive: true });
        await stat(join(DATA_DIR(), kind));
      } catch {
        reply.code(500);
        return { error: `Cannot read the ${kind} folder on the server.` };
      }
    }

    // A direct download is the usual way to move a big library to another
    // station, so the archive carries the same index manifest an on-disk snapshot
    // does — restoring the streamed file makes its files visible again.
    const manifestPath = kind === "db" ? null : await stageManifest(kind);
    // One -C only: busybox tar (the api image) applies -C globally, so a second
    // one would change the directory for the folders as well.
    const manifestArgs = manifestPath ? `"${basename(manifestPath)}" ` : "";

    // gzip level 1: the audio is already compressed, so the default level would
    // burn hours of CPU on a big library to save almost nothing.
    const child =
      kind === "db"
        ? spawn("sh", ["-c", `pg_dump ${pgArgs.join(" ")} | gzip -1`], {
            env: { ...process.env, ...pgEnv },
          })
        : spawn("sh", ["-c", `tar cf - -C "${DATA_DIR()}" ${manifestArgs}"${kind}" | gzip -1`]);

    // The staged manifest is only needed while tar reads from it.
    if (manifestPath) {
      const cleanup = () => void unlink(manifestPath).catch(() => {});
      child.on("close", cleanup);
      reply.raw.on("close", cleanup);
    }

    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => {
      stderr = (stderr + c.toString()).slice(-2000);
    });
    child.on("error", (e) => {
      req.log.error({ err: e, component: kind }, "backup stream could not start");
      child.stdout.destroy(e);
    });
    child.on("close", (code) => {
      if (code) req.log.warn({ code, component: kind, stderr }, "backup stream ended early");
    });
    // A cancelled or closed download must not leave tar/pg_dump running.
    reply.raw.on("close", () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    });

    return reply
      .header("content-type", "application/gzip")
      .header("content-disposition", `attachment; filename="${name}"`)
      .header("cache-control", "no-store")
      // nginx would otherwise spool the whole response to a temp file — exactly
      // the disk usage this endpoint exists to avoid.
      .header("x-accel-buffering", "no")
      .send(child.stdout);
  });

  // Admin: upload a backup file (database dump, media/recordings/voice archive
  // or config bundle) so a snapshot taken on another machine can be imported
  // and restored here. The filename is validated against the safe patterns.
  app.post("/backups/upload", { preHandler: requireAdmin }, async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "No file uploaded" });
    if (file.file.truncated) return reply.code(400).send({ error: "File too large" });

    const name = basename(file.filename || "").trim();
    if (!fileType(name)) {
      return reply.code(400).send({
        error:
          "Unrecognised backup filename. Expected db-YYYY-MM-DD-HHMM.sql.gz, media-YYYY-MM-DD-HHMM.tar.gz, recordings-YYYY-MM-DD-HHMM.tar.gz, voice-YYYY-MM-DD-HHMM.tar.gz, config-YYYY-MM-DD-HHMM.env or a legacy data-YYYY-MM-DD-HHMM.tar.gz.",
      });
    }

    await mkdir(BACKUP_DIR(), { recursive: true });
    await sweepStaleUploads();
    const outPath = join(BACKUP_DIR(), name);

    // The upload streams to a uniquely-named temp file and is only copied into
    // place once it has arrived intact. Writing straight to the target used to
    // be actively destructive: `flags: "wx"` made an upload whose name already
    // existed fail with EEXIST, and the error path then unlinked that path —
    // deleting the backup that was already on the server.
    const tmpPath = join(BACKUP_DIR(), `.upload-${randomUUID()}.part`);
    try {
      await pipeline(file.file, createWriteStream(tmpPath, { flags: "wx" }));
    } catch {
      await unlink(tmpPath).catch(() => {});
      return reply.code(400).send({ error: "Upload failed — the transfer was interrupted. Try again." });
    }
    try {
      // COPYFILE_EXCL refuses to overwrite, so an existing snapshot is never
      // replaced by an upload (and never deleted by a failed one).
      await copyFile(tmpPath, outPath, constants.COPYFILE_EXCL);
    } catch {
      return reply.code(409).send({
        error: `A backup named “${name}” is already on this server. Delete it first, or rename the file you are uploading.`,
      });
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
    return { backups: await listBackups() };
  });

  // Admin: delete a backup file.
  app.delete("/backups/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const file = safeBackupPath(id);
    if (!file) return reply.code(404).send({ error: "Not found" });
    await unlink(file).catch(() => {});
    return { ok: true };
  });

  // Admin: restore from backups. Each field selects which file to apply, and
  // any combination may be given. db/data/media/recordings/voice REPLACE the
  // current database / files — destructive! config rewrites the server's .env
  // file (applied on the next restart). Restoring a media component also
  // rebuilds the index rows that make its files visible in the app, so a
  // recordings or library archive works on its own.
  app.post("/backups/restore", { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      db?: string;
      media?: string;
      recordings?: string;
      voice?: string;
      data?: string;
      config?: string;
      jobId?: string;
    };
    const job = startJob(body.jobId, "restore");
    const picks: Record<string, string | null> = {
      db: body.db ? safeBackupPath(body.db) : null,
      media: body.media ? safeBackupPath(body.media) : null,
      recordings: body.recordings ? safeBackupPath(body.recordings) : null,
      voice: body.voice ? safeBackupPath(body.voice) : null,
      data: body.data ? safeBackupPath(body.data) : null,
      config: body.config ? safeBackupPath(body.config) : null,
    };
    if (!Object.values(picks).some(Boolean)) {
      const message = "Pick a database, media, recordings, voice, config or legacy data backup (or a combination) to restore.";
      failJob(job, message);
      return reply.code(400).send({ error: message });
    }

    let configApplied = false;
    const restored: Record<string, boolean> = {};
    // What the index rebuild actually put back, so the page can report it rather
    // than claiming a silent success.
    const index: Record<string, IndexReport> = {};
    try {
      if (picks.db) {
        await stat(picks.db);
        // Drop the schema first so the dump restores cleanly (the dump contains
        // the full schema, so nothing else is needed afterwards).
        step(job, "Clearing the current database…");
        await run(
          `psql ${pgArgs.join(" ")} -v ON_ERROR_STOP=1 -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"`,
          pgEnv
        );
        // The image ships a newer pg_dump/psql than the pinned Postgres server,
        // and newer clients write session settings the older server rejects
        // (PG17+ added `transaction_timeout`), so those lines are dropped as the
        // dump streams through.
        await restoreDb(picks.db, pgArgs, pgEnv, job, "Restoring the database…");
        restored.db = true;
      }
      // Archives hold their component folder at the top level, so extracting
      // into the data dir replaces just that folder. Files added since the
      // backup are kept.
      for (const comp of ["data", "media", "recordings", "voice"] as const) {
        const file = picks[comp];
        if (!file) continue;
        await stat(file);
        const label = extractLabelFor(comp);
        step(job, label);
        await extractTar(file, DATA_DIR(), job, label);
        restored[comp] = true;
        // The audio on its own is invisible — the rows that list it live in the
        // database — so rebuild any index entries this archive carries.
        const comps: MediaComponent[] = comp === "data" ? ["media", "recordings", "voice"] : [comp];
        for (const c of comps) {
          step(job, `Rebuilding the ${c === "media" ? "music library" : c} index…`);
          index[c] = await reindexComponent(c, job);
        }
      }
      if (picks.config) {
        await stat(picks.config);
        step(job, "Restoring the config…");
        // Rewrite the mounted .env so the restored secrets take effect on the
        // next restart of the containers (the running processes keep their
        // current settings until then).
        await writeFile("/app/.env", await readFile(picks.config, "utf8"));
        configApplied = true;
        restored.config = true;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "unknown error";
      failJob(job, message);
      reply.code(500);
      return { error: `Restore failed: ${message}` };
    }
    const result = {
      ok: true,
      restored,
      index,
      note: configApplied ? "Config restored — it will be applied on the next restart of the station." : undefined,
    };
    doneJob(job, result);
    return result;
  });
}
