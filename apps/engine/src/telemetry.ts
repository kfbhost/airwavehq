import { api } from "./api.js";
import { config } from "./config.js";
import type { Playout } from "./playout.js";
import type { Sink } from "./icecast.js";
import type { EnginePlayEvent, EngineStatus } from "@radiohost/shared";

export class Telemetry {
  private startedAt = Date.now();
  private timer: NodeJS.Timeout | null = null;
  private lastStatus: EngineStatus | null = null;
  private listeners = 0;

  constructor(
    private playout: Playout,
    private sink: Sink,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.reportStatus(), 15_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  onPlayStart(p: { item: { id: string; trackId: string | null; kind: string; title: string; artist: string; durationSec: number; source: string; showId: string | null; campaignId: string | null; voiceTrackId: string | null }; startMs: number }): void {
    const startedAt = new Date(p.startMs).toISOString();
    const ev: EnginePlayEvent = {
      playId: p.item.id,
      trackId: p.item.trackId,
      title: p.item.title,
      artist: p.item.artist,
      startedAt,
      endedAt: null,
      durationSeconds: p.item.durationSec,
      source: p.item.source as EnginePlayEvent["source"],
      showId: p.item.showId,
      campaignId: p.item.campaignId,
      voiceTrackId: p.item.voiceTrackId,
      listenersAtStart: this.listeners,
      listenersAtEnd: null,
    };
    void api.playLog([ev]).catch((err) => console.error("[engine] play-log start failed", err.message));
    // Push a fresh status immediately so the dashboard's now-playing and
    // countdown flip the instant a track changes (the 15s heartbeat alone made
    // it feel sticky/laggy).
    void this.reportStatus();
    void this.sink.setMetadata(`${p.item.title} - ${p.item.artist}`.trim());
  }

  onPlayEnd(p: { item: { id: string; trackId: string | null; title: string; artist: string; durationSec: number; source: string; showId: string | null; campaignId: string | null; voiceTrackId: string | null }; startedAt: number | null }, endedAtMs: number): void {
    if (p.startedAt == null) return;
    const ev: EnginePlayEvent = {
      playId: p.item.id,
      trackId: p.item.trackId,
      title: p.item.title,
      artist: p.item.artist,
      startedAt: new Date(p.startedAt).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      durationSeconds: (endedAtMs - p.startedAt) / 1000,
      source: p.item.source as EnginePlayEvent["source"],
      showId: p.item.showId,
      campaignId: p.item.campaignId,
      voiceTrackId: p.item.voiceTrackId,
      listenersAtStart: null,
      listenersAtEnd: this.listeners,
    };
    void api.playLog([ev]).catch((err) => console.error("[engine] play-log end failed", err.message));
    void this.reportStatus();
  }

  onLiveToggle(live: boolean): void {
    this.reportStatus();
  }

  private async reportStatus(): Promise<void> {
    const payload = this.playout.getStatusPayload();
    this.listeners = this.sink.listeners();
    const status: EngineStatus = {
      online: true,
      mode: payload.mode as EngineStatus["mode"],
      currentItem: payload.currentItem,
      nextItem: payload.nextItem,
      upcomingItems: payload.upcomingItems,
      listeners: this.listeners,
      liveDjName: this.lastLiveDjName,
      liveShowName: this.lastLiveShowName,
      encoderBitrateKbps: config.iceBitrate,
      engineTime: new Date().toISOString(),
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
    };
    this.lastStatus = status;
    await api.status(status);
  }

  private lastLiveDjName: string | null = null;
  private lastLiveShowName: string | null = null;
  setLiveDj(name: string | null, showName?: string | null): void {
    this.lastLiveDjName = name;
    this.lastLiveShowName = showName ?? null;
  }
}

export { config };
