import { useState } from "react";
import { api } from "../api";
import { Button, Card, PageHead, Spinner, useFetch } from "../components/ui";

interface AboutInfo {
  app: { name: string; version: string };
  build: { revision: string | null; builtAt: string | null };
  runtime: {
    node: string;
    platform: string;
    arch: string;
    os: string;
    uptimeSeconds: number;
    memoryMb: number;
  };
  database: { version: string | null };
  ffmpeg: string | null;
  settings: {
    stationName: string;
    timezone: string;
    streamUrl: string;
    mount: string;
    streamBitrate: number;
    publicPageEnabled: boolean;
    geoMode: string;
  } | null;
}

function shortUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * "About this server": the build, the machine and the dependencies, plus a
 * copy button. This page exists so a bug report can say which version and
 * environment it came from instead of "it doesn't work".
 */
export function About() {
  const { data, loading } = useFetch(() => api<AboutInfo>("/about"));
  const [copied, setCopied] = useState(false);

  const copy = () => {
    if (!data) return;
    const text = [
      `${data.app.name} ${data.app.version}`,
      `build: ${data.build.revision ?? "unknown"}${data.build.builtAt ? ` (${data.build.builtAt})` : ""}`,
      `runtime: node ${data.runtime.node} · ${data.runtime.platform}/${data.runtime.arch} · ${data.runtime.os}`,
      `uptime: ${shortUptime(data.runtime.uptimeSeconds)} · rss ${data.runtime.memoryMb} MB`,
      `database: ${data.database.version ?? "unknown"}`,
      `ffmpeg: ${data.ffmpeg ?? "not found on PATH"}`,
      data.settings
        ? `station: ${data.settings.stationName} · ${data.settings.timezone} · ${data.settings.streamBitrate} kbps · mount ${data.settings.mount}`
        : "station: unconfigured",
      `stream: ${data.settings?.streamUrl || "(not set)"}`,
    ].join("\n");
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => setCopied(false),
    );
  };

  return (
    <>
      <PageHead
        title="About this server"
        sub="What is running, where, and with what — copy this into a bug report"
        actions={(
          <Button variant="primary" onClick={copy} disabled={!data}>
            {copied ? "Copied ✓" : "Copy diagnostics"}
          </Button>
        )}
      />

      {loading || !data ? (
        <Card><Spinner /></Card>
      ) : (
        <div className="grid grid-2">
          <Card title="Build">
            <div className="table-wrap">
              <table>
                <tbody>
                  <tr><td className="muted">Product</td><td><strong>{data.app.name}</strong></td></tr>
                  <tr><td className="muted">Version</td><td className="mono">{data.app.version}</td></tr>
                  <tr><td className="muted">Revision</td><td className="mono">{data.build.revision ?? "unknown"}</td></tr>
                  <tr><td className="muted">Built</td><td className="mono">{data.build.builtAt ?? "unknown"}</td></tr>
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Runtime">
            <div className="table-wrap">
              <table>
                <tbody>
                  <tr><td className="muted">Node</td><td className="mono">{data.runtime.node}</td></tr>
                  <tr><td className="muted">Platform</td><td className="mono">{data.runtime.platform}/{data.runtime.arch}</td></tr>
                  <tr><td className="muted">OS</td><td className="mono">{data.runtime.os}</td></tr>
                  <tr><td className="muted">Uptime</td><td className="mono">{shortUptime(data.runtime.uptimeSeconds)}</td></tr>
                  <tr><td className="muted">Memory</td><td className="mono">{data.runtime.memoryMb} MB</td></tr>
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Dependencies">
            <div className="table-wrap">
              <table>
                <tbody>
                  <tr><td className="muted">Database</td><td className="mono small">{data.database.version ?? "unknown"}</td></tr>
                  <tr><td className="muted">ffmpeg</td><td className="mono small">{data.ffmpeg ?? "not found on PATH"}</td></tr>
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Station">
            {data.settings ? (
              <div className="table-wrap">
                <table>
                  <tbody>
                    <tr><td className="muted">Name</td><td>{data.settings.stationName}</td></tr>
                    <tr><td className="muted">Timezone</td><td className="mono">{data.settings.timezone}</td></tr>
                    <tr><td className="muted">Bitrate</td><td className="mono">{data.settings.streamBitrate} kbps</td></tr>
                    <tr><td className="muted">Mount</td><td className="mono">{data.settings.mount}</td></tr>
                    <tr><td className="muted">Stream URL</td><td className="mono small">{data.settings.streamUrl || "not set"}</td></tr>
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">Station settings are not initialised yet.</p>
            )}
          </Card>
        </div>
      )}

      <Card title="Found a problem?" style={{ marginTop: 16 }}>
        <p className="hint" style={{ marginTop: 0 }}>
          Copy the diagnostics above into a{" "}
          <a href="https://github.com/kfbhost/airwavehq/issues/new?template=bug_report.yml" target="_blank" rel="noreferrer">
            bug report
          </a>
          , along with what you did and what happened. Please don't paste passwords or your <code>.env</code>.
        </p>
      </Card>
    </>
  );
}
