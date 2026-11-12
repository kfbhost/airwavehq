import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, upload } from "../api";
import { mediaUrl } from "../media";
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHead, Select, Spinner, useFetch } from "../components/ui";
import type { Track, TrackKind } from "@airwavehq/shared";
import { KIND_LABELS } from "@airwavehq/shared";

const KINDS: Array<TrackKind | "all"> = ["all", "music", "jingle", "sweeper", "station_id", "ad", "voice"];
const MAX_CONCURRENT_UPLOADS = 5;
type TrackSortKey = "createdAt" | "title" | "artist";

interface FolderInfo {
  name: string;
  count: number;
}

interface LibraryStorage {
  trackCount: number;
  libraryBytes: number;
  freeBytes: number;
  totalBytes: number;
  libraryPercent: number;
  freePercent: number;
}

interface UploadItem {
  id: string;
  name: string;
  size: number;
  loaded: number;
  progress: number;
  status: "queued" | "uploading" | "processing" | "done" | "error";
  error?: string;
}

interface UploadJob {
  id: string;
  file: File;
  folder: string;
  kind: TrackKind;
}

export function Library() {
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<string>("all");
  const [folder, setFolder] = useState<string>(""); // "" = all, "unfiled" = no folder, else folder name
  const [uploadFolder, setUploadFolder] = useState<string>("");
  const [uploadKind, setUploadKind] = useState<TrackKind>("music");
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<TrackSortKey>("createdAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [edit, setEdit] = useState<Track | null>(null);
  const [dupOpen, setDupOpen] = useState(false);
  const [previewTrackId, setPreviewTrackId] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const uploadQueueRef = useRef<UploadJob[]>([]);
  const activeUploadsRef = useRef(0);

  const { data, loading, reload } = useFetch(
    () => api<{ tracks: Track[]; total: number }>(`/tracks?search=${encodeURIComponent(search)}&kind=${kind}${folder ? `&folder=${encodeURIComponent(folder)}` : ""}&sortBy=${sortBy}&sortDir=${sortDir}&page=${page}&pageSize=50`),
    [search, kind, folder, sortBy, sortDir, page],
  );

  const folders = useFetch(
    () => api<{ folders: FolderInfo[]; unfiled: number }>("/folders"),
    [],
  );
  const storage = useFetch(
    () => api<LibraryStorage>("/tracks/storage"),
    [],
  );

  // Bar shows media library against free space (the two numbers listed below),
  // not how full the whole disk is — so the % always matches the rows beside it.
  const mediaSharePct =
    (storage.data?.libraryBytes ?? 0) + (storage.data?.freeBytes ?? 0) > 0
      ? ((storage.data?.libraryBytes ?? 0) / ((storage.data?.libraryBytes ?? 0) + (storage.data?.freeBytes ?? 0))) * 100
      : 0;

  const refreshAll = () => {
    reload();
    folders.reload();
    storage.reload();
  };

  const pumpUploadQueue = () => {
    while (activeUploadsRef.current < MAX_CONCURRENT_UPLOADS && uploadQueueRef.current.length > 0) {
      const job = uploadQueueRef.current.shift();
      if (!job) return;

      activeUploadsRef.current += 1;
      setUploads((u) => u.map((x) => (x.id === job.id ? { ...x, status: "uploading" } : x)));

      const form = new FormData();
      if (job.folder) form.append("folder", job.folder);
      form.append("kind", job.kind);
      form.append("file", job.file);

      upload("/tracks/upload", form, {
        onProgress: (loaded, total) => {
          setUploads((u) => u.map((x) => (x.id === job.id ? { ...x, loaded, progress: total > 0 ? Math.min(100, (loaded / total) * 100) : x.progress } : x)));
        },
        onProcessing: () => {
          setUploads((u) => u.map((x) => (x.id === job.id ? { ...x, loaded: x.size, progress: 100, status: "processing" } : x)));
        },
      })
        .then(() => {
          setUploads((u) => u.map((x) => (x.id === job.id ? { ...x, loaded: x.size, progress: 100, status: "done" } : x)));
        })
        .catch((e) => setUploads((u) => u.map((x) => (x.id === job.id ? { ...x, status: "error", error: e.message } : x))))
        .finally(() => {
          activeUploadsRef.current = Math.max(0, activeUploadsRef.current - 1);
          if (activeUploadsRef.current === 0 && uploadQueueRef.current.length === 0) {
            refreshAll();
          }
          pumpUploadQueue();
        });
    }
  };

  const enqueue = (files: FileList | null) => {
    if (!files) return;
    const list = Array.from(files);
    for (const file of list) {
      const uploadId = `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`;
      uploadQueueRef.current.push({
        id: uploadId,
        file,
        folder: uploadFolder,
        kind: uploadKind,
      });
      setUploads((u) => [...u, { id: uploadId, name: file.name, size: file.size, loaded: 0, progress: 0, status: "queued" }]);
    }
    pumpUploadQueue();
  };

  const activeUploadCount = useMemo(() => uploads.filter((u) => u.status === "uploading" || u.status === "processing").length, [uploads]);
  const queuedUploadCount = useMemo(() => uploads.filter((u) => u.status === "queued").length, [uploads]);
  const allTracksCount = useMemo(() => {
    if (typeof data?.total === "number") return data.total;
    if (!folders.data) return null;
    return folders.data.folders.reduce((acc, f) => acc + f.count, 0) + folders.data.unfiled;
  }, [data?.total, folders.data]);

  const createFolder = async () => {
    const name = window.prompt("New folder name (e.g. House, Rock, Jingles…)");
    if (!name || !name.trim()) return;
    try {
      await api("/folders", { method: "POST", body: { name: name.trim() } });
      folders.reload();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to create folder");
    }
  };

  const renameFolder = async (oldName: string) => {
    const name = window.prompt("Rename folder to:", oldName);
    if (!name || !name.trim() || name.trim() === oldName) return;
    try {
      await api("/folders", { method: "PATCH", body: { oldName, newName: name.trim() } });
      if (folder === oldName) setFolder(name.trim());
      refreshAll();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to rename folder");
    }
  };

  const deleteFolder = async (name: string, count: number) => {
    const msg = count > 0
      ? `Delete folder "${name}"?\n\nThis will PERMANENTLY delete the folder and all ${count} track${count === 1 ? "" : "s"} inside it (their audio files are removed from disk). This cannot be undone.`
      : `Delete empty folder "${name}"?`;
    if (!confirm(msg)) return;
    try {
      await api(`/folders/${encodeURIComponent(name)}`, { method: "DELETE" });
      if (folder === name) setFolder("");
      refreshAll();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to delete folder");
    }
  };

  useEffect(() => {
    return () => {
      if (previewAudioRef.current) {
        previewAudioRef.current.pause();
        previewAudioRef.current = null;
      }
    };
  }, []);

  const toggleSort = (next: TrackSortKey) => {
    setPage(1);
    if (sortBy === next) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
      return;
    }
    setSortBy(next);
    setSortDir("asc");
  };

  const togglePreview = async (track: Track) => {
    if (previewTrackId === track.id && previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.currentTime = 0;
      previewAudioRef.current = null;
      setPreviewTrackId(null);
      return;
    }

    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.currentTime = 0;
      previewAudioRef.current = null;
    }

    const src = mediaUrl(track.filePath);
    if (!src) {
      setPreviewTrackId(null);
      return;
    }
    const audio = new Audio(src);
    audio.volume = 0.9;
    audio.onended = () => {
      if (previewAudioRef.current === audio) {
        previewAudioRef.current = null;
        setPreviewTrackId(null);
      }
    };
    previewAudioRef.current = audio;
    setPreviewTrackId(track.id);

    try {
      await audio.play();
    } catch {
      previewAudioRef.current = null;
      setPreviewTrackId(null);
      alert("Could not play this track preview.");
    }
  };

  return (
    <>
      <PageHead
        title="Media Library"
        sub="Drag-and-drop uploads with automatic metadata, artwork and loudness handling"
        actions={(
          <div className="lib-upload-controls">
            <Button className="btn-ghost" onClick={() => setDupOpen(true)} title="Scan the library for duplicate tracks">🔍 Find duplicates</Button>
            <Select value={uploadKind} onChange={(e) => setUploadKind(e.target.value as TrackKind)} title="Choose upload kind">
              <option value="music">Music</option>
              <option value="jingle">Jingle</option>
              <option value="sweeper">Sweeper</option>
              <option value="station_id">Station ID</option>
              <option value="ad">Ad copy</option>
            </Select>
            <Select value={uploadFolder} onChange={(e) => setUploadFolder(e.target.value)} title="Choose upload folder">
              <option value="">Unfiled</option>
              {folders.data?.folders.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
            </Select>
            <Button variant="primary" onClick={() => inputRef.current?.click()}>⬆ Upload</Button>
          </div>
        )}
      />
      <input ref={inputRef} type="file" multiple accept="audio/*" hidden onChange={(e) => enqueue(e.target.files)} />

      {uploads.length > 0 ? (
        <Card title={activeUploadCount > 0 || queuedUploadCount > 0 ? `Uploading ${activeUploadCount}${queuedUploadCount > 0 ? ` · ${queuedUploadCount} queued` : ""}` : "Uploads"}>
          <p className="hint" style={{ marginBottom: 10 }}>
            Uploads now run in VPS-friendly batches of {MAX_CONCURRENT_UPLOADS}. Each file finishes uploading and processing before the queue moves deeper into the batch.
          </p>
          <div className="lib-upload-list">
            {uploads.map((u) => (
              <div key={u.id} className={`lib-upload-item is-${u.status}`}>
                <div className="lib-upload-item-head">
                  <div className="lib-upload-item-copy">
                    <strong className="lib-upload-item-name">{u.name}</strong>
                    <span className="lib-upload-item-meta">
                      {u.status === "queued"
                        ? `Waiting in queue · ${fmtBytes(u.size)}`
                        : null}
                      {u.status === "processing"
                        ? `Uploaded ${fmtBytes(u.size)} · processing audio`
                        : u.status === "queued"
                          ? null
                          : `${fmtBytes(Math.min(u.loaded, u.size))} of ${fmtBytes(u.size)}`}
                    </span>
                  </div>
                  <div className="lib-upload-item-side">
                    <span className="lib-upload-item-percent">{u.status === "queued" ? "—" : u.status === "processing" ? "100%" : `${Math.round(u.progress)}%`}</span>
                    <Badge tone={u.status === "done" ? "green" : u.status === "error" ? "red" : u.status === "processing" ? "amber" : u.status === "queued" ? "default" : "blue"}>
                      {u.status === "processing" ? "processing" : u.status}
                    </Badge>
                  </div>
                </div>
                <div className={`progress-bar lib-upload-progress ${u.status === "processing" ? "is-processing" : ""}`}>
                  <div style={{ width: `${u.status === "queued" ? 0 : u.status === "processing" ? 100 : u.progress}%` }} />
                </div>
                {u.error ? <div className="small red">{u.error}</div> : null}
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <div className="lib-grid">
        {/* Folders sidebar */}
        <aside className="card lib-folders">
          <div className="lib-folders-head">
            <span className="lib-folders-title">Folders</span>
            <Button className="btn-sm" onClick={() => void createFolder()}>+ New</Button>
          </div>
          <button className={`lib-folder ${folder === "" ? "active" : ""}`} onClick={() => { setFolder(""); setPage(1); }}>
            <span>🗂️ All tracks</span>
            <span className="lib-folder-count">{allTracksCount ?? "…"}</span>
          </button>
          <button className={`lib-folder ${folder === "unfiled" ? "active" : ""}`} onClick={() => { setFolder("unfiled"); setPage(1); setUploadFolder(""); }}>
            <span>📄 Unfiled</span>
            <span className="lib-folder-count">{folders.data?.unfiled ?? "…"}</span>
          </button>
          {folders.data?.folders.map((f) => (
            <div key={f.name} className={`lib-folder ${folder === f.name ? "active" : ""}`}>
              <button className="lib-folder-main" onClick={() => { setFolder(f.name); setPage(1); setUploadFolder(f.name); }}>
                <span>📁 {f.name}</span>
                <span className="lib-folder-count">{f.count}</span>
              </button>
              <button className="lib-folder-action" title="Rename folder" onClick={() => void renameFolder(f.name)}>✎</button>
              <button className="lib-folder-action danger" title="Delete folder and its tracks" onClick={() => void deleteFolder(f.name, f.count)}>×</button>
            </div>
          ))}
          {!folders.loading && folders.data && folders.data.folders.length === 0 ? (
            <div className="muted small" style={{ padding: "8px 4px" }}>No folders yet — create one to organise tracks by genre.</div>
          ) : null}
          <div className="lib-storage">
            <div className="lib-storage-head">
              <span className="lib-folders-title">Storage</span>
              <span className="small muted">
                {storage.data ? `${Math.round(mediaSharePct)}% used by library` : "Checking..."}
              </span>
            </div>
            <div className="progress-bar lib-storage-bar" aria-hidden="true">
              <div style={{ width: `${storage.data ? Math.max(0, Math.min(100, mediaSharePct)) : 0}%` }} />
            </div>
            <div className="lib-storage-stats">
              <div className="lib-storage-row">
                <span>Media library</span>
                <strong>{storage.data ? fmtBytes(storage.data.libraryBytes) : "..."}</strong>
              </div>
              <div className="lib-storage-row">
                <span>Free space</span>
                <strong>{storage.data ? fmtBytes(storage.data.freeBytes) : "..."}</strong>
              </div>
              <div className="lib-storage-row">
                <span>Tracked files</span>
                <strong>{storage.data?.trackCount ?? "..."}</strong>
              </div>
            </div>
          </div>
        </aside>

        {/* Track table */}
        <Card
          className="lib-main-card"
          title={folder === "" ? "All tracks" : folder === "unfiled" ? "Unfiled tracks" : folder}
          sub={data ? `${data.total} track${data.total === 1 ? "" : "s"}${kind !== "all" ? ` · ${KIND_LABELS[kind as TrackKind]}` : ""}` : "Browse, search and organise your audio"}
        >
          <div className="lib-toolbar">
            <div className="lib-search-row">
              <Input
                placeholder="Search title, artist, album…"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                style={{ flex: 1, minWidth: 220 }}
              />
              <Select value={kind} onChange={(e) => { setKind(e.target.value); setPage(1); }}>
                {KINDS.map((k) => <option key={k} value={k}>{k === "all" ? "All kinds" : KIND_LABELS[k]}</option>)}
              </Select>
            </div>
            <p className="hint lib-upload-hint">
              Uploads inherit the selected kind and folder. Clockwheel imaging slots only use tracks tagged with the exact matching kind.
            </p>
          </div>
          {loading ? <div style={{ textAlign: "center", padding: 30 }}><Spinner /></div> : null}
          {!loading && data && data.tracks.length === 0 ? <Empty>No tracks{kind !== "all" ? ` of kind ${KIND_LABELS[kind as TrackKind]}` : ""}{folder === "unfiled" ? " without a folder" : folder ? ` in “${folder}”` : ""}. {folder === "unfiled" ? "Assign tracks to a folder using Edit." : "Upload your first files above."}</Empty> : null}
          {!loading && data && data.tracks.length > 0 ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>
                      <button type="button" className={`table-sort${sortBy === "title" ? " active" : ""}`} onClick={() => toggleSort("title")}>
                        Title <span>{sortBy === "title" ? (sortDir === "asc" ? "↑" : "↓") : "↕"}</span>
                      </button>
                    </th>
                    <th>
                      <button type="button" className={`table-sort${sortBy === "artist" ? " active" : ""}`} onClick={() => toggleSort("artist")}>
                        Artist <span>{sortBy === "artist" ? (sortDir === "asc" ? "↑" : "↓") : "↕"}</span>
                      </button>
                    </th>
                    <th>Folder</th><th>Kind</th><th>Duration</th><th>Format</th><th>Plays</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.tracks.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <div className="row" style={{ gap: 8 }}>
                          {t.artworkPath ? <img src={mediaUrl(t.artworkPath) ?? undefined} alt="" style={{ width: 30, height: 30, borderRadius: 6, objectFit: "cover" }} /> : <div style={{ width: 30, height: 30, borderRadius: 6, background: "var(--panel2)", display: "grid", placeItems: "center" }}>♪</div>}
                          <strong>{t.title}</strong>
                        </div>
                      </td>
                      <td>{t.artist || "—"}</td>
                      <td>
                        {t.folder ? <Badge tone="blue">{t.folder}</Badge> : <span className="muted small">—</span>}
                      </td>
                      <td><Badge>{KIND_LABELS[t.kind as TrackKind] ?? t.kind}</Badge></td>
                      <td className="mono">{fmtDur(t.durationSeconds)}</td>
                      <td className="small">{formatCodec(t)}</td>
                      <td>{t.playCount}</td>
                      <td>
                        <div className="row" style={{ justifyContent: "flex-end" }}>
                          <Button className="btn-sm" onClick={() => void togglePreview(t)}>
                            {previewTrackId === t.id ? "⏸ Pause" : "▶ Preview"}
                          </Button>
                          <Button className="btn-sm" onClick={() => setEdit(t)}>Edit</Button>
                          <Button className="btn-sm btn-danger" onClick={() => { if (confirm(`Delete "${t.title}"?`)) void api(`/tracks/${t.id}`, { method: "DELETE" }).then(refreshAll); }}>×</Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {data && data.total > 50 ? (
            <div className="row" style={{ justifyContent: "center", marginTop: 12 }}>
              <Button className="btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Prev</Button>
              <span className="small muted">Page {page} · {data.total} tracks</span>
              <Button className="btn-sm" disabled={page * 50 >= data.total} onClick={() => setPage((p) => p + 1)}>Next →</Button>
            </div>
          ) : null}
        </Card>
      </div>

      <EditModal track={edit} folders={folders.data?.folders.map((f) => f.name) ?? []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); refreshAll(); }} />
      <DuplicatesModal open={dupOpen} onClose={() => setDupOpen(false)} onDeleted={refreshAll} />
    </>
  );
}

interface DuplicateGroup {
  tracks: Track[];
}

function DuplicatesModal({ open, onClose, onDeleted }: { open: boolean; onClose: () => void; onDeleted: () => void }) {
  const [scanning, setScanning] = useState(true);
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [keep, setKeep] = useState<Record<string, string>>({}); // group key -> kept track id
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groupKey = (g: DuplicateGroup) => String(g.tracks[0]?.fileHash ?? g.tracks[0]?.id);

  const load = useCallback(async () => {
    try {
      const res = await api<{ scanning: boolean; groups: DuplicateGroup[] }>("/tracks/duplicates");
      setScanning(res.scanning);
      if (res.scanning) return;
      setGroups(res.groups);
      setKeep((prev) => {
        const next: Record<string, string> = {};
        for (const g of res.groups) {
          const key = groupKey(g);
          // default: keep the first (oldest) track of each group
          next[key] = prev[key] ?? g.tracks[0]?.id ?? "";
        }
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to check duplicates");
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setScanning(true);
    void load();
  }, [open, load]);

  // Poll while the background hash scan is still running.
  useEffect(() => {
    if (!open || !scanning) return;
    const iv = setInterval(() => void load(), 2500);
    return () => clearInterval(iv);
  }, [open, scanning, load]);

  const duplicateCount = groups.reduce((acc, g) => acc + g.tracks.length - 1, 0);
  const savedBytes = groups.reduce((acc, g) => {
    const kept = keep[groupKey(g)];
    return acc + g.tracks.filter((t) => t.id !== kept).reduce((a, t) => a + (t.fileSize || 0), 0);
  }, 0);

  const removeDuplicates = async () => {
    const ids: string[] = [];
    for (const g of groups) {
      const kept = keep[groupKey(g)];
      for (const t of g.tracks) if (t.id !== kept) ids.push(t.id);
    }
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} duplicate track${ids.length === 1 ? "" : "s"}? The files will be removed from disk — one copy of each track is kept.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api("/tracks/duplicates/delete", { method: "POST", body: { ids } });
      onDeleted();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete duplicates");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title="Find duplicates" onClose={onClose} className="dup-modal"
      footer={
        groups.length > 0 ? (
          <>
            <span className="small muted" style={{ marginRight: "auto" }}>
              {groups.length} group{groups.length === 1 ? "" : "s"} · {duplicateCount} duplicate{duplicateCount === 1 ? "" : "s"} · {fmtBytes(savedBytes)} recoverable
            </span>
            <Button variant="ghost" onClick={onClose}>Close</Button>
            <Button variant="danger" onClick={() => void removeDuplicates()} disabled={busy || duplicateCount === 0}>
              {busy ? "Deleting…" : `Delete ${duplicateCount} duplicate${duplicateCount === 1 ? "" : "s"}`}
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={onClose}>Close</Button>
        )
      }>
      {scanning ? (
        <div style={{ textAlign: "center", padding: "30px 10px" }}>
          <Spinner />
          <p className="hint" style={{ marginTop: 12 }}>Hashing the library… this runs in the background and can take a while for large libraries.</p>
        </div>
      ) : error ? (
        <p className="small red">{error}</p>
      ) : groups.length === 0 ? (
        <div style={{ textAlign: "center", padding: "24px 10px" }}>
          <div style={{ fontSize: 32 }}>🎉</div>
          <p className="hint" style={{ marginTop: 8 }}>No duplicate tracks found — every file in your library is unique.</p>
        </div>
      ) : (
        <div className="dup-groups">
          <p className="hint" style={{ marginBottom: 10 }}>
            These tracks have identical audio. Pick the copy to <strong>keep</strong> in each group — the rest will be deleted.
          </p>
          {groups.map((g) => (
            <div key={groupKey(g)} className="dup-group card">
              <div className="dup-group-head">
                <strong>{g.tracks[0]?.title || "Untitled"}</strong>
                {g.tracks[0]?.artist ? <span className="muted small"> · {g.tracks[0].artist}</span> : null}
                <span className="small muted" style={{ marginLeft: "auto" }}>{g.tracks.length} copies</span>
              </div>
              {g.tracks.map((t) => (
                <label key={t.id} className={`dup-row ${keep[groupKey(g)] === t.id ? "is-kept" : ""}`}>
                  <input
                    type="radio"
                    name={`dup-${groupKey(g)}`}
                    checked={keep[groupKey(g)] === t.id}
                    onChange={() => setKeep((prev) => ({ ...prev, [groupKey(g)]: t.id }))}
                  />
                  <span className="dup-row-title">
                    {t.title}
                    {t.artist ? <span className="muted small"> — {t.artist}</span> : null}
                  </span>
                  <span className="badge">{KIND_LABELS[t.kind as TrackKind] ?? t.kind}</span>
                  <span className="small muted">{t.folder || "unfiled"}</span>
                  <span className="small muted mono">{fmtDur(t.durationSeconds)}</span>
                  <span className="small muted mono">{fmtBytes(t.fileSize)}</span>
                  <span className={`small ${keep[groupKey(g)] === t.id ? "green" : "muted"}`}>
                    {keep[groupKey(g)] === t.id ? "✔ kept" : "duplicate"}
                  </span>
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function EditModal({ track, folders, onClose, onSaved }: { track: Track | null; folders: string[]; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(track?.title ?? "");
  const [artist, setArtist] = useState(track?.artist ?? "");
  const [album, setAlbum] = useState(track?.album ?? "");
  const [folder, setFolder] = useState<string>(track?.folder ?? "");
  const [kind, setKind] = useState<string>(track?.kind ?? "music");
  const [busy, setBusy] = useState(false);
  const [bpm, setBpm] = useState<string>(track?.bpm?.toString() ?? "");

  // keep local state in sync when opening a different track
  useEffect(() => {
    setTitle(track?.title ?? "");
    setArtist(track?.artist ?? "");
    setAlbum(track?.album ?? "");
    setFolder(track?.folder ?? "");
    setKind(track?.kind ?? "music");
    setBpm(track?.bpm?.toString() ?? "");
  }, [track?.id]);

  if (!track) return null;

  const save = async () => {
    setBusy(true);
    try {
      await api(`/tracks/${track.id}`, {
        method: "PATCH",
        body: { title, artist, album, folder: folder || null, kind, bpm: bpm ? Number(bpm) : null },
      });
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={!!track} title={`Edit — ${track.title}`} onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => void save()} disabled={busy}>Save</Button>
      </>}>
      <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      <div className="form-row">
        <Field label="Artist"><Input value={artist} onChange={(e) => setArtist(e.target.value)} /></Field>
        <Field label="Album"><Input value={album} onChange={(e) => setAlbum(e.target.value)} /></Field>
      </div>
      <div className="form-row">
        <Field label="Folder">
          <Select value={folder} onChange={(e) => setFolder(e.target.value)}>
            <option value="">— no folder —</option>
            {folders.map((f) => <option key={f} value={f}>{f}</option>)}
          </Select>
        </Field>
        <Field label="Kind">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(KIND_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="BPM"><Input value={bpm} inputMode="decimal" onChange={(e) => setBpm(e.target.value)} placeholder="optional" /></Field>
      <div className="row" style={{ marginTop: 6 }}>
        <Button className="btn-sm" onClick={() => void api(`/tracks/${track.id}/rescan`, { method: "POST" }).then(onSaved)}>↻ Rescan loudness & artwork</Button>
      </div>
    </Modal>
  );
}

function formatCodec(t: Track): string {
  const codec = (t.codec || "").toLowerCase();
  if (codec === "mp3") {
    return t.bitrateKbps ? `MP3 ${t.bitrateKbps} kbps` : "MP3";
  }
  if (codec === "aac" || codec === "alac") {
    return t.bitrateKbps ? `${codec.toUpperCase()} ${t.bitrateKbps} kbps` : codec.toUpperCase();
  }
  if (codec === "flac") return t.bitrateKbps ? `FLAC ${t.bitrateKbps} kbps` : "FLAC";
  if (codec === "vorbis") return "Ogg Vorbis";
  if (codec === "opus") return "Opus";
  if (codec === "pcm_s16le" || codec === "pcm_s24le" || codec === "wav") return "WAV";
  if (codec) return t.bitrateKbps ? `${codec.toUpperCase()} ${t.bitrateKbps} kbps` : codec.toUpperCase();
  // Fall back to a friendly name from the MIME type when no codec was captured.
  if (t.mime === "audio/mpeg") return t.bitrateKbps ? `MP3 ${t.bitrateKbps} kbps` : "MP3";
  if (t.mime === "audio/flac") return t.bitrateKbps ? `FLAC ${t.bitrateKbps} kbps` : "FLAC";
  if (t.mime === "audio/aac") return t.bitrateKbps ? `AAC ${t.bitrateKbps} kbps` : "AAC";
  return t.bitrateKbps ? `${t.bitrateKbps} kbps` : "—";
}

function fmtDur(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** power;
  return `${value >= 100 || power === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[power]}`;
}
