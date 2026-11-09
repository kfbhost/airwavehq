import type { FastifyInstance } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, statfs, unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { db, schema, isoRow } from "../db/client.js";
import { authenticate, requireAdmin } from "../auth.js";
import { detectMime, extractArtwork, probeAudio, scanLoudness } from "../services/ffprobe.js";
import { config } from "../config.js";
import { KINDS, trackPatchSchema } from "@radiohost/shared";

const mediaDir = () => join(config.dataDir, "media");

// Background loudness scanning. The EBU R128 pass decodes the whole file and is
// single-threaded, so doing it inline made every upload block for 15-20s and 5
// concurrent uploads thrashed a small server's CPU. Instead we save + probe the
// file, return the upload immediately, and run loudness scans one-at-a-time in
// the background using otherwise-idle CPU.
const loudnessQueue: string[] = [];
let loudnessBusy = false;

async function processLoudnessQueue(): Promise<void> {
  if (loudnessBusy) return;
  loudnessBusy = true;
  try {
    while (loudnessQueue.length > 0) {
      const id = loudnessQueue.shift()!;
      const rows = await db.select().from(schema.tracks).where(eq(schema.tracks.id, id)).limit(1);
      const t = rows[0];
      if (!t) continue;
      try {
        const loudness = await scanLoudness(t.filePath);
        await db
          .update(schema.tracks)
          .set({ loudnessGainDb: loudness.gainDb, loudnessLufs: loudness.lufs, updatedAt: new Date() })
          .where(eq(schema.tracks.id, id));
      } catch {
        /* leave gain at 0 — the track still plays, just un-normalised */
      }
    }
  } finally {
    loudnessBusy = false;
  }
}

function queueLoudness(trackId: string): void {
  loudnessQueue.push(trackId);
  void processLoudnessQueue();
}

