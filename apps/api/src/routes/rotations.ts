import type { FastifyInstance } from "fastify";
import { asc, eq } from "drizzle-orm";
import { stationRotationPatchSchema, stationRotationSchema } from "@airwavehq/shared";
import { authenticate, requireAdmin } from "../auth.js";
import { db, isoRow, schema } from "../db/client.js";
import { bumpProgrammingRevision } from "../services/engineState.js";

/** musicFolders is stored as a JSON text column; expose it as an array. */
function parseFolders(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function folderValuesFor(body: {
  autoGenerate?: boolean;
  musicFolders?: string[];
}): { autoGenerate: boolean; musicFolders: string | null } {
  const autoGenerate = body.autoGenerate ?? false;
  const musicFolders = autoGenerate ? JSON.stringify(body.musicFolders ?? []) : null;
  return { autoGenerate, musicFolders };
}

export function rotationRoutes(app: FastifyInstance): void {
  app.get("/rotations", { preHandler: authenticate }, async () => {
    const rotations = await db
      .select()
      .from(schema.stationRotations)
      .orderBy(
        asc(schema.stationRotations.dayOfWeek),
        asc(schema.stationRotations.startHour),
        asc(schema.stationRotations.priority),
      );

    return {
      rotations: rotations.map((r) => ({
        ...isoRow(r),
        musicFolders: parseFolders(r.musicFolders),
      })),
    };
  });

  app.post("/rotations", { preHandler: requireAdmin }, async (req, reply) => {
    const body = stationRotationSchema.parse(req.body);
    const folders = folderValuesFor(body);
    const [rotation] = await db
      .insert(schema.stationRotations)
      .values({
        ...body,
        autoGenerate: folders.autoGenerate,
        shufflePlaylist: folders.autoGenerate ? false : (body.shufflePlaylist ?? false),
        musicFolders: folders.musicFolders,
      })
      .returning();

    if (!rotation) return reply.code(500).send({ error: "Could not create rotation" });

    bumpProgrammingRevision();
    return reply.code(201).send({ rotation: { ...isoRow(rotation), musicFolders: parseFolders(rotation.musicFolders) } });
  });

  app.patch("/rotations/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const patch = stationRotationPatchSchema.parse(req.body);
    const existing = await db
      .select()
      .from(schema.stationRotations)
      .where(eq(schema.stationRotations.id, id))
      .limit(1);

    const current = existing[0];
    if (!current) return reply.code(404).send({ error: "Not found" });

    // autoGenerate/musicFolders need coordinated defaults: if autoGenerate is
    // false the folder list is cleared, so resolve them from the patch plus
    // the current row before the plain schema parse.
    const autoGenerate = patch.autoGenerate !== undefined ? patch.autoGenerate : current.autoGenerate;
    const musicFolders = autoGenerate
      ? (patch.musicFolders !== undefined ? patch.musicFolders : parseFolders(current.musicFolders))
      : [];
    // Shuffle and auto-generate are alternatives: auto-generate already varies
    // the list every day, so turning it on disables the curated shuffle.
    const shufflePlaylist =
      patch.shufflePlaylist !== undefined ? patch.shufflePlaylist : current.shufflePlaylist;

    const nextValues = stationRotationSchema.parse({
      name: patch.name ?? current.name,
      dayOfWeek: patch.dayOfWeek ?? current.dayOfWeek,
      startHour: patch.startHour ?? current.startHour,
      endHour: patch.endHour ?? current.endHour,
      playlistId: patch.playlistId !== undefined ? patch.playlistId : current.playlistId,
      clockwheelId: patch.clockwheelId !== undefined ? patch.clockwheelId : current.clockwheelId,
      sundayPlaylistId: patch.sundayPlaylistId !== undefined ? patch.sundayPlaylistId : current.sundayPlaylistId,
      mondayPlaylistId: patch.mondayPlaylistId !== undefined ? patch.mondayPlaylistId : current.mondayPlaylistId,
      tuesdayPlaylistId: patch.tuesdayPlaylistId !== undefined ? patch.tuesdayPlaylistId : current.tuesdayPlaylistId,
      wednesdayPlaylistId: patch.wednesdayPlaylistId !== undefined ? patch.wednesdayPlaylistId : current.wednesdayPlaylistId,
      thursdayPlaylistId: patch.thursdayPlaylistId !== undefined ? patch.thursdayPlaylistId : current.thursdayPlaylistId,
      fridayPlaylistId: patch.fridayPlaylistId !== undefined ? patch.fridayPlaylistId : current.fridayPlaylistId,
      saturdayPlaylistId: patch.saturdayPlaylistId !== undefined ? patch.saturdayPlaylistId : current.saturdayPlaylistId,
      autoGenerate,
      shufflePlaylist: autoGenerate ? false : shufflePlaylist,
      musicFolders,
      includeJingles: patch.includeJingles !== undefined ? patch.includeJingles : current.includeJingles,
      jingleEvery: patch.jingleEvery !== undefined ? patch.jingleEvery : current.jingleEvery,
      jingleFolder: patch.jingleFolder !== undefined ? patch.jingleFolder : current.jingleFolder,
      priority: patch.priority ?? current.priority,
      isActive: patch.isActive ?? current.isActive,
    });

    const folders = folderValuesFor({ autoGenerate: nextValues.autoGenerate, musicFolders: nextValues.musicFolders });
    const [rotation] = await db
      .update(schema.stationRotations)
      .set({
        ...nextValues,
        musicFolders: folders.musicFolders,
      })
      .where(eq(schema.stationRotations.id, id))
      .returning();

    if (!rotation) return reply.code(404).send({ error: "Not found" });

    bumpProgrammingRevision();
    return { rotation: { ...isoRow(rotation), musicFolders: parseFolders(rotation.musicFolders) } };
  });

  app.delete("/rotations/:id", { preHandler: requireAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    await db.delete(schema.stationRotations).where(eq(schema.stationRotations.id, id));
    bumpProgrammingRevision();
    return { ok: true };
  });
}
