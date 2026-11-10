import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { api, getToken, setToken } from "./api";
import { OnAirBar } from "./components/OnAirBar";
import { Login, Register, DjLogin } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { Library } from "./pages/Library";
import { Playlists } from "./pages/Playlists";
import { Rotations } from "./pages/Rotations";
import { Clockwheels } from "./pages/Clockwheels";
import { Schedule } from "./pages/Schedule";
import { Shows } from "./pages/Shows";
import { Rundowns } from "./pages/Rundowns";
import { LiveStudio } from "./pages/LiveStudio";
import { Analytics } from "./pages/Analytics";
import { Recordings } from "./pages/Recordings";
import { Backups } from "./pages/Backups";
import { Settings } from "./pages/Settings";
import { PublicPlayer } from "./pages/PublicPlayer";
import { ListenAgain } from "./pages/ListenAgain";
import { AcceptInvite } from "./pages/AcceptInvite";
import { Widgets } from "./pages/Widgets";
import { Help } from "./pages/Help";
import { DjHelp } from "./pages/DjHelp";
import { APP_VERSION } from "@radiohost/shared";
import type { User } from "@radiohost/shared";

function SidebarBrand({ appName }: { appName: string }) {
  const [station, setStation] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api<{ stationName?: string }>("/public/settings")
      .then((r) => {
        if (alive && r.stationName) setStation(r.stationName);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return (
    <div className="brand">
      <div className="logo">📻</div>
      <div className="brand-text">
        <span className="brand-title">{appName}</span>
        {station ? <span className="brand-station" title={station}>{station}</span> : null}
      </div>
    </div>
  );
}


const NAV = [
  { to: "/", icon: "🏠", label: "Dashboard" },
  { to: "/library", icon: "🎵", label: "Media Library" },
  { to: "/playlists", icon: "📋", label: "Playlists" },
  { to: "/clockwheels", icon: "🕐", label: "Clockwheels" },
  { to: "/rotations", icon: "🔁", label: "Rotations" },
  { to: "/settings", icon: "⚙️", label: "Settings" },
  { to: "/shows", icon: "🎙️", label: "Shows" },
  { to: "/rundowns", icon: "🎚️", label: "Show Builder" },
  { to: "/schedule", icon: "📅", label: "Schedule" },
  { to: "/recordings", icon: "🎧", label: "Recordings" },
  { to: "/backups", icon: "💾", label: "Backups" },
  { to: "/studio", icon: "🔴", label: "Live Studio" },
  { to: "/player", icon: "🔊", label: "Public Player" },
  { to: "/widgets", icon: "🧩", label: "Widgets" },
  { to: "/analytics", icon: "📊", label: "Analytics" },
  { to: "/help", icon: "❓", label: "Help Guide" },
];

function Shell({ user, onAuthUserUpdated }: { user: User; onAuthUserUpdated: (user: User) => void }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  void open;

  return (
    <div className="layout">
      <aside className="sidebar">
        <SidebarBrand appName="RadioHost Studio" />
        <nav className="nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === "/"}>
              <span className="nav-icon">{n.icon}</span>
              <span>{n.label}</span>
            </NavLink>
          ))}
        </nav>
        <div style={{ flex: 1 }} />
        <div className="sidebar-version" title={`RadioHost Studio · Version ${APP_VERSION}`}>{APP_VERSION}</div>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            setToken(null);
            window.location.href = "/login";
          }}
        >
          Sign out
        </button>
      </aside>
      <div className="main">
        <OnAirBar userName={user.name} userAvatarPath={user.avatarPath} />
        <div className="content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/library" element={<Library />} />
            <Route path="/playlists" element={<Playlists />} />
            <Route path="/rotations" element={<Rotations />} />
            <Route path="/clockwheels" element={<Clockwheels />} />
            <Route path="/schedule" element={<Schedule />} />
            <Route path="/recordings" element={<Recordings />} />
            <Route path="/backups" element={<Backups />} />
            <Route path="/shows" element={<Shows />} />
            <Route path="/voice" element={<Navigate to="/rundowns" replace />} />
            <Route path="/rundowns" element={<Rundowns />} />
            <Route path="/studio" element={<LiveStudio />} />
            {/* /live belongs to the Icecast stream (Caddy proxies /live* to
                Icecast), so the studio lives at /studio. This redirect only
                catches client-side navigations from an old bookmark. */}
            <Route path="/live" element={<Navigate to="/studio" replace />} />
            <Route path="/campaigns" element={<Navigate to="/" replace />} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/requests" element={<Navigate to="/" replace />} />
            <Route path="/settings" element={<Settings onAuthUserUpdated={onAuthUserUpdated} />} />
            <Route path="/player" element={<PublicPlayer />} />
            <Route path="/widgets" element={<Widgets />} />
            <Route path="/help" element={<Help />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}

