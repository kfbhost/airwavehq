import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHead, Select, Spinner, useFetch } from "../components/ui";
import type { Playlist, PlaylistItem, Track } from "@radiohost/shared";

interface ItemRow extends PlaylistItem {
  track: Track;
}

interface PlaylistRow extends Playlist {
  itemCount: number;
}

interface FolderInfo {
  name: string;
  count: number;
}

export function Playlists() {
  const { data, loading, reload } = useFetch(() => api<{ playlists: PlaylistRow[] }>("/playlists"));
  const [open, setOpen] = useState<Playlist | null>(null);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const create = async () => {
    const name = prompt("Playlist name");
    if (!name?.trim()) return;
    await api("/playlists", { method: "POST", body: { name: name.trim() } });
    reload();
  };

  return (
    <>
      <PageHead
        title="Playlists"
        sub="Build rotations in seconds — artist separation and repeat rules keep the sound fresh"
        actions={
          <>
            <Button onClick={() => setGeneratorOpen(true)}>Auto build</Button>
            <Button variant="primary" onClick={() => void create()}>+ New playlist</Button>
          </>
        }
      />
      {notice ? <Card><p className="hint" style={{ margin: 0 }}><strong>{notice}</strong></p></Card> : null}
      {loading ? <Spinner /> : null}
      {!loading && data && data.playlists.length === 0 ? <Card><Empty>No playlists yet — create one and add tracks from the library.</Empty></Card> : null}
      <div className="grid grid-3 playlists-grid">
        {data?.playlists.map((p) => (
          <Card key={p.id} className="playlists-card" title={p.name} actions={<Button className="btn-sm" onClick={() => setOpen(p)}>Open</Button>}>
            <div className="playlists-card-body">
              <div className="small muted">{p.itemCount} tracks</div>
              <div className="row wrap" style={{ marginTop: 8 }}>
                <Badge>Artist sep: {p.artistSeparation}</Badge>
                <Badge tone="blue">Repeat: {p.trackSeparationMinutes}m</Badge>
                {p.shuffle ? <Badge tone="green">🔀 Shuffle each pass</Badge> : null}
              </div>
            </div>
          </Card>
        ))}
      </div>
      {open ? (
        <PlaylistEditor
          playlist={open}
          onClose={() => setOpen(null)}
          onChanged={reload}
          onDeleted={(playlist) => {
            setOpen(null);
            setNotice(`Deleted playlist "${playlist.name}".`);
            reload();
          }}
        />
      ) : null}
      {generatorOpen ? (
        <PlaylistGenerator
          onClose={() => setGeneratorOpen(false)}
          onCreated={(result) => {
            setGeneratorOpen(false);
            setNotice(result.message);
            reload();
            setOpen(result.playlist);
          }}
        />
      ) : null}
    </>
  );
}

