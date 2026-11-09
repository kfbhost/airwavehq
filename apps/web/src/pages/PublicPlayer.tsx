import { useEffect, useState } from "react";
import { api } from "../api";
import type { PublicNowPlaying } from "@radiohost/shared";

const HEARTBEAT_MS = 30_000;

function listenerSessionId(): string {
  const key = "rhs_public_listener_session";
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const next = crypto.randomUUID();
  sessionStorage.setItem(key, next);
  return next;
}

export function PublicPlayer() {
  const [info, setInfo] = useState<PublicNowPlaying | null>(null);
  const [audio, setAudio] = useState<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(85);

  useEffect(() => {
    let live = true;
    const poll = () => {
      void api<PublicNowPlaying>("/public/now-playing").then((r) => live && setInfo(r)).catch(() => {});
    };
    poll();
    const id = setInterval(poll, 10_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  const stream = info?.streamUrl || `${location.protocol}//${location.host}/live`;

  useEffect(() => {
    if (!playing) return;
    const sendHeartbeat = () => {
      void api("/public/listener-heartbeat", {
        method: "POST",
        body: { sessionId: listenerSessionId() },
      }).catch(() => {});
    };
    sendHeartbeat();
    const id = setInterval(sendHeartbeat, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [playing]);

  useEffect(() => {
    if (!audio) return;
    audio.volume = volume / 100;
  }, [audio, volume]);

  const blocked = info?.geoBlocked === true;

  const toggle = () => {
    if (blocked) return;
    if (audio) {
      if (playing) audio.pause();
      else void audio.play();
      setPlaying(!playing);
      return;
    }
    const a = new Audio(stream);
    a.volume = volume / 100;
    a.onplay = () => setPlaying(true);
    a.onpause = () => setPlaying(false);
    setAudio(a);
    void a.play();
  };

  return (
    <div className="public-player-shell">
      <div className="public-player-card">
        <div className="public-player-hero">
          <ArtworkHero artworkUrl={info?.nowPlaying?.artworkUrl ?? null} />
          <div className="public-player-copy">
            <h1 className="public-player-title">{info?.stationName ?? "Radio Station"}</h1>
            <div className="public-player-track">
              {info?.live ? (
                <>
                  <div className="public-player-live-line">
                    <span className="public-player-live-dot" aria-hidden="true" />
                    LIVE
                  </div>
                  <div className="public-player-track-sub">
                    {info.liveDjName ? `with ${info.liveDjName}` : "with the live team"}
                    {info.showName ? ` — ${info.showName}` : ""}
                  </div>
                </>
              ) : (
                <>
                  <div className="public-player-track-title">{info?.nowPlaying?.title ?? "Waiting for audio..."}</div>
                  <div className="public-player-track-sub">{info?.nowPlaying?.artist || "AutoDJ"}</div>
                </>
              )}
            </div>
            <div className="public-player-actions">
              {blocked ? (
                <button className="btn btn-lg public-player-button" disabled style={{ background: "var(--bg3)", color: "var(--muted)" }}>🚫 Not available in your region</button>
              ) : (
                <button className="btn btn-primary btn-lg public-player-button" onClick={toggle}>
                  {playing ? "⏸ Pause stream" : "▶ Listen live"}
                </button>
              )}
              <div className="public-player-stats">
                <span className="public-player-chip">👥 {info?.listeners ?? 0} listening</span>
                <a className="public-player-chip listen-again-link" href="/listen-again">🎧 Listen Again</a>
              </div>
            </div>
            <div className="public-player-controls">
              <label className="public-player-volume" htmlFor="public-player-volume">
                <span className="public-player-volume-label">Volume</span>
                <input
                  id="public-player-volume"
                  type="range"
                  min="0"
                  max="100"
                  value={volume}
                  onChange={(e) => setVolume(Number(e.target.value))}
                />
                <span className="public-player-volume-value">{volume}%</span>
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ArtworkHero({ artworkUrl }: { artworkUrl: string | null }) {
  return artworkUrl ? (
    <img className="public-player-art" src={artworkUrl} alt="" loading="lazy" />
  ) : (
    <div className="public-player-art public-player-art-fallback" aria-hidden="true">
      ♪
    </div>
  );
}
