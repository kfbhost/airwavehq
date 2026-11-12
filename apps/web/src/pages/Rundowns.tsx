import { useEffect, useMemo, useRef, useState } from "react";
import { api, getToken, upload } from "../api";
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHead, Select, Spinner, useFetch } from "../components/ui";
import type { RundownItem, ScheduleEntry, Show, Track, VoiceTrack } from "@airwavehq/shared";
import { VOICE_LINK_OVERLAP_IN_MS, VOICE_LINK_OVERLAP_OUT_MS, VOICE_SLOT_ESTIMATE_SEC, SHOW_OVERRUN_TARGET_SEC } from "@airwavehq/shared";

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

function fmtClock(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

interface TrackRow extends Track {
  isActive: boolean;
}

interface FolderInfo {
  name: string;
  count: number;
}

interface ScheduleRow extends ScheduleEntry {
  show: Show;
}

const DOWS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function formatSlot(entry: ScheduleRow): string {
  const day = entry.dayOfWeek === null ? "Daily" : DOWS[entry.dayOfWeek];
  return `${day} ${formatMinutes(entry.startMinutes)}-${formatMinutes(entry.endMinutes)}`;
}

function timingTone(deltaMin: number): "green" | "amber" | "red" {
  const abs = Math.abs(deltaMin);
  if (abs <= 3) return "green";
  if (abs <= 10) return "amber";
  return "red";
}

function voiceSlotIdent(item: RundownItem): string {
  return `VL-${item.id.slice(0, 6).toUpperCase()}`;
}

function defaultVoiceTitle(showName: string | undefined, item: RundownItem): string {
  const ident = voiceSlotIdent(item);
  return showName ? `${showName} ${ident}` : ident;
}

/** Duration a voice slot contributes to planning: real recording once recorded, else the 15s rule. */
function voiceDuration(it: RundownItem): number {
  if (it.kind !== "voice") return 0;
  return it.voice?.durationSeconds ?? VOICE_SLOT_ESTIMATE_SEC;
}

function airedDurationSec(items: RundownItem[]): number {
  let total = items.reduce((acc, it) => acc + (it.track?.durationSeconds ?? voiceDuration(it)), 0);
  for (let i = 0; i < items.length; i++) {
    const current = items[i]!;
    if (current.kind !== "voice") continue;
    const before = [...items.slice(0, i)].reverse().find((it) => it.kind === "track" && it.track)?.track;
    const after = items.slice(i + 1).find((it) => it.kind === "track" && it.track)?.track;
    if (before) total -= Math.min(VOICE_LINK_OVERLAP_IN_MS / 1000, before.durationSeconds);
    if (after) total -= Math.min(VOICE_LINK_OVERLAP_OUT_MS / 1000, after.durationSeconds);
  }
  return Math.max(0, total);
}

/* ---------------- In-browser voice recorder ---------------- */

function VoiceRecorder({
  showId,
  titleHint,
  slotIdent,
  beforeTrack,
  afterTrack,
  onClose,
  onSaved,
}: {
  showId: string;
  titleHint: string;
  slotIdent: string;
  beforeTrack: { title: string; artist: string } | null;
  afterTrack: { title: string; artist: string } | null;
  onClose: () => void;
  onSaved: (voice: VoiceTrack) => void;
}) {
  const [state, setState] = useState<"idle" | "recording" | "recorded">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [title, setTitle] = useState(titleHint);
  const [url, setUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const blobRef = useRef<Blob | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (timerRef.current) window.clearInterval(timerRef.current);
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async () => {
    setErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true } });
      streamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : "";
      // Opus at 192 kbps for a fuller, more broadcast-like voice recording.
      // Most browsers default to ~96 kbps, which sounds noticeably thinner next to the music.
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 192000 } : { audioBitsPerSecond: 192000 });
      recRef.current = rec;
      blobRef.current = null;
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) blobRef.current = e.data;
      };
      rec.onstop = () => {
        const blob = blobRef.current;
        if (blob) {
          setUrl(URL.createObjectURL(blob));
          setState("recorded");
        } else {
          setErr("No audio captured — try again.");
          setState("idle");
        }
        if (timerRef.current) {
          window.clearInterval(timerRef.current);
          timerRef.current = null;
        }
      };
      rec.start();
      setState("recording");
      const t0 = Date.now();
      timerRef.current = window.setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 250);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Mic access denied — check your browser's microphone permission.");
    }
  };

  const stop = () => {
    recRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const save = async () => {
    const blob = blobRef.current;
    if (!blob) return;
    setSaving(true);
    setErr(null);
    try {
      const ext = blob.type.includes("mp4") ? "m4a" : "webm";
      const form = new FormData();
      form.append("file", blob, `voice-link.${ext}`);
      form.append("title", title.trim() || "Voice link");
      form.append("showId", showId);
      form.append("playEvery", "5");
      const res = (await upload("/voice/upload", form)) as { voiceTrack: VoiceTrack };
      onSaved(res.voiceTrack);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed");
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`🎙 Record a voice link · ${slotIdent}`} footer={
      <>
        {state === "recorded" ? <Button variant="ghost" onClick={() => { setUrl(null); setState("idle"); blobRef.current = null; }}>Re-record</Button> : null}
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        {state === "recording" ? <Button variant="danger" onClick={stop}>■ Stop</Button> : null}
        {state === "idle" ? <Button variant="primary" onClick={() => void start()}>● Record</Button> : null}
        {state === "recorded" ? <Button variant="primary" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save to rundown"}</Button> : null}
      </>
    }>
      <Field label="Link name"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Intro link" /></Field>
      {beforeTrack || afterTrack ? (
        <div style={{ background: "var(--bg2)", borderRadius: 8, padding: "10px 12px", margin: "4px 0 12px", display: "flex", flexDirection: "column", gap: 6 }}>
          {beforeTrack ? (
            <div className="row" style={{ gap: 8, alignItems: "center" }}>
              <Badge tone="blue">Last played</Badge>
              <span style={{ fontWeight: 600 }}>{beforeTrack.title}</span>
              <span className="small muted">{beforeTrack.artist ?? ""}</span>
            </div>
          ) : null}
          {afterTrack ? (
            <div className="row" style={{ gap: 8, alignItems: "center" }}>
              <Badge tone="green">Up next</Badge>
              <span style={{ fontWeight: 600 }}>{afterTrack.title}</span>
              <span className="small muted">{afterTrack.artist ?? ""}</span>
            </div>
          ) : null}
          <p className="hint" style={{ margin: 0 }}>Mention these in your link — say what just played and what's coming up next.</p>
        </div>
      ) : null}
      {state === "recording" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 0" }}>
          <span className="rec-dot" />
          <strong>Recording… {elapsed}s</strong>
          <span className="small muted">speak, then press Stop</span>
        </div>
      ) : null}
      {state === "recorded" && url ? (
        <div style={{ padding: "8px 0" }}>
          <audio controls src={url} style={{ width: "100%" }} />
          <p className="hint">Listen back — when it sounds right, press <strong>Save to rundown</strong>.</p>
        </div>
      ) : null}
      {state === "idle" ? <p className="hint">Allow microphone access and press <strong>● Record</strong>. Keep it short — a few seconds of links sounds most natural between songs.</p> : null}
      {err ? <div className="err-text">{err}</div> : null}
    </Modal>
  );
}

