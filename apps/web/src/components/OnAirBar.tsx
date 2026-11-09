import { useEffect, useRef, useState } from "react";
import { useStatus } from "../ws";
import { api } from "../api";
import { Badge, UserAvatar } from "./ui";

export function OnAirBar({ userName, userAvatarPath }: { userName: string; userAvatarPath?: string | null }) {
  const snap = useStatus();
  const status = snap?.status;
  const current = status?.currentItem ?? null;
  const online = status?.online ?? false;
  const isLive = status?.mode === "live";
  const djName = status?.liveDjName;

  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [timezone, setTimezone] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    localStorage.getItem("rhs_theme") === "light" ? "light" : "dark",
  );
  const [fullscreen, setFullscreen] = useState(false);
  const fsSupported = fullscreenSupported();

  // Keep the button in sync with the real fullscreen state — the user can also
  // leave fullscreen with the Esc key or F11, so we must follow the document.
  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(fullscreenElement()));
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    onChange();
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);

  const toggleFullscreen = () => {
    const el = document.documentElement as FullscreenElement;
    const doc = document as FullscreenDocument;
    try {
      // Browsers reject this if it isn't in a user gesture — ours is a click, so
      // a rejection only means fullscreen isn't available; ignore it.
      const pending = fullscreenElement()
        ? (doc.exitFullscreen ?? doc.webkitExitFullscreen)?.call(doc)
        : (el.requestFullscreen ?? el.webkitRequestFullscreen)?.call(el);
      void Promise.resolve(pending).catch(() => {});
    } catch {
      /* ignore — stay in windowed mode */
    }
  };

  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    try {
      localStorage.setItem("rhs_theme", next);
    } catch {
      /* ignore */
    }
    if (next === "light") {
      document.documentElement.dataset.theme = "light";
    } else {
      delete document.documentElement.dataset.theme;
    }
  };

  useEffect(() => {
    api<{ streamUrl?: string; timezone?: string }>("/public/settings")
      .then((r) => {
        if (r.streamUrl) setStreamUrl(r.streamUrl);
        if (r.timezone) setTimezone(r.timezone);
      })
      .catch(() => {});
  }, []);

  // Stop the stream if the user navigates away from the dashboard.
  useEffect(() => () => audioRef.current?.pause(), []);

  const togglePlay = () => {
    if (!streamUrl) return;
    if (!audioRef.current) {
      const audio = new Audio(streamUrl);
      audio.addEventListener("ended", () => setPlaying(false));
      audioRef.current = audio;
    }
    const a = audioRef.current;
    if (playing) {
      a.pause();
      setPlaying(false);
    } else {
      void a
        .play()
        .then(() => setPlaying(true))
        .catch(() => setPlaying(false));
    }
  };

  return (
    <div className={`topbar${isLive ? " topbar-live" : ""}`}>
      <div className="now-playing">
        {isLive ? (
          <>
            <div className="np-art np-art-live">🔴</div>
            <div style={{ minWidth: 0 }}>
              <div className="np-title live-title">{djName ? `${djName} is broadcasting` : "Live broadcast"}</div>
              <div className="np-sub">
                <span className="live-pulse-dot" /> You're hearing the live DJ — automation is paused
              </div>
            </div>
          </>
        ) : current ? (
          <>
            {current.artworkPath ? (
              <img className="np-art np-art-image" src={artworkUrl(current.artworkPath)} alt="" loading="lazy" />
            ) : (
              <div className="np-art" aria-hidden="true">♪</div>
            )}
            <div style={{ minWidth: 0 }}>
              <div className="np-title">{current.title}</div>
              <div className="np-sub">
                {current.artist || "—"} · {current.source}
                {snap?.show?.name ? ` · ${snap.show.name}` : ""}
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="np-art">—</div>
            <div style={{ minWidth: 0 }}>
              <div className="np-title muted">Nothing playing yet</div>
              <div className="np-sub">Engine {online ? "online" : "offline"}</div>
            </div>
          </>
        )}
      </div>
      <div className="spacer" />
      <StudioClock tz={timezone} />
      <button
        className="topbar-theme"
        onClick={toggleTheme}
        title={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
        aria-label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
      >
        {theme === "light" ? "🌙" : "☀️"}
      </button>
      {fsSupported ? (
        <button
          className={`topbar-fs${fullscreen ? " active" : ""}`}
          onClick={toggleFullscreen}
          title={fullscreen ? "Exit full screen (Esc)" : "Full screen — hides the browser for a desktop feel"}
          aria-label={fullscreen ? "Exit full screen" : "Enter full screen"}
          aria-pressed={fullscreen}
        >
          {fullscreen ? "⤡" : "⛶"}
        </button>
      ) : null}
      <button
        className={`topbar-play${playing ? " playing" : ""}`}
        onClick={togglePlay}
        title={playing ? "Stop the station stream" : "Play the live station stream"}
        disabled={!streamUrl}
        aria-label={playing ? "Stop live stream" : "Play live stream"}
      >
        {playing ? "⏸" : "▶"}
      </button>
      {isLive ? (
        <Badge tone="live">
          <span className="live-pulse-dot" /> {djName ? `LIVE · ${djName}` : "LIVE"}
        </Badge>
      ) : online ? (
        <Badge tone="green">
          <span className="onair-dot" /> ON AIR
        </Badge>
      ) : (
        <Badge tone="red">OFFLINE</Badge>
      )}
      <Badge tone="blue">👥 {status?.listeners ?? 0}</Badge>
      <span className="topbar-user" title={userName}>
        <UserAvatar name={userName} avatarPath={userAvatarPath} size={30} />
      </span>
    </div>
  );
}

/* ---------- Full screen ("desktop app" mode) ---------- */

/** Fullscreen API, plus the WebKit-prefixed variant older Safari needs. */
type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};
type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenEnabled?: boolean;
};

function fullscreenElement(): Element | null {
  const doc = document as FullscreenDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/** iOS Safari has no element fullscreen, so we hide the button there. */
function fullscreenSupported(): boolean {
  const doc = document as FullscreenDocument;
  return Boolean(doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled);
}

function artworkUrl(artworkPath: string): string {
  const fileName = artworkPath.split(/[/\\\\]/).pop() ?? artworkPath;
  return `/media/${encodeURIComponent(fileName)}`;
}

/** A clear, always-ticking studio clock shown in the station's timezone. */
function StudioClock({ tz }: { tz: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  const zone = tz || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const d = new Date(now);
  let time = "";
  let zoneLabel = "";
  try {
    time = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(d);
    zoneLabel =
      new Intl.DateTimeFormat("en-GB", { timeZone: zone, timeZoneName: "short" })
        .formatToParts(d)
        .find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    time = d.toLocaleTimeString("en-GB", { hour12: false });
  }
  return (
    <div className="studio-clock" title={`Station time (${zone})`} aria-label={`Station time ${time}`}>
      <span className="studio-clock-time">{time}</span>
      {zoneLabel ? <span className="studio-clock-tz">{zoneLabel}</span> : null}
    </div>
  );
}