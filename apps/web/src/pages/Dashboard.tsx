import { useEffect, useMemo, useState } from "react";
import { useStatus } from "../ws";
import { useFetch } from "../components/ui";
import { api } from "../api";
import { mediaUrl } from "../media";
import { Card, Empty, PageHead, Stat, Badge } from "../components/ui";
import { Link } from "react-router-dom";
import type { StationSettings } from "@airwavehq/shared";

interface DashboardShow {
  id: string;
  name: string;
  color: string;
  presenters: string;
  createdAt: string;
  rundownCount: number;
  built: boolean;
  nextAir: {
    startIso: string;
    endIso: string;
    dayOfWeek: number | null;
    startMinutes: number;
    endMinutes: number;
  } | null;
}

export function Dashboard() {
  const snap = useStatus();
  const status = snap?.status;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const { data: settings } = useFetch(() => api<{ settings: StationSettings }>("/settings"));
  const { data: playlists } = useFetch(() => api<{ playlists: Array<{ id: string; name: string }> }>("/playlists"));
  const { data: lib } = useFetch(() => api<{ total: number }>("/tracks?pageSize=1"));
  const { data: music } = useFetch(() => api<{ total: number }>("/tracks?kind=music&pageSize=1"));
  const { data: showsData } = useFetch(() => api<{ shows: DashboardShow[]; timezone: string }>("/shows/dashboard"));

  const current = status?.currentItem ?? null;
  const rawUpcoming = status?.upcomingItems ?? [];
  // The engine sends heartbeats frequently and can briefly publish overlapping
  // queue windows while it refills. Keep a stable list until the first item
  // genuinely changes, rather than visually reordering the card on every tick.
  const [displayUpcoming, setDisplayUpcoming] = useState(rawUpcoming);
  const rawQueueKey = useMemo(() => rawUpcoming.map((item) => item.id).join("|"), [rawUpcoming]);
  useEffect(() => {
    setDisplayUpcoming((previous) => {
      const next = rawUpcoming.filter((item, index, items) => items.findIndex((candidate) => candidate.id === item.id) === index);
      const previousKey = previous.map((item) => item.id).join("|");
      const nextKey = next.map((item) => item.id).join("|");
      if (previousKey === nextKey || !nextKey) return previous;
      // Preserve existing rows in place; only prepend newly-seen items so the
      // list advances smoothly (each row is keyed by its own id).
      return [...next];
    });
  }, [rawQueueKey]);
  const upcoming = displayUpcoming;
  const activePlaylistName = snap?.programming?.playlistName ?? null;
  const activeRotationName = snap?.programming?.stationRotationName ?? null;
  const configuredPlaylistName = playlists?.playlists.find((p) => p.id === settings?.settings.defaultPlaylistId)?.name ?? null;
  const needsFirstRunSetup = (music?.total ?? 0) === 0 || !settings?.settings.defaultPlaylistId;
  const activeSource = status?.mode === "live"
    ? `Live Studio${status.liveDjName ? ` · ${status.liveDjName}` : ""}`
    : snap?.show?.name
      ? `Scheduled show · ${snap.show.name}`
      : activeRotationName
        ? `Rotation · ${activeRotationName}`
      : activePlaylistName
        ? `Automation playlist · ${activePlaylistName}`
          : configuredPlaylistName
            ? `Default playlist fallback · ${configuredPlaylistName}`
            : "No active source";

  // Labels derived from the refreshed programming snapshot (current wall clock),
  // plus what the schedule switches to next.
  const prog = snap?.programming ?? null;
  const programmingNext = prog?.next ?? null;
  const displayTz = settings?.settings.timezone ?? "UTC";
  const currentSourceLabel = (() => {
    if (status?.mode === "live") return `Live Studio${status.liveDjName ? ` · ${status.liveDjName}` : ""}`;
    if (prog?.automationSource === "show") return snap?.show?.name ? `Scheduled show · ${snap.show.name}` : "Scheduled show";
    if (prog?.automationSource === "rotation") {
      return prog.stationRotationName
        ? `Rotation · ${prog.stationRotationName}`
        : prog.playlistName
          ? `Playlist · ${prog.playlistName}`
          : "Rotation";
    }
    if (prog?.playlistName) return `Default playlist · ${prog.playlistName}`;
    if (configuredPlaylistName) return `Default playlist · ${configuredPlaylistName}`;
    return "No active source";
  })();
  const nextSourceName = programmingNext
    ? programmingNext.automationSource === "show"
      ? (programmingNext.showName ?? "Scheduled show")
      : programmingNext.automationSource === "rotation"
        ? (programmingNext.stationRotationName ?? programmingNext.playlistName ?? "Rotation")
        : (programmingNext.playlistName ?? "Default playlist")
    : null;
  const nextTimeLabel = programmingNext?.atMs ? fmtTimeLabel(programmingNext.atMs, displayTz) : null;

  const healthChecks: Array<{
    ok: boolean;
    label: string;
    help: string;
    to?: string;
  }> = [
    {
      ok: Boolean(status?.online),
      label: "Playout engine connected",
      help: status?.online
        ? `Last heartbeat ${relativeTime(status.engineTime)}.`
        : "Automation is offline, so the station cannot keep itself on air.",
      to: "/settings",
    },
    {
      ok: (music?.total ?? 0) > 0,
      label: "Music available in the library",
      help: (music?.total ?? 0) > 0
        ? `${music?.total ?? 0} music tracks ready for automation.`
        : "Upload music before expecting AutoDJ or rotations to run.",
      to: "/library",
    },
    {
      ok: Boolean(settings?.settings.defaultPlaylistId),
      label: "Fallback default playlist set",
      help: configuredPlaylistName
        ? `${configuredPlaylistName} is ready as the station fallback.`
        : "Choose a default playlist so automation always has a music source.",
      to: "/settings",
    },
    {
      ok: Boolean(settings?.settings.streamUrl),
      label: "Public stream URL configured",
      help: settings?.settings.streamUrl
        ? "Public player and widgets know where to send listeners."
        : "Add the stream URL in Settings so listen links work properly.",
      to: "/settings",
    },
    {
      ok: status?.mode === "live" || Boolean(snap?.show?.name || activePlaylistName || configuredPlaylistName),
      label: "Current on-air source resolved",
      help: activeSource,
    },
  ];

  const healthIssues = healthChecks.filter((check) => !check.ok).length;
  const healthTone = healthIssues === 0 ? "green" : needsFirstRunSetup ? "amber" : "red";
  const healthLabel = healthIssues === 0 ? "Healthy" : needsFirstRunSetup ? "Needs setup" : "Needs attention";
  const currentStartedAtMs = snap?.currentItemStartedAt ? Date.parse(snap.currentItemStartedAt) : NaN;
  const currentRemainingSec = current && Number.isFinite(currentStartedAtMs)
    ? Math.max(0, Math.round(current.durationSec - (nowMs - currentStartedAtMs) / 1000))
    : null;
  // How far through the current track we are (0-100), for the countdown bar.
  const currentProgressPct = current && current.durationSec > 0 && currentRemainingSec != null
    ? Math.max(0, Math.min(100, ((current.durationSec - currentRemainingSec) / current.durationSec) * 100))
    : 0;

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <>
      <div className="dashboard-shell">
        <PageHead
          title={settings?.settings.stationName ?? "Your station"}
          sub="Broadcast control room"
          actions={
            <Link to="/studio">
              <span className="btn btn-primary">🔴 Go Live</span>
            </Link>
          }
        />
        <div className="grid dashboard-stats">
          <Stat
            className="dashboard-stat"
            label="Status"
            value={
              status?.mode === "live" ? (
                <Badge tone="live"><span className="live-pulse-dot" /> LIVE · {status.liveDjName ?? "DJ"}</Badge>
              ) : status?.online ? (
                <Badge tone="green"><span className="onair-dot" /> ON AIR</Badge>
              ) : (
                <Badge tone="red">OFFLINE</Badge>
              )
            }
            sub={
              status?.mode === "live"
                ? "A DJ is broadcasting live — automation is paused"
                : "AutoDJ is streaming 24/7 when online"
            }
          />
          <Stat className="dashboard-stat" label="Listeners" value={status?.listeners ?? 0} sub="Connected to the stream" />
          <Stat
            className="dashboard-stat"
            label="Live bitrate"
            value={status?.encoderBitrateKbps ? `${status.encoderBitrateKbps} kbps` : "—"}
            sub={status?.online ? "Current encoder output" : "Shown when the engine is online"}
          />
          <Stat className="dashboard-stat" label="Library" value={lib?.total ?? "—"} sub="Tracks uploaded" />
        </div>

        <div className="dashboard-main">
          <div className="dashboard-column">
            {needsFirstRunSetup ? (
              <Card className="dashboard-card" title="Before your station can stay on air">
                <p className="hint" style={{ marginTop: 0 }}>
                  On a new install, AutoDJ will not stay on air until you upload music and choose a default playlist. With no
                  music in the library, or no fallback playlist set in Settings, the automation has nothing to play.
                </p>
                <div className="row wrap" style={{ marginTop: 10 }}>
                  <Link to="/library"><span className="btn">Upload music</span></Link>
                  <Link to="/playlists"><span className="btn">Build playlist</span></Link>
                  <Link to="/settings"><span className="btn btn-primary">Set default playlist</span></Link>
                </div>
              </Card>
            ) : null}
            <Card className="dashboard-card" title={status?.mode === "live" ? "Live now" : "Now playing"}>
              {status?.mode === "live" ? (
                <>
                  <div className="dashboard-now-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span className="live-pulse-dot" /> {status.liveDjName ?? "A DJ"} is live
                  </div>
                  <div className="dashboard-now-sub">
                    You're hearing the live broadcast — the AutoDJ rotation resumes when the DJ stops.
                  </div>
                  <div className="dashboard-badges">
                    <Badge tone="live">live</Badge>
                    <Badge tone="blue">source: live</Badge>
                  </div>
                </>
              ) : current ? (
                <>
                  <div className="dashboard-now-row">
                    <ArtworkThumb item={current} size="large" />
                    <div className="dashboard-now-copy">
                      <div className="dashboard-now-title">{current.title}</div>
                      <div className="dashboard-now-sub">{current.artist || "—"}</div>
                      <div className="dashboard-badges">
                        <Badge>{current.kind}</Badge>
                        <Badge tone="blue">source: {current.source}</Badge>
                        {snap?.show?.name ? <Badge tone="green">{snap.show.name}</Badge> : null}
                      </div>
                    </div>
                  </div>
                  <div className="dashboard-now-timer">
                    <div className="dashboard-now-timer-head">
                      <span className="dashboard-now-timer-left">
                        <span className="mono dashboard-now-timer-count">
                          {currentRemainingSec != null ? fmtClock(currentRemainingSec) : fmtClock(current.durationSec)}
                        </span>
                        <span className="small muted"> remaining</span>
                      </span>
                      <span className="small muted">{fmtClock(current.durationSec)} total</span>
                    </div>
                    <div className="dashboard-now-timer-track" aria-hidden="true">
                      <div className="dashboard-now-timer-fill" style={{ width: `${currentProgressPct}%` }} />
                    </div>
                  </div>
                </>
              ) : (
                <Empty>Nothing playing. Start the engine or upload music first.</Empty>
              )}
              <div className="dashboard-section-divider" />
              <div className="card-head" style={{ marginBottom: 10 }}>
                <div className="card-head-copy">
                  <strong className="card-title">Coming up next</strong>
                  <div className="card-sub">The next 5 items the engine is lined up to play</div>
                </div>
              </div>
              {status?.mode === "live" ? (
                <Empty>A DJ is live right now, so the automation queue is on standby until they hand back.</Empty>
              ) : upcoming.length === 0 ? (
                <Empty>No queued items yet. The engine will fill this once automation is active.</Empty>
              ) : (
                <div className="dashboard-queue">
                  {upcoming.map((item, index) => (
                    <div key={item.id} className="dashboard-queue-item queue-item-enter">
                      <div className="dashboard-queue-head">
                        <div className="dashboard-queue-meta">
                          <span className="dashboard-queue-index">{index + 1}.</span>
                          <ArtworkThumb item={item} size="small" />
                          <div>
                            <div className="dashboard-queue-title">{item.title}</div>
                            <div className="dashboard-queue-artist">{item.artist || "—"}</div>
                          </div>
                        </div>
                        <span className="dashboard-queue-duration mono">{fmtClock(item.durationSec)}</span>
                      </div>
                      <div className="dashboard-badges" style={{ marginTop: 8 }}>
                        <Badge>{item.kind}</Badge>
                        <Badge tone="blue">source: {sourceLabel(item.source)}</Badge>
                        {item.showId ? <Badge tone="green">show item</Badge> : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          <div className="dashboard-column">
            <Card className="dashboard-card" title="Automation source">
              <div className="dashboard-health-summary">
                <div>
                  <div className="dashboard-health-label">Automation health</div>
                  <div className="dashboard-health-title">{healthLabel}</div>
                </div>
                <Badge tone={healthTone}>{healthIssues === 0 ? "All checks passed" : `${healthIssues} check${healthIssues === 1 ? "" : "s"} need attention`}</Badge>
              </div>
              <div className="dashboard-checks">
              {healthChecks.map((check) => (
                <div key={check.label} className="dashboard-check">
                  <div className="dashboard-check-head">
                    <div className="dashboard-check-title">{check.label}</div>
                    <Badge tone={check.ok ? "green" : "amber"}>{check.ok ? "OK" : "Check"}</Badge>
                  </div>
                  <div className="dashboard-check-help">{check.help}</div>
                  {!check.ok && check.to ? (
                    <Link className="dashboard-link" to={check.to}>Open {check.to === "/library" ? "Media Library" : "Settings"}</Link>
                  ) : null}
                </div>
              ))}
              </div>
              <div className="dashboard-source-grid">
                <div className="dashboard-source-box dashboard-source-wide">
                  <div className="dashboard-kicker">On air now</div>
                  <div className="dashboard-source-value">{currentSourceLabel}</div>
                </div>
                <div className="dashboard-source-box">
                  <div className="dashboard-kicker">Default fallback playlist</div>
                  <div className="dashboard-source-value">{configuredPlaylistName ?? "None selected"}</div>
                </div>
              </div>
              <div className="dashboard-source-box" style={{ marginTop: 10 }}>
                <div className="dashboard-kicker">Next on the schedule</div>
                {nextSourceName ? (
                  <div className="dashboard-source-value">
                    {nextSourceName}
                    {nextTimeLabel ? <span className="small muted"> · {nextTimeLabel}</span> : null}
                  </div>
                ) : (
                  <div className="dashboard-source-value muted">No further change programmed</div>
                )}
              </div>
              <div className="dashboard-badges" style={{ marginTop: 14 }}>
                <Badge tone="blue">mode: {snap?.programming?.mode ?? "idle"}</Badge>
                {snap?.programming?.automationSource ? <Badge tone="blue">automation: {snap.programming.automationSource}</Badge> : null}
                {snap?.programming?.clockwheelName ? <Badge>clockwheel: {snap.programming.clockwheelName}</Badge> : null}
                {snap?.show?.name ? <Badge tone="green">show: {snap.show.name}</Badge> : null}
              </div>
            </Card>
          </div>

          <div className="dashboard-column">
            <Card
              className="dashboard-card dashboard-shows-card"
              title="Shows"
              sub="Every show, newest first — built in the Show Builder and its next time on air"
              actions={<Link to="/shows"><span className="btn btn-ghost btn-sm">Manage shows</span></Link>}
            >
              {showsData && showsData.shows.length === 0 ? (
                <Empty>No shows yet. Create one on the Shows page, then build its rundown in the Show Builder.</Empty>
              ) : (
                <div className="dashboard-shows">
                  {showsData?.shows.map((s) => (
                    <div key={s.id} className="dashboard-show-row">
                      <span className="dashboard-show-dot" style={{ background: s.color }} aria-hidden="true" />
                      <div className="dashboard-show-main">
                        <div className="dashboard-show-name">{s.name}</div>
                        <div className="dashboard-show-meta">
                          {s.presenters ? <span>🎙 {s.presenters}</span> : null}
                          <span>Created {formatDate(s.createdAt)}</span>
                        </div>
                      </div>
                      <div className="dashboard-show-side">
                        {s.built ? (
                          <Badge tone="green">Built · {s.rundownCount} item{s.rundownCount === 1 ? "" : "s"}</Badge>
                        ) : (
                          <Badge tone="amber">Not built</Badge>
                        )}
                        <span className="dashboard-show-next">
                          {s.nextAir ? (
                            <>
                              Next <strong>{nextAirLabel(s.nextAir.startIso, showsData.timezone)}</strong>
                              <span className="muted"> · {scheduleWhen(s.nextAir.startIso, nowMs, showsData.timezone)}</span>
                            </>
                          ) : s.built ? (
                            "Built — add it to the Schedule"
                          ) : (
                            "Not scheduled yet"
                          )}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}

function fmtTimeLabel(ms: number, tz: string): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = d.toDateString() === new Date().toDateString();
  try {
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(d);
    const day = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" }).format(d);
    return sameDay ? `today ${time}` : `${day} ${time}`;
  } catch {
    return "";
  }
}

function relativeTime(iso: string | null | undefined): string {  if (!iso) return "unknown";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < 15_000) return "just now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  return `${Math.round(ms / 60_000)}m ago`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function nextAirLabel(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  }
}

function scheduleWhen(iso: string, nowMs: number, tz: string): string {
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return "";
  const diffMs = target - nowMs;
  const days = localDayGap(nowMs, target, tz);
  if (days === 0) {
    const mins = Math.round(diffMs / 60_000);
    if (mins < 1) return "now";
    if (mins < 60) return `in ${mins} min`;
    const hrs = Math.floor(mins / 60);
    return hrs <= 4 ? `in ${hrs} hr${hrs === 1 ? "" : "s"}` : "later today";
  }
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

/** Whole number of local calendar days from `nowMs` up to `targetMs` (0 = today). */
function localDayGap(nowMs: number, targetMs: number, tz: string): number {
  const stamp = (ms: number): string => {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
    } catch {
      return "";
    }
  };
  const a = stamp(nowMs);
  const b = stamp(targetMs);
  if (!a || !b) return Math.max(0, Math.floor((targetMs - nowMs) / 86_400_000));
  return Math.max(0, Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000));
}

function sourceLabel(source: string): string {
  if (source === "voice") return "voice link";
  if (source === "show") return "show";
  return source;
}

function fmtClock(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function ArtworkThumb({
  item,
  size,
}: {
  item: { artworkPath: string | null; title: string };
  size: "large" | "small";
}) {
  const [failed, setFailed] = useState(false);
  const src = mediaUrl(item.artworkPath);
  if (!src || failed) {
    return <div className={`dashboard-artwork dashboard-artwork-${size} is-fallback`} aria-hidden="true">♪</div>;
  }
  return (
    <img
      className={`dashboard-artwork dashboard-artwork-${size}`}
      src={src}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
