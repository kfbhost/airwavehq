import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { extname, join } from "node:path";
import { and, count, eq, inArray } from "drizzle-orm";
import { db, schema, isoRow } from "../db/client.js";
import { config } from "../config.js";
import {
  authenticate,
  hashPassword,
  signToken,
  verifyPassword,
  requireAdmin,
  generateDjCode,
  hashToken,
} from "../auth.js";
import { registerSchema, loginSchema, djLoginSchema, djCreateSchema, passwordChangeSchema, adminAccountUpdateSchema } from "@airshift/shared";

const mediaDir = () => join(config.dataDir, "media");
const AVATAR_MIME = /^image\/(png|jpe?g|webp|gif)$/i;
const AVATAR_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

function publicUser(user: typeof schema.users.$inferSelect) {
  return { ...isoRow(user), passwordHash: undefined, djCode: user.role === "dj" ? user.djCode : null };
}

/** How many active admins exist, optionally excluding one id. */
async function activeAdminCount(excludeId?: string): Promise<number> {
  const rows = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.role, "admin"), eq(schema.users.isActive, true)));
  return rows.filter((r) => r.id !== excludeId).length;
}

export function authRoutes(app: FastifyInstance): void {
  // First-run: create the admin account when no users exist yet.
  app.post("/auth/register", async (req, reply) => {
    const body = registerSchema.parse(req.body);
    const counts = await db.select({ n: count() }).from(schema.users);
    const n = counts[0]?.n ?? 0;
    if (n > 0) {
      return reply.code(403).send({ error: "Registration closed — an account already exists." });
    }
    const inserted = await db
      .insert(schema.users)
      .values({
        email: body.email.toLowerCase(),
        name: body.name,
        passwordHash: hashPassword(body.password),
        role: "admin",
      })
      .returning();
    const user = inserted[0]!;
    const token = await signToken({ sub: user.id, email: user.email, name: user.name, role: "admin" });
    return { token, user: publicUser(user) };
  });

  app.post("/auth/login", async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const users = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, body.email.toLowerCase()))
      .limit(1);
    const user = users[0];
    if (!user || !verifyPassword(body.password, user.passwordHash) || !user.isActive) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }
    const token = await signToken({ sub: user.id, email: user.email, name: user.name, role: user.role as "admin" | "dj" });
    return { token, user: publicUser(user) };
  });

  // Admin support access: issue a short-lived DJ-scoped token without exposing the DJ code.
  app.post("/auth/impersonate-dj/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
    const dj = rows[0];
    if (!dj || dj.role !== "dj" || !dj.isActive) return reply.code(404).send({ error: "Active DJ account not found" });
    const token = await signToken({ sub: dj.id, email: dj.email, name: dj.name, role: "dj", impersonatedBy: req.user!.sub });
    return { token, user: publicUser(dj) };
  });

  // DJ sign-in with email + 6-digit code.
  app.post("/auth/dj-login", async (req, reply) => {
    const body = djLoginSchema.parse(req.body);
    const users = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, body.email.toLowerCase()))
      .limit(1);
    const user = users[0];
    if (!user || !user.djCode || user.role !== "dj" || !user.isActive) {
      return reply.code(401).send({ error: "No DJ account for that email" });
    }
    if (user.djCode !== body.code) {
      return reply.code(401).send({ error: "Invalid code" });
    }
    const token = await signToken({ sub: user.id, email: user.email, name: user.name, role: "dj" });
    return { token, user: publicUser(user) };
  });

  app.get("/auth/me", { preHandler: authenticate }, async (req) => {
    const users = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, req.user!.sub))
      .limit(1);
    const u = users[0];
    if (!u) return { user: null };
    return { user: publicUser(u) };
  });

  app.post("/auth/password", { preHandler: authenticate }, async (req, reply) => {
    const body = passwordChangeSchema.parse(req.body);
    const users = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, req.user!.sub))
      .limit(1);
    const u = users[0];
    if (!u || !verifyPassword(body.currentPassword, u.passwordHash)) {
      return reply.code(401).send({ error: "Current password is incorrect" });
    }
    await db
      .update(schema.users)
      .set({ passwordHash: hashPassword(body.newPassword) })
      .where(eq(schema.users.id, u.id));
    return { ok: true };
  });

  app.post("/auth/admin-account", { preHandler: requireAdmin }, async (req, reply) => {
    const body = adminAccountUpdateSchema.parse(req.body);
    const users = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, req.user!.sub))
      .limit(1);
    const u = users[0];
    if (!u || u.role !== "admin") {
      return reply.code(404).send({ error: "Admin account not found" });
    }
    if (!verifyPassword(body.currentPassword, u.passwordHash)) {
      return reply.code(401).send({ error: "Current password is incorrect" });
    }

    const nextEmail = body.email.toLowerCase();
    if (nextEmail !== u.email) {
      const existing = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, nextEmail))
        .limit(1);
      if (existing[0] && existing[0].id !== u.id) {
        return reply.code(409).send({ error: "That email address is already in use" });
      }
    }

    const [updated] = await db
      .update(schema.users)
      .set({
        name: body.name,
        email: nextEmail,
        passwordHash: body.newPassword ? hashPassword(body.newPassword) : u.passwordHash,
      })
      .where(eq(schema.users.id, u.id))
      .returning();
    if (!updated) {
      return reply.code(404).send({ error: "Admin account not found" });
    }

    const token = await signToken({
      sub: updated.id,
      email: updated.email,
      name: updated.name,
      role: "admin",
    });
    return { token, user: publicUser(updated) };
  });

  /* ---------------- DJ management (admin) ---------------- */

  app.get("/users", { preHandler: requireAdmin }, async () => {
    const users = await db
      .select()
      .from(schema.users)
      .orderBy(schema.users.createdAt);
    return { users: users.map(publicUser) };
  });

  app.post("/users", { preHandler: requireAdmin }, async (req, reply) => {
    const body = djCreateSchema.parse(req.body);
    const code = generateDjCode();
    const exists = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, body.email.toLowerCase()))
      .limit(1);
    if (exists[0]) return reply.code(409).send({ error: "A user with that email already exists" });
    // DJs log in with a code — password is random and never used.
    const inserted = await db
      .insert(schema.users)
      .values({
        email: body.email.toLowerCase(),
        name: body.name,
        passwordHash: hashPassword(randomBytes(24).toString("hex")),
        role: "dj",
        djCode: code,
      })
      .returning();
    const user = inserted[0]!;
    return { user: publicUser(user), djCode: code };
  });

  app.patch("/users/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { name?: string; isActive?: boolean; regenerateCode?: boolean; role?: "admin" | "dj"; password?: string };
    const targets = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
    const target = targets[0];
    if (!target) return reply.code(404).send({ error: "Not found" });

    const patch: Record<string, unknown> = {};
    let issuedCode: string | undefined;
    let tempPassword: string | undefined;

    if (body.name !== undefined) patch.name = body.name;
    if (body.password !== undefined) {
      if (body.password.length < 8) return reply.code(400).send({ error: "Password must be at least 8 characters." });
      patch.passwordHash = hashPassword(body.password);
    }
    if (body.regenerateCode) {
      const code = generateDjCode();
      patch.djCode = code;
      issuedCode = code;
    }

    // Role change (promote/demote) with lockout protection.
    if (body.role !== undefined && body.role !== target.role) {
      if (body.role !== "admin" && body.role !== "dj") return reply.code(400).send({ error: "Invalid role." });
      if (body.role === "dj" && target.role === "admin" && target.isActive && (await activeAdminCount(id)) === 0) {
        return reply.code(400).send({ error: "You can't demote the last active admin." });
      }
      patch.role = body.role;
      if (body.role === "admin") {
        // A promoted DJ needs a usable password (they previously signed in with a code).
        tempPassword = randomBytes(9).toString("base64url");
        patch.passwordHash = hashPassword(tempPassword);
        patch.djCode = null;
      } else {
        const code = generateDjCode();
        patch.djCode = code;
        issuedCode = code;
      }
    }

    // Enable/disable with lockout protection.
    if (body.isActive !== undefined) {
      if (body.isActive === false && target.role === "admin" && target.isActive && (await activeAdminCount(id)) === 0) {
        return reply.code(400).send({ error: "You can't disable the last active admin." });
      }
      patch.isActive = body.isActive;
    }

    if (Object.keys(patch).length === 0) return { user: publicUser(target) };

    const [user] = await db.update(schema.users).set(patch).where(eq(schema.users.id, id)).returning();
    if (!user) return reply.code(404).send({ error: "Not found" });
    return { user: publicUser(user), djCode: issuedCode, tempPassword };
  });

  app.delete("/users/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const targets = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
    const target = targets[0];
    if (!target) return reply.code(404).send({ error: "Not found" });
    if (target.role === "admin" && target.isActive && (await activeAdminCount(id)) === 0) {
      return reply.code(400).send({ error: "You can't remove the last active admin." });
    }
    await db.delete(schema.users).where(eq(schema.users.id, id));
    return { ok: true };
  });

  /* ---------------- Profile picture (avatar) ---------------- */

  async function saveAvatar(id: string, req: FastifyRequest, reply: FastifyReply) {
    const targets = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
    const target = targets[0];
    if (!target) return reply.code(404).send({ error: "User not found" });

    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "No image uploaded" });
    const mime = (file.mimetype || "").toLowerCase();
    if (!AVATAR_MIME.test(mime)) {
      file.file.resume();
      return reply.code(400).send({ error: "Please upload a PNG, JPG, WEBP or GIF image" });
    }

    await mkdir(mediaDir(), { recursive: true });
    const ext = AVATAR_EXT[mime] ?? (extname(file.filename || "").toLowerCase() || ".jpg");
    const filename = `avatar-${randomUUID()}${ext}`;
    const filePath = join(mediaDir(), filename);
    await pipeline(file.file, createWriteStream(filePath));

    // Replace any previous picture file.
    if (target.avatarPath && target.avatarPath !== filePath) await unlink(target.avatarPath).catch(() => {});

    const [user] = await db.update(schema.users).set({ avatarPath: filePath }).where(eq(schema.users.id, id)).returning();
    if (!user) return reply.code(404).send({ error: "User not found" });
    return { user: publicUser(user) };
  }

  app.post("/users/:id/avatar", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return saveAvatar(id, req, reply);
  });

  app.post("/auth/me/avatar", { preHandler: authenticate }, async (req, reply) => {
    return saveAvatar(req.user!.sub, req, reply);
  });

  app.delete("/users/:id/avatar", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const targets = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
    const target = targets[0];
    if (!target) return reply.code(404).send({ error: "Not found" });
    if (target.avatarPath) await unlink(target.avatarPath).catch(() => {});
    const [user] = await db.update(schema.users).set({ avatarPath: null }).where(eq(schema.users.id, id)).returning();
    return { user: publicUser(user!) };
  });

  /* ---------------- API keys ---------------- */

  app.get("/api-keys", { preHandler: requireAdmin }, async () => {
    const keys = await db
      .select()
      .from(schema.apiKeys)
      .orderBy(schema.apiKeys.createdAt);
    return { keys: keys.map((k) => ({ ...isoRow(k), keyHash: undefined })) };
  });

  app.post("/api-keys", { preHandler: requireAdmin }, async (req) => {
    const body = req.body as { name: string; scopes?: string[] };
    const name = String(body.name ?? "API key").slice(0, 120);
    const scopes = Array.isArray(body.scopes) && body.scopes.length > 0 ? body.scopes : ["read"];
    const raw = `rhk_${randomBytes(24).toString("base64url")}`;
    const [key] = await db
      .insert(schema.apiKeys)
      .values({ name, scopes, keyHash: hashToken(raw) })
      .returning();
    return { key: { ...isoRow(key), keyHash: undefined }, token: raw };
  });

  app.delete("/api-keys/:id", { preHandler: requireAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    await db.delete(schema.apiKeys).where(eq(schema.apiKeys.id, id));
    return { ok: true };
  });
}

export { hashToken, inArray };