/* ---------------- Web Audio preview of the rundown "as it would air" ---------------- */

async function fetchBuffer(ctx: AudioContext, url: string): Promise<AudioBuffer> {
  const token = getToken();
  const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  const buf = await res.arrayBuffer();
  return ctx.decodeAudioData(buf);
}

interface PreviewSeg {
  buffer: AudioBuffer;
  dur: number;
  offset: number;
  startAt: number;
  gainFrom: number;
  gainTo: number;
  fadeIn: number;
  fadeOut: number;
  label: string;
  kind: "track" | "voice";
}

const PREVIEW_INTRO_SECONDS = 8;
const PREVIEW_OUTRO_SECONDS = 8;
const PREVIEW_TRACK_GAIN = 0.58;
const PREVIEW_TRACK_DUCK_GAIN = 0.2;
const PREVIEW_VOICE_GAIN = 1;
const PREVIEW_EDGE_FADE_SECONDS = 0.35;
const PREVIEW_VOICE_OVERLAP_IN_SECONDS = 4;
const PREVIEW_VOICE_OVERLAP_OUT_SECONDS = 2.25;

function addPreviewSegment(
  segments: PreviewSeg[],
  buffer: AudioBuffer,
  label: string,
  kind: "track" | "voice",
  startAt: number,
  offset: number,
  dur: number,
  gainFrom: number,
  gainTo: number,
) {
  segments.push({
    buffer,
    dur,
    startAt,
    offset,
    gainFrom,
    gainTo,
    fadeIn: kind === "track" ? PREVIEW_EDGE_FADE_SECONDS : 0.08,
    fadeOut: kind === "track" ? PREVIEW_EDGE_FADE_SECONDS : 0.18,
    label,
    kind,
  });
}