function PlaylistEditor({
  playlist,
  onClose,
  onChanged,
  onDeleted,
}: {
  playlist: Playlist;
  onClose: () => void;
  onChanged: () => void;
  onDeleted: (playlist: Playlist) => void;
}) {
  const [items, setItems] = useState<ItemRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [artistSep, setArtistSep] = useState(playlist.artistSeparation);
  const [sepMin, setSepMin] = useState(playlist.trackSeparationMinutes);
  const [shuffle, setShuffle] = useState(playlist.shuffle);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const totalSeconds = useMemo(() => items.reduce((sum, item) => sum + item.track.durationSeconds, 0), [items]);

  useEffect(() => {
    setLoading(true);
    api<{ items: ItemRow[] }>(`/playlists/${playlist.id}/items`)
      .then((r) => setItems(r.items))
      .finally(() => setLoading(false));
  }, [playlist.id]);

  const remove = (itemId: string) => {
    void api(`/playlists/${playlist.id}/items/${itemId}`, { method: "DELETE" }).then(() => {
      setItems((xs) => xs.filter((x) => x.id !== itemId));
      onChanged();
    });
  };

  const setWeight = (itemId: string, weight: number) => {
    void api(`/playlists/${playlist.id}/items/${itemId}`, { method: "PATCH", body: { weight } }).then(() => {
      setItems((xs) => xs.map((x) => (x.id === itemId ? { ...x, weight } : x)));
    });
  };

  const move = (index: number, dir: -1 | 1) => {
    const next = [...items];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j]!, next[index]!];
    setItems(next);
    void api(`/playlists/${playlist.id}/items/order`, { method: "PUT", body: { itemIds: next.map((x) => x.id) } });
  };

  const saveRules = () => {
    setBusy(true);
    setError(null);
    void api(`/playlists/${playlist.id}`, {
      method: "PATCH",
      body: { artistSeparation: artistSep, trackSeparationMinutes: sepMin, shuffle },
    }).then(onChanged).finally(() => setBusy(false));
  };

  const removePlaylist = () => {
    if (!confirm(`Delete playlist "${playlist.name}"?`)) return;
    setBusy(true);
    setError(null);
    void api(`/playlists/${playlist.id}`, { method: "DELETE" })
      .then(() => onDeleted(playlist))
      .catch((err) => setError(err instanceof Error ? err.message : "Could not delete playlist."))
      .finally(() => setBusy(false));
  };

  return (
    <Modal open className="modal-wide playlist-editor-modal" onClose={onClose} title={playlist.name} footer={
      <>
        <Button variant="danger" disabled={busy} onClick={removePlaylist}>Delete playlist</Button>
        <Button variant="ghost" disabled={busy} onClick={onClose}>Close</Button>
        <Button variant="primary" disabled={busy} onClick={() => setPicker(true)}>+ Add tracks</Button>
      </>
    }>
      <div className="form-row">
        <Field label="Artist separation (plays)">
          <Input type="number" min={0} max={50} value={artistSep} onChange={(e) => setArtistSep(Number(e.target.value))} />
        </Field>
        <Field label="Track repeat (minutes)">
          <Input type="number" min={0} max={1440} value={sepMin} onChange={(e) => setSepMin(Number(e.target.value))} />
        </Field>
        <div className="field"><label>&nbsp;</label><Button disabled={busy} onClick={saveRules}>Save rules</Button></div>
      </div>
      <Field label="Running order" hint="Shuffle each pass keeps the jingles where you placed them but plays the music in a brand-new order every time the playlist loops, so a 24 hour playlist never repeats the same running order.">
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={shuffle} onChange={(e) => setShuffle(e.target.checked)} />
          <span>🔀 Shuffle the music each pass</span>
        </label>
      </Field>
      <p className="hint">Current length: <strong>{fmtClock(totalSeconds)}</strong> · {items.length} items</p>
      <p className="hint">Higher weight = hotter rotation (played more often). Drag-order matters for rotation pools.</p>
      <p className="hint">Tip: keep a default fallback playlist set in Settings so AutoDJ always has music to pull from.</p>
      {error ? <p className="hint" style={{ color: "var(--danger)" }}>{error}</p> : null}
      {loading ? <Spinner /> : null}
      {!loading && items.length === 0 ? <Empty>Empty playlist — add tracks from your library.</Empty> : null}
      <div className="table-wrap">
        <table>
          <thead><tr><th>#</th><th>Track</th><th>Artist</th><th>Dur</th><th>Weight</th><th></th></tr></thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={it.id}>
                <td className="mono">{i + 1}</td>
                <td><strong>{it.track.title}</strong></td>
                <td>{it.track.artist || "—"}</td>
                <td className="mono">{Math.round(it.track.durationSeconds)}s</td>
                <td>
                  <Select value={it.weight} onChange={(e) => setWeight(it.id, Number(e.target.value))} style={{ width: 70 }}>
                    {[1, 2, 3, 4, 5].map((w) => <option key={w} value={w}>{w}</option>)}
                  </Select>
                </td>
                <td>
                  <div className="row" style={{ justifyContent: "flex-end" }}>
                    <Button className="btn-sm" disabled={i === 0} onClick={() => move(i, -1)}>↑</Button>
                    <Button className="btn-sm" disabled={i === items.length - 1} onClick={() => move(i, 1)}>↓</Button>
                    <Button className="btn-sm btn-danger" onClick={() => remove(it.id)}>×</Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {picker ? <TrackPicker onClose={() => setPicker(false)} onAdded={(ids) => {
        void api(`/playlists/${playlist.id}/items`, { method: "POST", body: { trackIds: ids } }).then(() => {
          setPicker(false);
          setLoading(true);
          void api<{ items: ItemRow[] }>(`/playlists/${playlist.id}/items`).then((r) => setItems(r.items)).finally(() => setLoading(false));
          onChanged();
        });
      }} /> : null}
    </Modal>
  );
}

