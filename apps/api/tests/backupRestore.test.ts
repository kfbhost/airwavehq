import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const run = promisify(execFile);

// `config` reads DATA_DIR at module load, so point it at a scratch directory and
// import the app modules dynamically (static imports are hoisted above this).
const dataDir = await mkdtemp(join(tmpdir(), "airwavehq-restore-"));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = "test-secret";

// Just enough of the drizzle query builder for the restore path, so this can run
// without a Postgres server. Rows live here and the assertions read them back.
const store = vi.hoisted(() => new Map<string, Array<Record<string, unknown>>>());

vi.mock("../src/db/client.js", () => {
  const table = (name: string) => ({ __table: name });
  const schema = {
    recordings: table("recordings"),
    voiceTracks: table("voice_tracks"),
    tracks: table("tracks"),
    folders: table("folders"),
    users: table("users"),
  };
  const rowsFor = (t: { __table: string }) => {
    let rows = store.get(t.__table);
    if (!rows) {
      rows = [];
      store.set(t.__table, rows);
    }
    return rows;
  };
  const db = {
    // A real drizzle select is awaitable, so `await select(...).from(...)` works.
    select: () => ({ from: (t: { __table: string }) => Promise.resolve(rowsFor(t)) }),
    insert: (t: { __table: string }) => ({
      values: (input: Array<Record<string, unknown>> | Record<string, unknown>) => {
        const chunk = Array.isArray(input) ? input : [input];
        const promise = (async () => {
          const rows = rowsFor(t);
          for (const r of chunk) {
            // The real table generates a uuid for rows that omit one.
            if (r.id === undefined) r.id = `fake-${t.__table}-${rows.length + 1}`;
            if (!rows.some((existing) => existing.id === r.id)) rows.push(r);
          }
        })();
        // `.values(...)` is awaited directly in some paths and chained with
        // `.onConflictDoNothing()` in others, so the result must be both.
        return {
          onConflictDoNothing: () => promise,
          then: promise.then.bind(promise),
          catch: promise.catch.bind(promise),
        };
      },
    }),
  };
  return { db, schema, client: {}, isoRow: (row: unknown) => row };
});

const { default: Fastify } = await import("fastify");
const { backupRoutes } = await import("../src/routes/backups.js");
const { signToken } = await import("../src/auth.js");

let app: FastifyInstance;
let adminToken: string;

/** The routes authenticate with a bearer token, as the web client sends it. */
function authed(): Record<string, string> {
  return { authorization: `Bearer ${adminToken}` };
}

