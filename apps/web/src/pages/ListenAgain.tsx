import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import { AudioPlayer } from "../components/AudioPlayer";
import { UserAvatar } from "../components/ui";
import type { PublicListenAgainItem } from "@airwavehq/shared";

function fmtClock(totalSeconds: number): string {
  const total = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtDate(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
    time: d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
  };
}

/**
 * Share URL for one episode. This points at /e/<id>, which the API answers
 * with real HTML carrying that episode's Open Graph tags — social crawlers
 * don't run JavaScript, so sharing the SPA route would always preview the same
 * generic page.
 */
function episodeShareUrl(episodeId: string): string {
  return `${window.location.origin}/e/${episodeId}`;
}

function ShareRow({ ep, stationName }: { ep: PublicListenAgainItem; stationName: string }) {
  const [copied, setCopied] = useState(false);
  const url = episodeShareUrl(ep.id);
  const text = `${ep.title}${ep.djName ? ` — ${ep.djName}` : ""} · ${stationName}`;
  // iOS hands facebook.com/sharer.php off to the Facebook app, which drops the
  // query string and opens an empty composer. The native share sheet is the
  // only reliable route on phones, so offer it whenever it exists.
  const canNativeShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  const nativeShare = async () => {
    try {
      await navigator.share({ title: ep.title, text, url });
    } catch {
      /* the listener dismissed the sheet — nothing to do */
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt("Copy this link", url);
    }
  };

  const fbHref = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`;
  const waHref = `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`;

  return (
    <div className="listen-again-share">
      {canNativeShare ? (
        <button type="button" className="share-btn native" onClick={() => void nativeShare()} aria-label="Share" title="Share">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 16V4" />
            <path d="M8 8l4-4 4 4" />
            <path d="M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" />
          </svg>
        </button>
      ) : null}
      <button
        type="button"
        className="share-btn copy"
        onClick={() => void copyLink()}
        aria-label="Copy link"
        title={copied ? "Link copied" : "Copy link"}
      >
        {copied ? (
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
            <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
          </svg>
        )}
      </button>
      <a className="share-btn fb" href={fbHref} target="_blank" rel="noopener noreferrer" aria-label="Share on Facebook" title="Share on Facebook">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M13.5 21v-8h2.7l.4-3.1h-3.1V7.9c0-.9.25-1.5 1.55-1.5H16.7V3.6c-.3 0-1.3-.1-2.5-.1-2.5 0-4.2 1.5-4.2 4.3v2.1H7.3V13h2.7v8h3.5z" /></svg>
      </a>
      <a className="share-btn wa" href={waHref} target="_blank" rel="noopener noreferrer" aria-label="Share on WhatsApp" title="Share on WhatsApp">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.5 15.2L2 22l4.9-1.3A10 10 0 1 0 12 2zm0 18a8 8 0 0 1-4.1-1.1l-.3-.2-2.9.8.8-2.8-.2-.3A8 8 0 1 1 12 20zm4.4-5.9c-.2-.1-1.4-.7-1.6-.8-.2-.1-.4-.1-.5.1-.2.2-.6.8-.8 1-.1.2-.3.2-.5.1-.2-.1-.9-.3-1.8-1.1-.7-.6-1.1-1.3-1.2-1.5-.1-.2 0-.3.1-.4.1-.1.2-.3.4-.4.1-.1.2-.2.2-.4 0-.1 0-.3-.1-.4-.1-.1-.5-1.2-.7-1.7-.2-.4-.4-.4-.5-.4h-.4c-.1 0-.4.1-.5.3-.2.2-.7.7-.7 1.6s.7 1.9.8 2c.1.2 1.4 2.1 3.3 2.9.5.2.8.3 1.1.4.5.1.9.1 1.2.1.4-.1 1.2-.5 1.3-1 .2-.5.2-.9.1-1-.1-.1-.2-.2-.4-.2z" /></svg>
      </a>
    </div>
  );
}

function EpisodeCard({
  ep,
  stationName,
  focused = false,
}: {
  ep: PublicListenAgainItem;
  stationName: string;
  focused?: boolean;
}) {
  const t = fmtDate(ep.startedAt);
  const color = ep.color ?? "#3b82f6";
  // Prefer the DJ's profile picture as the card header so you can see who did
  // the show; fall back to show artwork, then the show initial.
  const headerImg = ep.djAvatarUrl ?? ep.artworkUrl;
  return (
    <div className={`listen-again-card${focused ? " listen-again-card--focused" : ""}`}>
      <div className="listen-again-art" style={{ background: `linear-gradient(135deg, ${color}, ${color}55)` }}>
        {headerImg ? (
          <img src={headerImg} alt="" loading="lazy" className="listen-again-art-img" />
        ) : (
          <span>{(ep.showName ?? "♪").slice(0, 1).toUpperCase()}</span>
        )}
      </div>
      <div className="listen-again-card-body">
        <div className="listen-again-show">{ep.showName ?? "Show"}</div>
        <div className="listen-again-episode-title">{ep.title}</div>
        {ep.djName || ep.presenters ? (
          <div className="listen-again-djs">
            <UserAvatar name={ep.djName ?? ep.presenters ?? "DJ"} src={ep.djAvatarUrl} size={22} />
            <span>🎙 {ep.presenters ?? ep.djName}</span>
          </div>
        ) : null}
        <div className="listen-again-meta">
          {t.date} · {t.time} · {fmtClock(ep.durationSeconds)}
        </div>
        <ShareRow ep={ep} stationName={stationName} />
        <AudioPlayer src={ep.audioUrl} />
      </div>
    </div>
  );
}

export function ListenAgain() {
  const { id } = useParams<{ id: string }>();
  const [stationName, setStationName] = useState("Radio Station");
  const [episodes, setEpisodes] = useState<PublicListenAgainItem[] | null>(null);
  const [episode, setEpisode] = useState<PublicListenAgainItem | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (id) {
      // Shared link: load just that episode and show it on its own.
      setEpisode(null);
      setMissing(false);
      void api<{ stationName: string; episode: PublicListenAgainItem }>(`/public/listen-again/${encodeURIComponent(id)}`)
        .then((r) => {
          if (r.stationName) setStationName(r.stationName);
          setEpisode(r.episode);
        })
        .catch(() => setMissing(true));
      return;
    }
    void api<{ stationName: string }>("/public/settings")
      .then((r) => {
        if (r.stationName) setStationName(r.stationName);
      })
      .catch(() => {});
    void api<{ episodes: PublicListenAgainItem[] }>("/public/listen-again")
      .then((r) => setEpisodes(r.episodes))
      .catch(() => setEpisodes([]));
  }, [id]);

  // Give a shared episode its own tab title, so the browser history and any
  // client that does run JavaScript show the right show name.
  useEffect(() => {
    if (episode) document.title = `${episode.title}${episode.showName ? ` · ${episode.showName}` : ""} — ${stationName}`;
    else if (missing) document.title = `Episode not found — ${stationName}`;
    else document.title = `Listen Again — ${stationName}`;
  }, [episode, missing, stationName]);

  if (id) {
    return (
      <div className="public-player-shell listen-again-shell">
        <div className="listen-again-head">
          <a className="listen-again-back" href="/listen-again">◀ All episodes</a>
          <h1 className="listen-again-title">Listen Again</h1>
          <p className="listen-again-sub">A shared episode from <strong>{stationName}</strong>.</p>
        </div>
        {missing ? (
          <div className="listen-again-empty">
            That episode is no longer available.{" "}
            <a className="listen-again-link" href="/listen-again">Browse all episodes</a>
          </div>
        ) : !episode ? (
          <div className="listen-again-loading">Loading episode…</div>
        ) : (
          <div className="listen-again-focused">
            <EpisodeCard ep={episode} stationName={stationName} focused />
            <p className="listen-again-more">
              <a className="listen-again-link" href="/listen-again">◀ Browse all episodes</a>
            </p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="public-player-shell listen-again-shell">
      <div className="listen-again-head">
        <a className="listen-again-back" href="/listen">◀ Listen live</a>
        <h1 className="listen-again-title">Listen Again</h1>
        <p className="listen-again-sub">
          Catch up on recent shows from <strong>{stationName}</strong> — every episode is available as soon as it finishes airing.
        </p>
      </div>

      {episodes === null ? (
        <div className="listen-again-loading">Loading episodes…</div>
      ) : episodes.length === 0 ? (
        <div className="listen-again-empty">
          No recorded shows yet. Episodes appear here automatically once a show has aired and been published.
        </div>
      ) : (
        <div className="listen-again-grid">
          {episodes.map((ep) => (
            <EpisodeCard key={ep.id} ep={ep} stationName={stationName} />
          ))}
        </div>
      )}
    </div>
  );
}
