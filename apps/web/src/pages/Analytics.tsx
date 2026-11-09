import { useState } from "react";
import { api, getToken } from "../api";
import { Badge, Button, Card, Empty, PageHead, Select, Spinner, Stat, useFetch } from "../components/ui";

export function Analytics() {
  const [days, setDays] = useState(7);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const to = new Date().toISOString();
  const from = new Date(Date.now() - days * 86_400_000).toISOString();

  const { data: summary } = useFetch(() => api<{ avgListeners: number; maxListeners: number; listeningHours: number; plays: number }>(`/analytics/summary?from=${from}&to=${to}`), [days]);
  const { data: series } = useFetch(() => api<{ series: Array<{ at: string; listeners: number }> }>(`/analytics/listeners?from=${from}&to=${to}&bucket=60`), [days]);
  const { data: top } = useFetch(() => api<{ tracks: Array<{ title: string; artist: string; plays: number }> }>(`/analytics/top-tracks?from=${from}&to=${to}&limit=15`), [days]);
  const { data: countries } = useFetch(() => api<{ countries: Array<{ code: string; count: number }> }>(`/analytics/countries?from=${from}&to=${to}`), [days]);

  const exportCsv = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const token = getToken();
      const res = await fetch(`/api/analytics/export?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `playlog-${days}d.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Could not export play log.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <PageHead
        title="Analytics"
        sub="Listeners, top tracks and royalty-ready play logs"
        actions={<div className="analytics-actions">
          <Select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={1}>Last 24 hours</option>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </Select>
          <Button variant="primary" onClick={() => void exportCsv()}>{exporting ? "Exporting..." : "⬇ Export play log (CSV)"}</Button>
        </div>}
      />
      {exportError ? <Card><p className="hint" style={{ margin: 0, color: "var(--danger)" }}><strong>{exportError}</strong></p></Card> : null}
      <div className="grid grid-3 analytics-stats" style={{ marginBottom: 16 }}>
        <Stat label="Average listeners" value={summary?.avgListeners ?? "—"} />
        <Stat label="Peak listeners" value={summary?.maxListeners ?? "—"} />
        <Stat label="Listening hours" value={summary?.listeningHours ?? "—"} />
      </div>

      <div className="analytics-layout">
        <div className="analytics-column">
          <Card className="analytics-card analytics-chart-card" title="Listeners over time">
            {series ? (
              <div className="analytics-chart">
                <LineChart points={series.series.map((s) => ({ x: new Date(s.at).getTime(), y: s.listeners }))} />
              </div>
            ) : <Spinner />}
          </Card>
          <Card
            className="analytics-card"
            title="Countries"
            sub={countries && countries.countries.length === 0 ? "Country data builds up from public player/widget listener heartbeats." : undefined}
          >
            {countries && countries.countries.length === 0 ? <Empty>No country data collected.</Empty> : null}
            <div className="analytics-country-list">
              {countries?.countries.map((c) => (
                <div key={c.code} className="analytics-country-row">
                  <span>{countryLabel(c.code)}</span>
                  <Badge tone="blue">{c.count}</Badge>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="analytics-column">
          <Card className="analytics-card analytics-top-card" title="Top tracks">
            {!top ? <Spinner /> : null}
            {top && top.tracks.length === 0 ? <Empty>No plays in this window yet.</Empty> : null}
            {top && top.tracks.length > 0 ? (
              <div className="analytics-list">
                {top.tracks.map((t, i) => (
                  <div key={i} className="analytics-list-row">
                    <div className="row" style={{ gap: 10, minWidth: 0 }}>
                      <span className="analytics-list-rank mono">{i + 1}</span>
                      <span className="analytics-list-copy"><strong>{t.title}</strong> <span className="muted">— {t.artist}</span></span>
                    </div>
                    <Badge>{t.plays}</Badge>
                  </div>
                ))}
              </div>
            ) : null}
          </Card>
          <Card className="analytics-card analytics-royalty-card" title="Royalty reporting">
            <p className="hint" style={{ lineHeight: 1.7, margin: 0 }}>
              Every play is logged with its exact start and end time, duration, source (automation, live, voice or ad)
              and the audience at the time. The CSV export is formatted for royalty declarations to collection
              societies — music licensing itself stays with you, as it should.
            </p>
            <Button onClick={() => void exportCsv()}>{exporting ? "Exporting..." : "⬇ Download CSV"}</Button>
          </Card>
        </div>
      </div>
    </>
  );
}

function LineChart({ points }: { points: Array<{ x: number; y: number }> }) {
  if (points.length === 0) return <Empty>No listener samples yet — start the engine.</Empty>;
  const w = 560;
  const h = 180;
  const padX = 14;
  const padTop = 14;
  const padBottom = 26;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const maxY = Math.max(1, ...ys);
  const plotHeight = h - padTop - padBottom;
  const px = (x: number) => padX + ((x - minX) / (maxX - minX || 1)) * (w - padX * 2);
  const py = (y: number) => h - padBottom - (y / maxY) * plotHeight;
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(" ");
  const area = `${path} L${px(maxX).toFixed(1)},${h - padBottom} L${px(minX).toFixed(1)},${h - padBottom} Z`;
  const sameDay = new Date(minX).toDateString() === new Date(maxX).toDateString();
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`}>
      <defs>
        <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#38bdf8" stopOpacity="0" />
        </linearGradient>
      </defs>
      <line x1={padX} y1={h - padBottom} x2={w - padX} y2={h - padBottom} stroke="rgba(143, 163, 196, 0.18)" />
      <path d={area} fill="url(#area)" />
      <path d={path} fill="none" stroke="#38bdf8" strokeWidth="2" strokeLinejoin="round" />
      <text x={padX} y={12} fill="#8fa3c4" fontSize="10">{maxY} listener{maxY === 1 ? "" : "s"}</text>
      <text x={padX} y={h - 6} fill="#8fa3c4" fontSize="10">{formatTickLabel(minX, sameDay)}</text>
      <text x={w - padX} y={h - 6} fill="#8fa3c4" fontSize="10" textAnchor="end">{formatTickLabel(maxX, sameDay)}</text>
    </svg>
  );
}

function formatTickLabel(value: number, sameDay: boolean): string {
  const date = new Date(value);
  return sameDay
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString();
}

function countryLabel(code: string): string {
  if (code === "LOCAL") return "🏠 Local";
  const normalized = code.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(normalized)) {
    return `${flagEmoji(normalized)} ${normalized}`;
  }
  return `🌍 ${normalized}`;
}

function flagEmoji(code: string): string {
  return String.fromCodePoint(...code.split("").map((char) => 127397 + char.charCodeAt(0)));
}
