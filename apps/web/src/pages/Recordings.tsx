import { useState } from "react";
import { api, getToken } from "../api";
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHead, Select, Spinner, UserAvatar, useFetch } from "../components/ui";
import { AudioPlayer } from "../components/AudioPlayer";
import type { RecordingRow, User } from "@radiohost/shared";

function fmtClock(totalSeconds: number): string {
  const total = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function audioSrc(id: string): string {
  const token = getToken();
  return `/api/recordings/${id}/audio${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

export function Recordings() {
  const { data, loading, reload } = useFetch(() => api<{ recordings: RecordingRow[] }>("/recordings"));
  const { data: usersData } = useFetch(() => api<{ users: User[] }>("/users"));
  const [editing, setEditing] = useState<RecordingRow | null>(null);
  const [rename, setRename] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const djs = (usersData?.users ?? []).filter((u) => u.role === "dj");

  const assignDj = async (rec: RecordingRow, djId: string) => {
    await api(`/recordings/${rec.id}`, { method: "PATCH", body: { djId: djId || null } });
    reload();
  };

  const createShow = async (rec: RecordingRow) => {
    setBusyId(rec.id);
    setMsg(null);
    try {
      const res = await api<{ show: { name: string }; created: boolean }>(`/recordings/${rec.id}/create-show`, { method: "POST" });
      setMsg(res.created ? `Created show “${res.show.name}” — add it on the Schedule page to re-air it.` : `“${res.show.name}” is already in your Shows.`);
      reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not create the show.");
    } finally {
      setBusyId(null);
    }
  };

  const togglePodcast = async (rec: RecordingRow) => {
    await api(`/recordings/${rec.id}`, { method: "PATCH", body: { isPodcast: !rec.isPodcast } });
    reload();
  };

  const del = async (rec: RecordingRow) => {
    if (!confirm(`Delete "${rec.title}"? This removes the recording from the server — it cannot be undone.`)) return;
    await api(`/recordings/${rec.id}`, { method: "DELETE" });
    reload();
  };

  const saveRename = async () => {
    if (!editing || !rename.trim()) return;
    setSaving(true);
    try {
      await api(`/recordings/${editing.id}`, { method: "PATCH", body: { title: rename.trim() } });
      setEditing(null);
      reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not rename recording.");
    } finally {
      setSaving(false);
    }
  };

  const recordings = data?.recordings ?? [];

  return (
    <>
      <PageHead
        title="Recordings"
        sub="Every show is recorded automatically while it airs — listen back, rename, publish as a podcast, or remove them here."
      />
      {msg ? <div className="badge red" style={{ marginBottom: 10 }}>{msg}</div> : null}
      {loading ? <Spinner /> : null}
      {!loading && recordings.length === 0 ? (
        <Card><Empty>No recordings yet. When <strong>Record shows → podcast feeds</strong> is on in Settings, every scheduled show that airs is captured here automatically.</Empty></Card>
      ) : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {recordings.map((rec) => (
          <Card key={rec.id}>
            <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div className="row" style={{ gap: 10, minWidth: 0, alignItems: "center" }}>
                <UserAvatar name={rec.djName ?? rec.showName ?? "Radio"} src={rec.djAvatarUrl} size={46} />
                <div style={{ minWidth: 0 }}>
                  <div className="row wrap" style={{ gap: 6, alignItems: "center" }}>
                    <strong>{rec.title}</strong>
                    {rec.showName ? <Badge tone="green">{rec.showName}</Badge> : <Badge>no show</Badge>}
                    <Badge tone={rec.isPodcast ? "blue" : "default"}>{rec.isPodcast ? "podcast" : "private"}</Badge>
                  </div>
                  <div className="small muted" style={{ marginTop: 4 }}>
                    {fmtDate(rec.startedAt)} · {fmtClock(rec.durationSeconds)}{rec.djName ? ` · 🎙 ${rec.djName}` : ""}
                  </div>
                  <div className="row" style={{ gap: 6, alignItems: "center", marginTop: 6 }}>
                    <span className="small muted">DJ:</span>
                    <Select
                      value={rec.djId ?? ""}
                      onChange={(e) => void assignDj(rec, e.target.value)}
                      style={{ maxWidth: 220 }}
                    >
                      <option value="">— not set —</option>
                      {djs.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </Select>
                  </div>
                </div>
              </div>
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                <Button className="btn-sm" disabled={busyId === rec.id} onClick={() => void createShow(rec)}>
                  {busyId === rec.id ? "Creating…" : "→ Create show"}
                </Button>
                <Button className="btn-sm" onClick={() => { setEditing(rec); setRename(rec.title); setMsg(null); }}>✎ Rename</Button>
                <Button className="btn-sm" onClick={() => void togglePodcast(rec)}>
                  {rec.isPodcast ? "Hide from podcast" : "Publish as podcast"}
                </Button>
                <Button className="btn-sm btn-danger" onClick={() => void del(rec)}>×</Button>
              </div>
            </div>
            <div className="rec-player">
              <AudioPlayer src={audioSrc(rec.id)} />
            </div>
          </Card>
        ))}
      </div>

      {editing ? (
        <Modal
          open
          onClose={() => setEditing(null)}
          title="Rename recording"
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" disabled={saving || !rename.trim()} onClick={() => void saveRename()}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </>
          }
        >
          <Field label="Title">
            <Input value={rename} onChange={(e) => setRename(e.target.value)} placeholder="e.g. Breakfast Show — Fri 28 Aug" />
          </Field>
          <p className="hint">This is the title listeners see on the public player and podcast feed.</p>
        </Modal>
      ) : null}
    </>
  );
}
