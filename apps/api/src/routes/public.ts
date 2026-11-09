import type { FastifyInstance } from "fastify";
import { and, asc, eq, ilike, or } from "drizzle-orm";
import { basename, dirname } from "node:path";
import { db, schema, isoRow } from "../db/client.js";
import { getStatus, getCurrentItemStartedAt, snapshot } from "../services/engineState.js";
import { resolveListenerCountry, touchPublicListener } from "../services/listenerPresence.js";
import { geoDecision } from "../services/geoblock.js";
import { loadListenAgainEpisode, loadListenAgainEpisodes, loadStationInfo } from "../services/listenAgain.js";
import { emitEvent } from "../services/webhooks.js";
import { listenerHeartbeatSchema, requestSchema } from "@radiohost/shared";
import type { PublicNowPlaying, PublicScheduleItem } from "@radiohost/shared";

export function publicRoutes(app: FastifyInstance): void {
  app.get("/public/now-playing", async (req) => {
    const geo = await geoDecision(req);
    const settings = await db.select().from(schema.settings).where(eq(schema.settings.id, 1)).limit(1);
    const s = settings[0];
    const status = getStatus();
    const live = status.mode === "live";
    // During a live broadcast the DJ's audio is on air — the engine's
    // currentItem is the (silent) automation track, so don't present it as
    // "now playing".
    const nowPlaying =
      !live && status.currentItem
        ? {
            title: status.currentItem.title,
            artist: status.currentItem.artist,
            startedAt: getCurrentItemStartedAt(),
            artworkUrl: status.currentItem.artworkPath ? `/media/${basename(status.currentItem.artworkPath)}` : null,
          }
        : null;
    const out: PublicNowPlaying = {
      stationName: s?.stationName ?? "Radio Station",
      streamUrl: s?.streamUrl ?? "",
      nowPlaying,
      listeners: status.listeners,
      live,
      liveDjName: status.liveDjName,
      // When live, prefer the show name the DJ set when going live; otherwise
      // fall back to the scheduled show currently on air.
      showName: live ? (status.liveShowName ?? snapshot().show.name) : snapshot().show.name,
      geoBlocked: geo.blocked,
      updatedAt: new Date().toISOString(),
    };
    return out;
  });

  app.get("/public/schedule", async () => {
    const settings = await db.select().from(schema.settings).where(eq(schema.settings.id, 1)).limit(1);
    const tz = settings[0]?.timezone || "UTC";
    const rows = await db
      .select({ entry: schema.scheduleEntries, show: schema.shows })
      .from(schema.scheduleEntries)
      .innerJoin(schema.shows, eq(schema.scheduleEntries.showId, schema.shows.id))
      .orderBy(asc(schema.scheduleEntries.startMinutes));
    const allocated = await db
      .select({ slot: schema.djSlots, dj: schema.users, show: schema.shows })
      .from(schema.djSlots)
      .innerJoin(schema.users, eq(schema.djSlots.djId, schema.users.id))
      .leftJoin(schema.shows, eq(schema.djSlots.showId, schema.shows.id));
    const items: PublicScheduleItem[] = [
      ...rows.map((r) => ({
        dayOfWeek: r.entry.dayOfWeek ?? -1,
        startMinutes: r.entry.startMinutes,
        endMinutes: r.entry.endMinutes,
        show: {
          name: r.show.name,
          color: r.show.color,
          description: r.show.description,
          presenters: r.show.presenters,
        },
      })),
      ...allocated
        .filter((r) => !r.show)
        .map((r) => ({
          dayOfWeek: r.slot.dayOfWeek ?? -1,
          startMinutes: r.slot.startMinutes,
          endMinutes: r.slot.endMinutes,
          show: {
            name: `${r.dj.name} — Show to be configured`,
            color: "#64748b",
            description: "DJ slot",
            presenters: r.dj.name,
          },
        })),
    ];
    return { timezone: tz, items };
  });

  app.get("/public/podcasts", async () => {
    const rows = await db
      .select()
      .from(schema.recordings)
      .where(eq(schema.recordings.isPodcast, true))
      .orderBy(asc(schema.recordings.startedAt));
    const base = process.env.PUBLIC_BASE_URL ?? "";
    return {
      podcasts: rows.map((r) => ({
        ...isoRow(r),
        audioUrl: `${base}/api/public/podcasts/${r.id}/audio`,
      })),
    };
  });

  // Public "Listen Again": recorded shows with DJ/show details.
  app.get("/public/listen-again", async () => {
    const [station, episodes] = await Promise.all([loadStationInfo(), loadListenAgainEpisodes()]);
    return { stationName: station.stationName, episodes };
  });

  // A single episode — used by the focused view a shared link opens.
  app.get("/public/listen-again/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [station, episode] = await Promise.all([loadStationInfo(), loadListenAgainEpisode(id)]);
    if (!episode) return reply.code(404).send({ error: "Episode not found" });
    return { stationName: station.stationName, episode };
  });

  app.get("/public/podcasts/:id/audio", async (req, reply) => {
    if ((await geoDecision(req)).blocked) return reply.code(403).send({ error: "Not available in your region" });
    const { id } = req.params as { id: string };
    const rows = await db.select().from(schema.recordings).where(eq(schema.recordings.id, id)).limit(1);
    const r = rows[0];
    // Only published recordings are publicly streamable; private recordings
    // are admin-only via /api/recordings/:id/audio.
    if (!r || !r.isPodcast) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile(basename(r.filePath), dirname(r.filePath));
  });

  // RSS feed for podcast apps.
  app.get("/public/podcasts.rss", async (_req, reply) => {
    const settings = await db.select().from(schema.settings).where(eq(schema.settings.id, 1)).limit(1);
    const s = settings[0];
    const base = process.env.PUBLIC_BASE_URL ?? "";
    const rows = await db
      .select()
      .from(schema.recordings)
      .where(eq(schema.recordings.isPodcast, true))
      .orderBy(asc(schema.recordings.startedAt));
    const items = rows
      .map((r) => {
        const enclosure = `${base}/api/public/podcasts/${r.id}/audio`;
        const safe = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return `    <item>
      <title>${safe(r.title)}</title>
      <pubDate>${r.startedAt.toUTCString()}</pubDate>
      <enclosure url="${safe(enclosure)}" type="audio/mpeg" length="${0}" />
      <guid>${r.id}</guid>
    </item>`;
      })
      .join("\n");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${safeXml(s?.stationName ?? "Radio")} — Podcasts</title>
    <description>${safeXml(s?.tagline ?? "")}</description>
    <link>${safeXml(base)}</link>
${items}
  </channel>
</rss>`;
    reply.header("Content-Type", "application/rss+xml; charset=utf-8");
    return reply.send(xml);
  });

  app.post("/public/requests", async (req, reply) => {
    const settings = await db.select().from(schema.settings).where(eq(schema.settings.id, 1)).limit(1);
    if (!settings[0]?.requestBoxEnabled) {
      return reply.code(403).send({ error: "Requests are disabled" });
    }
    const body = requestSchema.parse(req.body);
    const inserted = await db
      .insert(schema.requests)
      .values({
        songQuery: body.songQuery,
        trackId: body.trackId ?? null,
        listenerName: body.listenerName ?? "",
        message: body.message ?? "",
      })
      .returning();
    const entry = inserted[0]!;
    await emitEvent("request.received", { requestId: entry.id, song: entry.songQuery, trackId: entry.trackId });
    return reply.code(201).send({ request: isoRow(entry) });
  });

  app.get("/public/settings", async () => {
    const settings = await db.select().from(schema.settings).where(eq(schema.settings.id, 1)).limit(1);
    const s = settings[0];
    if (!s) return {};
    return {
      stationName: s.stationName,
      tagline: s.tagline,
      logoUrl: s.logoPath ? `/media/${basename(s.logoPath)}` : null,
      streamUrl: s.streamUrl,
      timezone: s.timezone,
      publicPageEnabled: s.publicPageEnabled,
      requestBoxEnabled: s.requestBoxEnabled,
    };
  });

  app.post("/public/listener-heartbeat", async (req) => {
    const body = listenerHeartbeatSchema.parse(req.body);
    const country = await resolveListenerCountry(req);
    touchPublicListener(body.sessionId, country);
    return { ok: true, country };
  });

  // Public search over the library, for the request box widget.
  app.get("/public/search", async (req) => {
    const q = (req.query as { q?: string }).q?.trim();
    if (!q || q.length < 2) return { results: [] };
    const rows = await db
      .select()
      .from(schema.tracks)
      .where(or(
        ilike(schema.tracks.title, `%${q}%`),
        ilike(schema.tracks.artist, `%${q}%`),
      ))
      .limit(10);
    return {
      results: rows
        .filter((r) => r.kind === "music")
        .map((r) => ({ id: r.id, title: r.title, artist: r.artist })),
    };
  });
}

function safeXml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
