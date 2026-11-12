import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://airwavehq:airwavehq@localhost:5432/airwavehq",
  },
  verbose: true,
  strict: true,
});
