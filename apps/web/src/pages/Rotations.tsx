import { useMemo, useState } from "react";
import { api } from "../api";
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHead, Select, Spinner, Stat, useFetch } from "../components/ui";
import type { Playlist, StationRotation, StationSettings } from "@airwavehq/shared";

const DOWS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const END_HOURS = Array.from({ length: 24 }, (_, i) => i + 1);

export function Rotations() {
  const { data, loading, error, reload } = useFetch(() => api<{ rotations: StationRotation[] }>("/rotations"));
  const { data: playlistsData, loading: playlistsLoading } = useFetch(() => api<{ playlists: Playlist[] }>("/playlists"));
  const { data: settingsData } = useFetch(() => api<{ settings: StationSettings }>("/settings"));
  const [editing, setEditing] = useState<StationRotation | null | "new">(null);
  const [notice, setNotice] = useState<string | null>(null);

  const playlists = playlistsData?.playlists ?? [];
  const playlistMap = useMemo(() => new Map(playlists.map((playlist) => [playlist.id, playlist.name])), [playlists]);
  const rotations = data?.rotations ?? [];
  const activeCount = rotations.filter((rotation) => rotation.isActive).length;

  return (
    <>
      <PageHead
        title="Rotations"
        sub="Swap AutoDJ playlists by day and hour while keeping the existing clockwheel flow"
        actions={<Button variant="primary" onClick={() => setEditing("new")}>+ New rule</Button>}
      />

      {notice ? <Card><p className="hint" style={{ margin: 0 }}><strong>{notice}</strong></p></Card> : null}
      {error ? <Card><p className="hint" style={{ margin: 0, color: "var(--danger)" }}><strong>{error}</strong></p></Card> : null}
      {(loading || playlistsLoading) ? <Spinner /> : null}

      <Card title="How it works" style={{ marginBottom: 16 }}>
        <p className="hint" style={{ lineHeight: 1.7, margin: 0 }}>
          Rotations choose which playlist feeds default automation when no show is live. Day-specific rules beat
          all-days rules, and higher priority wins when overlapping rules cover the same hour.
        </p>
      </Card>

      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <Stat label="Timezone" value={settingsData?.settings.timezone ?? "UTC"} sub="Rules follow your station timezone" />
        <Stat label="Rules" value={rotations.length} sub="Total rotation rules created" />
        <Stat label="Active" value={activeCount} sub="Hours are start-inclusive and end-exclusive" />
      </div>

      {!loading && !playlistsLoading && playlists.length === 0 ? (
        <Card title="Rotations need playlists first">
          <Empty>Create at least one playlist first. Rotation rules only point AutoDJ at existing playlists.</Empty>
        </Card>
      ) : null}

      {!loading && !playlistsLoading && rotations.length === 0 ? (
        <Card title="No rotation rules yet">
          <Empty>No rotation rules yet. Add one to change the default playlist by hour or weekday.</Empty>
        </Card>
      ) : null}

      {rotations.length > 0 ? (
        <Card title="Hourly rules" sub="Rules are evaluated in station time.">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Playlist</th>
                  <th>When</th>
                  <th>Priority</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rotations.map((rotation) => (
                  <tr key={rotation.id}>
                    <td>
                      <strong>{rotation.name}</strong>
                      {rotation.shufflePlaylist ? (
                        <span className="muted small" style={{ display: "block", marginTop: 2 }}>
                          <Badge tone="blue">shuffle on</Badge>
                        </span>
                      ) : null}
                    </td>
                    <td>
                      {rotation.playlistId ? playlistMap.get(rotation.playlistId) ?? "Missing playlist" : "No playlist"}
                      {rotation.dayOfWeek == null && rotation.mondayPlaylistId ? (
                        <span className="muted small" style={{ display: "block", marginTop: 2 }}>per-day playlists set</span>
                      ) : null}
                    </td>
                    <td>{formatRotationWindow(rotation)}</td>
                    <td className="mono">{rotation.priority}</td>
                    <td>
                      <Badge tone={rotation.isActive ? "green" : "default"}>
                        {rotation.isActive ? "active" : "paused"}
                      </Badge>
                    </td>
                    <td>
                      <div className="row" style={{ justifyContent: "flex-end" }}>
                        <Button className="btn-sm" onClick={() => setEditing(rotation)}>Edit</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {editing ? (
        <RotationEditor
          playlists={playlists}
          rotation={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            setNotice(message);
            reload();
          }}
        />
      ) : null}
    </>
  );
}

function RotationEditor({
  playlists,
  rotation,
  onClose,
  onSaved,
}: {
  playlists: Playlist[];
  rotation: StationRotation | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const isNew = rotation == null;
  const [name, setName] = useState(rotation?.name ?? "");
  const [dayOfWeek, setDayOfWeek] = useState(rotation?.dayOfWeek == null ? "" : String(rotation.dayOfWeek));
  const [startHour, setStartHour] = useState(rotation?.startHour ?? 9);
  const [endHour, setEndHour] = useState(rotation?.endHour ?? 12);
  const [playlistId, setPlaylistId] = useState(rotation?.playlistId ?? playlists[0]?.id ?? "");
  const [dayPlaylists, setDayPlaylists] = useState<string[]>([
    rotation?.sundayPlaylistId ?? "",
    rotation?.mondayPlaylistId ?? "",
    rotation?.tuesdayPlaylistId ?? "",
    rotation?.wednesdayPlaylistId ?? "",
    rotation?.thursdayPlaylistId ?? "",
    rotation?.fridayPlaylistId ?? "",
    rotation?.saturdayPlaylistId ?? "",
  ]);
  const [autoGen, setAutoGen] = useState(rotation?.autoGenerate ?? false);
  const [shuffle, setShuffle] = useState(rotation?.shufflePlaylist ?? false);
  const [musicFolders, setMusicFolders] = useState<string[]>(rotation?.musicFolders ?? []);
  const [includeJingles, setIncludeJingles] = useState(rotation?.includeJingles ?? true);
  const [jingleEvery, setJingleEvery] = useState(rotation?.jingleEvery ?? 3);
  const [jingleFolder, setJingleFolder] = useState(rotation?.jingleFolder ?? "");
  const { data: foldersData } = useFetch(() => api<{ folders: Array<{ name: string; count: number }> }>("/folders"));
  const folders = foldersData?.folders ?? [];
  const [priority, setPriority] = useState(rotation?.priority ?? 0);
  const [isActive, setIsActive] = useState(rotation?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    if (!playlistId) {
      setError("Pick a playlist.");
      return;
    }
    if (endHour <= startHour) {
      setError("End hour must be after start hour.");
      return;
    }
    const useAutoGen = autoGen && dayOfWeek === "";

    setBusy(true);
    setError(null);
    try {
      const [sun, mon, tue, wed, thu, fri, sat] = dayPlaylists;
      const body = {
        name: name.trim(),
        dayOfWeek: dayOfWeek === "" ? null : Number(dayOfWeek),
        startHour,
        endHour,
        playlistId,
        sundayPlaylistId: dayOfWeek === "" ? (sun || null) : null,
        mondayPlaylistId: dayOfWeek === "" ? (mon || null) : null,
        tuesdayPlaylistId: dayOfWeek === "" ? (tue || null) : null,
        wednesdayPlaylistId: dayOfWeek === "" ? (wed || null) : null,
        thursdayPlaylistId: dayOfWeek === "" ? (thu || null) : null,
        fridayPlaylistId: dayOfWeek === "" ? (fri || null) : null,
        saturdayPlaylistId: dayOfWeek === "" ? (sat || null) : null,
        autoGenerate: useAutoGen,
        shufflePlaylist: !useAutoGen && shuffle,
        musicFolders: useAutoGen ? musicFolders : [],
        includeJingles: useAutoGen ? includeJingles : true,
        jingleEvery: useAutoGen ? jingleEvery : 3,
        jingleFolder: useAutoGen ? (jingleFolder || null) : null,
        priority,
        isActive,
      };

      if (isNew) {
        await api("/rotations", { method: "POST", body });
        onSaved(`Created rotation "${body.name}".`);
      } else {
        await api(`/rotations/${rotation.id}`, { method: "PATCH", body });
        onSaved(`Updated rotation "${body.name}".`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save rotation.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!rotation) return;
    if (!confirm(`Delete rotation "${rotation.name}"?`)) return;

    setBusy(true);
    setError(null);
    try {
      await api(`/rotations/${rotation.id}`, { method: "DELETE" });
      onSaved(`Deleted rotation "${rotation.name}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete rotation.");
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={isNew ? "New rotation rule" : "Edit rotation rule"}
      footer={
        <>
          {!isNew ? <Button variant="danger" disabled={busy} onClick={() => void remove()}>Delete</Button> : null}
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || playlists.length === 0} onClick={() => void save()}>
            {busy ? "Saving..." : "Save"}
          </Button>
        </>
      }
    >
      <Field label="Rule name">
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Weekday breakfast" />
      </Field>
      <Field label="Playlist">
        <Select value={playlistId} onChange={(e) => setPlaylistId(e.target.value)}>
          <option value="">Select playlist</option>
          {playlists.map((playlist) => <option key={playlist.id} value={playlist.id}>{playlist.name}</option>)}
        </Select>
      </Field>
      <Field label="Day" hint="Leave on Every day for a station-wide catch-all rule.">
        <Select value={dayOfWeek} onChange={(e) => setDayOfWeek(e.target.value)}>
          <option value="">Every day</option>
          {DOWS.map((day, index) => <option key={day} value={index}>{day}</option>)}
        </Select>
      </Field>
      <div className="form-row">
        <Field label="Start hour">
          <Select value={startHour} onChange={(e) => setStartHour(Number(e.target.value))}>
            {HOURS.map((hour) => <option key={hour} value={hour}>{formatHour(hour)}</option>)}
          </Select>
        </Field>
        <Field label="End hour">
          <Select value={endHour} onChange={(e) => setEndHour(Number(e.target.value))}>
            {END_HOURS.map((hour) => <option key={hour} value={hour}>{formatHour(hour % 24 === 0 ? 24 : hour)}</option>)}
          </Select>
        </Field>
        <Field label="Priority" hint="Higher priority wins inside overlapping windows.">
          <Input
            type="number"
            min={0}
            max={100}
            value={priority}
            onChange={(e) => setPriority(clampPriority(e.target.value))}
          />
        </Field>
      </div>
      <label className="row" style={{ gap: 8, marginTop: 6 }}>
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        <span>Rule is active</span>
      </label>
      {dayOfWeek === "" ? (
        <div style={{ background: "var(--bg2)", borderRadius: 8, padding: "10px 12px", margin: "10px 0 4px" }}>
          <div className="small" style={{ fontWeight: 600, marginBottom: 8 }}>
            Playlist per day <span className="muted">(leave a day blank to use the playlist above)</span>
          </div>
          {[1, 2, 3, 4, 5, 6, 0].map((dow) => (
            <div key={dow} className="row" style={{ gap: 8, alignItems: "center", marginBottom: 6 }}>
              <span style={{ width: 52, flexShrink: 0 }} className="small"><strong>{DOWS[dow]}</strong></span>
              <Select
                value={dayPlaylists[dow] ?? ""}
                onChange={(e) => {
                  const next = [...dayPlaylists];
                  next[dow] = e.target.value;
                  setDayPlaylists(next);
                }}
              >
                <option value="">— same as playlist above —</option>
                {playlists.map((playlist) => <option key={playlist.id} value={playlist.id}>{playlist.name}</option>)}
              </Select>
            </div>
          ))}
        </div>
      ) : null}
      {dayOfWeek === "" ? (
        <div style={{ background: "var(--bg2)", borderRadius: 8, padding: "10px 12px", margin: "10px 0 4px" }}>
          <label className="row" style={{ gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={autoGen} onChange={(e) => setAutoGen(e.target.checked)} />
            <span><strong>Auto-generate a fresh list each day</strong></span>
          </label>
          {!autoGen ? null : (
            <div className="small" style={{ marginTop: 10 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>
                Music folders <span className="muted">(leave all unticked to use every folder)</span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                {folders.length === 0 ? (
                  <span className="muted">No folders yet.</span>
                ) : (
                  folders.map((folder) => (
                    <button
                      key={folder.name}
                      type="button"
                      style={{
                        background: musicFolders.includes(folder.name) ? "var(--accent)" : "var(--bg)",
                        color: "var(--text)",
                        border: "1px solid var(--border)",
                        borderRadius: 999,
                        padding: "4px 10px",
                        cursor: "pointer",
                      }}
                      onClick={() =>
                        setMusicFolders((cur) =>
                          cur.includes(folder.name) ? cur.filter((f) => f !== folder.name) : [...cur, folder.name],
                        )
                      }
                    >
                      {folder.name} <span className="muted">({folder.count})</span>
                    </button>
                  ))
                )}
              </div>
              <label className="row" style={{ gap: 8, marginBottom: 8 }}>
                <input type="checkbox" checked={includeJingles} onChange={(e) => setIncludeJingles(e.target.checked)} />
                <span>Include a jingle every few tracks</span>
              </label>
              <div className="form-row">
                <Field label="Jingle every">
                  <Input
                    type="number"
                    min={1}
                    max={20}
                    value={jingleEvery}
                    onChange={(e) => setJingleEvery(Math.max(1, Math.min(20, Number(e.target.value) || 3)))}
                  />
                </Field>
                <Field label="Jingle folder" hint="Leave blank for all jingles">
                  <Select value={jingleFolder} onChange={(e) => setJingleFolder(e.target.value)}>
                    <option value="">All jingle folders</option>
                    {folders.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
                  </Select>
                </Field>
              </div>
              <p className="hint" style={{ marginTop: 4 }}>
                Each local day a brand-new, shuffled list is built from these folders, so every day airs different tracks without setting up separate playlists.
              </p>
            </div>
          )}
        </div>
      ) : null}
      {!autoGen ? (
        <label className="row" style={{ gap: 8, alignItems: "center", marginTop: 4 }}>
          <input type="checkbox" checked={shuffle} onChange={(e) => setShuffle(e.target.checked)} />
          <span><strong>Shuffle music each time this rule airs</strong></span>
        </label>
      ) : null}
      {shuffle && !autoGen ? (
        <p className="hint" style={{ marginTop: 4 }}>
          The chosen playlist&rsquo;s music plays in a fresh order each time this block airs. Jingles, sweepers and
          station IDs stay exactly where you placed them.
        </p>
      ) : null}
      <p className="hint" style={{ marginTop: 12 }}>
        This rule will run <strong>{describeDay(dayOfWeek)}</strong> from <strong>{formatHour(startHour)}</strong> to <strong>{formatHour(endHour)}</strong>.
      </p>
      {playlists.length === 0 ? <p className="hint" style={{ color: "var(--danger)" }}>No playlists available for rotation rules yet.</p> : null}
      {error ? <p className="hint" style={{ color: "var(--danger)" }}>{error}</p> : null}
    </Modal>
  );
}

function formatRotationWindow(rotation: StationRotation): string {
  return `${rotation.dayOfWeek == null ? "Every day" : DOWS[rotation.dayOfWeek] ?? "Unknown"} · ${formatHour(rotation.startHour)}-${formatHour(rotation.endHour)}`;
}

function describeDay(dayOfWeek: string): string {
  if (dayOfWeek === "") return "every day";
  return DOWS[Number(dayOfWeek)]?.toLowerCase() ?? "the selected day";
}

function formatHour(hour: number): string {
  const normalized = hour === 24 ? 24 : Math.max(0, Math.min(23, hour));
  return `${String(normalized).padStart(2, "0")}:00`;
}

function clampPriority(value: string): number {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, Math.min(100, parsed));
}
