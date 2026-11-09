import { useEffect, useRef, useState } from "react";
import { api, getToken, upload } from "../api";
import { Badge, Button, Card, Empty, PageHead, Select, Spinner, useFetch } from "../components/ui";

type BackupType = "db" | "media" | "recordings" | "voice" | "config" | "data";
type Component = "db" | "media" | "recordings" | "voice" | "config";

interface BackupRow {
  id: string;
  type: BackupType;
  size: number;
  modified: string;
}

interface Meta {
  icon: string;
  label: string;
  tone: "blue" | "green" | "amber" | "default";
  blurb: string;
  /** Sizable components get a live size hint from the server. */
  sized: boolean;
  /** Shown as a choice in the create panel (legacy `data` is restore-only). */
  creatable: boolean;
}

const META: Record<BackupType, Meta> = {
  db: {
    icon: "🗄️",
    label: "Settings & data",
    tone: "blue",
    blurb:
      "Settings, users, shows, schedule, playlists, rotations, DJ slots and the library index. Small — this is the one that rebuilds your station's setup on a fresh install.",
    sized: true,
    creatable: true,
  },
  media: {
    icon: "🎵",
    label: "Music library",
    tone: "green",
    blurb: "The music files and artwork in your library.",
    sized: true,
    creatable: true,
  },
  recordings: {
    icon: "🎙️",
    label: "Show recordings",
    tone: "green",
    blurb: "The listen-again recordings of past shows.",
    sized: true,
    creatable: true,
  },
  voice: {
    icon: "🔊",
    label: "Voice links",
    tone: "green",
    blurb: "Voice-links recorded in the studio.",
    sized: true,
    creatable: true,
  },
  config: {
    icon: "🔑",
    label: "Config",
    tone: "amber",
    blurb: "Your .env secrets (database password, stream keys).",
    sized: false,
    creatable: true,
  },
  data: {
    icon: "📦",
    label: "Legacy full data",
    tone: "default",
    blurb: "An older single archive holding the whole data folder. Still restorable.",
    sized: false,
    creatable: false,
  },
};

const CREATABLE: Component[] = ["db", "media", "recordings", "voice", "config"];
// Components worth streaming straight off the server. Config is a kilobyte, so
// it is only ever written to disk; these are the ones that need real space.
const STREAMABLE: Component[] = ["db", "media", "recordings", "voice"];
const RESTORABLE: BackupType[] = ["db", "media", "recordings", "voice", "config", "data"];

interface FileJob {
  id: string;
  kind: "backup" | "restore";
  state: "running" | "done" | "error";
  /** 0–100, or null while the current step has no measurable size. */
  percent: number | null;
  label: string;
  detail: string | null;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
}

/** What a restore rebuilt, so the page can report it instead of a bare "done". */
interface IndexReport {
  added: number;
  fromManifest: number;
  total: number;
}