export function trackRoutes(app: FastifyInstance): void {
  // On boot, pick up any tracks still missing a loudness scan (e.g. uploads that
  // were queued just before a restart) and normalise them in the background.
  void (async () => {
    try {
      const pending = await db
        .select({ id: schema.tracks.id })
        .from(schema.tracks)
        .where(isNull(schema.tracks.loudnessLufs));
      for (const p of pending) loudnessQueue.push(p.id);
      void processLoudnessQueue();
    } catch {
      /* ignore */
    }
  })();

  app.post("/tracks/upload", { preHandler: requireAdmin }, async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "No file uploaded" });
    if (file.file.truncated) return reply.code(400).send({ error: "File too large" });

    await mkdir(mediaDir(), { recursive: true });
    const ext = extname(file.filename || ".mp3").toLowerCase() || ".mp3";
    const filename = `${crypto.randomUUID()}${ext}`;
    const filePath = join(mediaDir(), filename);
    const out = createWriteStream(filePath, { flags: "wx" });
    const fileHash = createHash("sha256");
    const hasher = new Transform({
      transform(chunk, _enc, cb) {
        fileHash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(file.file, hasher, out);
    } catch {
      await unlink(filePath).catch(() => {});
      return reply.code(400).send({ error: "Upload failed" });
    }

    // Multipart value fields may arrive after the file part, so read them only
    // once the file stream has been fully consumed.
    const folderField = file.fields.folder;
    const firstFolderField = Array.isArray(folderField) ? folderField[0] : folderField;
    const rawFolder = firstFolderField && firstFolderField.type === "field" ? firstFolderField.value : undefined;
    const folder = typeof rawFolder === "string" ? rawFolder.trim() : "";
    const kindField = file.fields.kind;
    const firstKindField = Array.isArray(kindField) ? kindField[0] : kindField;
    const rawKind = firstKindField && firstKindField.type === "field" ? firstKindField.value : undefined;
    const kind = typeof rawKind === "string" ? rawKind.trim() : "music";
    if (folder.length > 120) {
      await unlink(filePath).catch(() => {});
      return reply.code(400).send({ error: "Folder name too long (max 120)" });
    }
    if (!KINDS.includes(kind as (typeof KINDS)[number]) || kind === "voice") {
      await unlink(filePath).catch(() => {});
      return reply.code(400).send({ error: "Invalid track kind" });
    }
    if (folder.toLowerCase() === "unfiled") {
      await unlink(filePath).catch(() => {});
      return reply.code(400).send({ error: "'Unfiled' is reserved" });
    }

    const size = (await stat(filePath)).size;
    const mime = detectMime(filePath);
    let probe;
    try {
      probe = await probeAudio(filePath);
    } catch {
      await unlink(filePath).catch(() => {});
      return reply.code(400).send({ error: "Not a decodable audio file (ffprobe failed)" });
    }

    const artwork = probe.hasArtwork ? await extractArtwork(filePath) : null;

    if (folder) {
      const existingFolder = await db.select().from(schema.folders).where(eq(schema.folders.name, folder)).limit(1);
      if (!existingFolder[0]) {
        await db.insert(schema.folders).values({ name: folder });
      }
    }

    const [track] = await db
      .insert(schema.tracks)
      .values({
        title: probe.title || basename(file.filename || "untitled").replace(/\.[^.]+$/, ""),
        artist: probe.artist,
        album: probe.album,
        folder: folder || null,
        kind: kind as Exclude<(typeof KINDS)[number], "voice">,
        durationSeconds: probe.durationSeconds,
        filePath,
        fileHash: fileHash.digest("hex"),
        fileSize: size,
        mime,
        codec: probe.codec,
        bitrateKbps: probe.bitrateKbps,
        loudnessGainDb: 0,
        loudnessLufs: null,
        artworkPath: artwork,
      })
      .returning();

    if (track) queueLoudness(track.id);
    return reply.code(201).send({ track: isoRow(track) });
  });

  app.get("/tracks", { preHandler: authenticate }, async (req) => {
    const q = req.query as { search?: string; kind?: string; folder?: string; sortBy?: string; sortDir?: string; page?: string; pageSize?: string };
    const search = q.search?.trim();
    const kind = q.kind;
    const folder = q.folder;
    const sortBy = q.sortBy === "title" || q.sortBy === "artist" ? q.sortBy : "createdAt";
    const sortDir = q.sortDir === "asc" ? "asc" : "desc";
    const page = Math.max(1, Number(q.page ?? 1) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize ?? 50) || 50));

    const conditions = [];
    if (kind && kind !== "all") conditions.push(eq(schema.tracks.kind, kind));
    // Hide auto-generated "recording" items (created when a recording is
    // promoted to a replayable show) from the general library browse + counts.
    else conditions.push(ne(schema.tracks.kind, "recording"));
    if (folder) {
      // "unfiled" = no folder; any other value filters by that folder name.
      if (folder === "unfiled") conditions.push(isNull(schema.tracks.folder));
      else conditions.push(eq(schema.tracks.folder, folder));
    }
    if (search) {
      conditions.push(
        or(
          ilike(schema.tracks.title, `%${search}%`),
          ilike(schema.tracks.artist, `%${search}%`),
          ilike(schema.tracks.album, `%${search}%`),
        ),
      );
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const dir = sortDir === "asc" ? asc : desc;
    const titleOrder = sql`lower(coalesce(${schema.tracks.title}, ''))`;
    const artistOrder = sql`lower(coalesce(${schema.tracks.artist}, ''))`;
    const orderBy =
      sortBy === "title"
        ? [dir(titleOrder), dir(artistOrder), desc(schema.tracks.createdAt)]
        : sortBy === "artist"
          ? [dir(artistOrder), dir(titleOrder), desc(schema.tracks.createdAt)]
          : [desc(schema.tracks.createdAt)];

    const [rows, counts] = await Promise.all([
      db
        .select()
        .from(schema.tracks)
        .where(where)
        .orderBy(...orderBy)
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      db.select({ n: count() }).from(schema.tracks).where(where),
    ]);

    return { tracks: rows.map(isoRow), total: counts[0]?.n ?? 0, page, pageSize };
  });

  app.get("/tracks/storage", { preHandler: authenticate }, async () => {
    await mkdir(mediaDir(), { recursive: true });
    const [totals, volume] = await Promise.all([
      db
        .select({
          trackCount: count(),
          libraryBytes: sql<number>`coalesce(sum(${schema.tracks.fileSize}), 0)`,
        })
        .from(schema.tracks),
      statfs(mediaDir()),
    ]);

    const blockSize = Number(volume.bsize);
    const totalBytes = blockSize * Number(volume.blocks);
    const freeBytes = blockSize * Number(volume.bavail);
    const libraryBytes = Number(totals[0]?.libraryBytes ?? 0);
    const libraryPercent = totalBytes > 0 ? (libraryBytes / totalBytes) * 100 : 0;
    const freePercent = totalBytes > 0 ? (freeBytes / totalBytes) * 100 : 0;

    return {
      trackCount: totals[0]?.trackCount ?? 0,
      libraryBytes,
      freeBytes,
      totalBytes,
      libraryPercent,
      freePercent,
    };
  });

  /* ---------------- Duplicates ---------------- */

  let dupScanPromise: Promise<void> | null = null;
  let dupScanActive = false;

  // Hash every track that doesn't have a file hash yet (files uploaded before
  // this feature existed). Runs in the background with bounded concurrency so
  // the API stays responsive while a large library is being scanned.
  async function runDuplicateScan(): Promise<void> {
    const pending = await db
      .select({ id: schema.tracks.id, filePath: schema.tracks.filePath })
      .from(schema.tracks)
      .where(isNull(schema.tracks.fileHash));
    if (pending.length === 0) return;
    const CONCURRENCY = 4;
    let idx = 0;
    async function worker(): Promise<void> {
      for (;;) {
        const i = idx++;
        if (i >= pending.length) return;
        const t = pending[i];
        if (!t) return;
        try {
          if (!(await stat(t.filePath).catch(() => null))) continue; // file missing — skip
          const hash = createHash("sha256");
          for await (const chunk of createReadStream(t.filePath)) hash.update(chunk);
          await db.update(schema.tracks).set({ fileHash: hash.digest("hex") }).where(eq(schema.tracks.id, t.id));
        } catch {
          // unreadable file — leave the hash null so it's retried next time
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, () => worker()));
  }

  // List duplicate groups. On first call (or when tracks are still missing
  // hashes) a background scan is started; the response says scanning:true and
  // the client polls until it completes.
  app.get("/tracks/duplicates", { preHandler: authenticate }, async () => {
    const unhashed = await db
      .select({ id: schema.tracks.id })
      .from(schema.tracks)
      .where(isNull(schema.tracks.fileHash))
      .limit(1);
    if (unhashed[0] && !dupScanActive && !dupScanPromise) {
      dupScanActive = true;
      dupScanPromise = runDuplicateScan().finally(() => {
        dupScanActive = false;
        dupScanPromise = null;
      });
    }
    if (dupScanActive || dupScanPromise) return { scanning: true, groups: [] };

    const all = await db.select().from(schema.tracks).where(isNotNull(schema.tracks.fileHash));
    const byHash = new Map<string, typeof all>();
    for (const t of all) {
      const h = t.fileHash!;
      const g = byHash.get(h);
      if (g) g.push(t);
      else byHash.set(h, [t]);
    }
    const groups = [...byHash.values()]
      .filter((g) => g.length > 1)
      .map((g) => ({ tracks: g.map((t) => isoRow(t)) }));
    return { scanning: false, groups };
  });

  // Bulk-delete duplicate tracks (files + artwork removed). Keeps whatever the
  // caller chose to retain — the UI sends every id except the one kept.
  app.post("/tracks/duplicates/delete", { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { ids?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : [];
    if (ids.length === 0) return reply.code(400).send({ error: "No track ids provided" });
    const rows = await db.select().from(schema.tracks).where(inArray(schema.tracks.id, ids));
    let deleted = 0;
    for (const t of rows) {
      await db.delete(schema.tracks).where(eq(schema.tracks.id, t.id));
      await unlink(t.filePath).catch(() => {});
      if (t.artworkPath) await unlink(t.artworkPath).catch(() => {});
      deleted += 1;
    }
    return { ok: true, deleted };
  });

  app.patch("/tracks/:id", { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = trackPatchSchema.parse(req.body);
    const [track] = await db
      .update(schema.tracks)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(schema.tracks.id, id))
      .returning();
    if (!track) return reply.code(404).send({ error: "Not found" });
    return { track: isoRow(track) };
  });

  app.post("/tracks/:id/rescan", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const tracks = await db.select().from(schema.tracks).where(eq(schema.tracks.id, id)).limit(1);
    const t = tracks[0];
    if (!t) return reply.code(404).send({ error: "Not found" });
    const [probe, loudness] = await Promise.all([
      probeAudio(t.filePath),
      scanLoudness(t.filePath),
    ]);
    const artwork = t.artworkPath ?? (await extractArtwork(t.filePath));
    const [track] = await db
      .update(schema.tracks)
      .set({ loudnessGainDb: loudness.gainDb, loudnessLufs: loudness.lufs, artworkPath: artwork, codec: probe.codec, bitrateKbps: probe.bitrateKbps, updatedAt: new Date() })
      .where(eq(schema.tracks.id, id))
      .returning();
    return { track: isoRow(track) };
  });

  /* ---------------- Folders ---------------- */

  // List folders with track counts. Explicit folders are persisted, and any
  // legacy folder labels already present on tracks are merged in too.
  app.get("/folders", { preHandler: authenticate }, async () => {
    const [savedFolders, trackCounts, unfiled] = await Promise.all([
      db.select().from(schema.folders).orderBy(schema.folders.name),
      db
        .select({ name: schema.tracks.folder, n: count() })
        .from(schema.tracks)
        .where(isNotNull(schema.tracks.folder))
        .groupBy(schema.tracks.folder)
        .orderBy(schema.tracks.folder),
      db
        .select({ n: count() })
        .from(schema.tracks)
        .where(isNull(schema.tracks.folder)),
    ]);

    const merged = new Map<string, number>();
    for (const row of savedFolders) merged.set(row.name, 0);
    for (const row of trackCounts) merged.set(row.name!, row.n);

    return {
      folders: Array.from(merged.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, n]) => ({ name, count: n })),
      unfiled: unfiled[0]?.n ?? 0,
    };
  });

  // Create a folder.
  app.post("/folders", { preHandler: requireAdmin }, async (req, reply) => {
    const name = String((req.body as { name?: string }).name ?? "").trim();
    if (!name) return reply.code(400).send({ error: "Folder name is required" });
    if (name.length > 120) return reply.code(400).send({ error: "Folder name too long (max 120)" });
    if (name.toLowerCase() === "unfiled") return reply.code(400).send({ error: "'Unfiled' is reserved" });

    const [existingFolder, existingTrackFolder] = await Promise.all([
      db.select().from(schema.folders).where(eq(schema.folders.name, name)).limit(1),
      db
        .select({ id: schema.tracks.id })
        .from(schema.tracks)
        .where(eq(schema.tracks.folder, name))
        .limit(1),
    ]);
    if (existingFolder[0] || existingTrackFolder[0]) return reply.code(409).send({ error: "A folder with that name already exists" });

    const [folder] = await db.insert(schema.folders).values({ name }).returning();
    return { ok: true, folder: isoRow(folder) };
  });

  // Rename a folder (bulk-updates every track in it).
  app.patch("/folders", { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as { oldName?: string; newName?: string };
    const oldName = String(body.oldName ?? "").trim();
    const newName = String(body.newName ?? "").trim();
    if (!oldName || !newName) return reply.code(400).send({ error: "oldName and newName are required" });
    if (newName.length > 120) return reply.code(400).send({ error: "Folder name too long (max 120)" });
    if (newName.toLowerCase() === "unfiled") return reply.code(400).send({ error: "'Unfiled' is reserved" });
    if (oldName === newName) return { ok: true, moved: 0 };

    const [existingFolder, existingTrackFolder, savedOldFolder, tracksInOld] = await Promise.all([
      db.select().from(schema.folders).where(eq(schema.folders.name, newName)).limit(1),
      db
        .select({ id: schema.tracks.id })
        .from(schema.tracks)
        .where(eq(schema.tracks.folder, newName))
        .limit(1),
      db.select().from(schema.folders).where(eq(schema.folders.name, oldName)).limit(1),
      db
        .select({ id: schema.tracks.id })
        .from(schema.tracks)
        .where(eq(schema.tracks.folder, oldName))
        .limit(1),
    ]);
    if (existingFolder[0] || existingTrackFolder[0]) {
      return reply.code(409).send({ error: "A folder with that name already exists" });
    }
    if (!savedOldFolder[0] && !tracksInOld[0]) {
      return reply.code(404).send({ error: "Folder not found" });
    }

    if (savedOldFolder[0]) {
      await db.update(schema.folders).set({ name: newName }).where(eq(schema.folders.id, savedOldFolder[0].id));
    } else {
      await db.insert(schema.folders).values({ name: newName });
    }

    const updated = await db
      .update(schema.tracks)
      .set({ folder: newName, updatedAt: new Date() })
      .where(eq(schema.tracks.folder, oldName))
      .returning({ id: schema.tracks.id });
    return { ok: true, moved: updated.length };
  });

  // Delete a folder AND every track inside it (database rows and audio files
  // are removed together). Deleting a track also cascades to any playlist
  // items that referenced it.
  app.delete("/folders/:name", { preHandler: requireAdmin }, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!name || name.toLowerCase() === "unfiled") return reply.code(400).send({ error: "Invalid folder" });

    const [savedFolder, tracksInFolder] = await Promise.all([
      db.select().from(schema.folders).where(eq(schema.folders.name, name)).limit(1),
      db
        .select({ id: schema.tracks.id, filePath: schema.tracks.filePath, artworkPath: schema.tracks.artworkPath })
        .from(schema.tracks)
        .where(eq(schema.tracks.folder, name)),
    ]);
    if (!savedFolder[0] && tracksInFolder.length === 0) return reply.code(404).send({ error: "Folder not found" });

    // Remove the folder label itself.
    if (savedFolder[0]) {
      await db.delete(schema.folders).where(eq(schema.folders.id, savedFolder[0].id));
    }

    // Remove every track row in the folder (cascades to playlist items).
    await db.delete(schema.tracks).where(eq(schema.tracks.folder, name));

    // Best-effort delete of the audio + artwork files from disk.
    for (const t of tracksInFolder) {
      await unlink(t.filePath).catch(() => {});
      if (t.artworkPath) await unlink(t.artworkPath).catch(() => {});
    }

    return { ok: true, deleted: tracksInFolder.length };
  });

  app.delete("/tracks/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = await db.select().from(schema.tracks).where(eq(schema.tracks.id, id)).limit(1);
    const t = rows[0];
    if (!t) return reply.code(404).send({ error: "Not found" });
    await db.delete(schema.tracks).where(eq(schema.tracks.id, id));
    await unlink(t.filePath).catch(() => {});
    if (t.artworkPath) await unlink(t.artworkPath).catch(() => {});
    return { ok: true };
  });

  // Stream a track (with HTTP range support for seeking).
  app.get("/tracks/:id/stream", async (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = await db.select().from(schema.tracks).where(eq(schema.tracks.id, id)).limit(1);
    const t = rows[0];
    if (!t) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile(basename(t.filePath), dirname(t.filePath));
  });
}
