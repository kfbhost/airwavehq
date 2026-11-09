import type { FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { resolveListenerCountry } from "./listenerPresence.js";

export type GeoDecision =
  | { blocked: false }
  | { blocked: true; country: string | null; mode: "block" | "allow" };

/**
 * Decide whether the caller (by country) is allowed to consume the public
 * player / widgets / podcasts. Settings live in the DB:
 *   geoMode "off"       -> everyone allowed
 *   geoMode "block"     -> countries listed in geoCountries are blocked
 *   geoMode "allow"     -> only countries listed in geoCountries are allowed
 */
export async function geoDecision(req: FastifyRequest): Promise<GeoDecision> {
  const settings = await db.select().from(schema.settings).where(eq(schema.settings.id, 1)).limit(1);
  const s = settings[0];
  if (!s || s.geoMode === "off") return { blocked: false };

  const country = await resolveListenerCountry(req);
  if (!country) {
    // Unknown / impossible to resolve — err on allowing when in "block" mode
    // (block the ones we know), but on disallowing when in "allow" mode.
    if (s.geoMode === "allow") return { blocked: true, country: null, mode: "allow" };
    return { blocked: false };
  }

  const allowed = parseCountries(s.geoCountries);
  if (s.geoMode === "block") {
    return allowed.includes(country)
      ? { blocked: true, country, mode: "block" }
      : { blocked: false };
  }
  // allow mode
  return allowed.includes(country)
    ? { blocked: false }
    : { blocked: true, country, mode: "allow" };
}

export function parseCountries(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter((c) => /^[A-Z]{2}$/.test(c));
}