export function Rundowns() {
  const params = new URLSearchParams(window.location.search);
  const { data: shows, loading: showsLoading } = useFetch(() => api<{ shows: Show[] }>("/shows"));
  const [showId, setShowId] = useState(params.get("show") ?? "");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [folder, setFolder] = useState("");
  const [kind, setKind] = useState("music"); // music | jingle | all
  const [insertAt, setInsertAt] = useState(0);

  const { data: rundown, loading, reload } = useFetch(
    () => (showId ? api<{ items: RundownItem[] }>(`/shows/${showId}/rundown`) : Promise.resolve({ items: [] as RundownItem[] })),
    [showId],
  );
  const { data: tracks } = useFetch(
    () => api<{ tracks: TrackRow[] }>(`/tracks?kind=${kind}&pageSize=200&search=${encodeURIComponent(query)}${folder ? `&folder=${encodeURIComponent(folder)}` : ""}`),
    [query, folder, kind],
  );
  const { data: folders } = useFetch(() => api<{ folders: FolderInfo[]; unfiled: number }>("/folders"));
  const { data: schedule } = useFetch(() => api<{ entries: ScheduleRow[] }>("/schedule"));

  const show = shows?.shows.find((s) => s.id === showId) ?? null;
  const items = rundown?.items ?? [];
  const musicTotalSec = items.reduce((acc, it) => acc + (it.track?.durationSeconds ?? 0), 0);
  const voiceTotalSec = items.reduce((acc, it) => acc + voiceDuration(it), 0);
  const voiceSlotCount = items.filter((it) => it.kind === "voice").length;
  const recordedVoiceCount = items.filter((it) => it.kind === "voice" && it.voice).length;
  const pendingVoiceCount = voiceSlotCount - recordedVoiceCount;
  const rawTotalSec = items.reduce((acc, it) => acc + (it.track?.durationSeconds ?? voiceDuration(it)), 0);
  const totalSec = airedDurationSec(items);
  const activeTracks = useMemo(() => (tracks?.tracks ?? []).filter((t) => t.isActive), [tracks]);
  const showSlots = useMemo(
    () => (schedule?.entries ?? []).filter((entry) => entry.show.id === showId),
    [schedule, showId],
  );
  const slotLengths = useMemo(
    () => Array.from(new Set(showSlots.map((entry) => entry.endMinutes - entry.startMinutes))),
    [showSlots],
  );
  const slotMinutes = slotLengths.length === 1 ? slotLengths[0]! : null;
  const slotSec = slotMinutes === null ? null : slotMinutes * 60;
  // Aim slightly OVER the slot so the last track fades into the top-of-hour
  // jingle; ~2 min also absorbs blank/short voice links so the show is never short.
  const aimSec = slotSec === null ? null : slotSec + SHOW_OVERRUN_TARGET_SEC;
  const overrunSec = slotSec === null ? null : totalSec - slotSec; // + = runs over the slot
  const deltaSec = aimSec === null ? null : totalSec - aimSec; // + = over the aim
  const deltaMinutes = deltaSec === null ? null : deltaSec / 60;
  const insertTarget = items[insertAt] ?? null;
  const insertSummary = !showId
    ? "Choose a show first."
    : items.length === 0
      ? "The first item will start the rundown."
      : insertTarget
        ? `New items go before #${insertAt + 1} (${insertTarget.kind === "voice" ? insertTarget.voice?.title ?? "Voice link" : insertTarget.track?.title ?? "Track"}).`
        : "New items go at the end of the rundown.";

  useEffect(() => {
    setInsertAt(items.length);
  }, [showId]);

  useEffect(() => {
    setInsertAt((curr) => Math.max(0, Math.min(curr, items.length)));
  }, [items.length]);

  const [recorder, setRecorder] = useState<{ itemId: string; title: string; ident: string; beforeTrack: { title: string; artist: string } | null; afterTrack: { title: string; artist: string } | null } | null>(null);
  const [autoOpen, setAutoOpen] = useState(false);
  const [autoFolder, setAutoFolder] = useState("");
  const [autoMinutes, setAutoMinutes] = useState(60);
  const [autoVoiceEvery, setAutoVoiceEvery] = useState(3);
  const [autoMode, setAutoMode] = useState<"append" | "replace">("append");
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoResult, setAutoResult] = useState<string | null>(null);
  const [draggedItemId, setDraggedItemId] = useState<string | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Preview state.
  const [previewLabel, setPreviewLabel] = useState<string | null>(null);
  const [previewItemId, setPreviewItemId] = useState<string | null>(null);
  const previewCtxRef = useRef<AudioContext | null>(null);
  const previewTimerRef = useRef<number | null>(null);
  const [trackPreviewId, setTrackPreviewId] = useState<string | null>(null);
  const [trackPreviewLabel, setTrackPreviewLabel] = useState<string | null>(null);
  const trackPreviewAudioRef = useRef<HTMLAudioElement | null>(null);
  const trackPreviewUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (previewTimerRef.current) window.clearInterval(previewTimerRef.current);
      void previewCtxRef.current?.close();
      trackPreviewAudioRef.current?.pause();
      if (trackPreviewUrlRef.current) URL.revokeObjectURL(trackPreviewUrlRef.current);
    };
  }, []);

  const stopPreview = () => {
    if (previewTimerRef.current) {
      window.clearInterval(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    void previewCtxRef.current?.close();
    previewCtxRef.current = null;
    setPreviewLabel(null);
    setPreviewItemId(null);
  };

  const stopTrackPreview = () => {
    trackPreviewAudioRef.current?.pause();
    trackPreviewAudioRef.current = null;
    if (trackPreviewUrlRef.current) {
      URL.revokeObjectURL(trackPreviewUrlRef.current);
      trackPreviewUrlRef.current = null;
    }
    setTrackPreviewId(null);
    setTrackPreviewLabel(null);
  };

  const findBeforeTrack = (index: number) =>
    [...items.slice(0, index)].reverse().find((it) => it.kind === "track" && it.track);

  const findAfterTrack = (index: number) =>
    items.slice(index + 1).find((it) => it.kind === "track" && it.track);

  const playPreview = async (itemId: string) => {
    if (previewItemId === itemId) {
      stopPreview();
      return;
    }
    stopTrackPreview();
    stopPreview();
    const voiceIndex = items.findIndex((it) => it.id === itemId);
    const voiceItem = items[voiceIndex];
    if (voiceIndex < 0 || voiceItem?.kind !== "voice" || !voiceItem.voice) return;
    const before = findBeforeTrack(voiceIndex);
    const after = findAfterTrack(voiceIndex);
    if (!before?.track || !after?.track) return;
    const ctx = new AudioContext();
    previewCtxRef.current = ctx;
    await ctx.resume();
    setPreviewItemId(itemId);
    setPreviewLabel("Loading audio…");
    const segs: PreviewSeg[] = [];
    let voiceWindow: { start: number; end: number; title: string } | null = null;
    try {
      const intro = await fetchBuffer(ctx, `/api/tracks/${before.track.id}/stream`);
      const introDur = Math.min(PREVIEW_INTRO_SECONDS, intro.duration);
      const introOffset = Math.max(0, intro.duration - introDur);
      addPreviewSegment(
        segs,
        intro,
        `Intro · ${before.track.title} — ${before.track.artist}`,
        "track",
        0,
        introOffset,
        introDur,
        PREVIEW_TRACK_GAIN,
        PREVIEW_TRACK_DUCK_GAIN,
      );
      const voice = await fetchBuffer(ctx, `/api/voice/${voiceItem.voice.id}/audio`);
      const voiceDur = Math.min(voiceItem.voice.durationSeconds || voice.duration, voice.duration);
      const voiceStart = Math.max(0.75, introDur - Math.min(PREVIEW_VOICE_OVERLAP_IN_SECONDS, introDur - 0.5));
      addPreviewSegment(segs, voice, voiceItem.voice.title, "voice", voiceStart, 0, voiceDur, PREVIEW_VOICE_GAIN, PREVIEW_VOICE_GAIN);
      const outro = await fetchBuffer(ctx, `/api/tracks/${after.track.id}/stream`);
      const outroDur = Math.min(PREVIEW_OUTRO_SECONDS, outro.duration);
      const outroStart = voiceStart + Math.max(0.4, voiceDur - Math.min(PREVIEW_VOICE_OVERLAP_OUT_SECONDS, Math.max(0.4, voiceDur - 0.2)));
      addPreviewSegment(
        segs,
        outro,
        `Return · ${after.track.title} — ${after.track.artist}`,
        "track",
        outroStart,
        0,
        outroDur,
        PREVIEW_TRACK_DUCK_GAIN,
        PREVIEW_TRACK_GAIN,
      );
      voiceWindow = { start: voiceStart, end: voiceStart + voiceDur, title: voiceItem.voice.title };
    } catch {
      setPreviewLabel("Preview unavailable");
      setPreviewItemId(null);
      void ctx.close();
      previewCtxRef.current = null;
      return;
    }
    if (segs.length === 0) {
      setPreviewLabel("Nothing to preview");
      void ctx.close();
      previewCtxRef.current = null;
      setPreviewItemId(null);
      return;
    }
    const start = ctx.currentTime + 0.1;
    for (const s of segs) {
      const src = ctx.createBufferSource();
      src.buffer = s.buffer;
      const g = ctx.createGain();
      const segmentStart = start + s.startAt;
      const audibleGainFrom = Math.max(0.0001, s.gainFrom);
      const audibleGainTo = Math.max(0.0001, s.gainTo);
      g.gain.setValueAtTime(0.0001, segmentStart);
      g.gain.linearRampToValueAtTime(audibleGainFrom, segmentStart + s.fadeIn);
      if (s.kind === "track" && s.gainFrom !== s.gainTo) {
        g.gain.linearRampToValueAtTime(audibleGainTo, segmentStart + Math.max(s.fadeIn, s.dur - s.fadeOut));
      } else {
        g.gain.setValueAtTime(audibleGainTo, segmentStart + Math.max(s.fadeIn, s.dur - s.fadeOut));
      }
      g.gain.linearRampToValueAtTime(0.0001, segmentStart + s.dur);
      src.connect(g).connect(ctx.destination);
      src.start(segmentStart, s.offset, s.dur);
    }
    const previewEnd = Math.max(...segs.map((s) => s.startAt + s.dur));
    const tick = () => {
      const elapsed = ctx.currentTime - start;
      let label = "Previewing live-style handoff";
      if (voiceWindow && elapsed >= voiceWindow.start && elapsed < voiceWindow.end) {
        label = `🎤 ${voiceWindow.title} · music ducked underneath`;
      } else {
        const activeTrack = segs.find((s) => s.kind === "track" && elapsed >= s.startAt && elapsed < s.startAt + s.dur);
        if (activeTrack) label = `🎵 ${activeTrack.label}`;
      }
      setPreviewLabel(label);
      if (elapsed >= previewEnd + 0.5) stopPreview();
    };
    tick();
    previewTimerRef.current = window.setInterval(tick, 500);
  };

  const playTrackPreview = async (track: TrackRow) => {
    if (trackPreviewId === track.id) {
      stopTrackPreview();
      return;
    }
    stopPreview();
    stopTrackPreview();
    setTrackPreviewId(track.id);
    setTrackPreviewLabel(`Loading ${track.title}…`);
    try {
      const token = getToken();
      const res = await fetch(`/api/tracks/${track.id}/stream`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`fetch /api/tracks/${track.id}/stream -> ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      trackPreviewUrlRef.current = url;
      const audio = new Audio(url);
      trackPreviewAudioRef.current = audio;
      audio.addEventListener("ended", () => {
        stopTrackPreview();
      }, { once: true });
      audio.addEventListener("error", () => {
        stopTrackPreview();
        setTrackPreviewLabel("Track preview unavailable");
      }, { once: true });
      await audio.play();
      setTrackPreviewLabel(`▶ Previewing ${track.title} — ${track.artist || "Unknown artist"}`);
    } catch {
      stopTrackPreview();
      setTrackPreviewLabel("Track preview unavailable");
    }
  };

  const addTrack = async (t: TrackRow) => {
    setBusy(true);
    try {
      await api(`/shows/${showId}/rundown`, { method: "POST", body: { kind: "track", trackId: t.id, position: insertAt } });
      setInsertAt((curr) => curr + 1);
      reload();
    } finally {
      setBusy(false);
    }
  };

  const addBlankVoice = async () => {
    setBusy(true);
    try {
      await api(`/shows/${showId}/rundown`, { method: "POST", body: { kind: "voice", position: insertAt } });
      setInsertAt((curr) => curr + 1);
      reload();
    } finally {
      setBusy(false);
    }
  };

  const removeItem = async (id: string) => {
    await api(`/rundown/${id}`, { method: "DELETE" });
    reload();
  };

  const move = async (index: number, dir: -1 | 1) => {
    const next = [...items];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j]!, next[index]!];
    await api(`/shows/${showId}/rundown/reorder`, { method: "POST", body: { ids: next.map((i) => i.id) } });
    reload();
  };

  const moveItemToIndex = async (itemId: string, targetIndex: number) => {
    const fromIndex = items.findIndex((it) => it.id === itemId);
    if (fromIndex < 0) return;
    const dragged = items[fromIndex]!;
    const remaining = items.filter((it) => it.id !== itemId);
    const adjustedIndex = fromIndex < targetIndex ? targetIndex - 1 : targetIndex;
    const boundedIndex = Math.max(0, Math.min(adjustedIndex, remaining.length));
    remaining.splice(boundedIndex, 0, dragged);
    await api(`/shows/${showId}/rundown/reorder`, { method: "POST", body: { ids: remaining.map((it) => it.id) } });
    setInsertAt(Math.max(0, Math.min(boundedIndex + 1, remaining.length)));
    reload();
  };

  const onRecorderSaved = async (voice: VoiceTrack) => {
    if (recorder) {
      await api(`/rundown/${recorder.itemId}`, { method: "PATCH", body: { voiceTrackId: voice.id } });
    }
    setRecorder(null);
    reload();
  };

  const buildAuto = async () => {
    if (!showId) return;
    setAutoBusy(true);
    setAutoResult(null);
    try {
      const res = await api<{ summary: { tracksAdded: number; voiceSlotsAdded: number; musicSeconds: number; airedSeconds: number; targetMinutes: number } }>(
        `/shows/${showId}/rundown/auto`,
        { method: "POST", body: { folder: autoFolder, targetMinutes: autoMinutes, voiceEvery: autoVoiceEvery, mode: autoMode } },
      );
      reload();
      const s = res.summary;
      setAutoResult(`Built ${s.tracksAdded} tracks + ${s.voiceSlotsAdded} voice slots ≈ ${fmtClock(s.airedSeconds)} aired — that's a little over the slot so the last track fades into the top-of-hour jingle. Record your links into the 🎤 slots.`);
    } catch (e) {
      setAutoResult(e instanceof Error ? e.message : "Could not build the rundown.");
    } finally {
      setAutoBusy(false);
    }
  };

  return (
    <>
      <PageHead
        title="Show Builder"
        sub="Build a pre-produced hour: pick the exact tracks, drop in your voice links where you want them, and audition each handoff with song intros and ducked music — just like live radio."
      />
      {showsLoading ? <Spinner /> : null}
      {!showsLoading && shows && shows.shows.length === 0 ? (
        <Card><Empty>No shows yet. Create a show on the Shows page, then build its rundown here.</Empty></Card>
      ) : (
        <>
          <Card className="rundown-show-card">
            <Field label="Show">
              <Select value={showId} onChange={(e) => { setShowId(e.target.value); setFolder(""); }}>
                <option value="">— choose a show —</option>
                {shows?.shows.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
            {show ? <p className="hint">When <strong>{show.name}</strong> is on air, the engine plays this rundown in order (looping until the show ends), with ad breaks still airing on time.</p> : null}
            {show ? <div className="row wrap" style={{ gap: 8, marginBottom: 8 }}><Badge tone="green">Saved live</Badge><span className="small muted">Every change is saved as you build, so when the hour sounds right it is ready to air.</span></div> : null}
            {showSlots.length > 0 ? (
              <div className="row wrap" style={{ gap: 8 }}>
                {showSlots.slice(0, 4).map((slot) => <Badge key={slot.id}>{formatSlot(slot)}</Badge>)}
                {showSlots.length > 4 ? <Badge>+{showSlots.length - 4} more</Badge> : null}
              </div>
            ) : show ? (
              <div className="small muted">This show is not on the schedule yet, so there is no slot-length target to compare against.</div>
            ) : null}
          </Card>

          {!showId ? null : (
            <div className="grid grid-2 rundown-body" style={{ alignItems: "start" }}>
              <Card title={`Rundown (${items.length} items)`}>
                {loading ? <Spinner /> : null}
                {!loading && items.length === 0 ? (
                  <Empty>Empty rundown. Add tracks, drop in blank voice slots where you want them, then record each link into place.</Empty>
                ) : null}
                <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
                  <Button variant="primary" className="btn-sm" disabled={busy || !showId} onClick={() => void addBlankVoice()}>
                    + Add blank voice slot
                  </Button>
                  <span className="small muted">Voice links live inside the rundown now, so each slot stays tied to the show and is managed where it airs.</span>
                </div>
                {!loading && items.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div
                      className={`rundown-insert ${insertAt === 0 ? "active" : ""} ${dragOverIndex === 0 ? "drag-over" : ""}`}
                      onDragOver={(e) => {
                        if (!draggedItemId) return;
                        e.preventDefault();
                        setDragOverIndex(0);
                      }}
                      onDragLeave={() => {
                        if (dragOverIndex === 0) setDragOverIndex(null);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (!draggedItemId) return;
                        void moveItemToIndex(draggedItemId, 0);
                        setDraggedItemId(null);
                        setDragOverIndex(null);
                      }}
                    >
                      <button type="button" onClick={() => setInsertAt(0)}>Insert at the start</button>
                    </div>
                    {items.map((it, i) => (
                      <div key={it.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <div
                          className={`rundown-row ${insertAt === i ? "selected" : ""} ${draggedItemId === it.id ? "dragging" : ""} ${it.kind === "voice" ? (it.voice ? "voice-complete" : "voice-pending") : ""}`}
                          draggable
                          onDragStart={() => {
                            setDraggedItemId(it.id);
                            setDragOverIndex(i);
                          }}
                          onDragEnd={() => {
                            setDraggedItemId(null);
                            setDragOverIndex(null);
                          }}
                        >
                          <span className="rundown-drag" title="Drag to reorder">⋮⋮</span>
                          <span className="rundown-pos">{i + 1}</span>
                          <span className="rundown-icon">{it.kind === "voice" ? "🎤" : "🎵"}</span>
                          <div className="rundown-main">
                            {it.kind === "voice" ? (
                              <>
                                <div className="row wrap" style={{ gap: 6, alignItems: "center" }}>
                                  <Badge tone={it.voice ? "green" : "amber"}>{voiceSlotIdent(it)}</Badge>
                                  {it.voice ? <Badge tone="green">Recorded</Badge> : <Badge tone="amber">Pending</Badge>}
                                </div>
                                <strong>{it.voice?.title ?? defaultVoiceTitle(show?.name, it)}</strong>
                                <span className="small muted">
                                  {it.voice ? `voice · ${fmt(it.voice.durationSeconds ?? 0)}` : "record into this slot when you're ready"}
                                </span>
                              </>
                            ) : (
                              <>
                                <strong>{it.track?.title ?? "Track"}</strong>
                                <span className="small muted">{it.track?.artist ?? ""} · {fmt(it.track?.durationSeconds ?? 0)}</span>
                              </>
                            )}
                          </div>
                          <div className="rundown-actions">
                            {it.kind === "voice" ? (
                              <>
                                <Button
                                  className="btn-sm"
                                  title={it.voice ? "Re-record this link" : "Record into this slot"}
                                  onClick={() => {
                                    const before = findBeforeTrack(i)?.track ?? null;
                                    const after = findAfterTrack(i)?.track ?? null;
                                    setRecorder({ itemId: it.id, title: it.voice?.title ?? defaultVoiceTitle(show?.name, it), ident: voiceSlotIdent(it), beforeTrack: before, afterTrack: after });
                                  }}
                                >
                                  {it.voice ? "🎙" : "Record"}
                                </Button>
                                <Button
                                  className="btn-sm"
                                  disabled={!it.voice || !findBeforeTrack(i)?.track || !findAfterTrack(i)?.track}
                                  title="Preview this link with the surrounding songs"
                                  onClick={() => void playPreview(it.id)}
                                >
                                  {previewItemId === it.id ? "■ Stop" : "▶ Preview"}
                                </Button>
                              </>
                            ) : null}
                            <Button className="btn-sm" disabled={i === 0} onClick={() => void move(i, -1)} title="Move up">↑</Button>
                            <Button className="btn-sm" disabled={i === items.length - 1} onClick={() => void move(i, 1)} title="Move down">↓</Button>
                            <Button className="btn-sm btn-danger" onClick={() => void removeItem(it.id)} title="Remove">×</Button>
                          </div>
                        </div>
                        <div
                          className={`rundown-insert ${insertAt === i + 1 ? "active" : ""} ${dragOverIndex === i + 1 ? "drag-over" : ""}`}
                          onDragOver={(e) => {
                            if (!draggedItemId) return;
                            e.preventDefault();
                            setDragOverIndex(i + 1);
                          }}
                          onDragLeave={() => {
                            if (dragOverIndex === i + 1) setDragOverIndex(null);
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            if (!draggedItemId) return;
                            void moveItemToIndex(draggedItemId, i + 1);
                            setDraggedItemId(null);
                            setDragOverIndex(null);
                          }}
                        >
                          <button type="button" onClick={() => setInsertAt(i + 1)}>
                            Insert after #{i + 1}
                          </button>
                        </div>
                      </div>
                    ))}
                    <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                      <div className="timing-overview">
                        <div className="timing-stat">
                          <span>Music total</span>
                          <strong>{fmtClock(musicTotalSec)}</strong>
                        </div>
                        <div className="timing-stat">
                          <span>Voice links</span>
                          <strong>{fmtClock(voiceTotalSec)}</strong>
                        </div>
                        <div className="timing-stat">
                          <span>Source total</span>
                          <strong>{fmtClock(rawTotalSec)}</strong>
                        </div>
                        <div className="timing-stat">
                          <span>Aired length</span>
                          <strong>{fmtClock(totalSec)}</strong>
                        </div>
                      </div>
                      {slotSec !== null && overrunSec !== null ? (
                        <div className={`timing-status ${overrunSec < 0 ? "short" : overrunSec <= SHOW_OVERRUN_TARGET_SEC + 45 ? "on-time" : "over"}`}>
                          <strong>
                            {overrunSec < 0
                              ? `${fmtClock(Math.abs(overrunSec))} short of the slot`
                              : overrunSec <= SHOW_OVERRUN_TARGET_SEC + 45
                                ? `On target · ${fmtClock(overrunSec)} over the slot`
                                : `${fmtClock(overrunSec)} over the slot`}
                          </strong>
                          <span>
                            Scheduled slot {fmtClock(slotSec)} · planned {fmtClock(totalSec)} · aim ~{fmtClock(SHOW_OVERRUN_TARGET_SEC)} over so the last track fades into the top-of-hour jingle
                          </span>
                        </div>
                      ) : null}
                      <div className="row wrap" style={{ gap: 8, alignItems: "center" }}>
                        <Badge tone="blue">{insertSummary}</Badge>
                        {slotSec !== null && overrunSec !== null && deltaMinutes !== null ? (
                          <Badge tone={timingTone(deltaMinutes)}>
                            Slot {slotMinutes} min · {overrunSec < 0 ? `${Math.abs(overrunSec / 60).toFixed(1)} min short` : `${(overrunSec / 60).toFixed(1)} min over`} · aim ~2 min over
                          </Badge>
                        ) : null}
                      </div>
                      <div className="small muted">
                        Voice links add <strong>{fmtClock(voiceTotalSec)}</strong> — recorded links use their real length, and {pendingVoiceCount > 0 ? `the ${pendingVoiceCount} blank slot${pendingVoiceCount === 1 ? "" : "s"} count as ~${VOICE_SLOT_ESTIMATE_SEC}s each until recorded` : "all slots are recorded"}. The build aims ~{fmtClock(SHOW_OVERRUN_TARGET_SEC)} over the slot, so even if some links end up short or unrecorded the show still reaches the hour — the last track fades out before the top-of-hour jingle.
                      </div>
                      <div className="small muted">
                        Record into each blank voice slot, then use that slot's <strong>Preview</strong> button to hear the join with the song before and after.
                      </div>
                      <div className="small muted">
                        You can also drag any track or voice slot up and down the rundown to drop it exactly where you want it.
                      </div>
                      <div className="small muted">
                        Show voice recordings stay archived with this show in the background, and they are cleared out automatically if the show is deleted.
                      </div>
                      {previewLabel ? <div className="small">{previewLabel}</div> : null}
                    </div>
                  </div>
                ) : null}
              </Card>

              <div className="rundown-side" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <Card title="⚡ Quick build">
                  <p className="hint" style={{ marginTop: 0 }}>
                    In a rush? Pick a genre folder and auto-fill the show with music and blank voice slots spaced through it — then just record your links.
                  </p>
                  <Button variant="primary" className="btn-sm" disabled={!showId} onClick={() => { setAutoFolder(""); setAutoMinutes(60); setAutoVoiceEvery(3); setAutoMode("append"); setAutoResult(null); setAutoOpen(true); }}>
                    Auto-build rundown
                  </Button>
                </Card>
                <Card title="Add a track / jingle">
                  <div className="form-row">
                    <Field label="Type">
                      <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                        <option value="music">Music</option>
                        <option value="jingle">Jingles</option>
                        <option value="all">All</option>
                      </Select>
                    </Field>
                    <Field label="Folder">
                      <Select value={folder} onChange={(e) => setFolder(e.target.value)}>
                        <option value="">All folders</option>
                        <option value="unfiled">Unfiled</option>
                        {folders?.folders.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
                      </Select>
                    </Field>
                    <Field label="Search">
                      <Input placeholder="Search your library…" value={query} onChange={(e) => setQuery(e.target.value)} />
                    </Field>
                  </div>
                  <div className="small muted" style={{ marginBottom: 8 }}>
                    {insertSummary}
                  </div>
                  <div className="small muted" style={{ marginBottom: 8 }}>
                    Showing <strong>{activeTracks.length}</strong> matching {kind === "jingle" ? "jingles" : kind === "all" ? "tracks + jingles" : "tracks"}. Choose <strong>Jingles</strong> above to throw one into the show manually. Use preview to audition before adding.
                  </div>
                  <div className="rundown-pick track-picker" style={{ marginTop: 8 }}>
                    {activeTracks.map((t) => (
                      <div key={t.id} className="rundown-row">
                        <span className="rundown-icon">{t.kind === "jingle" ? "🔔" : "🎵"}</span>
                        <div className="rundown-main">
                          <strong>{t.title}</strong>
                          <span className="small muted">{t.artist} · {fmt(t.durationSeconds)}{t.folder ? ` · ${t.folder}` : ""}{t.kind === "jingle" ? " · jingle" : ""}</span>
                        </div>
                        <div className="rundown-actions">
                          <Button className="btn-sm" onClick={() => void playTrackPreview(t)}>
                            {trackPreviewId === t.id ? "■ Stop" : "▶ Preview"}
                          </Button>
                          <Button className="btn-sm" disabled={busy} onClick={() => void addTrack(t)}>+ Add</Button>
                        </div>
                      </div>
                    ))}
                    {activeTracks.length === 0 ? <div className="small muted">No matching {kind === "jingle" ? "jingles" : "tracks"}.</div> : null}
                  </div>
                  {trackPreviewLabel ? <div className="small" style={{ marginTop: 8 }}>{trackPreviewLabel}</div> : null}
                </Card>
              </div>
            </div>
          )}
        </>
      )}

      {recorder ? (
        <VoiceRecorder
          showId={showId}
          titleHint={recorder.title}
          slotIdent={recorder.ident}
          beforeTrack={recorder.beforeTrack}
          afterTrack={recorder.afterTrack}
          onClose={() => setRecorder(null)}
          onSaved={(v) => void onRecorderSaved(v)}
        />
      ) : null}

      {autoOpen ? (
        <Modal
          open
          onClose={() => setAutoOpen(false)}
          title="⚡ Quick build a show"
          footer={
            <>
              <Button variant="ghost" onClick={() => setAutoOpen(false)}>Close</Button>
              <Button variant="primary" disabled={autoBusy} onClick={() => void buildAuto()}>
                {autoBusy ? "Building…" : autoMode === "replace" ? "Replace rundown" : "Add to rundown"}
              </Button>
            </>
          }
        >
          <Field label="Genre folder">
            <Select value={autoFolder} onChange={(e) => setAutoFolder(e.target.value)}>
              <option value="">All folders</option>
              <option value="unfiled">Unfiled</option>
              {folders?.folders.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
            </Select>
          </Field>
          <div className="form-row">
            <Field label="Show length">
              <Select value={autoMinutes} onChange={(e) => setAutoMinutes(Number(e.target.value))}>
                {[60, 120, 180].map((m) => <option key={m} value={m}>{m / 60} hr{m === 60 ? "" : "s"}</option>)}
              </Select>
            </Field>
            <Field label="Voice link every">
              <Select value={autoVoiceEvery} onChange={(e) => setAutoVoiceEvery(Number(e.target.value))}>
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>every {n} track{n === 1 ? "" : "s"}</option>)}
              </Select>
            </Field>
            <Field label="Where">
              <Select value={autoMode} onChange={(e) => setAutoMode(e.target.value as "append" | "replace")}>
                <option value="append">Add to end</option>
                <option value="replace">Replace rundown</option>
              </Select>
            </Field>
          </div>
          <p className="hint" style={{ marginTop: 0 }}>
            Tracks are picked at random to fill the length, with blank voice slots about every {autoVoiceEvery} tracks (roughly every {Math.round(autoVoiceEvery * 3.5)} min).
            Each blank slot counts as ~{VOICE_SLOT_ESTIMATE_SEC}s towards the length, and the build aims ~{fmtClock(SHOW_OVERRUN_TARGET_SEC)} over the slot so the last track fades into the top-of-hour jingle even if some links are short or unrecorded.
            Replace clears the current rundown first. Re-run to get a different selection — nothing is saved until you press build.
          </p>
          {autoResult ? (
            <p className="hint" style={{ marginTop: 10, color: autoResult.startsWith("Built") ? "var(--green)" : "var(--red)" }}>{autoResult}</p>
          ) : null}
        </Modal>
      ) : null}
    </>
  );
}
