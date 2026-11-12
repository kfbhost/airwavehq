import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHead, Select, Spinner, useFetch } from "../components/ui";
import type { Clockwheel, Djslot, Playlist, Show, User } from "@airwavehq/shared";

export function Shows() {
  const { data, loading, reload } = useFetch(() => api<{ shows: Show[] }>("/shows"));
  const { data: me } = useFetch(() => api<{ user: User }>("/auth/me"));
  const isDj = me?.user.role === "dj";
  const { data: playlists } = useFetch(() => api<{ playlists: Playlist[] }>("/playlists"));
  const { data: clockwheels } = useFetch(() => api<{ clockwheels: Clockwheel[] }>("/clockwheels"));
  const { data: slots } = useFetch(() => api<{ slots: Djslot[] }>("/dj-slots"));
  const [edit, setEdit] = useState<Show | null>(null);
  const allocatedSlots = slots?.slots ?? [];
  const canDjCreate = !isDj || allocatedSlots.length > 0;

  return (
    <>
      <PageHead
        title="Shows"
        sub="Every show gets its own clockwheel or playlist — descriptions, presenters and colours included"
        actions={me && canDjCreate ? <Button variant="primary" onClick={() => setEdit({ id: "", ownerId: me?.user.id ?? "", name: "", description: "", color: "#3b82f6", imagePath: null, playlistId: null, clockwheelId: null, presenters: "", createdAt: "" } as unknown as Show)}>+ New show</Button> : null}
      />
      {loading ? <Spinner /> : null}
      {isDj ? <Card className="shows-slots-card" title="Your allocated slots"><p className="hint">Your administrator controls these days and times. You can create multiple shows, then place each one on the weekly Schedule inside these allocated windows.</p>{slots?.slots.map((slot) => <div key={slot.id} className="row" style={{ justifyContent: "space-between", marginTop: 8 }}><span>{slot.show?.name ?? "Available DJ slot"}</span><span className="small muted">{slot.dayOfWeek === null ? "Daily" : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][slot.dayOfWeek]} · {minutes(slot.startMinutes)}–{minutes(slot.endMinutes)}</span></div>)}{slots && allocatedSlots.length === 0 ? <p className="hint" style={{ color: "var(--warning)", marginBottom: 0 }}>You cannot create a show until your administrator allocates you a slot.</p> : null}</Card> : null}
      {!loading && data && data.shows.length === 0 ? <Card><Empty>No shows yet. Create one, then schedule it on the Schedule page.</Empty></Card> : null}
      <div className="grid grid-3 shows-grid">
        {data?.shows.map((s) => (
          <Card key={s.id} className="shows-card" title={s.name} actions={<>
            <Link className="btn btn-ghost btn-sm" to={`/rundowns?show=${s.id}`}>🎚️ Build rundown</Link>
            {(!isDj || s.ownerId === me?.user.id) ? <Button className="btn-sm" onClick={() => setEdit(s)}>Edit</Button> : null}
          </>}>
            <div className="shows-card-body">
              {s.description ? <div className="small muted">{s.description}</div> : <div className="small muted">No description</div>}
              <div className="row wrap" style={{ gap: 6 }}>
                {s.isRecorded ? <Badge tone="blue">🔴 Recorded · {Math.round((s.plannedDurationSec ?? 0) / 60)} min</Badge> : null}
                {s.presenters ? <Badge>🎙 {s.presenters}</Badge> : null}
                {s.clockwheelId ? <Badge tone="blue">🕐 Clockwheel</Badge> : null}
                {s.playlistId ? <Badge tone="blue">📋 Playlist</Badge> : null}
              </div>
            </div>
          </Card>
        ))}
      </div>
      {edit ? <ShowEditor show={edit} playlists={playlists?.playlists ?? []} clockwheels={clockwheels?.clockwheels ?? []} slotOptions={isDj ? allocatedSlots : []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} /> : null}
    </>
  );
}

function minutes(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function ShowEditor({ show, playlists, clockwheels, slotOptions, onClose, onSaved }: { show: Show; playlists: Playlist[]; clockwheels: Clockwheel[]; slotOptions: Djslot[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(show.name);
  const [description, setDescription] = useState(show.description ?? "");
  const [presenters, setPresenters] = useState(show.presenters ?? "");
  const [color, setColor] = useState(show.color);
  const [playlistId, setPlaylistId] = useState(show.playlistId ?? "");
  const [clockwheelId, setClockwheelId] = useState(show.clockwheelId ?? "");
  const isNew = !show.id;
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        description: description || null,
        presenters,
        color,
        playlistId: playlistId || null,
        clockwheelId: clockwheelId || null,
      };
      if (isNew) await api("/shows", { method: "POST", body });
      else await api(`/shows/${show.id}`, { method: "PATCH", body });
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (!confirm(`Delete show "${name}"?`)) return;
    await api(`/shows/${show.id}`, { method: "DELETE" });
    onSaved();
  };

  return (
    <Modal open onClose={onClose} title={isNew ? "New show" : "Edit show"} footer={
      <>
        {!isNew ? <Button variant="danger" onClick={() => void del()}>Delete</Button> : null}
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void save()}>Save</Button>
      </>
    }>
      <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
      {isNew && slotOptions.length > 0 ? <p className="hint">Your administrator-assigned slot windows are available in Schedule. Create this show, then add it to a permitted day and time there.</p> : null}
      <Field label="Description"><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} /></Field>
      <Field label="Presenters"><Input value={presenters} onChange={(e) => setPresenters(e.target.value)} placeholder="DJ names, comma separated" /></Field>
      <div className="form-row">
        <Field label="Colour"><Input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ padding: 4, height: 38 }} /></Field>
        <Field label="Programming — clockwheel (optional)">
          <Select value={clockwheelId} onChange={(e) => setClockwheelId(e.target.value)}>
            <option value="">(station default)</option>
            {clockwheels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Programming — playlist (fallback)">
          <Select value={playlistId} onChange={(e) => setPlaylistId(e.target.value)}>
            <option value="">(station default)</option>
            {playlists.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}
