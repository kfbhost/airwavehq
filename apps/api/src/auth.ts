import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import type { Role } from "@airshift/shared";

/* ---------------- Passwords (scrypt, zero native deps) ---------------- */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64 ?? "", "base64");
  const expected = Buffer.from(hashB64 ?? "", "base64");
  const actual = scryptSync(password, salt, expected.length, {
    N: Number(nStr),
    r: Number(rStr),
    p: Number(pStr),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/* ---------------- JWT ---------------- */

const secret = new TextEncoder().encode(config.jwtSecret);
const ALG = "HS256";
const TOKEN_TTL = "30d";

export interface JwtPayload {
  sub: string;
  email: string;
  name: string;
  role: Role;
  impersonatedBy?: string;
}

export async function signToken(p: JwtPayload): Promise<string> {
  return new SignJWT({ email: p.email, name: p.name, role: p.role, ...(p.impersonatedBy ? { impersonatedBy: p.impersonatedBy } : {}) })
    .setProtectedHeader({ alg: ALG })
    .setSubject(p.sub)
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(secret);
}

export async function verifyToken(token: string): Promise<JwtPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    const role = payload.role as Role;
    if (role !== "admin" && role !== "dj") return null;
    return {
      sub: String(payload.sub),
      email: String(payload.email ?? ""),
      name: String(payload.name ?? ""),
      role,
      impersonatedBy: payload.impersonatedBy ? String(payload.impersonatedBy) : undefined,
    };
  } catch {
    return null;
  }
}

/* ---------------- Fastify helpers ---------------- */

declare module "fastify" {
  interface FastifyRequest {
    user?: JwtPayload;
    apiKey?: { scopes: string[] };
  }
}

export function bearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const [scheme, token] = h.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return token;
}

/** Require a valid JWT (admin or DJ). Sets req.user. */
export async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = bearerToken(req);
  if (!token) {
    reply.code(401).send({ error: "Unauthorized" });
    return;
  }
  const user = await verifyToken(token);
  if (!user) {
    reply.code(401).send({ error: "Invalid or expired token" });
    return;
  }
  req.user = user;
}

/** Require an admin JWT. */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await authenticate(req, reply);
  if (reply.sent) return;
  if (req.user!.role !== "admin") {
    reply.code(403).send({ error: "Admin only" });
  }
}

/** Verify the engine shared-secret header. */
export async function requireEngine(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const key = req.headers["x-engine-key"];
  if (key !== config.engineSecret) {
    reply.code(401).send({ error: "Bad engine key" });
  }
}

export function generateDjCode(): string {
  const bytes = randomBytes(3);
  return (bytes.readUIntBE(0, 3) % 1_000_000).toString().padStart(6, "0");
}
