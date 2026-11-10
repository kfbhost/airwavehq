import { readFile, mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

// `config` reads DATA_DIR at module load, so point it at a scratch directory and
// import the app modules dynamically (static imports are hoisted above this).
const dataDir = await mkdtemp(join(tmpdir(), "airshift-upload-"));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = "test-secret";

const { default: Fastify } = await import("fastify");
const { default: multipart } = await import("@fastify/multipart");
const { backupRoutes } = await import("../src/routes/backups.js");
const { signToken } = await import("../src/auth.js");

const EXISTING = "recordings-2026-09-13-0741.tar.gz";

let app: FastifyInstance;
let adminToken: string;

function authed(): Record<string, string> {
  return { authorization: `Bearer ${adminToken}` };
}

/** A one-part multipart body, the shape a browser's file input sends. */
function multipartBody(filename: string, content: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----airshifttest";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/gzip\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, content, tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

beforeAll(async () => {
  await mkdir(join(dataDir, "backups"), { recursive: true });
  app = Fastify();
  await app.register(multipart, { limits: { fileSize: 64 * 1024 * 1024, files: 1 } });
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
 * Uploading a file whose name was already taken used to *delete* the backup that
 * was on the server: the write used `flags: "wx"` (so it failed with EEXIST) and
 * the error path then unlinked the path — the pre-existing file. An admin
 * re-uploading their own snapshot silently destroyed the server's copy.
 */
describe("POST /backups/upload", () => {
  it("never deletes a backup that is already on the server", async () => {
    const original = Buffer.from("the snapshot that must survive");
    await writeFile(join(dataDir, "backups", EXISTING), original);

    const body = multipartBody(EXISTING, Buffer.from("a different file with the same name"));
    const res = await app.inject({
      method: "POST",
      url: "/backups/upload",
      headers: { ...authed(), ...body.headers },
      payload: body.payload,
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toContain("already on this server");
    // The point of the test: the bytes on disk are untouched.
    expect(await readFile(join(dataDir, "backups", EXISTING))).toEqual(original);
  });

  it("still imports a backup under a name that is free", async () => {
    const content = Buffer.from("a genuinely new snapshot");
    const body = multipartBody("voice-2026-09-13-0900.tar.gz", content);
    const res = await app.inject({
      method: "POST",
      url: "/backups/upload",
      headers: { ...authed(), ...body.headers },
      payload: body.payload,
    });

    expect(res.statusCode).toBe(200);
    const backups = (res.json() as { backups: Array<{ id: string; size: number }> }).backups;
    expect(backups.map((b) => b.id)).toContain("voice-2026-09-13-0900.tar.gz");
    const written = await readFile(join(dataDir, "backups", "voice-2026-09-13-0900.tar.gz"));
    expect(written).toEqual(content);
  });

  it("leaves no part file behind", async () => {
    const entries = await readdir(join(dataDir, "backups"));
    expect(entries.filter((f) => f.endsWith(".part"))).toEqual([]);
  });

  it("rejects an unrecognised filename without touching anything", async () => {
    const body = multipartBody("download", Buffer.from("whatever"));
    const res = await app.inject({
      method: "POST",
      url: "/backups/upload",
      headers: { ...authed(), ...body.headers },
      payload: body.payload,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("Unrecognised backup filename");
    expect(await readFile(join(dataDir, "backups", EXISTING))).toEqual(Buffer.from("the snapshot that must survive"));
  });

  it("needs an admin token", async () => {
    const body = multipartBody("voice-2026-09-13-1000.tar.gz", Buffer.from("x"));
    const res = await app.inject({
      method: "POST",
      url: "/backups/upload",
      headers: body.headers,
      payload: body.payload,
    });
    expect(res.statusCode).toBe(401);
  });
});
