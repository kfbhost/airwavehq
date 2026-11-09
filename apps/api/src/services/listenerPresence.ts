import type { FastifyRequest } from "fastify";
import { isIP } from "node:net";
import { db, schema } from "../db/client.js";

const LISTENER_TTL_MS = 90_000;
const COUNTRY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const activeListeners = new Map<string, { country: string | null; lastSeenAt: number }>();
const countryCache = new Map<string, { country: string | null; resolvedAt: number }>();
const pendingLookups = new Map<string, Promise<string | null>>();

export function touchPublicListener(sessionId: string, country: string | null): void {
  cleanupExpiredListeners();
  activeListeners.set(sessionId, { country, lastSeenAt: Date.now() });
}

export function activeCountryCounts(now = Date.now()): Record<string, number> {
  cleanupExpiredListeners(now);
  const counts: Record<string, number> = {};
  for (const listener of activeListeners.values()) {
    if (!listener.country) continue;
    counts[listener.country] = (counts[listener.country] ?? 0) + 1;
  }
  return counts;
}

export async function recordListenerSnapshot(listeners: number, at = new Date()): Promise<void> {
  await db.insert(schema.listenerStats).values({
    at,
    listeners: Math.max(0, Math.round(listeners)),
    countries: activeCountryCounts(at.getTime()),
  });
}

export async function resolveListenerCountry(req: FastifyRequest): Promise<string | null> {
  const headerCountry = firstCountryHeader(req);
  if (headerCountry) return headerCountry;

  const ip = forwardedIp(req.headers["x-forwarded-for"]) ?? req.ip;
  if (!ip) return null;
  if (isPrivateIp(ip)) return "LOCAL";
  return lookupCountryByIp(ip);
}

function firstCountryHeader(req: FastifyRequest): string | null {
  const candidates = [
    req.headers["cf-ipcountry"],
    req.headers["x-vercel-ip-country"],
    req.headers["x-country-code"],
    req.headers["x-country"],
    req.headers["x-appengine-country"],
  ];
  for (const candidate of candidates) {
    const code = normalizeCountryCode(candidate);
    if (code) return code;
  }
  return null;
}

function normalizeCountryCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  if (!code || code === "XX" || code === "T1") return null;
  return /^[A-Z]{2,12}$/.test(code) ? code : null;
}

function cleanupExpiredListeners(now = Date.now()): void {
  for (const [sessionId, listener] of activeListeners.entries()) {
    if (now - listener.lastSeenAt > LISTENER_TTL_MS) {
      activeListeners.delete(sessionId);
    }
  }
}

function forwardedIp(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) value = value[0];
  if (!value) return null;
  const first = value.split(",")[0]?.trim();
  return first || null;
}

async function lookupCountryByIp(rawIp: string): Promise<string | null> {
  const ip = rawIp.replace(/^::ffff:/, "");
  const cached = countryCache.get(ip);
  if (cached && Date.now() - cached.resolvedAt < COUNTRY_CACHE_TTL_MS) {
    return cached.country;
  }

  const existing = pendingLookups.get(ip);
  if (existing) return existing;

  const lookup = fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(2500),
  })
    .then(async (res) => {
      if (!res.ok) return null;
      const data = await res.json() as { country_code?: unknown; success?: boolean };
      const code = normalizeCountryCode(data.country_code);
      return data.success === false ? null : code;
    })
    .catch(() => null)
    .then((country) => {
      countryCache.set(ip, { country, resolvedAt: Date.now() });
      pendingLookups.delete(ip);
      return country;
    });

  pendingLookups.set(ip, lookup);
  return lookup;
}

function isPrivateIp(rawIp: string): boolean {
  const ip = rawIp.replace(/^::ffff:/, "");
  if (ip === "::1" || ip === "127.0.0.1" || ip === "localhost") return true;

  if (isIP(ip) === 4) {
    return (
      ip.startsWith("10.") ||
      ip.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip) ||
      ip.startsWith("169.254.")
    );
  }

  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    return lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
  }

  return false;
}
