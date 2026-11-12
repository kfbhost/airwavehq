import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

// `config` reads DATA_DIR at module load, so point it at a scratch directory and
// import the app modules dynamically (static imports are hoisted above this).
const dataDir = await mkdtemp(join(tmpdir(), "airwavehq-backups-"));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = "test-secret";

const DB_NAME = "db-2026-09-13-1012.sql.gz";
const MEDIA_NAME = "media-2026-09-13-1013.tar.gz";

const { default: Fastify } = await import("fastify");
const { default: fastifyStatic } = await import("@fastify/static");
const { backupRoutes } = await import("../src/routes/backups.js");
const { signToken } = await import("../src/auth.js");

let app: FastifyInstance;
let adminToken: string;

beforeAll(async () => {
  const { resolve } = await import("node:path");
  const backupDir = resolve(dataDir, "backups");
  await mkdir(backupDir, { recursive: true });
  await writeFile(join(backupDir, DB_NAME), "dump-bytes");
  await writeFile(join(backupDir, MEDIA_NAME), "archive-bytes");

  app = Fastify();
  await app.register(fastifyStatic, { root: backupDir, decorateReply: true, serve: false });
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
 * The backup download route must name the file it serves. Without a
 * Content-Disposition header the browser falls back to the final URL segment
 * ("download") for `<a download>` links, so every snapshot landed in the user's
 * downloads folder under the same useless name.
 */
describe("GET /backups/:id/download", () => {
  it("names the downloaded file after the snapshot", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/backups/${DB_NAME}/download`,
      query: { token: adminToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="${DB_NAME}"`);
    expect(res.body).toBe("dump-bytes");
  });

  it("names archive components after their own snapshot", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/backups/${MEDIA_NAME}/download`,
      query: { token: adminToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="${MEDIA_NAME}"`);
  });

  it("refuses a request without an admin token", async () => {
    const res = await app.inject({ method: "GET", url: `/backups/${DB_NAME}/download` });
    expect(res.statusCode).toBe(401);
  });

  it("refuses names that are not backup files", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/backups/${encodeURIComponent("../../etc/passwd")}/download`,
      query: { token: adminToken },
    });
    expect(res.statusCode).toBe(404);
  });
});