/** Builds an archive exactly like the backup endpoint does: files, optional index. */
async function buildArchive(name: string, files: Record<string, string>, manifest?: unknown): Promise<void> {
  const stage = await mkdtemp(join(tmpdir(), "airwavehq-archive-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(stage, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content);
  }
  const entries: string[] = [];
  if (manifest) {
    await writeFile(join(stage, ".restore-index-recordings.json"), JSON.stringify(manifest));
    entries.push(".restore-index-recordings.json");
  }
  // Archive the top-level folders the files live in, as the real tar does.
  entries.push(...new Set(Object.keys(files).map((f) => f.split("/")[0] ?? "")));
  await run("tar", ["czf", join(dataDir, "backups", name), "-C", stage, ...entries]);
}

beforeAll(async () => {
  await mkdir(join(dataDir, "recordings"), { recursive: true });
  await mkdir(join(dataDir, "backups"), { recursive: true });
  app = Fastify();
  await app.register(backupRoutes);
  await app.ready();
  adminToken = await signToken({
    sub: "user-1",
    email: "admin@example.com",
    name: "Admin",
    role: "admin",
  });
});

/**
 * Restoring an archive of /data/recordings used to finish "successfully" while
 * changing nothing anyone could see: the audio files landed on disk but the rows
 * that list them live in the database. A recordings backup is therefore useless
 * on its own unless the restore rebuilds that index.
 */
describe("POST /backups/restore (recordings)", () => {
  it("rebuilds the index from the manifest the archive carries", async () => {
    store.set("users", [{ id: "dj-1" }]);
    const startedAt = "2026-09-05T11:01:23.000Z";
    const filePath = join(dataDir, "recordings", "saturday-test3-2026-09-05-11-01-23.mp3");
    await buildArchive(
      "recordings-2026-09-05-1200.tar.gz",
      { "recordings/saturday-test3-2026-09-05-11-01-23.mp3": "not-really-mp3" },
      {
        version: 1,
        component: "recordings",
        recordings: [
          {
            id: "rec-1",
            showId: "show-9",
            djId: "dj-1",
            title: "Saturday Test3",
            startedAt,
            endedAt: null,
            filePath,
            durationSeconds: 120,
            isPodcast: true,
            createdAt: startedAt,
          },
        ],
      }
    );

    const res = await app.inject({
      method: "POST",
      url: "/backups/restore",
      headers: authed(),
      payload: { recordings: "recordings-2026-09-05-1200.tar.gz" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { restored: Record<string, boolean>; index: Record<string, { added: number; fromManifest: number }> };

    expect(body.restored.recordings).toBe(true);
    expect(body.index.recordings?.fromManifest).toBe(1);
    // The audio really is on disk…
    expect(existsSync(filePath)).toBe(true);
    // …and it is now listed, which is what was missing.
    const rows = store.get("recordings") ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Saturday Test3");
    expect(rows[0]?.djId).toBe("dj-1");
    // The manifest is working data, not station data — it must not be left behind.
    expect(existsSync(join(dataDir, ".restore-index-recordings.json"))).toBe(false);
  });

  it("still makes an archive with no manifest visible, from the file itself", async () => {
    // Start from a clean library so the count is unambiguous.
    await unlink(join(dataDir, "recordings", "saturday-test3-2026-09-05-11-01-23.mp3")).catch(() => {});
    store.set("recordings", []);
    await buildArchive("recordings-2026-09-03-1000.tar.gz", {
      "recordings/alex-s-show-2026-09-03-17-00-15.mp3": "not-really-mp3",
    });

    const res = await app.inject({
      method: "POST",
      url: "/backups/restore",
      headers: authed(),
      payload: { recordings: "recordings-2026-09-03-1000.tar.gz" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { index: Record<string, { added: number; fromManifest: number }> };
    expect(body.index.recordings?.fromManifest).toBe(0);
    expect(body.index.recordings?.added).toBe(1);

    const rows = store.get("recordings") ?? [];
    expect(rows).toHaveLength(1);
    // "<show-slug>-YYYY-MM-DD-HH-MM-SS.mp3" recovers both the name and the time.
    expect(rows[0]?.title).toBe("Alex S Show");
    expect((rows[0]?.startedAt as Date).toISOString()).toBe("2026-09-03T17:00:15.000Z");
    expect(rows[0]?.isPodcast).toBe(true);
  });

  it("does not list the same file twice when restored again", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/backups/restore",
      headers: authed(),
      payload: { recordings: "recordings-2026-09-03-1000.tar.gz" },
    });
    const body = res.json() as { index: Record<string, { added: number }> };
    expect(body.index.recordings?.added).toBe(0);
    expect(store.get("recordings")).toHaveLength(1);
  });
});

/**
 * A recordings archive is only restorable on its own if the index travels inside
 * it, so the create path must bundle the manifest with the audio.
 */
describe("POST /backups (recordings)", () => {
  it("puts the index manifest inside the archive", async () => {
    const res = await app.inject({ method: "POST", url: "/backups", headers: authed(), payload: { components: ["recordings"] } });
    expect(res.statusCode).toBe(200);
    const created = (res.json() as { created: string[] }).created;
    expect(created).toHaveLength(1);
    const name = created[0] ?? "";
    expect(name).toMatch(/^recordings-\d{4}-\d{2}-\d{2}-\d{4}\.tar\.gz$/);

    const { stdout } = await run("tar", ["tzf", join(dataDir, "backups", name)]);
    expect(stdout).toContain("recordings/alex-s-show-2026-09-03-17-00-15.mp3");
    expect(stdout).toContain(".restore-index-recordings.json");
    // The manifest is working data and must not be left behind in the data dir.
    expect(existsSync(join(dataDir, ".restore-index-recordings.json"))).toBe(false);
  });

  it("reports progress under the job id the page sends", async () => {
    const jobId = "job-create-progress-1";
    await app.inject({ method: "POST", url: "/backups", headers: authed(), payload: { components: ["recordings"], jobId } });
    const res = await app.inject({ method: "GET", url: `/backups/jobs/${jobId}`, headers: authed() });
    const { job } = res.json() as { job: { kind: string; state: string; percent: number | null } };
    expect(job.kind).toBe("backup");
    expect(job.state).toBe("done");
    expect(job.percent).toBe(100);
  });
});

/**
 * A long restore answers only when it is finished, so the page needs somewhere to
 * ask how far along it is — otherwise the button just sits there.
 */
describe("GET /backups/jobs/:id", () => {
  it("reports a finished restore with its result", async () => {
    const jobId = "job-progress-check-1";
    const started = await app.inject({
      method: "POST",
      url: "/backups/restore",
      headers: authed(),
      payload: { recordings: "recordings-2026-09-03-1000.tar.gz", jobId },
    });
    expect(started.statusCode).toBe(200);

    const res = await app.inject({ method: "GET", url: `/backups/jobs/${jobId}`, headers: authed() });
    expect(res.statusCode).toBe(200);
    const { job } = res.json() as { job: { state: string; percent: number | null; result: { restored: Record<string, boolean> } } };
    expect(job.state).toBe("done");
    expect(job.percent).toBe(100);
    expect(job.result.restored.recordings).toBe(true);
  });

  it("404s for an unknown job", async () => {
    const res = await app.inject({ method: "GET", url: "/backups/jobs/not-a-real-job", headers: authed() });
    expect(res.statusCode).toBe(404);
  });

  it("still works for callers that send no job id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/backups/restore",
      headers: authed(),
      payload: { recordings: "recordings-2026-09-03-1000.tar.gz" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ok: boolean }).ok).toBe(true);
  });

  it("needs an admin token", async () => {
    const res = await app.inject({ method: "GET", url: "/backups/jobs/whatever" });
    expect(res.statusCode).toBe(401);
  });
});