/** crypto.randomUUID needs a secure context, so keep a fallback for local dev. */
function newJobId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `job-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

/**
 * The bar shimmers while a step has no measurable size (clearing the database,
 * rebuilding the index) so the page never looks frozen.
 */
function Progress({ percent, processing }: { percent: number | null; processing: boolean }) {
  return (
    <div className={`progress-bar progress-bar-lg${processing ? " is-processing" : ""}`} style={{ marginTop: 6 }}>
      <div style={{ width: percent === null ? "100%" : `${percent}%` }} />
    </div>
  );
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function downloadUrl(id: string): string {
  const token = getToken();
  return `/api/backups/${encodeURIComponent(id)}/download${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

/** Streams a component to the browser without staging a file on the server. */
function streamUrl(component: Component): string {
  const token = getToken();
  return `/api/backups/stream/${component}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

/** The starting selection: settings only, so the common backup is instant and tiny. */
const DEFAULT_PICK: Record<Component, boolean> = {
  db: true,
  media: false,
  recordings: false,
  voice: false,
  config: true,
};

export function Backups() {
  const { data, loading, reload } = useFetch(() => api<{ backups: BackupRow[] }>("/backups"));
  // `sizes.free` is the server's free space, not a component size.
  const sizes = useFetch(() => api<{ sizes: Record<string, number | null> }>("/backups/sizes"));
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [pick, setPick] = useState<Record<Component, boolean>>({ ...DEFAULT_PICK });
  const [restorePick, setRestorePick] = useState<Record<BackupType, string>>({
    db: "",
    media: "",
    recordings: "",
    voice: "",
    config: "",
    data: "",
  });
  const [confirmed, setConfirmed] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [job, setJob] = useState<FileJob | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [finishingUpload, setFinishingUpload] = useState(false);

  // Tick only while work is running, so the elapsed time proves the job is alive.
  useEffect(() => {
    if (job?.state !== "running") return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [job]);

  /**
   * Runs a long backup or restore with a job id, polling the API for progress
   * while it waits. The request only answers when the work is finished, so
   * without the poll the page had nothing to show between the click and the
   * result.
   */
  const withProgress = async <T,>(
    kind: "backup" | "restore",
    path: string,
    body: Record<string, unknown>
  ): Promise<T> => {
    const jobId = newJobId();
    const startedAt = Date.now();
    setJob({
      id: jobId,
      kind,
      state: "running",
      percent: null,
      label: kind === "backup" ? "Preparing the backup…" : "Preparing the restore…",
      detail: null,
      error: null,
      startedAt,
      endedAt: null,
    });
    setNow(startedAt);

    let stopped = false;
    const poll = (async () => {
      while (!stopped) {
        await new Promise((r) => setTimeout(r, 700));
        if (stopped) break;
        try {
          const r = await api<{ job: FileJob }>(`/backups/jobs/${jobId}`);
          setJob(r.job);
        } catch {
          // A dropped poll is harmless — the next one catches up.
        }
      }
    })();

    try {
      const result = await api<T>(path, { method: "POST", body: { ...body, jobId } });
      // The request finishing is authoritative: the last poll may have landed
      // a moment before the work actually ended.
      setJob((j) =>
        j && j.id === jobId ? { ...j, state: "done", percent: 100, label: "Done", detail: null, endedAt: Date.now() } : j
      );
      return result;
    } catch (e) {
      const text = e instanceof Error ? e.message : "Request failed.";
      setJob((j) => (j && j.id === jobId ? { ...j, state: "error", percent: null, error: text, endedAt: Date.now() } : j));
      throw e;
    } finally {
      stopped = true;
      await poll;
      reload();
    }
  };

  const backups = data?.backups ?? [];
  const byType = (t: BackupType) => backups.filter((b) => b.type === t);
  const chosen = CREATABLE.filter((c) => pick[c]);
  const chosenSized = sizes.data?.sizes ?? {};

  const anythingPicked = RESTORABLE.some((t) => restorePick[t]);

  const freeBytes = typeof chosenSized.free === "number" ? chosenSized.free : null;
  // Would archiving the ticked components run the server out of disk? The
  // archive is roughly the size of its contents, so a straight comparison is a
  // good enough warning — and the fix is the direct-download buttons below.
  const wontFit = CREATABLE.filter((c) => {
    const size = chosenSized[c];
    return pick[c] && META[c].sized && freeBytes !== null && typeof size === "number" && size > freeBytes;
  });

  const create = async () => {
    if (chosen.length === 0) {
      setMsg({ tone: "err", text: "Choose at least one thing to back up." });
      return;
    }
    setCreating(true);
    setMsg(null);
    try {
      const r = await withProgress<{ created?: string[] }>("backup", "/backups", { components: chosen });
      const n = r.created?.length ?? chosen.length;
      setMsg({ tone: "ok", text: `Backup created — ${n} file${n === 1 ? "" : "s"}: ${(r.created ?? []).join(", ")}` });
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof Error ? e.message : "Backup failed." });
    } finally {
      setCreating(false);
    }
  };

  const onFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    setUploadPct(0);
    setFinishingUpload(false);
    setMsg(null);
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      await upload("/backups/upload", form, {
        onProgress: (loaded, total) => setUploadPct(total > 0 ? Math.round((loaded / total) * 100) : null),
        // The bytes are all sent, but the server still has to flush them to disk.
        onProcessing: () => {
          setUploadPct(100);
          setFinishingUpload(true);
        },
      });
      setMsg({ tone: "ok", text: `Backup “${file.name}” uploaded. It can now be restored on this server.` });
      reload();
    } catch (err) {
      setMsg({ tone: "err", text: err instanceof Error ? err.message : "Upload failed." });
    } finally {
      setUploading(false);
      setUploadPct(null);
      setFinishingUpload(false);
    }
  };

  const del = async (b: BackupRow) => {
    if (!confirm(`Delete ${b.id}? This cannot be undone.`)) return;
    await api(`/backups/${encodeURIComponent(b.id)}`, { method: "DELETE" });
    setRestorePick((p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v === b.id ? "" : v])) as Record<BackupType, string>);
    reload();
  };

  const restore = async () => {
    if (!anythingPicked || !confirmed) return;
    setRestoring(true);
    setMsg(null);
    try {
      const body: Record<string, string> = {};
      for (const t of RESTORABLE) if (restorePick[t]) body[t] = restorePick[t];
      const r = await withProgress<{
        restored: Record<string, boolean>;
        index?: Record<string, IndexReport>;
        note?: string;
      }>("restore", "/backups/restore", body);
      const parts = RESTORABLE.filter((t) => r.restored[t]).map((t) => META[t].label.toLowerCase());
      // Say what the restore actually put back — a restore that silently added
      // nothing is exactly what this used to hide.
      const rebuilt = Object.entries(r.index ?? {})
        .filter(([, v]) => v.added > 0)
        .map(([k, v]) => `${v.added} ${k === "media" ? "music library" : k}`);
      setMsg({
        tone: "ok",
        text: `Restore complete (${parts.join(" + ")}).${
          rebuilt.length ? ` Rebuilt the index: ${rebuilt.join(", ")}.` : ""
        }${r.note ? ` ${r.note}` : ""} Reloading…`,
      });
      setConfirmed(false);
      setTimeout(() => window.location.reload(), 1800);
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof Error ? e.message : "Restore failed." });
      setRestoring(false);
    }
  };

  return (
    <>
      <PageHead
        title="Backups"
        sub="Back up each part of the station separately. Settings & data is tiny and rebuilds your whole setup on a fresh install — the music library, recordings and voice links can be archived on their own, whenever suits."
        actions={
          <div className="row" style={{ gap: 8 }}>
            <input
              ref={fileRef}
              type="file"
              accept=".gz,.sql.gz,.tar.gz,.env"
              style={{ display: "none" }}
              onChange={(e) => void onFilePick(e)}
            />
            <Button variant="ghost" disabled={uploading} onClick={() => fileRef.current?.click()}>
              {uploading ? "Uploading…" : "📤 Upload backup"}
            </Button>
            <Button variant="primary" disabled={creating || chosen.length === 0} onClick={() => void create()}>
              {creating ? "Creating…" : "💾 Create backup"}
            </Button>
          </div>
        }
      />

      {msg ? (
        <div className={`badge ${msg.tone === "err" ? "red" : "green"}`} style={{ marginBottom: 10 }}>
          {msg.text}
        </div>
      ) : null}

      {job && job.state === "running" ? (
        <Card style={{ marginBottom: 14 }}>
          <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <strong>{job.kind === "backup" ? "Creating the backup" : "Restoring"}</strong>
            <span className="small muted">
              {job.percent === null ? "working…" : `${job.percent}%`}
              {job.detail ? ` · ${job.detail}` : ""} · {fmtElapsed(now - job.startedAt)} elapsed
            </span>
          </div>
          <div className="small" style={{ marginTop: 6 }}>
            {job.label}
          </div>
          <Progress percent={job.percent} processing={job.percent === null} />
          <p className="hint" style={{ marginBottom: 0 }}>
            This runs on the server, so it keeps going if the browser closes — but keep the page open to see the result.
          </p>
        </Card>
      ) : null}

      {uploading ? (
        <Card style={{ marginBottom: 14 }}>
          <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
            <strong>Uploading the backup</strong>
            <span className="small muted">
              {uploadPct === null ? "working…" : `${uploadPct}%`}
            </span>
          </div>
          <div className="small" style={{ marginTop: 6 }}>
            {finishingUpload ? "Saving it on the server…" : "Sending the file to the server…"}
          </div>
          <Progress percent={uploadPct} processing={finishingUpload} />
        </Card>
      ) : null}

      {/* Create — choose exactly what goes into this snapshot. */}
      <Card style={{ marginBottom: 14 }}>
        <h3 style={{ marginTop: 0 }}>Create a backup</h3>
        <p className="hint" style={{ marginTop: 0 }}>
          Tick what to include. Sizes show what each part currently takes on the server.
        </p>
        <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
          <Button
            className="btn-sm btn-ghost"
            onClick={() => setPick({ db: true, media: false, recordings: false, voice: false, config: true })}
          >
            Settings only
          </Button>
          <Button
            className="btn-sm btn-ghost"
            onClick={() => setPick({ db: false, media: true, recordings: false, voice: false, config: false })}
          >
            Music library only
          </Button>
          <Button
            className="btn-sm btn-ghost"
            onClick={() => setPick({ db: true, media: true, recordings: true, voice: true, config: true })}
          >
            Everything
          </Button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {CREATABLE.map((c) => {
            const m = META[c];
            const size = m.sized ? chosenSized[c] : null;
            return (
              <label key={c} className="row" style={{ gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={pick[c]}
                  style={{ marginTop: 3 }}
                  onChange={(e) => setPick((p) => ({ ...p, [c]: e.target.checked }))}
                />
                <div style={{ minWidth: 0 }}>
                  <div className="row wrap" style={{ gap: 6, alignItems: "center" }}>
                    <span>{m.icon}</span>
                    <strong>{m.label}</strong>
                    {m.sized ? (
                      <Badge tone="default">
                        {sizes.loading ? "…" : typeof size === "number" ? fmtSize(size) : sizes.error ? "unknown" : "empty"}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="small muted" style={{ marginTop: 2 }}>{m.blurb}</div>
                </div>
              </label>
            );
          })}
        </div>
        {pick.media || pick.recordings ? (
          <p className="hint" style={{ marginBottom: 0 }}>
            Archiving the media library can take several minutes on a large library — the page waits, so leave it open.
          </p>
        ) : null}

        {wontFit.length > 0 ? (
          <div className="badge red" style={{ marginTop: 10, whiteSpace: "normal" }}>
            Not enough free space on the server: {wontFit.map((c) => META[c].label).join(" + ")} need more room than the{" "}
            {fmtSize(freeBytes ?? 0)} that is free. Use the direct downloads below instead — they never touch the server's
            disk.
          </div>
        ) : null}

        <div style={{ borderTop: "1px solid var(--border)", marginTop: 12, paddingTop: 10 }}>
          <strong>Direct download (uses no server space)</strong>
          <p className="hint" style={{ marginTop: 4 }}>
            Streams the backup straight to your computer instead of saving it on the server first, so it works even when
            the archive is bigger than the server's free disk. Keep the file somewhere safe locally, or upload it to
            another station with <strong>📤 Upload backup</strong> and restore it there.
          </p>
          <div className="row wrap" style={{ gap: 6 }}>
            {STREAMABLE.map((c) => (
              <a key={c} className="btn btn-sm" href={streamUrl(c)}>
                ⬇ {META[c].label}
              </a>
            ))}
          </div>
          <p className="hint" style={{ marginBottom: 0, marginTop: 6 }}>
            Leave the tab open until the download finishes — a large library can take a while, and stopping it means
            starting again.
          </p>
        </div>
      </Card>

      {loading ? <Spinner /> : null}
      {!loading && backups.length === 0 ? (
        <Card>
          <Empty>
            No backups yet. <strong>Settings & data</strong> plus <strong>Config</strong> is the quick, small one to start
            with — add the media library whenever you want a copy of the audio.
          </Empty>
        </Card>
      ) : null}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {backups.map((b) => {
          const m = META[b.type];
          return (
            <Card key={b.id}>
              <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div className="row wrap" style={{ gap: 6, alignItems: "center" }}>
                    <span>{m.icon}</span>
                    <strong style={{ wordBreak: "break-all" }}>{b.id}</strong>
                    <Badge tone={m.tone}>{m.label}</Badge>
                  </div>
                  <div className="small muted" style={{ marginTop: 4 }}>
                    {fmtDate(b.modified)} · {fmtSize(b.size)}
                  </div>
                </div>
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  <a className="btn btn-sm" href={downloadUrl(b.id)} download={b.id}>⬇ Download</a>
                  <Button className="btn-sm btn-danger" onClick={() => void del(b)}>×</Button>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      <Card style={{ marginTop: 16, border: "1px solid rgba(255,80,80,.35)" }}>
        <h3 style={{ marginTop: 0 }}>⚠️ Restore</h3>
        <p className="hint">
          Restoring <strong>replaces the current station data</strong> with the chosen backup. The database restore wipes
          the current settings, users, shows, schedule and library index, then reloads the snapshot; the media,
          recordings and voice restores replace those folders with the archived copies (files added since the backup are
          kept). Restoring the <strong>database + media library</strong> together is what rebuilds a station on a fresh
          install. The config restore rewrites your server's .env file — it takes effect on the next restart.
        </p>
        <p className="hint">
          Music, recordings and voice archives carry their own index, so restoring one on its own makes those files show
          up again — you do not have to restore the database as well. The restore tells you afterwards how many entries
          it rebuilt.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
          {RESTORABLE.map((t) => {
            const m = META[t];
            const options = byType(t);
            return (
              <div className="field" key={t}>
                <label className="field-label">
                  {m.icon} {m.label}
                </label>
                <Select
                  value={restorePick[t]}
                  disabled={options.length === 0}
                  onChange={(e) => setRestorePick((p) => ({ ...p, [t]: e.target.value }))}
                >
                  <option value="">— none —</option>
                  {options.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.id} · {fmtSize(b.size)}
                    </option>
                  ))}
                </Select>
                {options.length === 0 ? <span className="hint">No {m.label.toLowerCase()} backups on this server yet.</span> : null}
              </div>
            );
          })}
          <label className="row" style={{ gap: 8, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>I understand this replaces the current data and cannot be undone.</span>
          </label>
          <div>
            <Button variant="danger" disabled={restoring || !anythingPicked || !confirmed} onClick={() => void restore()}>
              {restoring ? "Restoring…" : "Restore from backups"}
            </Button>
          </div>
        </div>
      </Card>
    </>
  );
}