function DjShell({ user }: { user: User }) {
  const [isImpersonating, setIsImpersonating] = useState(() => Boolean(localStorage.getItem("rhs_admin_token")));
  const returnToAdmin = () => {
    const adminToken = localStorage.getItem("rhs_admin_token");
    if (!adminToken) return;
    localStorage.removeItem("rhs_admin_token");
    setIsImpersonating(false);
    setToken(adminToken);
    window.location.replace("/settings");
  };

  return (
    <div className="layout">
      <aside className="sidebar">
        <SidebarBrand appName="Live Studio" />
        <nav className="nav">
          <NavLink to="/studio"><span className="nav-icon">🔴</span><span>Go Live</span></NavLink>
          <NavLink to="/shows"><span className="nav-icon">🎙️</span><span>My Shows</span></NavLink>
          <NavLink to="/schedule"><span className="nav-icon">📅</span><span>Schedule</span></NavLink>
          <NavLink to="/rundowns"><span className="nav-icon">🎚️</span><span>Show Builder</span></NavLink>
          <NavLink to="/player"><span className="nav-icon">🔊</span><span>Public Player</span></NavLink>
          <NavLink to="/widgets"><span className="nav-icon">🧩</span><span>Widgets</span></NavLink>
          <NavLink to="/help"><span className="nav-icon">❓</span><span>Help Guide</span></NavLink>
        </nav>
        <div style={{ flex: 1 }} />
        {isImpersonating ? <button className="btn btn-primary btn-sm" style={{ marginBottom: 8 }} onClick={returnToAdmin}>← Return to admin</button> : null}
        <div className="sidebar-version" title={`RadioHost Studio · Version ${APP_VERSION}`}>{APP_VERSION}</div>
        <button className="btn btn-ghost btn-sm" onClick={() => { setToken(null); window.location.href = "/dj"; }}>
          Sign out
        </button>
      </aside>
      <div className="main">
        <OnAirBar userName={user.name} userAvatarPath={user.avatarPath} />
        <div className="content">
          <Routes>
            <Route path="/studio" element={<LiveStudio />} />
            {/* /live belongs to the Icecast stream (Caddy proxies /live* to
                Icecast), so the studio lives at /studio. This redirect only
                catches client-side navigations from an old bookmark. */}
            <Route path="/live" element={<Navigate to="/studio" replace />} />
            <Route path="/shows" element={<Shows />} />
            <Route path="/schedule" element={<Schedule />} />
            <Route path="/rundowns" element={<Rundowns />} />
            <Route path="/player" element={<PublicPlayer />} />
            <Route path="/widgets" element={<Widgets />} />
            <Route path="/help" element={<DjHelp />} />
            <Route path="*" element={<Navigate to="/studio" />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!getToken()) {
      setChecking(false);
      return;
    }
    api<{ user: User | null }>("/auth/me")
      .then((r) => setUser(r.user))
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/listen" element={<PublicPlayer />} />
        <Route path="/listen-again" element={<ListenAgain />} />
        {/* A shared episode opens on its own — see /e/<id> for the
            crawler-readable version that generates the preview card. */}
        <Route path="/listen-again/:id" element={<ListenAgain />} />
        <Route path="/accept-invite" element={<AcceptInvite />} />
        {checking ? (
          <Route path="*" element={<div className="login-wrap"><span className="spinner" /></div>} />
        ) : !user ? (
          <>
            <Route path="/register" element={<Register onDone={setUser} />} />
            <Route path="/dj" element={<DjLogin onDone={setUser} />} />
            <Route path="*" element={<Login onDone={setUser} />} />
          </>
        ) : user.role === "dj" ? (
          <Route path="/*" element={<DjShell user={user} />} />
        ) : (
          <Route path="/*" element={<Shell user={user} onAuthUserUpdated={setUser} />} />
        )}
      </Routes>
    </BrowserRouter>
  );
}
