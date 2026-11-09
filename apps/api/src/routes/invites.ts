import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { desc, eq, isNull } from "drizzle-orm";
import { db, schema, isoRow } from "../db/client.js";
import { requireAdmin, hashPassword, hashToken, signToken } from "../auth.js";
import { config } from "../config.js";
import { sendInviteEmail } from "../services/mailer.js";
import { inviteCreateSchema, inviteAcceptSchema } from "@radiohost/shared";
import type { Role } from "@radiohost/shared";

const INVITE_TTL_MS = 7 * 24 * 3600_000; // 7 days

async function stationName(): Promise<string> {
  const rows = await db.select({ stationName: schema.settings.stationName }).from(schema.settings).where(eq(schema.settings.id, 1)).limit(1);
  return rows[0]?.stationName ?? "your station";
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function acceptUrl(rawToken: string): string {
  const base = (config.publicBaseUrl || "").replace(/\/+$/, "");
  return `${base}/accept-invite?token=${encodeURIComponent(rawToken)}`;
}

function publicInvite(row: typeof schema.invites.$inferSelect) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    invitedBy: row.invitedBy,
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt ? row.acceptedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function inviteRoutes(app: FastifyInstance): void {
  // Create an invite (admin). Returns the accept link so it can be copied or emailed.
  app.post("/invites", { preHandler: requireAdmin }, async (req, reply) => {
    const body = inviteCreateSchema.parse(req.body);
    const email = body.email.toLowerCase();
    const existing = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
    if (existing[0]) return reply.code(409).send({ error: "That email already has an account." });

    const raw = newToken();
    const [invite] = await db
      .insert(schema.invites)
      .values({
        email,
        role: body.role,
        tokenHash: hashToken(raw),
        invitedBy: req.user!.sub,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      })
      .returning();
    if (!invite) return reply.code(500).send({ error: "Could not create the invite." });

    const url = acceptUrl(raw);
    const mail = await sendInviteEmail({ to: email, role: body.role, acceptUrl: url, invitedByName: req.user!.name, stationName: await stationName() });
    return reply.code(201).send({ invite: publicInvite(invite), acceptUrl: url, emailed: mail.sent, mailError: mail.error });
  });

  // List outstanding (not-yet-accepted) invites (admin).
  app.get("/invites", { preHandler: requireAdmin }, async () => {
    const rows = await db
      .select()
      .from(schema.invites)
      .where(isNull(schema.invites.acceptedAt))
      .orderBy(desc(schema.invites.createdAt));
    return { invites: rows.map(publicInvite) };
  });

  // Revoke an invite (admin).
  app.delete("/invites/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = await db.delete(schema.invites).where(eq(schema.invites.id, id)).returning({ id: schema.invites.id });
    if (deleted.length === 0) return reply.code(404).send({ error: "Invite not found" });
    return { ok: true };
  });

  // Re-issue the token for an invite (admin) — returns a fresh accept link.
  app.post("/invites/:id/resend", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = await db.select().from(schema.invites).where(eq(schema.invites.id, id)).limit(1);
    const invite = rows[0];
    if (!invite) return reply.code(404).send({ error: "Invite not found" });
    const raw = newToken();
    const [updated] = await db
      .update(schema.invites)
      .set({ tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + INVITE_TTL_MS), acceptedAt: null })
      .where(eq(schema.invites.id, id))
      .returning();
    if (!updated) return reply.code(500).send({ error: "Could not resend the invite." });
    const url = acceptUrl(raw);
    const mail = await sendInviteEmail({ to: updated.email, role: updated.role as Role, acceptUrl: url, invitedByName: req.user!.name, stationName: await stationName() });
    return { invite: publicInvite(updated), acceptUrl: url, emailed: mail.sent, mailError: mail.error };
  });

  // Public: look up an invite by token to show the accept screen.
  app.get("/invites/accept", async (req) => {
    const { token } = req.query as { token?: string };
    if (!token) return { valid: false, reason: "This invite link is not valid." };
    const rows = await db.select().from(schema.invites).where(eq(schema.invites.tokenHash, hashToken(token))).limit(1);
    const invite = rows[0];
    if (!invite) return { valid: false, reason: "This invite link is not valid." };
    if (invite.acceptedAt) return { valid: false, reason: "This invite has already been used." };
    if (invite.expiresAt.getTime() < Date.now()) return { valid: false, reason: "This invite has expired — ask an admin to send a new one." };
    const settings = await db.select({ stationName: schema.settings.stationName }).from(schema.settings).where(eq(schema.settings.id, 1)).limit(1);
    return { valid: true, email: invite.email, role: invite.role, stationName: settings[0]?.stationName ?? "your station" };
  });

  // Public: accept an invite — set name + password, create the account, sign in.
  app.post("/invites/accept", async (req, reply) => {
    const body = inviteAcceptSchema.parse(req.body);
    const rows = await db.select().from(schema.invites).where(eq(schema.invites.tokenHash, hashToken(body.token))).limit(1);
    const invite = rows[0];
    if (!invite) return reply.code(400).send({ error: "This invite link is not valid." });
    if (invite.acceptedAt) return reply.code(400).send({ error: "This invite has already been used." });
    if (invite.expiresAt.getTime() < Date.now()) return reply.code(400).send({ error: "This invite has expired — ask an admin to send a new one." });

    const taken = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, invite.email)).limit(1);
    if (taken[0]) return reply.code(409).send({ error: "An account with this email already exists." });

    const [user] = await db
      .insert(schema.users)
      .values({
        email: invite.email,
        name: body.name.trim(),
        passwordHash: hashPassword(body.password),
        role: invite.role as Role,
      })
      .returning();
    if (!user) return reply.code(500).send({ error: "Could not create the account." });
    await db.update(schema.invites).set({ acceptedAt: new Date() }).where(eq(schema.invites.id, invite.id));

    const token = await signToken({ sub: user.id, email: user.email, name: user.name, role: user.role as Role });
    return { token, user: { ...isoRow(user), passwordHash: undefined, djCode: null } };
  });
}
