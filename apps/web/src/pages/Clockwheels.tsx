import { useEffect, useState } from "react";
import { api } from "../api";
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHead, Select, Spinner, useFetch } from "../components/ui";
import type { ClockSlot, Clockwheel, Playlist, Track } from "@radiohost/shared";

export function Clockwheels() {
  const { data, loading, reload } = useFetch(() => api<{ clockwheels: Clockwheel[] }>("/clockwheels"));
  const [open, setOpen] = useState<Clockwheel | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const create = async () => {
    const name = prompt("Clockwheel name");
    if (!name?.trim()) return;
    await api("/clockwheels", { method: "POST", body: { name: name.trim() } });
    reload();
  };

  return (
    <>
      <PageHead
        title="Clockwheels"
        sub="Design each hour like a program director — IDs, hot rotations, jingles, sweepers and anchored slots"
        actions={<Button variant="primary" onClick={() => void create()}>+ New clockwheel</Button>}
      />
      {notice ? <Card><p className="hint" style={{ margin: 0 }}><strong>{notice}</strong></p></Card> : null}
      {loading ? <Spinner /> : null}
      {!loading && data && data.clockwheels.length === 0 ? <Card><Empty>No clockwheels. Create one and add slots, then assign it to a show or as the station default.</Empty></Card> : null}
      <div className="grid grid-3">
        {data?.clockwheels.map((c) => (
          <Card key={c.id} title={c.name} actions={<Button className="btn-sm" onClick={() => setOpen(c)}>Edit</Button>} />
        ))}
      </div>
      {open ? (
        <ClockwheelEditor
          clockwheel={open}
          onClose={() => setOpen(null)}
          onChanged={reload}
          onDeleted={(clockwheel) => {
            setOpen(null);
            setNotice(`Deleted clockwheel "${clockwheel.name}".`);
            reload();
          }}
        />
      ) : null}
    </>
  );
}

const SLOT_TYPES: Array<{ value: string; label: string }> = [
  { value: "music", label: "Music rotation" },
  { value: "jingle", label: "Jingle" },
  { value: "sweeper", label: "Sweeper" },
  { value: "station_id", label: "Station ID" },
  { value: "anchored", label: "Anchored track" },
  { value: "ad_break", label: "Ad break" },
];