function PlaylistGenerator({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (result: { playlist: Playlist; message: string }) => void;
}) {
  const folders = useFetch(() => api<{ folders: FolderInfo[]; unfiled: number }>("/folders"), []);
  const [name, setName] = useState("");
  const [hours, setHours] = useState(1);
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());
  const [includeJingles, setIncludeJingles] = useState(true);
  const [jingleEvery, setJingleEvery] = useState(3);
  const [jingleFolder, setJingleFolder] = useState("");
  const [shuffle, setShuffle] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleFolder = (folder: string) => {
    setSelectedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  };

  const selectAllFolders = () => {
    setSelectedFolders(new Set(folders.data?.folders.map((folder) => folder.name) ?? []));
  };

  const build = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{
        playlist: Playlist;
        itemCount: number;
        totalDurationSeconds: number;
        warnings: string[];
      }>("/playlists/generate", {
        method: "POST",
        body: {
          name,
          hours,
          musicFolders: [...selectedFolders],
          includeJingles,
          jingleEvery,
          jingleFolder: includeJingles && jingleFolder ? jingleFolder : null,
          shuffle,
        },
      });
      const warningText = result.warnings.length > 0 ? ` ${result.warnings.join(" ")}` : "";
      onCreated({
        playlist: result.playlist,
        message: `Built ${result.playlist.name} with ${result.itemCount} items for about ${fmtClock(result.totalDurationSeconds)}.${warningText}`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build playlist.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Auto build playlist"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void build()}>
            {busy ? "Building..." : "Build playlist"}
          </Button>
        </>
      }
    >
      <Field label="Playlist name">
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Daytime Auto 24hr" />
      </Field>
      <div className="form-row">
        <Field label="Target hours" hint="Works well for a 1 hour test or a full 24 hour playlist.">
          <Input type="number" min={1} max={24} value={hours} onChange={(e) => setHours(Math.max(1, Math.min(24, Number(e.target.value) || 1)))} />
        </Field>
        <Field label="Jingle frequency" hint="Insert one jingle after every N music tracks.">
          <Input
            type="number"
            min={1}
            max={20}
            value={jingleEvery}
            disabled={!includeJingles}
            onChange={(e) => setJingleEvery(Math.max(1, Math.min(20, Number(e.target.value) || 3)))}
          />
        </Field>
      </div>
      <Field label="Music folders" hint="Leave everything unticked if you want the builder to use all music folders.">
        <div className="row wrap" style={{ marginBottom: 8 }}>
          <Button className="btn-sm" type="button" onClick={selectAllFolders}>Select all</Button>
          <Button className="btn-sm" type="button" onClick={() => setSelectedFolders(new Set())}>Use all folders</Button>
        </div>
        <div style={{ maxHeight: 220, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
          {folders.data?.folders.map((folder) => (
            <label key={folder.name} className="row" style={{ padding: "6px 8px", borderRadius: 6, cursor: "pointer", background: selectedFolders.has(folder.name) ? "var(--panel2)" : "transparent" }}>
              <input type="checkbox" checked={selectedFolders.has(folder.name)} onChange={() => toggleFolder(folder.name)} />
              <span style={{ flex: 1 }}>{folder.name}</span>
              <Badge tone="blue">{folder.count}</Badge>
            </label>
          ))}
          {!folders.loading && folders.data?.folders.length === 0 ? <Empty>No folders yet.</Empty> : null}
        </div>
      </Field>
      <Field label="Jingles">
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={includeJingles} onChange={(e) => setIncludeJingles(e.target.checked)} />
          <span>Throw jingles into the generated playlist</span>
        </label>
      </Field>
      <Field label="Running order" hint="Leave this on for long auto playlists: each time the playlist reaches the end it restarts in a new order, so the same tunes never play in the same sequence twice.">
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={shuffle} onChange={(e) => setShuffle(e.target.checked)} />
          <span>🔀 Shuffle the music each pass</span>
        </label>
      </Field>
      <Field label="Jingle folder" hint="Leave blank to use all jingle-tagged tracks.">
        <Select value={jingleFolder} disabled={!includeJingles} onChange={(e) => setJingleFolder(e.target.value)}>
          <option value="">All jingle folders</option>
          {folders.data?.folders.map((folder) => <option key={folder.name} value={folder.name}>{folder.name}</option>)}
        </Select>
      </Field>
      {error ? <p className="hint" style={{ color: "var(--danger)" }}>{error}</p> : null}
    </Modal>
  );
}

function TrackPicker({ onClose, onAdded }: { onClose: () => void; onAdded: (ids: string[]) => void }) {
  const [search, setSearch] = useState("");
  const [folder, setFolder] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const folders = useFetch(
    () => api<{ folders: FolderInfo[]; unfiled: number }>("/folders"),
    [],
  );
  const { data, loading } = useFetch(
    () => api<{ tracks: Track[] }>(`/tracks?kind=music&search=${encodeURIComponent(search)}${folder ? `&folder=${encodeURIComponent(folder)}` : ""}&pageSize=200`),
    [search, folder],
  );
  const visibleIds = data?.tracks.map((t) => t.id) ?? [];

  const selectVisible = () => {
    setSel((prev) => {
      const next = new Set(prev);
      for (const id of visibleIds) next.add(id);
      return next;
    });
  };

  const clearVisible = () => {
    setSel((prev) => {
      const next = new Set(prev);
      for (const id of visibleIds) next.delete(id);
      return next;
    });
  };

  return (
    <Modal open onClose={onClose} title="Add tracks" footer={
      <>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={sel.size === 0} onClick={() => onAdded([...sel])}>Add {sel.size || ""}</Button>
      </>
    }>
      <div className="form-row">
        <Field label="Search">
          <Input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search music…" />
        </Field>
        <Field label="Folder">
          <Select value={folder} onChange={(e) => setFolder(e.target.value)}>
            <option value="">All folders</option>
            <option value="unfiled">Unfiled</option>
            {folders.data?.folders.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
          </Select>
        </Field>
      </div>
      <div className="row wrap" style={{ justifyContent: "space-between", marginBottom: 10 }}>
        <span className="small muted">
          {visibleIds.length} shown{folder === "unfiled" ? " in Unfiled" : folder ? ` in ${folder}` : ""} · {sel.size} selected
        </span>
        <div className="row wrap">
          <Button className="btn-sm" onClick={selectVisible} disabled={visibleIds.length === 0}>Select all shown</Button>
          <Button className="btn-sm" onClick={clearVisible} disabled={visibleIds.length === 0}>Clear shown</Button>
        </div>
      </div>
      {loading ? <Spinner /> : null}
      <div style={{ maxHeight: 320, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
        {data?.tracks.map((t) => (
          <label key={t.id} className="row" style={{ padding: "6px 8px", borderRadius: 6, cursor: "pointer", background: sel.has(t.id) ? "var(--panel2)" : "transparent" }}>
            <input type="checkbox" checked={sel.has(t.id)} onChange={() => {
              const next = new Set(sel);
              if (next.has(t.id)) next.delete(t.id);
              else next.add(t.id);
              setSel(next);
            }} />
            <span style={{ flex: 1 }}><strong>{t.title}</strong> <span className="muted">— {t.artist}</span></span>
            {t.folder ? <Badge tone="blue">{t.folder}</Badge> : null}
            <span className="mono small muted">{Math.round(t.durationSeconds)}s</span>
          </label>
        ))}
        {!loading && data && data.tracks.length === 0 ? <Empty>No music matches.</Empty> : null}
      </div>
    </Modal>
  );
}

function fmtClock(sec: number): string {
  const total = Math.round(sec);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
