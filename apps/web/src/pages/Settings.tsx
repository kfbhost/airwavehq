import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, setToken, upload } from "../api";
import { Badge, Button, Card, Field, Input, Modal, PageHead, Select, Spinner, UserAvatar, useFetch } from "../components/ui";
import type { ApiKey, Djslot, Invite, ProcessingPreset, Show, StationSettings, User, Webhook } from "@radiohost/shared";
import { EVENT_TYPES } from "@radiohost/shared";

/**
 * Real IANA timezones for the Station card dropdown. Uses the browser's own
 * timezone database when available (every option is guaranteed to work with
 * the scheduler), with a curated fallback list for older browsers.
 */
function timezoneGroups(): Array<{ label: string; zones: string[] }> {
  let zones: string[];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = [
      "UTC", "Etc/UTC",
      "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Madrid", "Europe/Rome", "Europe/Amsterdam", "Europe/Dublin", "Europe/Lisbon", "Europe/Athens", "Europe/Warsaw", "Europe/Helsinki", "Europe/Zurich", "Europe/Vienna", "Europe/Brussels", "Europe/Copenhagen", "Europe/Stockholm", "Europe/Oslo", "Europe/Prague", "Europe/Istanbul", "Europe/Moscow",
      "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Phoenix", "America/Anchorage", "America/Toronto", "America/Vancouver", "America/Mexico_City", "America/Sao_Paulo", "America/Buenos_Aires", "America/Bogota", "America/Lima", "America/Caracas", "America/Halifax", "America/St_Johns",
      "Africa/Cairo", "Africa/Johannesburg", "Africa/Lagos", "Africa/Nairobi", "Africa/Casablanca", "Africa/Accra",
      "Asia/Tokyo", "Asia/Shanghai", "Asia/Hong_Kong", "Asia/Singapore", "Asia/Seoul", "Asia/Kolkata", "Asia/Dubai", "Asia/Riyadh", "Asia/Bangkok", "Asia/Jakarta", "Asia/Manila", "Asia/Tehran", "Asia/Jerusalem", "Asia/Karachi", "Asia/Kuala_Lumpur",
      "Australia/Sydney", "Australia/Melbourne", "Australia/Perth", "Australia/Brisbane", "Australia/Adelaide", "Australia/Darwin", "Pacific/Auckland", "Pacific/Honolulu", "Pacific/Fiji",
    ];
  }
  const groups = new Map<string, string[]>();
  for (const zone of zones.slice().sort()) {
    const idx = zone.indexOf("/");
    const label = idx === -1 ? "Other" : zone.slice(0, idx);
    const list = groups.get(label) ?? [];
    list.push(zone);
    groups.set(label, list);
  }
  return [...groups.entries()].map(([label, groupZones]) => ({ label, zones: groupZones }));
}

const TZ_GROUPS = timezoneGroups();