function ClockwheelEditor({
  clockwheel,
  onClose,
  onChanged,
  onDeleted,
}: {
  clockwheel: Clockwheel;
  onClose: () => void;
  onChanged: () => void;
  onDeleted: (clockwheel: Clockwheel) => void;
}) {
  const [slots, setSlots] = useState<ClockSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    void Promise.all([
      api<{ slots: ClockSlot[] }>(`/clockwheels/${clockwheel.id}/slots`).then((r) => setSlots(r.slots)),
      api<{ playlists: Playlist[] }>("/playlists").then((r) => setPlaylists(r.playlists)),
      fetchAllTracks().then(setTracks),
    ]).finally(() => setLoading(false));
  }, [clockwheel.id]);

  const move = (i: number, dir: -1 | 1) => {
    const next = [...slots];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    setSlots(next);
    void Promise.all(next.map((s, idx) => api(`/clockwheels/${clockwheel.id}/slots/${s.id}`, { method: "PATCH", body: { position: idx } })));
  };

  const remove = (slotId: string) => {
    void api(`/clockwheels/${clockwheel.id}/slots/${slotId}`, { method: "DELETE" }).then(() => {
      setSlots((xs) => xs.filter((x) => x.id !== slotId));
      onChanged();
    });
  };

  const patch = (slotId: string, body: Record<string, unknown>) => {
    void api(`/clockwheels/${clockwheel.id}/slots/${slotId}`, { method: "PATCH", body }).then((r) => {
      const s = (r as { slot: ClockSlot }).slot;
      setSlots((xs) => xs.map((x) => (x.id === slotId ? { ...x, ...s } : x)));
    });
  };

  const removeClockwheel = () => {
    if (!confirm(`Delete clockwheel "${clockwheel.name}"?`)) return;
    setBusy(true);
    setError(null);
    void api(`/clockwheels/${clockwheel.id}`, { method: "DELETE" })
      .then(() => onDeleted(clockwheel))
      .catch((err) => setError(err instanceof Error ? err.message : "Could not delete clockwheel."))
      .finally(() => setBusy(false));
  };

  const kindLabel = (t: string) => SLOT_TYPES.find((s) => s.value === t)?.label ?? t;
  const kindCounts = {
    jingle: tracks.filter((t) => t.kind === "jingle").length,
    sweeper: tracks.filter((t) => t.kind === "sweeper").length,
    station_id: tracks.filter((t) => t.kind === "station_id").length,
  };
  const missingKinds = [
    kindCounts.jingle === 0 ? "jingles" : null,
    kindCounts.sweeper === 0 ? "sweepers" : null,
    kindCounts.station_id === 0 ? "station IDs" : null,
  ].filter(Boolean);

  return (
    <Modal open className="modal-wide" onClose={onClose} title={`${clockwheel.name} — hour layout`} footer={
      <>
        <Button variant="danger" disabled={busy} onClick={removeClockwheel}>Delete clockwheel</Button>
        <Button variant="ghost" disabled={busy} onClick={onClose}>Close</Button>
        <Button variant="primary" disabled={busy} onClick={() => setAddOpen(true)}>+ Add slot</Button>
      </>
    }>
      <p className="hint">Slots run in order and loop around the hour. Music slots draw from their rotation playlist (or the show's default).</p>
      {error ? <p className="hint" style={{ color: "var(--danger)" }}>{error}</p> : null}
      {missingKinds.length > 0 ? (
        <Card>
          <p className="hint" style={{ margin: 0 }}>
            Clockwheel warning: this library currently has no {missingKinds.join(", ")} tagged for automation.
            Those slot types will be skipped until tracks are uploaded or edited with the correct kind in Media Library.
          </p>
        </Card>
      ) : null}
      {loading ? <Spinner /> : null}
      {!loading && slots.length === 0 ? <Empty>No slots yet — the wheel is empty.</Empty> : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {slots.map((s, i) => (
          <div key={s.id} className="card" style={{ padding: 12 }}>
            <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <div className="row">
                <span className="mono muted">{i + 1}</span>
                <Badge tone={s.type === "ad_break" ? "amber" : "blue"}>{kindLabel(s.type)}</Badge>
                {s.label ? <span className="small">{s.label}</span> : null}
              </div>
              <div className="row">
                <Button className="btn-sm" disabled={i === 0} onClick={() => move(i, -1)}>↑</Button>
                <Button className="btn-sm" disabled={i === slots.length - 1} onClick={() => move(i, 1)}>↓</Button>
                <Button className="btn-sm btn-danger" onClick={() => remove(s.id)}>×</Button>
              </div>
            </div>
            <div className="row wrap" style={{ marginTop: 8, gap: 8 }}>
              {s.type === "music" ? (
                <>
                  <span className="small muted">Rotation:</span>
                  <Select value={s.playlistId ?? ""} onChange={(e) => patch(s.id, { playlistId: e.target.value || null })}>
                    <option value="">(show default)</option>
                    {playlists.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </Select>
                </>
              ) : null}
              {s.type === "anchored" ? (
                <>
                  <span className="small muted">Track:</span>
                  <Select value={s.trackId ?? ""} onChange={(e) => patch(s.id, { trackId: e.target.value || null })}>
                    <option value="">—</option>
                    {tracks.map((t) => <option key={t.id} value={t.id}>{t.title} — {t.artist}</option>)}
                  </Select>
                </>
              ) : null}
              {(s.type === "jingle" || s.type === "sweeper" || s.type === "station_id") && kindCounts[s.type] === 0 ? (
                <Badge tone="amber">No {kindLabel(s.type).toLowerCase()}s in library</Badge>
              ) : null}
              <Input
                placeholder={s.type === "anchored" ? "Label (e.g. Top of hour)" : "Label (optional)"}
                defaultValue={s.label ?? ""}
                onBlur={(e) => patch(s.id, { label: e.target.value || null })}
                style={{ flex: 1, minWidth: 160 }}
              />
              {s.type === "ad_break" ? (
                <span className="hint">2-min ad break at this position (walls at :15/:45 are automatic anyway)</span>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      {addOpen ? <AddSlot clockwheelId={clockwheel.id} playlists={playlists} tracks={tracks} onClose={() => setAddOpen(false)} onAdded={(slot) => {
        setSlots((xs) => [...xs, slot]);
        setAddOpen(false);
        onChanged();
      }} /> : null}
    </Modal>
  );
}

async function fetchAllTracks(): Promise<Track[]> {
  const pageSize = 200;
  const tracks: Track[] = [];
  let page = 1;

  while (true) {
    const response = await api<{ tracks: Track[]; total: number }>(`/tracks?kind=all&page=${page}&pageSize=${pageSize}`);
    tracks.push(...response.tracks);
    if (tracks.length >= response.total || response.tracks.length < pageSize) break;
    page += 1;
  }

  return tracks;
}

function AddSlot({ clockwheelId, playlists, tracks, onClose, onAdded }: { clockwheelId: string; playlists: Playlist[]; tracks: Track[]; onClose: () => void; onAdded: (s: ClockSlot) => void }) {
  const [type, setType] = useState("music");
  const [playlistId, setPlaylistId] = useState("");
  const [trackId, setTrackId] = useState("");
  const [label, setLabel] = useState("");

  const add = async () => {
    const res = await api<{ slot: ClockSlot }>(`/clockwheels/${clockwheelId}/slots`, {
      method: "POST",
      body: {
        position: 9999,
        type,
        playlistId: type === "music" ? playlistId || null : null,
        trackId: type === "anchored" ? trackId || null : null,
        label: label || null,
        durationSeconds: type === "ad_break" ? 120 : null,
      },
    });
    onAdded(res.slot);
  };

  return (
    <Modal open onClose={onClose} title="Add slot" footer={
      <>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => void add()}>Add</Button>
      </>
    }>
      <Field label="Slot type">
        <Select value={type} onChange={(e) => setType(e.target.value)}>
          {SLOT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </Select>
      </Field>
      {type === "music" ? (
        <Field label="Rotation playlist" hint="Leave empty to use the show's default playlist">
          <Select value={playlistId} onChange={(e) => setPlaylistId(e.target.value)}>
            <option value="">(show default)</option>
            {playlists.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
      ) : null}
      {type === "anchored" ? (
        <Field label="Anchored track">
          <Select value={trackId} onChange={(e) => setTrackId(e.target.value)}>
            <option value="">—</option>
            {tracks.map((t) => <option key={t.id} value={t.id}>{t.title} — {t.artist}</option>)}
          </Select>
        </Field>
      ) : null}
      <Field label="Label">
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Top-of-hour ID" />
      </Field>
    </Modal>
  );
}
