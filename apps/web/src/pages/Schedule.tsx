import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { api } from "../api";
import { Button, Card, Empty, Field, Input, Modal, PageHead, Select, Spinner, useFetch } from "../components/ui";
import type { Djslot, ScheduleEntry, Show, StationRotation, StationSettings, User } from "@radiohost/shared";
import { minutesToHHMM } from "@radiohost/shared";

interface EntryRow extends ScheduleEntry {
  show: Show;
}

interface RotationRow extends StationRotation {
  playlistName: string | null;
  clockwheelName: string | null;
}

// Per-day playlist columns, indexed 0=Sun..6=Sat (matches DOWS).
const DAY_PLAYLIST_COLUMNS = [
  "sundayPlaylistId",
  "mondayPlaylistId",
  "tuesdayPlaylistId",
  "wednesdayPlaylistId",
  "thursdayPlaylistId",
  "fridayPlaylistId",
  "saturdayPlaylistId",
] as const;

const DOWS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Columns ordered Monday-first (Sun=0 ... Sat=6 internally, but the week starts Monday).
const WEEK_DOW = [1, 2, 3, 4, 5, 6, 0];
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const HOUR_PX = 56; // px per hour

export function Schedule() {
  const { data, loading, reload } = useFetch(() => api<{ entries: EntryRow[] }>("/schedule"));
  const { data: showsData } = useFetch(() => api<{ shows: Show[] }>("/shows"));
  const { data: rotationsData } = useFetch(() => api<{ rotations: StationRotation[] }>("/rotations"));
  const { data: playlistsData } = useFetch(() => api<{ playlists: Array<{ id: string; name: string }> }>("/playlists"));
  const { data: clockwheelsData } = useFetch(() => api<{ clockwheels: Array<{ id: string; name: string }> }>("/clockwheels"));
  const { data: settingsData } = useFetch(() => api<{ settings: StationSettings }>("/settings"));
  const { data: meData } = useFetch(() => api<{ user: User }>("/auth/me"));
  const isDj = meData?.user.role === "dj";
  const { data: djSlotsData } = useFetch(() => api<{ slots: Djslot[] }>("/dj-slots"));
  const [addOpen, setAddOpen] = useState(false);
  const [editEntry, setEditEntry] = useState<EntryRow | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const stationTz = settingsData?.settings.timezone || "UTC";
  const stationParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: stationTz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(new Date(now));
  const partMap = Object.fromEntries(stationParts.map((p) => [p.type, p.value]));
  const nowHour = Number(partMap.hour ?? "0");
  const nowMinute = Number(partMap.minute ?? "0");
  const nowDowLabel = partMap.weekday ?? "Sun";
  const nowDow = DOWS.findIndex((d) => d === nowDowLabel);
  const nowMinutes = nowHour * 60 + nowMinute;
  const nowTopPx = (nowMinutes / 60) * HOUR_PX;
  const nowLabel = `${String(nowHour).padStart(2, "0")}:${String(nowMinute).padStart(2, "0")}`;

  const deleteEntry = (id: string) => {
    if (!confirm("Remove this schedule entry?")) return;
    void api(`/schedule/${id}`, { method: "DELETE" }).then(reload);
  };

  const playlistNameOf = (id: string | null | undefined) =>
    id ? playlistsData?.playlists.find((playlist) => playlist.id === id)?.name ?? null : null;

  const rotations: RotationRow[] = (rotationsData?.rotations ?? []).map((rotation) => ({
    ...rotation,
    playlistName: playlistNameOf(rotation.playlistId),
    clockwheelName: clockwheelsData?.clockwheels.find((clockwheel) => clockwheel.id === rotation.clockwheelId)?.name ?? null,
  }));

  // For a daily block, the playlist actually playing on a given weekday.
  const rotationPlaylistOnDay = (rotation: RotationRow, dow: number): string | null => {
    if (rotation.dayOfWeek !== null) return rotation.playlistName;
    const column = DAY_PLAYLIST_COLUMNS[dow] ?? null;
    const dayId = column ? rotation[column] : null;
    return playlistNameOf(dayId ?? rotation.playlistId);
  };

  const entriesByDow = (dow: number) =>
    (data?.entries ?? []).filter((e) => e.dayOfWeek === null || e.dayOfWeek === dow);
  const rotationsByDow = (dow: number) =>
    rotations.filter((rotation) => rotation.isActive && (rotation.dayOfWeek === null || rotation.dayOfWeek === dow));

  const pickActiveRotation = (dow: number, hour: number) =>
    [...rotationsByDow(dow)]
      .filter((rotation) => rotation.startHour <= hour && hour < rotation.endHour)
      .sort((a, b) => {
        const specificity = Number(b.dayOfWeek !== null) - Number(a.dayOfWeek !== null);
        if (specificity !== 0) return specificity;
        if (b.priority !== a.priority) return b.priority - a.priority;
        return a.startHour - b.startHour;
      })[0] ?? null;

  const activeEntry =
    nowDow >= 0
      ? entriesByDow(nowDow).find((e) => e.startMinutes <= nowMinutes && nowMinutes < e.endMinutes) ?? null
      : null;
  const activeRotation = nowDow >= 0 ? pickActiveRotation(nowDow, nowHour) : null;

  return (
    <>
      <PageHead
        title="Schedule"
        sub="Plan your week on a visual calendar — shows, playlist blocks and one-off specials"
        actions={<Button variant="primary" onClick={() => setAddOpen(true)}>+ Add schedule slot</Button>}
      />
      {loading ? <Spinner /> : null}
      {!loading && data && data.entries.length === 0 && rotations.length === 0 ? (
        <Card><Empty>Nothing scheduled yet. Use “Add schedule slot” to place a show or a playlist block on the week.</Empty></Card>
      ) : null}

      <Card>
        <div className="row small muted" style={{ justifyContent: "space-between", marginBottom: 10 }}>
          <span>Station timezone: <strong>{stationTz}</strong></span>
          <span>Now: <strong>{nowLabel}</strong> on <strong>{nowDowLabel}</strong></span>
        </div>
        <div className="schedule-grid" style={{ gridTemplateRows: `auto repeat(24, ${HOUR_PX}px)` }}>
          <div className="schedule-hours" style={{ display: "grid", placeItems: "center" }}></div>
          {WEEK_DOW.map((d) => <div key={d} className="schedule-dow">{DOWS[d]}</div>)}
          {HOURS.map((h) => (
            <div
              key={h}
              className={`schedule-hours ${h === nowHour ? "is-current" : ""}`}
              style={{ display: "grid", alignItems: "stretch", paddingBottom: 2 }}
            >
              <div className="schedule-hour-label">
                <strong>{String(h).padStart(2, "0")}:00</strong>
                <span>{String((h + 1) % 24).padStart(2, "0")}:00</span>
              </div>
            </div>
          ))}
          {WEEK_DOW.map((d, col) => (
            <div
              key={`day-${d}`}
              className={`schedule-day-column ${d === nowDow ? "is-today" : ""}`}
              style={{ gridColumn: col + 2, gridRow: "2 / span 24", height: `${24 * HOUR_PX}px` }}
            >
              {HOURS.map((h) => (
                <div key={h} className={`schedule-day-divider ${h === nowHour ? "is-current-hour" : ""}`}>
                  <div className="schedule-half-divider" />
                </div>
              ))}
              {d === nowDow ? (
                <div className="schedule-now-line" style={{ top: `${nowTopPx}px` }}>
                  <span className="schedule-now-pill">
                    Now {nowLabel} · {activeEntry
                      ? `${activeEntry.show.name} · ${minutesToHHMM(activeEntry.startMinutes)}–${minutesToHHMM(activeEntry.endMinutes)}`
                      : activeRotation
                        ? `Rotation: ${activeRotation.name} · ${String(activeRotation.startHour).padStart(2, "0")}:00–${String(activeRotation.endHour).padStart(2, "0")}:00`
                        : `${String(nowHour).padStart(2, "0")}:00–${String((nowHour + 1) % 24).padStart(2, "0")}:00`}
                  </span>
                </div>
              ) : null}
              {rotationsByDow(d).map((rotation) => {
                const topPx = rotation.startHour * HOUR_PX;
                const heightPx = Math.max(HOUR_PX * 0.5, (rotation.endHour - rotation.startHour) * HOUR_PX);
                const isActive = d === nowDow && rotation.startHour <= nowHour && nowHour < rotation.endHour;
                return (
                  <div
                    key={rotation.id}
                    className={`rotation-block ${isActive ? "is-live" : ""}`}
                    style={{
                      top: `${topPx}px`,
                      height: `${heightPx - 4}px`,
                    }}
                    title={`${String(rotation.startHour).padStart(2, "0")}:00–${String(rotation.endHour).padStart(2, "0")}:00 · ${rotation.name}${rotationPlaylistOnDay(rotation, d) ? ` · ${rotationPlaylistOnDay(rotation, d)}` : rotation.clockwheelName ? ` · ${rotation.clockwheelName}` : ""}`}
                    onClick={() => { window.location.href = "/rotations"; }}
                  >
                    {String(rotation.startHour).padStart(2, "0")}:00 {rotation.name} {rotation.dayOfWeek === null ? "(daily)" : ""}
                    {rotation.dayOfWeek === null && rotationPlaylistOnDay(rotation, d) ? (
                      <span className="schedule-block-sub">{rotationPlaylistOnDay(rotation, d)}</span>
                    ) : null}
                  </div>
                );
              })}
              {entriesByDow(d).map((e) => {
                const topPx = (e.startMinutes / 60) * HOUR_PX;
                const heightPx = Math.max(HOUR_PX * 0.5, ((e.endMinutes - e.startMinutes) / 60) * HOUR_PX);
                const isActive = d === nowDow && e.startMinutes <= nowMinutes && nowMinutes < e.endMinutes;
                return (
                  <div
                    key={e.id}
                    className={`show-block ${isActive ? "is-live" : ""}`}
                    style={{
                      background: e.show.color + "33",
                      borderLeft: `3px solid ${e.show.color}`,
                      color: "var(--text)",
                      top: `${topPx}px`,
                      height: `${heightPx - 4}px`,
                    }}
                    title={`${minutesToHHMM(e.startMinutes)}–${minutesToHHMM(e.endMinutes)} · ${e.show.name}`}
                    onClick={() => setEditEntry(e)}
                  >
                    {minutesToHHMM(e.startMinutes)} {e.show.name} {e.dayOfWeek === null ? "(daily)" : ""}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </Card>

      <Card title="This week at a glance" style={{ marginTop: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {(data?.entries ?? []).map((e) => (
            <div key={e.id} className="row" style={{ justifyContent: "space-between" }}>
              <span className="row" style={{ gap: 8 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: e.show.color, display: "inline-block" }} />
                <strong>{e.show.name}</strong>
                <span className="muted small">{e.dayOfWeek === null ? "Every day" : DOWS[e.dayOfWeek!]} {minutesToHHMM(e.startMinutes)}–{minutesToHHMM(e.endMinutes)}</span>
              </span>
              <div className="row">
                <Button className="btn-sm" onClick={() => setEditEntry(e)}>Edit</Button>
                <Button className="btn-sm btn-danger" onClick={() => deleteEntry(e.id)}>×</Button>
              </div>
            </div>
          ))}
          {rotations.map((rotation) => (
            <div key={rotation.id} className="row" style={{ justifyContent: "space-between" }}>
              <span className="row" style={{ gap: 8 }}>
                <span className="schedule-rotation-swatch" />
                <strong>{rotation.name}</strong>
                <span className="muted small">
                  {rotation.dayOfWeek == null ? "Every day" : DOWS[rotation.dayOfWeek]} {String(rotation.startHour).padStart(2, "0")}:00–{String(rotation.endHour).padStart(2, "0")}:00
                  {rotation.playlistName ? ` · ${rotation.playlistName}` : rotation.clockwheelName ? ` · ${rotation.clockwheelName}` : ""}
                  {rotation.dayOfWeek == null && DAY_PLAYLIST_COLUMNS.some((column) => rotation[column]) ? (
                    <span className="muted"> · per-day playlists</span>
                  ) : null}
                </span>
              </span>
              <div className="row">
                <Button className="btn-sm" onClick={() => { window.location.href = "/rotations"; }}>Open rotations</Button>
              </div>
            </div>
          ))}
        </div>
      </Card>
      <Card title="How it works" style={{ marginTop: 16 }}>
        <p className="hint" style={{ lineHeight: 1.7, margin: 0 }}>
          A <strong>show</strong> slot maps a show to a weekly time slot — while it's on air, the show's clockwheel or playlist drives the hour.
          A <strong>playlist block</strong> is timed automation that plays a chosen playlist in that window. When nothing is scheduled, the
          station falls back to the default playlist or an active rotation. Shows run in your station's timezone (set in Settings), and ad breaks at :15 and :45 are still honoured automatically.
        </p>
      </Card>

      {addOpen ? <AddEntry isDj={isDj} allocatedSlots={djSlotsData?.slots ?? []} shows={showsData?.shows ?? []} playlists={playlistsData?.playlists ?? []} clockwheels={clockwheelsData?.clockwheels ?? []} onClose={() => setAddOpen(false)} onAdded={() => { setAddOpen(false); reload(); }} /> : null}
      {editEntry ? <EditEntry entry={editEntry} shows={showsData?.shows ?? []} onClose={() => setEditEntry(null)} onSaved={() => { setEditEntry(null); reload(); }} onDeleted={() => { setEditEntry(null); reload(); }} /> : null}
    </>
  );
}

function AddEntry({
  isDj,
  allocatedSlots,
  shows,
  playlists,
  clockwheels,
  onClose,
  onAdded,
}: {
  isDj: boolean | undefined;
  allocatedSlots: Djslot[];
  shows: Show[];
  playlists: Array<{ id: string; name: string }>;
  clockwheels: Array<{ id: string; name: string }>;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [type, setType] = useState<"show" | "playlist" | "rotation" | "clockwheel">("show");
  const [showId, setShowId] = useState(shows[0]?.id ?? "");
  const [playlistId, setPlaylistId] = useState(playlists[0]?.id ?? "");
  // Per-day playlists for a Daily block (index 0=Sun..6=Sat).
  const [dayPlaylists, setDayPlaylists] = useState<string[]>(["", "", "", "", "", "", ""]);
  const [clockwheelId, setClockwheelId] = useState(clockwheels[0]?.id ?? "");
  const [rotName, setRotName] = useState(playlists[0]?.name ?? "");
  // Auto-generate: a daily block rebuilds a fresh track list each day from
  // selected music folders (with jingles every N), instead of one fixed list.
  const [autoGen, setAutoGen] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [musicFolders, setMusicFolders] = useState<string[]>([]);
  const [includeJingles, setIncludeJingles] = useState(true);
  const [jingleEvery, setJingleEvery] = useState(3);
  const [jingleFolder, setJingleFolder] = useState("");
  const { data: foldersData } = useFetch(() => api<{ folders: Array<{ name: string; count: number }> }>("/folders"));
  const folders = foldersData?.folders ?? [];
  const [day, setDay] = useState(""); // "" = daily
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("10:00");
  const [startHour, setStartHour] = useState(9);
  const [endHour, setEndHour] = useState(10);
  const [priority, setPriority] = useState(0);
  const [isActive, setIsActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toMin = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };

  const selectedShow = shows.find((s) => s.id === showId) ?? null;

  // A recorded show replays a fixed-length recording. Round the slot UP to the
  // minute so it always fits the whole recording (never truncates); the engine
  // then hands back to default automation the moment the audio ends.
  useEffect(() => {
    if (selectedShow?.isRecorded && (selectedShow.plannedDurationSec ?? 0) > 0) {
      const endMin = Math.min(1440, toMin(start) + Math.ceil((selectedShow.plannedDurationSec ?? 0) / 60));
      setEnd(minutesToHHMM(endMin));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showId]);

  const selectPlaylist = (id: string) => {
    const prevName = playlists.find((p) => p.id === playlistId)?.name;
    const nextName = playlists.find((p) => p.id === id)?.name;
    setPlaylistId(id);
    setRotName((cur) => (cur.trim() === "" || cur === prevName ? (nextName ?? "") : cur));
  };

  const dayPlaylistPayload = () => {
    const [sun, mon, tue, wed, thu, fri, sat] = dayPlaylists;
    return {
      sundayPlaylistId: sun || null,
      mondayPlaylistId: mon || null,
      tuesdayPlaylistId: tue || null,
      wednesdayPlaylistId: wed || null,
      thursdayPlaylistId: thu || null,
      fridayPlaylistId: fri || null,
      saturdayPlaylistId: sat || null,
    };
  };

  const save = async () => {
    if (type === "clockwheel") {
      if (!clockwheelId) { setError("Pick a clockwheel."); return; }
      if (endHour <= startHour) { setError("End hour must be after start hour."); return; }
      setBusy(true);
      setError(null);
      try {
        const name = clockwheels.find((cw) => cw.id === clockwheelId)?.name || "Clockwheel block";
        await api("/rotations", {
          method: "POST",
          body: { name, clockwheelId, dayOfWeek: day === "" ? null : Number(day), startHour, endHour, priority: 0, isActive: true },
        });
        onAdded();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save the clockwheel block.");
      } finally {
        setBusy(false);
      }
      return;
    }
    if (type === "playlist" || type === "rotation") {
      const isRotation = type === "rotation";
      if (!playlistId) { setError("Pick a playlist."); return; }
      if (endHour <= startHour) { setError("End hour must be after start hour."); return; }
      if (isRotation && !rotName.trim()) { setError("Rule name is required."); return; }
      setBusy(true);
      setError(null);
      try {
        const name = isRotation
          ? rotName.trim()
          : (rotName.trim() || playlists.find((p) => p.id === playlistId)?.name || "Playlist block");
        const useAutoGen = autoGen && day === "";
        await api("/rotations", {
          method: "POST",
          body: {
            name,
            playlistId,
            dayOfWeek: day === "" ? null : Number(day),
            startHour,
            endHour,
            priority: isRotation ? priority : 0,
            isActive: isRotation ? isActive : true,
            ...(day === "" ? dayPlaylistPayload() : {}),
            autoGenerate: useAutoGen,
            shufflePlaylist: !useAutoGen && shuffle,
            musicFolders: useAutoGen ? musicFolders : [],
            includeJingles: useAutoGen ? includeJingles : true,
            jingleEvery: useAutoGen ? jingleEvery : 3,
            jingleFolder: useAutoGen ? (jingleFolder || null) : null,
          },
        });
        onAdded();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save the block.");
      } finally {
        setBusy(false);
      }
      return;
    }
    const s = toMin(start);
    const e = toMin(end);
    if (e <= s) { setError("End must be after start."); return; }
    if (!showId) { setError("Pick a show."); return; }
    setBusy(true);
    setError(null);
    try {
      await api("/schedule", {
        method: "POST",
        body: { showId, dayOfWeek: day === "" ? null : Number(day), startMinutes: s, endMinutes: e },
      });
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save show time.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Add schedule slot" footer={
      <>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="primary" onClick={() => void save()} disabled={busy}>{busy ? "Saving..." : "Save"}</Button>
      </>
    }>
      {!isDj ? <Field label="Type">
        <Select value={type} onChange={(e) => setType(e.target.value as "show" | "playlist" | "rotation" | "clockwheel")}>
          <option value="show">Show</option>
          <option value="playlist">Playlist</option>
          <option value="rotation">Rotation</option>
          <option value="clockwheel">Clockwheel</option>
        </Select>
      </Field> : <p className="hint">As a DJ, you can add your shows only. Your administrator controls your permitted time windows.</p>}

      {type === "show" ? (
        shows.length === 0 ? (
          <Empty>Create a show first — go to the Shows page.</Empty>
        ) : (
          <>
            <Field label="Show" hint={selectedShow?.isRecorded ? `Recorded show · ${Math.round((selectedShow.plannedDurationSec ?? 0) / 60)} min — plays once, then returns to the default playlist` : undefined}>
              <Select value={showId} onChange={(e) => setShowId(e.target.value)}>
                {shows.map((s) => <option key={s.id} value={s.id}>{s.isRecorded ? "🔴 " : ""}{s.name}</option>)}
              </Select>
            </Field>
            <Field label="Day" hint="Select a specific day, or leave 'Daily' for every day">
              <Select value={day} onChange={(e) => setDay(e.target.value)}>
                <option value="">Daily</option>
                {DOWS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </Select>
            </Field>
            {isDj ? <div className="hint" style={{ background: "var(--bg2)", borderRadius: 8, padding: "10px 12px", margin: "4px 0 12px" }}>
              <strong>Allocated windows</strong>
              <div className="small" style={{ marginTop: 5 }}>
                {allocatedSlots.length > 0 ? allocatedSlots.map((slot) => <div key={slot.id}>{slot.dayOfWeek === null ? "Daily" : DOWS[slot.dayOfWeek]} · {minutesToHHMM(slot.startMinutes)}–{minutesToHHMM(slot.endMinutes)}</div>) : "No allocated slots found."}
              </div>
            </div> : null}
            <div className="form-row">
              <Field label="Start"><Input type="time" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
              <Field label="End"><Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
            </div>
            <div className="hint">Runs {start}–{end} in the station timezone.</div>
          </>
        )
      ) : type === "clockwheel" ? (
        clockwheels.length === 0 ? (
          <Empty>Create a clockwheel first — go to the Clockwheels page.</Empty>
        ) : (
          <>
            <Field label="Clockwheel">
              <Select value={clockwheelId} onChange={(e) => setClockwheelId(e.target.value)}>
                {clockwheels.map((cw) => <option key={cw.id} value={cw.id}>{cw.name}</option>)}
              </Select>
            </Field>
            <Field label="Day" hint="Select a specific day, or leave 'Daily' for every day">
              <Select value={day} onChange={(e) => setDay(e.target.value)}>
                <option value="">Daily</option>
                {DOWS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </Select>
            </Field>
            <div className="form-row">
              <Field label="Start hour">
                <Select value={startHour} onChange={(e) => setStartHour(Number(e.target.value))}>
                  {HOURS.map((h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
                </Select>
              </Field>
              <Field label="End hour">
                <Select value={endHour} onChange={(e) => setEndHour(Number(e.target.value))}>
                  {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
                </Select>
              </Field>
            </div>
            <div className="hint">Runs this clockwheel (jingles, station IDs and music structure) as automation in that window. Runs {String(startHour).padStart(2, "0")}:00–{String(endHour).padStart(2, "0")}:00 in the station timezone.</div>
          </>
        )
      ) : type === "playlist" ? (
        playlists.length === 0 ? (
          <Empty>Create a playlist first — go to the Playlists page.</Empty>
        ) : (
          <>
            <Field label="Playlist">
              <Select value={playlistId} onChange={(e) => selectPlaylist(e.target.value)}>
                {playlists.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
            <Field label="Day" hint="Select a specific day, or leave 'Daily' for every day">
              <Select value={day} onChange={(e) => setDay(e.target.value)}>
                <option value="">Daily</option>
                {DOWS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </Select>
            </Field>
            <div className="form-row">
              <Field label="Start hour">
                <Select value={startHour} onChange={(e) => setStartHour(Number(e.target.value))}>
                  {HOURS.map((h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
                </Select>
              </Field>
              <Field label="End hour">
                <Select value={endHour} onChange={(e) => setEndHour(Number(e.target.value))}>
                  {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
                </Select>
              </Field>
            </div>
            {day === "" ? (
              <>
                <PerDayPlaylists dayPlaylists={dayPlaylists} setDayPlaylists={setDayPlaylists} playlists={playlists} />
                <AutoGenPanel
                  autoGen={autoGen}
                  setAutoGen={setAutoGen}
                  folders={folders}
                  musicFolders={musicFolders}
                  setMusicFolders={setMusicFolders}
                  includeJingles={includeJingles}
                  setIncludeJingles={setIncludeJingles}
                  jingleEvery={jingleEvery}
                  setJingleEvery={setJingleEvery}
                  jingleFolder={jingleFolder}
                  setJingleFolder={setJingleFolder}
                />
              </>
            ) : null}
            {!(autoGen && day === "") ? (
              <ShuffleToggle shuffle={shuffle} setShuffle={setShuffle} />
            ) : null}
            <div className="hint">Plays this playlist as automation in that window. The block is named after the playlist. Runs {String(startHour).padStart(2, "0")}:00–{String(endHour).padStart(2, "0")}:00 in the station timezone.</div>
          </>
        )
      ) : playlists.length === 0 ? (
        <Empty>Create a playlist first — go to the Playlists page.</Empty>
      ) : (
        <>
          <Field label="Rule name">
            <Input value={rotName} onChange={(e) => setRotName(e.target.value)} placeholder="e.g. Weekday breakfast" />
          </Field>
          <Field label="Playlist">
            <Select value={playlistId} onChange={(e) => selectPlaylist(e.target.value)}>
              {playlists.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label="Day" hint="Select a specific day, or leave 'Daily' for every day">
            <Select value={day} onChange={(e) => setDay(e.target.value)}>
              <option value="">Daily</option>
              {DOWS.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </Select>
          </Field>
          <div className="form-row">
            <Field label="Start hour">
              <Select value={startHour} onChange={(e) => setStartHour(Number(e.target.value))}>
                {HOURS.map((h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
              </Select>
            </Field>
            <Field label="End hour">
              <Select value={endHour} onChange={(e) => setEndHour(Number(e.target.value))}>
                {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
              </Select>
            </Field>
            <Field label="Priority" hint="Higher priority wins inside overlapping windows">
              <Input type="number" min={0} max={100} value={priority} onChange={(e) => setPriority(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} />
            </Field>
          </div>
          <label className="row" style={{ gap: 8, marginTop: 6 }}>
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            <span>Rule is active</span>
          </label>
          {day === "" ? (
            <>
              <PerDayPlaylists dayPlaylists={dayPlaylists} setDayPlaylists={setDayPlaylists} playlists={playlists} />
              <AutoGenPanel
                autoGen={autoGen}
                setAutoGen={setAutoGen}
                folders={folders}
                musicFolders={musicFolders}
                setMusicFolders={setMusicFolders}
                includeJingles={includeJingles}
                setIncludeJingles={setIncludeJingles}
                jingleEvery={jingleEvery}
                setJingleEvery={setJingleEvery}
                jingleFolder={jingleFolder}
                setJingleFolder={setJingleFolder}
              />
            </>
          ) : null}
          {!(autoGen && day === "") ? (
            <ShuffleToggle shuffle={shuffle} setShuffle={setShuffle} />
          ) : null}
          <div className="hint" style={{ marginTop: 8 }}>Runs {String(startHour).padStart(2, "0")}:00–{String(endHour).padStart(2, "0")}:00 in the station timezone.</div>
        </>
      )}
      {error ? <p className="hint" style={{ color: "var(--danger)" }}>{error}</p> : null}
    </Modal>
  );
}

/** Daily-block picker: assign a different playlist to each day of the week. */
function PerDayPlaylists({
  dayPlaylists,
  setDayPlaylists,
  playlists,
}: {
  dayPlaylists: string[];
  setDayPlaylists: Dispatch<SetStateAction<string[]>>;
  playlists: Array<{ id: string; name: string }>;
}) {
  const order = [1, 2, 3, 4, 5, 6, 0]; // Mon-first for display
  return (
    <div style={{ background: "var(--bg2)", borderRadius: 8, padding: "10px 12px", margin: "4px 0 12px" }}>
      <div className="small" style={{ fontWeight: 600, marginBottom: 8 }}>
        Playlist per day <span className="muted">(leave a day blank to use the playlist above)</span>
      </div>
      {order.map((dow) => (
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
            {playlists.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </div>
      ))}
    </div>
  );
}

/** Shuffle a curated playlist's music into a fresh order each airing. */
function ShuffleToggle({
  shuffle,
  setShuffle,
}: {
  shuffle: boolean;
  setShuffle: Dispatch<SetStateAction<boolean>>;
}) {
  return (
    <div style={{ background: "var(--bg2)", borderRadius: 8, padding: "10px 12px", margin: "4px 0 12px" }}>
      <label className="row" style={{ gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={shuffle} onChange={(e) => setShuffle(e.target.checked)} />
        <span><strong>Shuffle music each time this block airs</strong></span>
      </label>
      <p className="hint" style={{ marginTop: 6, marginBottom: 0 }}>
        The playlist&rsquo;s music plays in a fresh order each time it airs; jingles, sweepers and station IDs stay
        exactly where you placed them.
      </p>
    </div>
  );
}

/** Auto-generate: a daily block rebuilds a fresh list each day from folders. */
function AutoGenPanel({  autoGen,
  setAutoGen,
  folders,
  musicFolders,
  setMusicFolders,
  includeJingles,
  setIncludeJingles,
  jingleEvery,
  setJingleEvery,
  jingleFolder,
  setJingleFolder,
}: {
  autoGen: boolean;
  setAutoGen: Dispatch<SetStateAction<boolean>>;
  folders: Array<{ name: string; count: number }>;
  musicFolders: string[];
  setMusicFolders: Dispatch<SetStateAction<string[]>>;
  includeJingles: boolean;
  setIncludeJingles: Dispatch<SetStateAction<boolean>>;
  jingleEvery: number;
  setJingleEvery: Dispatch<SetStateAction<number>>;
  jingleFolder: string;
  setJingleFolder: Dispatch<SetStateAction<string>>;
}) {
  const toggleFolder = (name: string) => {
    setMusicFolders((cur) =>
      cur.includes(name) ? cur.filter((f) => f !== name) : [...cur, name],
    );
  };
  return (
    <div style={{ background: "var(--bg2)", borderRadius: 8, padding: "10px 12px", margin: "4px 0 12px" }}>
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
                  className={musicFolders.includes(folder.name) ? "tag-btn active" : "tag-btn"}
                  style={{
                    background: musicFolders.includes(folder.name) ? "var(--accent)" : "var(--bg)",
                    color: "var(--text)",
                    border: "1px solid var(--border)",
                    borderRadius: 999,
                    padding: "4px 10px",
                    cursor: "pointer",
                  }}
                  onClick={() => toggleFolder(folder.name)}
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
  );
}

function EditEntry({
  entry,
  shows,
  onClose,
  onSaved,
  onDeleted,
}: {
  entry: EntryRow;
  shows: Show[];
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [showId, setShowId] = useState(entry.showId);
  const [day, setDay] = useState(entry.dayOfWeek == null ? "" : String(entry.dayOfWeek));
  const [start, setStart] = useState(minutesToHHMM(entry.startMinutes));
  const [end, setEnd] = useState(minutesToHHMM(entry.endMinutes));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setShowId(entry.showId);
    setDay(entry.dayOfWeek == null ? "" : String(entry.dayOfWeek));
    setStart(minutesToHHMM(entry.startMinutes));
    setEnd(minutesToHHMM(entry.endMinutes));
  }, [entry.id, entry.showId, entry.dayOfWeek, entry.startMinutes, entry.endMinutes]);

  const toMin = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };

  const save = async () => {
    const s = toMin(start);
    const e = toMin(end);
    if (e <= s) {
      setError("End must be after start.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/schedule/${entry.id}`, {
        method: "PATCH",
        body: { showId, dayOfWeek: day === "" ? null : Number(day), startMinutes: s, endMinutes: e },
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save show time.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Remove "${entry.show.name}" from the schedule?`)) return;
    setBusy(true);
    try {
      await api(`/schedule/${entry.id}`, { method: "DELETE" });
      onDeleted();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit — ${entry.show.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={() => void remove()} disabled={busy}>Delete</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy}>Save</Button>
        </>
      }
    >
      <Field label="Show">
        <Select value={showId} onChange={(e) => setShowId(e.target.value)}>
          {shows.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
      </Field>
      <Field label="Day" hint="Select a specific day, or leave 'Daily' for every day">
        <Select value={day} onChange={(e) => setDay(e.target.value)}>
          <option value="">Daily</option>
          {DOWS.map((d, i) => <option key={d} value={i}>{d}</option>)}
        </Select>
      </Field>
      <div className="form-row">
        <Field label="Start"><Input type="time" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label="End"><Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
      </div>
      <div className="hint">Change the slot here, then save to move the show in the schedule.</div>
      {error ? <p className="hint" style={{ color: "var(--danger)" }}>{error}</p> : null}
    </Modal>
  );
}