/** Compact searchable timezone dropdown — avoids the huge native select popup. */
function TimezonePicker({ value, onChange }: { value: string; onChange: (tz: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const all = TZ_GROUPS.flatMap((g) => g.zones);
  const q = query.trim().toLowerCase();
  const matches = q ? all.filter((z) => z.toLowerCase().includes(q)) : all;

  // Keep the current value visible even if it's not in the standard list.
  const current = value && !all.includes(value) ? value : null;

  return (
    <div className="tz-picker" ref={ref}>
      <button
        type="button"
        className="tz-picker-btn"
        onClick={() => {
          setOpen((o) => !o);
          setQuery("");
        }}
      >
        <span className={value ? "tz-picker-value" : "tz-picker-value muted"}>{value || "Select timezone…"}</span>
        <span className="tz-picker-caret">▾</span>
      </button>
      {open ? (
        <div className="tz-picker-panel">
          <input
            autoFocus
            className="tz-picker-search"
            placeholder="Search timezone…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const first = matches[0];
                if (first) {
                  onChange(first);
                  setOpen(false);
                }
              }
              if (e.key === "Escape") setOpen(false);
            }}
          />
          <div className="tz-picker-list">
            {matches.length === 0 ? (
              <div className="tz-picker-empty">No timezones match</div>
            ) : (
              <>
                {current ? (
                  <div className="tz-picker-group">
                    <div className="tz-picker-group-label">Current</div>
                    <button type="button" className="tz-picker-item active" onClick={() => { onChange(current); setOpen(false); }}>{current}</button>
                  </div>
                ) : null}
                {q
                  ? matches.map((z) => (
                      <button key={z} type="button" className={`tz-picker-item ${z === value ? "active" : ""}`} onClick={() => { onChange(z); setOpen(false); }}>{z}</button>
                    ))
                  : TZ_GROUPS.map((g) => (
                      <div key={g.label} className="tz-picker-group">
                        <div className="tz-picker-group-label">{g.label}</div>
                        {g.zones.map((z) => (
                          <button key={z} type="button" className={`tz-picker-item ${z === value ? "active" : ""}`} onClick={() => { onChange(z); setOpen(false); }}>{z}</button>
                        ))}
                      </div>
                    ))}
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function Settings({ onAuthUserUpdated }: { onAuthUserUpdated?: (user: User) => void }) {
  const [tab, setTab] = useState("general");
  return (
    <>
      <PageHead title="Settings" sub="Your station, your integrations" />
      <div className="tabs">
        {[["general", "General"], ["account", "Admin account"], ["admins", "Admins & invites"], ["djs", "DJs"], ["keys", "API keys"], ["webhooks", "Webhooks"]].map(([k, v]) => (
          <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{v}</button>
        ))}
      </div>
      {tab === "general" ? <GeneralTab /> : null}
      {tab === "account" ? <AccountTab onAuthUserUpdated={onAuthUserUpdated} /> : null}
      {tab === "admins" ? <AdminsTab /> : null}
      {tab === "djs" ? <DjsTab /> : null}
      {tab === "keys" ? <KeysTab /> : null}
      {tab === "webhooks" ? <WebhooksTab /> : null}
    </>
  );
}

function GeneralTab() {
  const { data, loading, reload } = useFetch(() => api<{ settings: StationSettings }>("/settings"));
  const { data: playlists } = useFetch(() => api<{ playlists: Array<{ id: string; name: string }> }>("/playlists"));
  const { data: clockwheels } = useFetch(() => api<{ clockwheels: Array<{ id: string; name: string }> }>("/clockwheels"));
  const { data: music } = useFetch(() => api<{ total: number }>("/tracks?kind=music&pageSize=1"));
  const { data: stationIds } = useFetch(() => api<{ tracks: Array<{ id: string; title: string; artist: string }> }>("/tracks?kind=station_id&pageSize=100"));
  const { data: jingleTracks } = useFetch(() => api<{ tracks: Array<{ id: string; title: string; artist: string }> }>("/tracks?kind=jingle&pageSize=100"));
  const { data: folders } = useFetch(() => api<{ folders: Array<{ name: string; count: number }> }>("/folders"));
  const [form, setForm] = useState<StationSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [recoveryAction, setRecoveryAction] = useState<"reload" | "restart" | null>(null);
  const [recoveryMsg, setRecoveryMsg] = useState<string | null>(null);
  const [applyingStream, setApplyingStream] = useState(false);
  const [streamMsg, setStreamMsg] = useState<string | null>(null);

  useEffect(() => {
    if (data?.settings && !form) setForm(data.settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const s = form ?? data?.settings ?? null;
  if (!s) return <Card>{loading ? <Spinner /> : <div className="muted">No settings yet.</div>}</Card>;

  const save = async () => {
    await api("/settings", { method: "PUT", body: s });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    reload();
  };

  const runRecovery = async (action: "reload" | "restart") => {
    setRecoveryAction(action);
    setRecoveryMsg(null);
    try {
      const res = await api<{ message: string }>(
        action === "reload" ? "/settings/recovery/reload-automation" : "/settings/recovery/restart-engine",
        { method: "POST" },
      );
      setRecoveryMsg(res.message);
    } catch (err) {
      setRecoveryMsg(err instanceof Error ? err.message : "Recovery request failed.");
    } finally {
      setRecoveryAction(null);
    }
  };

  const applyStream = async () => {
    setApplyingStream(true);
    setStreamMsg(null);
    try {
      const res = await api<{ message: string }>("/settings/apply-stream", { method: "POST", body: s });
      setStreamMsg(res.message);
      reload();
    } catch (err) {
      setStreamMsg(err instanceof Error ? err.message : "Could not apply stream settings.");
    } finally {
      setApplyingStream(false);
    }
  };

  return (
    <div className="grid grid-2 settings-grid">
      <Card className="settings-top-card" title="Station">
        <Field label="Station name"><Input value={s.stationName} onChange={(e) => setForm({ ...s, stationName: e.target.value })} /></Field>
        <Field label="Tagline"><Input value={s.tagline} onChange={(e) => setForm({ ...s, tagline: e.target.value })} /></Field>
        <Field label="Timezone" hint="The whole schedule runs in this zone">
          <TimezonePicker value={s.timezone} onChange={(tz) => setForm({ ...s, timezone: tz })} />
        </Field>
      </Card>
      <Card
        className="settings-top-card"
        title="Stream"
        actions={
          <Button variant="primary" onClick={() => void applyStream()} disabled={applyingStream}>
            {applyingStream ? "Applying..." : "Save & apply stream"}
          </Button>
        }
      >
        <Field label="Public stream URL" hint="Shown in widgets and the player page">
          <Input value={s.streamUrl} onChange={(e) => setForm({ ...s, streamUrl: e.target.value })} placeholder="https://radio.example.com/live" />
        </Field>
        <div className="form-row">
          <Field label="Bitrate (kbps)"><Input type="number" min={32} max={320} value={s.streamBitrate} onChange={(e) => setForm({ ...s, streamBitrate: Number(e.target.value) })} /></Field>
          <Field label="Crossfade (ms)"><Input type="number" min={0} max={15000} value={s.crossfadeMs} onChange={(e) => setForm({ ...s, crossfadeMs: Number(e.target.value) })} /></Field>
        </div>
        <Field
          label="Broadcast processing"
          hint="Applied live to the whole output — no restart needed. Pick a preset and it takes effect on the stream within a few seconds."
        >
          <Select
            value={s.audioProcessingPreset}
            onChange={(e) => {
              const preset = e.target.value as ProcessingPreset;
              setForm({ ...s, audioProcessingPreset: preset });
              void api("/settings", { method: "PUT", body: { audioProcessingPreset: preset } })
                .then(() => setStreamMsg("Processing preset saved — the live stream will switch within a few seconds."))
                .catch(() => setStreamMsg("Could not save processing preset."));
            }}
          >
            <option value="off">Off — no processing</option>
            <option value="gentle">Gentle — subtle glue</option>
            <option value="radio">Radio — broadcast sound</option>
            <option value="punch">Punch — hot &amp; aggressive</option>
          </Select>
        </Field>
        <div className="row wrap" style={{ marginBottom: 12 }}>
          <label className="row"><input type="checkbox" checked={s.recordShows} onChange={(e) => setForm({ ...s, recordShows: e.target.checked })} /> Record shows → podcast feeds</label>
          <label className="row"><input type="checkbox" checked={s.publicPageEnabled} onChange={(e) => setForm({ ...s, publicPageEnabled: e.target.checked })} /> Public player page</label>
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          Use <strong>Save & apply stream</strong> after changing bitrate or crossfade. That saves the settings, refreshes the running crossfade, and requests an engine restart so bitrate changes really hit the live stream.
        </p>
        {streamMsg ? <p className="hint" style={{ marginTop: 10 }}><strong>{streamMsg}</strong></p> : null}
      </Card>
      <Card
        className="settings-span-2"
        title="Default programming (when no show is on air)"
        actions={<Button variant="primary" onClick={() => void save()}>{saved ? "✓ Saved" : "Save settings"}</Button>}
      >
        {(music?.total ?? 0) === 0 || !s.defaultPlaylistId ? (
          <p className="hint" style={{ marginTop: 0, marginBottom: 12, color: "var(--warning)" }}>
            New install tip: the station will not stay on air automatically until you upload some music and set a default
            playlist here. On a fresh install with no music or no default playlist, AutoDJ has nothing to play.
          </p>
        ) : null}
        <Field
          label="Top of hour jingle"
          hint="Plays at the top of every hour. The track before it fades out early, so the station always hits the hour exactly."
        >
          <Select value={s.topOfHourTrackId ?? ""} onChange={(e) => setForm({ ...s, topOfHourTrackId: e.target.value || null })}>
            <option value="">— none —</option>
            {stationIds?.tracks.map((t) => <option key={t.id} value={t.id}>{t.title}{t.artist ? ` — ${t.artist}` : ""} (station ID)</option>)}
            {jingleTracks?.tracks.map((t) => <option key={t.id} value={t.id}>{t.title}{t.artist ? ` — ${t.artist}` : ""} (jingle)</option>)}
          </Select>
        </Field>
        <Field label="Default clockwheel">
          <Select value={s.defaultClockwheelId ?? ""} onChange={(e) => setForm({ ...s, defaultClockwheelId: e.target.value || null })}>
            <option value="">— none —</option>
            {clockwheels?.clockwheels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Default playlist (AutoDJ)">
          <Select value={s.defaultPlaylistId ?? ""} onChange={(e) => setForm({ ...s, defaultPlaylistId: e.target.value || null })}>
            <option value="">— none —</option>
            {playlists?.playlists.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <div className="card" style={{ background: "var(--bg2)", borderRadius: 8, padding: "12px 14px", margin: "4px 0 10px" }}>
          <div className="small" style={{ fontWeight: 600, marginBottom: 8 }}>
            Automatic jingles <span className="muted">(radio jingle layer)</span>
          </div>
          <div className="form-row">
            <Field label="Every N tracks (0 = off)" hint="Plays a jingle between songs.">
              <Input type="number" min={0} max={50} value={s.autoJingleEvery} onChange={(e) => setForm({ ...s, autoJingleEvery: Math.max(0, Math.min(50, Number(e.target.value) || 0)) })} />
            </Field>
            <Field label="Jingle folder (optional)" hint="Leave on All jingles to use any.">
              <Select value={s.autoJingleFolder ?? ""} onChange={(e) => setForm({ ...s, autoJingleFolder: e.target.value || null })}>
                <option value="">All jingles</option>
                {folders?.folders.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
              </Select>
            </Field>
          </div>
          <p className="hint" style={{ margin: 0 }}>
            Jingles land <strong>tight and punchy</strong> (no gaps) at the end of a song in your playlists and
            pre-produced shows. Where a clockwheel or auto-generate already places its own jingles, this layer steps
            aside so nothing doubles. Live DJs still fire jingles from their carts.
          </p>
        </div>
        <p className="hint">Pick a playlist and hit the engine — AutoDJ runs 24/7 with artist separation and crossfades handled.</p>
        <p className="hint" style={{ marginTop: 10 }}>
          Recommended: keep a default playlist selected as a fallback, so the station still has music when no scheduled show is live and no rotation takes over.
        </p>
        {(music?.total ?? 0) === 0 ? (
          <p className="hint" style={{ marginTop: 10, color: "var(--warning)" }}>
            No music tracks are in the library yet. Upload music in Media Library first, then build a playlist and select it here.
          </p>
        ) : null}
        {!s.defaultPlaylistId ? (
          <p className="hint" style={{ marginTop: 10, color: "var(--warning)" }}>
            No default playlist is set right now. AutoDJ may run out of music if you remove playlists or leave gaps in your rotations.
          </p>
        ) : null}
        <p className="hint" style={{ marginTop: 10 }}>
          Need different playlists by hour or weekday? Use <Link to="/rotations">Rotations</Link> to steer default automation without changing your show schedule.
        </p>
      </Card>
      <Card className="settings-span-2" title="Show recordings" sub="How long automatic recordings of your scheduled shows are kept">
        <Field
          label="Keep recordings for"
          hint="Older recordings are deleted automatically, and any podcast episode built from one drops out of its RSS feed with it. Download anything you want to keep permanently from the media library."
        >
          <Select value={String(s.recordingRetentionDays ?? 60)} onChange={(e) => setForm({ ...s, recordingRetentionDays: Number(e.target.value) })}>
            <option value="7">1 week</option>
            <option value="14">2 weeks</option>
            <option value="30">1 month</option>
            <option value="45">6 weeks</option>
            <option value="60">2 months</option>
          </Select>
        </Field>
        <p className="hint">
          Two months is the maximum — a recorded series grows your storage on its own, and there is no keep-forever.
        </p>
      </Card>
      <Card className="settings-span-2" title="Geoblocking" sub="Restrict who can listen, by country">
        <Field
          label="Mode"
          hint="Block lets everyone in except the countries listed. Allow restricts listening to only the countries listed."
        >
          <Select value={s.geoMode ?? "off"} onChange={(e) => setForm({ ...s, geoMode: e.target.value as "off" | "block" | "allow" })}>
            <option value="off">Off — worldwide</option>
            <option value="block">Block listed countries</option>
            <option value="allow">Allow only listed countries</option>
          </Select>
        </Field>
        <Field label="Countries" hint="Comma-separated two-letter country codes (ISO 3166-1).">
          <Input value={s.geoCountries ?? ""} onChange={(e) => setForm({ ...s, geoCountries: e.target.value })} placeholder="e.g. US, GB, DE" />
        </Field>
      </Card>
      <Card className="settings-span-2" title="Recovery">
        <p className="hint">
          If automation gets stuck on a VPS, you can first reload the queue, then force the playout engine to restart itself.
          This works best when the engine is supervised, for example with Docker Compose `restart: unless-stopped`.
        </p>
        <div className="row wrap" style={{ gap: 8, marginTop: 12 }}>
          <Button
            onClick={() => void runRecovery("reload")}
            disabled={recoveryAction !== null}
          >
            {recoveryAction === "reload" ? "Reloading..." : "Reload automation now"}
          </Button>
          <Button
            variant="primary"
            onClick={() => void runRecovery("restart")}
            disabled={recoveryAction !== null}
          >
            {recoveryAction === "restart" ? "Restarting..." : "Restart playout engine"}
          </Button>
        </div>
        <p className="hint" style={{ marginTop: 10 }}>
          `Reload automation now` rebuilds the queue without dropping the service. `Restart playout engine` asks the engine process to exit so Docker or your process manager starts it again cleanly.
        </p>
        <p className="hint" style={{ marginTop: 10 }}>Stream and automation changes normally reach the engine within a few seconds.</p>
        {recoveryMsg ? <p className="hint" style={{ marginTop: 10 }}><strong>{recoveryMsg}</strong></p> : null}
      </Card>
    </div>
  );
}

function DjsTab() {
  const { data, loading, reload } = useFetch(() => api<{ users: User[] }>("/users"));
  const { data: slots, reload: reloadSlots } = useFetch(() => api<{ slots: Djslot[] }>("/dj-slots"));
  const { data: shows } = useFetch(() => api<{ shows: Show[] }>("/shows"));
  const [slotDj, setSlotDj] = useState("");
  const [slotShow, setSlotShow] = useState("");
  const [slotDay, setSlotDay] = useState("");
  const [slotStart, setSlotStart] = useState("09:00");
  const [slotEnd, setSlotEnd] = useState("10:00");
  const [newCode, setNewCode] = useState<{ user: User; code: string } | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [editSlot, setEditSlot] = useState<Djslot | null>(null);
  const [editDj, setEditDj] = useState("");
  const [editShow, setEditShow] = useState("");
  const [editDay, setEditDay] = useState("");
  const [editStart, setEditStart] = useState("09:00");
  const [editEnd, setEditEnd] = useState("10:00");

  const create = async () => {
    if (!email.trim() || !name.trim()) return;
    const res = await api<{ user: User; djCode: string }>("/users", { method: "POST", body: { email, name } });
    setNewCode({ user: res.user, code: res.djCode });
    setEmail("");
    setName("");
    reload();
  };

  const uploadAvatar = async (id: string, file: File | undefined) => {
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    try {
      await upload(`/users/${id}/avatar`, form);
      reload();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Could not upload photo");
    }
  };

  const removeAvatar = async (id: string) => {
    if (!confirm("Remove this profile picture?")) return;
    await api(`/users/${id}/avatar`, { method: "DELETE" });
    reload();
  };

  const toMin = (value: string) => { const [h, m] = value.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
  const addSlot = async () => {
    if (!slotDj || toMin(slotEnd) <= toMin(slotStart)) return;
    await api("/dj-slots", { method: "POST", body: { djId: slotDj, showId: slotShow || null, dayOfWeek: slotDay === "" ? null : Number(slotDay), startMinutes: toMin(slotStart), endMinutes: toMin(slotEnd) } });
    reloadSlots();
  };
  const openEdit = (slot: Djslot) => {
    setEditSlot(slot);
    setEditDj(slot.djId);
    setEditShow(slot.showId ?? "");
    setEditDay(slot.dayOfWeek === null ? "" : String(slot.dayOfWeek));
    setEditStart(formatSlotTime(slot.startMinutes));
    setEditEnd(formatSlotTime(slot.endMinutes));
  };
  const saveEdit = async () => {
    if (!editSlot || !editDj || toMin(editEnd) <= toMin(editStart)) return;
    await api(`/dj-slots/${editSlot.id}`, { method: "PATCH", body: { djId: editDj, showId: editShow || null, dayOfWeek: editDay === "" ? null : Number(editDay), startMinutes: toMin(editStart), endMinutes: toMin(editEnd) } });
    setEditSlot(null);
    reloadSlots();
  };

  return (
    <>
      <Card title="Allocate a DJ show slot">
        <div className="form-row">
          <Field label="DJ"><Select value={slotDj} onChange={(e) => setSlotDj(e.target.value)}><option value="">Choose DJ</option>{data?.users.filter((u) => u.role === "dj").map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>
          <Field label="Existing show (optional)"><Select value={slotShow} onChange={(e) => setSlotShow(e.target.value)}><option value="">DJ configures show</option>{shows?.shows.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          <Field label="Day"><Select value={slotDay} onChange={(e) => setSlotDay(e.target.value)}><option value="">Daily</option>{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => <option key={d} value={i}>{d}</option>)}</Select></Field>
        </div>
        <div className="form-row"><Field label="Start"><Input type="time" value={slotStart} onChange={(e) => setSlotStart(e.target.value)} /></Field><Field label="End"><Input type="time" value={slotEnd} onChange={(e) => setSlotEnd(e.target.value)} /></Field><div className="field"><label>&nbsp;</label><Button variant="primary" onClick={() => void addSlot()}>Allocate slot</Button></div></div>
        <p className="hint">DJs can configure the show and build a rundown, but only during the allocated times. Existing shows without an owner remain admin-managed.</p>
      </Card>
      <Card title="Allocated DJ slots">
        {slots?.slots.map((slot) => <div key={slot.id} className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}><span><strong>{slot.dj?.name}</strong> · {slot.show?.name ?? "Show to be configured"}</span><span className="small muted">{slot.dayOfWeek === null ? "Daily" : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][slot.dayOfWeek]} · {formatSlotTime(slot.startMinutes)}–{formatSlotTime(slot.endMinutes)}</span><Button className="btn-sm" onClick={() => openEdit(slot)} title="Edit allocated slot">Edit</Button><Button className="btn-sm btn-danger" onClick={() => void api(`/dj-slots/${slot.id}`, { method: "DELETE" }).then(reloadSlots)}>×</Button></div>)}
      </Card>
      <Card title="Invite a presenter">
        <div className="form-row">
          <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="dj@example.com" /></Field>
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="DJ name" /></Field>
          <div className="field"><label>&nbsp;</label><Button variant="primary" onClick={() => void create()}>Invite</Button></div>
        </div>
        <p className="hint">Presenters sign in with this email plus a 6-digit code. They see only Live Studio and their own shows — never your library or schedule.</p>
      </Card>
      {loading ? <Spinner /> : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
        {data?.users.filter((u) => u.role === "dj").map((u) => (
          <Card key={u.id} title={u.name}>
            <div className="row" style={{ gap: 12, alignItems: "center", marginBottom: 10 }}>
              <UserAvatar name={u.name} avatarPath={u.avatarPath} size={48} />
              <label className="btn btn-sm" style={{ cursor: "pointer", margin: 0 }}>
                {u.avatarPath ? "Change photo" : "Add photo"}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  style={{ display: "none" }}
                  onChange={(e) => { void uploadAvatar(u.id, e.target.files?.[0]); e.currentTarget.value = ""; }}
                />
              </label>
              {u.avatarPath ? (
                <Button className="btn-sm" onClick={() => void removeAvatar(u.id)}>Remove photo</Button>
              ) : null}
              <span className="small muted">Shown on their recordings &amp; Listen Again.</span>
            </div>
            <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
              <span className="muted">{u.email}</span>
              <div className="row">
                <Badge tone={u.isActive ? "green" : "default"}>{u.isActive ? "active" : "disabled"}</Badge>
                {u.djCode ? <span className="mono">{u.djCode}</span> : null}
                <Button className="btn-sm" onClick={() => {
                  const currentToken = localStorage.getItem("rhs_token");
                  if (!currentToken) return;
                  void api<{ token: string }>(`/auth/impersonate-dj/${u.id}`, { method: "POST" }).then((r) => {
                    localStorage.setItem("rhs_admin_token", currentToken);
                    setToken(r.token);
                    // Replace the document so the auth gate re-evaluates the DJ token
                    // instead of leaving the admin shell mounted during navigation.
                    // NOTE: never hard-load "/studio" or "/live" here — Caddy
                    // proxies /live* to Icecast (the audio mount) and a full page
                    // load bypasses the auth gate. Landing on "/" lets the DJ
                    // shell client-side redirect to /studio, never hitting Caddy.
                    window.location.replace("/");
                  });
                }}>Log in as DJ</Button>
                <Button className="btn-sm" onClick={() => {
                  void api<{ user: User; djCode: string }>(`/users/${u.id}`, { method: "PATCH", body: { regenerateCode: true } }).then((r) => {
                    setNewCode({ user: r.user, code: r.djCode! });
                    reload();
                  });
                }}>↻ New code</Button>
                <Button className="btn-sm" onClick={() => void api(`/users/${u.id}`, { method: "PATCH", body: { isActive: !u.isActive } }).then(reload)}>{u.isActive ? "Disable" : "Enable"}</Button>
                <Button className="btn-sm btn-danger" onClick={() => { if (confirm(`Remove ${u.name}?`)) void api(`/users/${u.id}`, { method: "DELETE" }).then(reload); }}>×</Button>
              </div>
            </div>
          </Card>
        ))}
      </div>
      {editSlot ? (
        <Modal open onClose={() => setEditSlot(null)} title="Edit allocated DJ slot" footer={<><Button onClick={() => setEditSlot(null)}>Cancel</Button><Button variant="primary" onClick={() => void saveEdit()}>Save changes</Button></>}>
          <div className="form-row">
            <Field label="DJ"><Select value={editDj} onChange={(e) => setEditDj(e.target.value)}>{data?.users.filter((u) => u.role === "dj").map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>
            <Field label="Existing show (optional)"><Select value={editShow} onChange={(e) => setEditShow(e.target.value)}><option value="">DJ configures show</option>{shows?.shows.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          </div>
          <div className="form-row">
            <Field label="Day"><Select value={editDay} onChange={(e) => setEditDay(e.target.value)}><option value="">Daily</option>{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => <option key={d} value={i}>{d}</option>)}</Select></Field>
            <Field label="Start"><Input type="time" value={editStart} onChange={(e) => setEditStart(e.target.value)} /></Field>
            <Field label="End"><Input type="time" value={editEnd} onChange={(e) => setEditEnd(e.target.value)} /></Field>
          </div>
        </Modal>
      ) : null}
      {newCode ? (
        <Modal open onClose={() => setNewCode(null)} title={`Sign-in code for ${newCode.user.name}`} footer={<Button variant="primary" onClick={() => setNewCode(null)}>Done</Button>}>
          <div style={{ textAlign: "center", padding: 20 }}>
            <div style={{ fontSize: 40, letterSpacing: 8, fontWeight: 700, fontFamily: "monospace" }}>{newCode.code}</div>
            <p className="hint">Send this to {newCode.user.email}. They sign in at <strong>/dj</strong> with their email + code.</p>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function formatSlotTime(value: number): string { return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`; }

function AdminsTab() {
  const { data: me } = useFetch(() => api<{ user: User }>("/auth/me"));
  const { data, loading, reload } = useFetch(() => api<{ users: User[] }>("/users"));
  const { data: inv, reload: reloadInv } = useFetch(() => api<{ invites: Invite[] }>("/invites"));
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "dj">("admin");
  const [link, setLink] = useState<{ title: string; value: string; note?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const copy = (text: string) => { void navigator.clipboard?.writeText(text).catch(() => {}); };

  const invite = async () => {
    if (!email.trim()) return;
    setBusy(true);
    try {
      const res = await api<{ invite: Invite; acceptUrl: string; emailed?: boolean; mailError?: string }>("/invites", { method: "POST", body: { email: email.trim(), role } });
      setLink({ title: `Invite link for ${res.invite.email}`, value: res.acceptUrl, note: res.emailed ? `Emailed to ${res.invite.email}. You can also copy the link below — it expires in 7 days.` : `Copy this link and send it to them (email, chat, anything). It expires in 7 days.` });
      setEmail("");
      reloadInv();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Could not create the invite.");
    } finally {
      setBusy(false);
    }
  };

  const getLink = async (id: string) => {
    try {
      const res = await api<{ invite: Invite; acceptUrl: string; emailed?: boolean; mailError?: string }>(`/invites/${id}/resend`, { method: "POST" });
      setLink({ title: `Invite link for ${res.invite.email}`, value: res.acceptUrl, note: res.emailed ? `Re-sent to ${res.invite.email}. Fresh link below (the old one is now invalid).` : `Copy this fresh link and send it to them (the old one is now invalid).` });
      reloadInv();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Could not get the link.");
    }
  };

  const revoke = (id: string) => { if (confirm("Revoke this invite?")) void api(`/invites/${id}`, { method: "DELETE" }).then(reloadInv); };

  const patch = (id: string, body: Record<string, unknown>) => {
    void api<{ tempPassword?: string }>(`/users/${id}`, { method: "PATCH", body })
      .then((r) => {
        if (r.tempPassword) setLink({ title: "Temporary password set", value: r.tempPassword, note: "Share this so they can sign in, then change it under the Admin account tab." });
        reload();
      })
      .catch((e) => alert(e instanceof Error ? e.message : "Update failed."));
  };

  const remove = (u: User) => {
    if (!confirm(`Remove ${u.name} (${u.email})?`)) return;
    void api(`/users/${u.id}`, { method: "DELETE" }).then(reload).catch((e) => alert(e instanceof Error ? e.message : "Could not remove."));
  };

  const admins = (data?.users ?? []).filter((u) => u.role === "admin");
  const djs = (data?.users ?? []).filter((u) => u.role === "dj");
  const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  return (
    <>
      <Card title="Invite a teammate" sub="Send an email invite, or copy the link and share it yourself">
        <div className="form-row">
          <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="person@example.com" /></Field>
          <Field label="Role"><Select value={role} onChange={(e) => setRole(e.target.value as "admin" | "dj")}><option value="admin">Administrator</option><option value="dj">DJ</option></Select></Field>
          <div className="field"><label>&nbsp;</label><Button variant="primary" disabled={busy || !email.trim()} onClick={() => void invite()}>{busy ? "Creating…" : "Create invite"}</Button></div>
        </div>
        <p className="hint">You'll get a one-time link to copy and send them. They open it, set their own name and password, and are signed straight in. Links expire after 7 days.</p>
      </Card>

      <Card title="Pending invites">
        {loading ? <Spinner /> : null}
        {inv && inv.invites.length === 0 ? <p className="hint">No outstanding invites.</p> : null}
        {inv?.invites.map((i) => (
          <div key={i.id} className="row" style={{ justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
            <span><strong>{i.email}</strong> <Badge tone={i.role === "admin" ? "blue" : "default"}>{i.role}</Badge> <span className="small muted">· expires {fmt(i.expiresAt)}</span></span>
            <div className="row">
              <Button className="btn-sm" onClick={() => void getLink(i.id)}>Get link</Button>
              <Button className="btn-sm btn-danger" onClick={() => revoke(i.id)}>Revoke</Button>
            </div>
          </div>
        ))}
      </Card>

      <Card title="Administrators" sub="Everyone here has full access to the station manager">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {admins.map((u) => (
            <div key={u.id} className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <span className="row" style={{ gap: 8 }}>
                <strong>{u.name}</strong>
                {me?.user.id === u.id ? <Badge tone="green">you</Badge> : null}
                <span className="muted small">{u.email}</span>
                <Badge tone={u.isActive ? "green" : "default"}>{u.isActive ? "active" : "disabled"}</Badge>
              </span>
              <div className="row" style={{ gap: 6 }}>
                <Button className="btn-sm" onClick={() => patch(u.id, { isActive: !u.isActive })}>{u.isActive ? "Disable" : "Enable"}</Button>
                <Button className="btn-sm" onClick={() => patch(u.id, { role: "dj" })}>Make DJ</Button>
                <Button className="btn-sm btn-danger" onClick={() => remove(u)}>×</Button>
              </div>
            </div>
          ))}
        </div>
        <p className="hint" style={{ marginTop: 10 }}>You can't remove or disable the last active admin — that keeps you from locking yourself out.</p>
      </Card>

      {djs.length > 0 ? (
        <Card title="Promote a DJ to admin">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {djs.map((u) => (
              <div key={u.id} className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <span><strong>{u.name}</strong> <span className="muted small">{u.email}</span></span>
                <Button className="btn-sm" onClick={() => patch(u.id, { role: "admin" })}>Make admin</Button>
              </div>
            ))}
          </div>
          <p className="hint" style={{ marginTop: 8 }}>Promoting gives a DJ a temporary password to sign in to the full manager.</p>
        </Card>
      ) : null}

      {link ? (
        <Modal open onClose={() => setLink(null)} title={link.title} footer={<><Button variant="ghost" onClick={() => copy(link.value)}>Copy</Button><Button variant="primary" onClick={() => setLink(null)}>Done</Button></>}>
          <p className="hint" style={{ marginTop: 0 }}>{link.note}</p>
          <Input readOnly value={link.value} onFocus={(e) => e.currentTarget.select()} style={{ width: "100%", fontFamily: "monospace" }} />
        </Modal>
      ) : null}
    </>
  );
}

function KeysTab() {
  const { data, loading, reload } = useFetch(() => api<{ keys: ApiKey[] }>("/api-keys"));
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);

  const create = async () => {
    const res = await api<{ token: string }>("/api-keys", { method: "POST", body: { name: name || "API key", scopes: ["read"] } });
    setCreated(res.token);
    setName("");
    reload();
  };

  return (
    <>
      {created ? (
        <Card title="Copy your key now — it won't be shown again">
          <div className="mono" style={{ background: "var(--bg2)", padding: 10, borderRadius: 8, wordBreak: "break-all" }}>{created}</div>
          <Button className="btn-sm" style={{ marginTop: 8 }} onClick={() => void navigator.clipboard.writeText(created)}>Copy</Button>
          <Button className="btn-sm btn-ghost" style={{ marginTop: 8 }} onClick={() => setCreated(null)}>Dismiss</Button>
        </Card>
      ) : null}
      <Card title="API keys">
        <div className="form-row">
          <Field label="Key name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My website integration" /></Field>
          <div className="field"><label>&nbsp;</label><Button variant="primary" onClick={() => void create()}>Generate key</Button></div>
        </div>
        <p className="hint">Use keys as <span className="mono">Authorization: Bearer rhk_…</span> for the now-playing, schedule and stats endpoints.</p>
      </Card>
      {loading ? <Spinner /> : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
        {data?.keys.map((k) => (
          <div key={k.id} className="card" style={{ padding: 12 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span><strong>{k.name}</strong> <span className="muted small">· {k.scopes.join(", ")}</span></span>
              <div className="row">
                <span className="small muted">{k.lastUsedAt ? `used ${new Date(k.lastUsedAt).toLocaleString()}` : "never used"}</span>
                <Button className="btn-sm btn-danger" onClick={() => void api(`/api-keys/${k.id}`, { method: "DELETE" }).then(reload)}>Revoke</Button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function WebhooksTab() {
  const { data, loading, reload } = useFetch(() => api<{ webhooks: Webhook[] }>("/webhooks"));
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["track.start", "live.on"]);

  const toggleEvent = (e: string) => {
    setEvents((xs) => (xs.includes(e) ? xs.filter((x) => x !== e) : [...xs, e]));
  };

  const create = async () => {
    if (!url.trim()) return;
    await api("/webhooks", { method: "POST", body: { url: url.trim(), events } });
    setUrl("");
    reload();
  };

  return (
    <>
      <Card title="New webhook">
        <Field label="Endpoint URL"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/radio" /></Field>
        <Field label="Events">
          <div className="row wrap">
            {EVENT_TYPES.map((e) => (
              <label key={e} className="badge" style={{ cursor: "pointer" }}>
                <input type="checkbox" checked={events.includes(e)} onChange={() => toggleEvent(e)} />
                {e}
              </label>
            ))}
          </div>
        </Field>
        <Button variant="primary" onClick={() => void create()}>Create webhook</Button>
        <p className="hint">Deliveries are signed with <span className="mono">X-RadioHost-Signature: sha256=…</span> (HMAC of the body with your secret) and retried with backoff.</p>
      </Card>
      {loading ? <Spinner /> : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
        {data?.webhooks.map((w) => (
          <div key={w.id} className="card" style={{ padding: 12 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="mono">{w.url}</span>
              <div className="row">
                <Badge tone={w.isActive ? "green" : "default"}>{w.isActive ? "active" : "paused"}</Badge>
                <Button className="btn-sm" onClick={() => void api(`/webhooks/${w.id}/test`, { method: "POST" })}>Test</Button>
                <Button className="btn-sm" onClick={() => void api(`/webhooks/${w.id}`, { method: "PATCH", body: { isActive: !w.isActive } }).then(reload)}>{w.isActive ? "Pause" : "Enable"}</Button>
                <Button className="btn-sm btn-danger" onClick={() => { if (confirm("Delete webhook?")) void api(`/webhooks/${w.id}`, { method: "DELETE" }).then(reload); }}>×</Button>
              </div>
            </div>
            <div className="row wrap" style={{ marginTop: 6 }}>
              {w.events.map((e) => <span key={e} className="badge">{e}</span>)}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function AccountTab({ onAuthUserUpdated }: { onAuthUserUpdated?: (user: User) => void }) {
  const { data, loading } = useFetch(() => api<{ user: User | null }>("/auth/me"));
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [confirmNext, setConfirmNext] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!data?.user) return;
    setName((prev) => prev || data.user!.name);
    setEmail((prev) => prev || data.user!.email);
  }, [data]);

  const change = async () => {
    if (next && next !== confirmNext) {
      setMsg("New password and confirmation do not match.");
      return;
    }
    setSaving(true);
    try {
      const res = await api<{ token: string; user: User }>("/auth/admin-account", {
        method: "POST",
        body: { name, email, currentPassword: cur, newPassword: next },
      });
      setToken(res.token);
      onAuthUserUpdated?.(res.user);
      setMsg("Admin account updated.");
      setCur("");
      setNext("");
      setConfirmNext("");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  };

  if (loading && !data?.user) return <Card><Spinner /></Card>;

  return (
    <Card title="Admin account" sub="Replace the original test admin details with your real station owner login" style={{ maxWidth: 560 }}>
      <Field label="Display name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Station Owner" /></Field>
      <Field label="Sign-in email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@station.com" /></Field>
      <Field label="Current password" hint="Required before we change the admin account">
        <Input type="password" value={cur} onChange={(e) => setCur(e.target.value)} />
      </Field>
      <Field label="New password" hint="Leave blank to keep the current password">
        <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label="Confirm new password">
        <Input type="password" value={confirmNext} onChange={(e) => setConfirmNext(e.target.value)} />
      </Field>
      {msg ? <div className={`badge ${msg.includes("updated") ? "green" : "red"}`} style={{ marginBottom: 10 }}>{msg}</div> : null}
      <Button variant="primary" onClick={() => void change()} disabled={saving || !name.trim() || !email.trim() || !cur}>
        {saving ? "Saving..." : "Update admin account"}
      </Button>
    </Card>
  );
}
