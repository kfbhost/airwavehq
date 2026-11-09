import type { FastifyInstance, FastifyRequest } from "fastify";
import { formatEpisodeDuration, loadListenAgainEpisode, loadStationInfo } from "../services/listenAgain.js";
import type { PublicListenAgainItem } from "@radiohost/shared";

// Server-rendered share page for one Listen Again episode.
//
// Social crawlers (Facebook, WhatsApp, X, iMessage) do not run JavaScript, so a
// single-page app can only ever expose one generic preview no matter which
// episode you share. This route is plain HTML the crawler can read, carrying
// that episode's title, show, DJ, running time and artwork, and then hands a
// human visitor straight on to the real player page.
//
// It lives at /e/<id> rather than /listen-again/<id> so nginx can proxy it to
// the API instead of serving the SPA shell.

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/**
 * Absolute origin for the share URLs. PUBLIC_BASE_URL is what a real install
 * sets; fall back to the request's forwarded headers so this still produces
 * correct links when it hasn't been configured.
 */
export function requestOrigin(req: FastifyRequest): string {
  const configured = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  const first = (value: string | string[] | undefined): string => {
    const raw = (Array.isArray(value) ? value[0] : value) ?? "";
    return (raw.split(",")[0] ?? "").trim();
  };
  const proto = first(req.headers["x-forwarded-proto"]) || "https";
  const host = first(req.headers["x-forwarded-host"]) || first(req.headers.host);
  const derived = host ? `${proto}://${host}` : "";
  // A localhost default is a placeholder on a real install — prefer whichever
  // the request itself tells us in that case.
  if (configured && !/^http:\/\/localhost/.test(configured)) return configured;
  return derived || configured;
}

export function airedLabel(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone,
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toUTCString();
  }
}

export interface SharePageInput {
  id: string;
  origin: string;
  stationName: string;
  timezone: string;
  episode: PublicListenAgainItem;
}

/** Pure so it can be unit tested without a database. */
export function renderSharePage({ id, origin, stationName, timezone, episode }: SharePageInput): string {
  const showName = episode.showName ?? "Show";
  const presenter = episode.presenters ?? episode.djName;
  const aired = airedLabel(episode.startedAt, timezone);
  const ranFor = formatEpisodeDuration(episode.durationSeconds);

  const title = `${episode.title} · ${showName} — ${stationName}`;
  const description = [
    presenter ? `${showName} with ${presenter}.` : `${showName}.`,
    `Aired ${aired}, ${ranFor}.`,
    `Listen again on ${stationName}.`,
  ].join(" ");

  // The DJ's picture is a square headshot; artwork is usually wide. Prefer
  // artwork for a social card, then fall back to the presenter.
  const image = [episode.artworkUrl, episode.djAvatarUrl].find((u) => Boolean(u)) ?? null;
  const imageUrl = image ? (image.startsWith("http") ? image : `${origin}${image}`) : null;
  const audioUrl = episode.audioUrl.startsWith("http") ? episode.audioUrl : `${origin}${episode.audioUrl}`;

  const meta = [
    `<meta property="og:type" content="music.song" />`,
    `<meta property="og:site_name" content="${escapeHtml(stationName)}" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:url" content="${escapeHtml(origin)}/e/${escapeHtml(id)}" />`,
    imageUrl ? `<meta property="og:image" content="${escapeHtml(imageUrl)}" />` : "",
    imageUrl ? `<meta property="og:image:alt" content="${escapeHtml(showName)} artwork" />` : "",
    `<meta property="og:audio" content="${escapeHtml(audioUrl)}" />`,
    `<meta name="twitter:card" content="${imageUrl ? "summary_large_image" : "summary"}" />`,
    `<meta name="twitter:title" content="${escapeHtml(episode.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
    imageUrl ? `<meta name="twitter:image" content="${escapeHtml(imageUrl)}" />` : "",
  ]
    .filter(Boolean)
    .join("\n  ");

  const target = `${origin}/listen-again/${id}`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <link rel="canonical" href="${escapeHtml(target)}" />
  ${meta}
  <meta http-equiv="refresh" content="0; url=${escapeHtml(target)}" />
  <script>location.replace(${JSON.stringify(target).replace(/</g, "\\u003c")});</script>
  <style>body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:40px;text-align:center}a{color:#3b82f6}</style>
</head>
<body>
  <p>Opening <strong>${escapeHtml(episode.title)}</strong>…</p>
  <p><a href="${escapeHtml(target)}">Continue to the episode</a></p>
</body>
</html>`;
}

function renderMissing(origin: string, stationName: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<title>Episode not found · ${escapeHtml(stationName)}</title>
<meta name="robots" content="noindex" />
<meta http-equiv="refresh" content="0; url=${escapeHtml(origin)}/listen-again" />
</head><body style="font-family:system-ui,sans-serif;padding:40px;text-align:center">
<p>That episode is no longer available.</p>
<p><a href="${escapeHtml(origin)}/listen-again">All episodes</a></p>
</body></html>`;
}

export function shareRoutes(app: FastifyInstance): void {
  app.get("/e/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [station, episode] = await Promise.all([loadStationInfo(), loadListenAgainEpisode(id)]);
    const origin = requestOrigin(req);

    reply.type("text/html; charset=utf-8");

    if (!episode) {
      reply.code(404);
      return renderMissing(origin, station.stationName);
    }

    return renderSharePage({
      id,
      origin,
      stationName: station.stationName,
      timezone: station.timezone,
      episode,
    });
  });
}
