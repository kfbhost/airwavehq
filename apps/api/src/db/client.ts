import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config.js";
import * as schema from "./schema.js";

export const client = postgres(config.databaseUrl, { max: 10, prepare: false });
export const db = drizzle(client, { schema });
export { schema };

/** Converts a DB row (with Date fields) into a JSON-safe object. */
export function isoRow<T extends object>(row: T | null | undefined): T | null {
  if (row === null || row === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out as T;
}
