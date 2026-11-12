import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

const run = promisify(execFile);

// `config` reads DATA_DIR at module load, so point it at a scratch directory and
// import the app modules dynamically (static imports are hoisted above this).
const dataDir = await mkdtemp(join(tmpdir(), "airwavehq-stream-"));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = "test-secret";

const { default: Fastify } = await import("fastify");
const { backupRoutes } = await import("../src/routes/backups.js");
const { signToken } = await import("../src/auth.js");

const NAME_RE = /^media-\d{4}-\d{2}-\d{2}-\d{4}\.tar\.gz$/;

let app: FastifyInstance;
let adminToken: string;

/** Snapshot archives sitting on the server's disk in the backup directory. */
async function stagedArchives(): Promise<string[]> {
  const entries = await readdir(join(dataDir, "backups")).catch(() => [] as string[]);
  return entries.filter((f) => NAME_RE.test(f));
}

beforeAll(async () => {
  await mkdir(join(dataDir, "media", "albums"), { recursive: true });
  await writeFile(join(dataDir, "media", "albums", "song.mp3"), "not-really-mp3");
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
 * The direct-download endpoint exists so a station whose library is larger than
 * its free disk space can still be backed up: tar writes straight down the HTTP
 * response and nothing is staged on the server. This checks the stream is a real,
 * restorable archive named like a normal snapshot.
 */
describe("GET /backups/stream/:component", () => {
  it("streams a restorable archive named like an on-disk snapshot", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/backups/stream/media",
      query: { token: adminToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/gzip");
    expect(res.headers["cache-control"]).toBe("no-store");
    const disposition = String(res.headers["content-disposition"]);
    const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "";
    expect(name).toMatch(NAME_RE);

    // Probe the payload the way the restore path does: write it out (as the
    // browser would) and list it with tar.
    const file = join(dataDir, name);
    await writeFile(file, res.rawPayload);
    const { stdout } = await run("tar", ["tzf", file]);
    expect(stdout).toContain("media/albums/song.mp3");
  });

  it("never stages the archive on the server's disk", async () => {
    // A file far bigger than the free space this test pretends to have: the
    // response must flow without a copy appearing in the backup directory.
    // Random bytes stand in for audio — they cannot be compressed away, so the
    // payload really is megabytes on the wire (Buffer.alloc would shrink to KBs).
    await writeFile(join(dataDir, "media", "albums", "big.mp3"), randomBytes(4 * 1024 * 1024));
    const res = await app.inject({
      method: "GET",
      url: "/backups/stream/media",
      query: { token: adminToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBeGreaterThan(1024 * 1024);
    expect(await stagedArchives()).toEqual([]);
  });

  it("refuses a request without an admin token", async () => {
    const res = await app.inject({ method: "GET", url: "/backups/stream/media" });
    expect(res.statusCode).toBe(401);
  });

  it("only streams components that can be huge", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/backups/stream/config",
      query: { token: adminToken },
    });
    expect(res.statusCode).toBe(404);
  });
});
