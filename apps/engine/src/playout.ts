import { PcmStream } from "./decode.js";
import { api } from "./api.js";
import { config, SAMPLE_RATE, CHANNELS } from "./config.js";
import { broadcastFilterArgsFor } from "./processing.js";
import {
  VOICE_LINK_DUCK_GAIN,
  VOICE_LINK_DUCK_RAMP_MS,
  VOICE_LINK_OVERLAP_IN_MS,
  VOICE_LINK_OVERLAP_OUT_MS,
  type EngineItem,
  type ProcessingPreset,
} from "@airshift/shared";

const FRAMES_PER_TICK = Math.round((SAMPLE_RATE * config.tickMs) / 1000);
const PRIME_MS = 800; // spawn ffmpeg this early so the buffer is full at start
const CONFIG_POLL_MS = 5000;

// "Production elements" (jingles, sweepers, station IDs) must land as a strict,
// gapless punch — no crossfade, no space. We keep a short attack so they don't
// click, and a very short tail so the next element/track starts immediately.
const PRODUCTION_KINDS = new Set<string>(["jingle", "sweeper", "station_id"]);
const PRODUCTION_ATTACK_MS = 22; // element-after-element: near-instant, punchy
const PRODUCTION_TAIL_MS = 90; // tight outgoing tail so nothing hangs before the next item
const PRODUCTION_LEAD_MS = 500; // overlap a music->element crossfade over the song's tail
const PRODUCTION_SMOOTH_MS = 180; // gentle ease-in for an element over music (a duck, not a cut)

// Trailing-silence trigger: when the on-air track's audio drops out near its end
// (files often carry a second or more of silence), start the next production
// element immediately so a jingle hits the moment the music stops — no dead air.
const TRAILING_SILENCE_WINDOW_MS = 3500; // only watch the last N ms of the track
const TRAILING_SILENCE_HOLD_MS = 250; // require this much continuous near-silence
const SILENCE_RMS = 0.005; // ~ -46 dBFS — only a genuine silent tail triggers this


interface Planned {
  item: EngineItem;
  startMs: number;
  endMs: number;
  fadeInMs: number;
  fadeOutMs: number;
  gainPoints: Array<{ atMs: number; gain: number }>;
  stream: PcmStream | null;
  primed: boolean;
  reportedStart: boolean;
  reportedEnd: boolean;
  startedAt: number | null;
  failed: boolean;
  /** Diag: cumulative silence frames this deck played due to decoder starvation (not EOF tail). */
  paddedFrames: number;
  /** Consecutive near-silent ms of this deck's own audio (used for trailing-silence advance). */
  silentMs: number;
}

export interface PlayoutEvents {
  onStatus: (payload: {
    currentItem: EngineItem | null;
    nextItem: EngineItem | null;
    mode: "automation" | "live";
  }) => void;
  onPlayStart: (p: Planned) => void;
  onPlayEnd: (p: Planned, endedAt: number) => void;
  onLiveToggle: (live: boolean) => void;
}

export type SequenceFetcher = (after: number, count: number) => Promise<{ items: EngineItem[] }>;

/**
 * Pure gain envelope for a deck: equal-power fades in/out.
 * Returns 0 outside [startMs - fadeInMs, endMs).
 */
export function gainEnvelope(
  startMs: number,
  endMs: number,
  fadeInMs: number,
  fadeOutMs: number,
  t: number,
): number {
  if (t < startMs - fadeInMs || t >= endMs) return 0;
  let g = 1;
  if (fadeInMs > 0 && t < startMs) {
    const theta = ((t - (startMs - fadeInMs)) / fadeInMs) * (Math.PI / 2);
    g *= Math.sin(Math.max(0, Math.min(Math.PI / 2, theta)));
  }
  if (fadeOutMs > 0 && t > endMs - fadeOutMs) {
    const theta = ((endMs - t) / fadeOutMs) * (Math.PI / 2);
    g *= Math.sin(Math.max(0, Math.min(Math.PI / 2, theta)));
  }
  return g;
}

export interface TransitionGains {
  live: number;
  auto: number;
}

/**
 * Equal-power gain pair for the live<->automation handover: at elapsed=0 the
 * outgoing source is at unity, at elapsed>=total the incoming source is.
 * sin² + cos² = 1 keeps perceived loudness constant across the blend.
 */
export function transitionGains(
  dir: "to-live" | "to-auto",
  elapsedMs: number,
  totalMs: number,
): TransitionGains {
  const p = Math.max(0, Math.min(1, elapsedMs / Math.max(1, totalMs)));
  const theta = p * (Math.PI / 2);
  const snap = (v: number) => (Math.abs(v) < 1e-9 ? 0 : v); // cos(π/2) ≈ 6e-17
  if (dir === "to-live") return { live: snap(Math.sin(theta)), auto: snap(Math.cos(theta)) };
  return { live: snap(Math.cos(theta)), auto: snap(Math.sin(theta)) };
}

/**
 * Continuous 48 kHz stereo f32le master pipeline. Automation items play
 * through crossfading decks; a live input blends in over a short equal-power
 * crossfade when a DJ connects and blends back out on disconnect. The
 * automation clock keeps running (silently) throughout a live broadcast, so
 * handovers are seamless and the schedule stays coherent.
 */
export class Playout {
  private queue: EngineItem[] = [];
  private queueEnd = 0; // end time of the last queued item
  private head = 0;
  private decks: Planned[] = [];
  private nextStartMs = 0;
  private fetchAfterMs = 0;
  private onAir: Planned | null = null;
  private liveMode = false;
  private transition: { dir: "to-live" | "to-auto"; startedAt: number } | null = null;
  private readonly transitionMs = config.liveTransitionMs;
  private liveBuffer: Float32Array[] = [];
  private liveBytes = 0;
  private timer: NodeJS.Timeout | null = null;
  private idleFetches = 0;
  private fetching = false;
  private queueGeneration = 0;
  private programmingRevision: number | null = null;
  private engineRestartRequestedAt = 0;
  private restartRequested = false;
  private configPollInFlight = false;
  private nextConfigPollAt = 0;
  private currentPreset: ProcessingPreset | null = null;
  // Diag: tick-loop health (only used when config.diag is on).
  private tickRunning = false;

  constructor(
    private sink: { write(pcm: Buffer): void; applyFilterArgs?(args: string[]): void },
    private events: PlayoutEvents,
    private crossfadeMs: number,
    private fetchSequence: SequenceFetcher = (after, count) => api.next(after, count),
  ) {}

  start(): void {
    this.nextStartMs = Date.now();
    this.fetchAfterMs = Date.now();
    this.queueEnd = this.nextStartMs;
    this.timer = setInterval(() => void this.tick(), config.tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const d of this.decks) d.stream?.kill();
    this.decks = [];
  }

  /* ---------------- Live input ---------------- */

  setLiveMode(live: boolean): void {
    if (live === this.liveMode) return;
    this.liveMode = live;
    if (live) {
      this.liveBuffer = [];
      this.liveBytes = 0;
      // The last audible automation track hands off to the DJ — close its play
      // record so the log reflects what listeners actually heard.
      const air = this.currentOnAir(Date.now());
      if (air && air.startedAt != null && !air.reportedEnd) {
        air.reportedEnd = true;
        this.events.onPlayEnd(air, Date.now());
      }
    } else {
      // Automation kept running silently during the broadcast, so its clock is
      // exactly on schedule — just fade it back in and open the play record
      // for the track taking over (it may have started while we were live).
      const air = this.currentOnAir(Date.now());
      if (air && !air.reportedStart) {
        air.reportedStart = true;
        air.startedAt = Date.now();
        this.onAir = air;
        this.events.onPlayStart(air);
      }
      void this.fetchMore(); // safety: ensure the queue is fresh on handback
    }
    this.transition = { dir: live ? "to-live" : "to-auto", startedAt: Date.now() };
    this.events.onLiveToggle(live);
  }

  pushLivePcm(buf: Buffer): void {
    const frames = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    this.liveBuffer.push(frames);
    this.liveBytes += frames.length * 4;
    const MAX_LIVE = 5 * SAMPLE_RATE * CHANNELS * 4; // 5 s
    while (this.liveBytes > MAX_LIVE && this.liveBuffer.length > 1) {
      this.liveBytes -= this.liveBuffer.shift()!.byteLength;
    }
  }

  get isLive(): boolean {
    return this.liveMode;
  }

  private updateTransition(now: number): void {
    if (this.transition && now - this.transition.startedAt >= this.transitionMs) {
      this.transition = null;
    }
  }

  private liveGainAt(now: number): number {
    if (!this.transition) return this.liveMode ? 1 : 0;
    return transitionGains(this.transition.dir, now - this.transition.startedAt, this.transitionMs).live;
  }

  private automGainAt(now: number): number {
    if (!this.transition) return this.liveMode ? 0 : 1;
    return transitionGains(this.transition.dir, now - this.transition.startedAt, this.transitionMs).auto;
  }

  /* ---------------- Queue ---------------- */

  private async fetchMore(): Promise<void> {
    if (this.fetching) return; // never run two fetches for the same window
    this.fetching = true;
    const generation = this.queueGeneration;
    try {
      const seq = await this.fetchSequence(this.fetchAfterMs, 16);
      if (generation !== this.queueGeneration) return;
      if (seq.items.length === 0) {
        this.idleFetches++;
        if (this.idleFetches > 6) {
          // Nothing programmed — keep retrying slowly.
          setTimeout(() => void this.fetchMore(), 15_000);
          return;
        }
        setTimeout(() => void this.fetchMore(), 5_000);
        return;
      }
      this.idleFetches = 0;
      // Drop anything already covered by the queue tail (stale windows from a
      // restart or overlap) so anchored items never play out of order.
      const fresh = seq.items.filter((item) => {
        const start = item.airAt ?? this.fetchAfterMs;
        return start + item.durationSec * 1000 > this.queueEnd - 1000;
      });
      this.queue.push(...fresh);
      if (fresh.length > 0) {
        const last = fresh[fresh.length - 1]!;
        this.queueEnd = Math.max(
          this.queueEnd,
          last.cutoffAt ?? (last.airAt ?? this.fetchAfterMs) + last.durationSec * 1000,
        );
      }
      console.log(
        `[engine] fetched ${fresh.length}/${seq.items.length} items -> ${fresh
          .map((i) => `${i.title}(${i.source}${i.airAt ? "," + new Date(i.airAt).toISOString().slice(11, 19) : ""})`)
          .join(" | ")}`,
      );
      // fetchAfter advances to the end of the last planned item.
      let cursor = this.fetchAfterMs;
      for (const item of seq.items) {
        const start = item.airAt ?? cursor;
        const end = item.cutoffAt ?? start + item.durationSec * 1000;
        cursor = Math.max(cursor, end);
      }
      this.fetchAfterMs = cursor;
    } catch (err) {
      console.error("[engine] fetch failed", err instanceof Error ? err.message : err);
      setTimeout(() => void this.fetchMore(), 5_000);
    } finally {
      this.fetching = false;
    }
  }

  private ensureQueue(): void {
    if (this.queue.length - this.head < config.queueLowWater) {
      void this.fetchMore();
    }
  }

  private maybeRefreshProgramming(now: number): void {
    if (this.configPollInFlight || now < this.nextConfigPollAt) return;
    this.configPollInFlight = true;
    this.nextConfigPollAt = now + CONFIG_POLL_MS;
    void api.config()
      .then((cfg) => {
        this.setCrossfade(cfg.crossfadeMs);
        // Hot-swap the broadcast processing when the preset changes in Settings
        // (no engine restart needed — the encoder respawns with new filter args).
        const preset = (cfg.processingPreset as ProcessingPreset) || "radio";
        if (this.currentPreset === null) {
          this.currentPreset = preset; // sink already started with this preset
        } else if (this.currentPreset !== preset) {
          this.currentPreset = preset;
          this.sink.applyFilterArgs?.(broadcastFilterArgsFor(preset));
          console.log(`[engine] processing preset -> ${preset}`);
        }
        if (this.programmingRevision == null) {
          this.programmingRevision = cfg.programmingRevision;
        } else if (cfg.programmingRevision > this.programmingRevision) {
          const previousRevision = this.programmingRevision;
          this.programmingRevision = cfg.programmingRevision;
          this.invalidateFutureQueue(Date.now(), previousRevision, cfg.programmingRevision);
        }
        if (this.engineRestartRequestedAt === 0) {
          this.engineRestartRequestedAt = cfg.engineRestartRequestedAt;
        } else if (cfg.engineRestartRequestedAt > this.engineRestartRequestedAt) {
          this.engineRestartRequestedAt = cfg.engineRestartRequestedAt;
          this.requestProcessRestart(cfg.engineRestartRequestedAt);
        }
      })
      .catch(() => {})
      .finally(() => {
        this.configPollInFlight = false;
      });
  }

  private requestProcessRestart(requestedAt: number): void {
    if (this.restartRequested) return;
    this.restartRequested = true;
    console.warn("[engine] restart requested by admin control");
    setTimeout(() => process.exit(0), 250);
  }

  private invalidateFutureQueue(now: number, previousRevision: number, nextRevision: number): void {
    const retained = this.decks.filter((d) => !d.failed && now >= d.startMs - d.fadeInMs && now < d.endMs);
    for (const d of this.decks) {
      if (!retained.includes(d)) d.stream?.kill();
    }
    this.queueGeneration++;
    this.queue = [];
    this.head = 0;
    this.decks = retained;
    this.onAir = this.currentOnAir(now);
    const retainedEnd = retained.reduce((max, d) => Math.max(max, d.endMs), now);
    this.nextStartMs = retainedEnd;
    this.fetchAfterMs = retainedEnd;
    this.queueEnd = retainedEnd;
    this.idleFetches = 0;
    void this.fetchMore();
  }

  /* ---------------- Main loop ---------------- */

  private async tick(): Promise<void> {
    // Never let two ticks overlap: an overlapping tick would double-consume
    // deck audio and cut tracks. With non-blocking reads ticks stay fast, so
    // this guard rarely trips.
    if (this.tickRunning) {
      if (config.diag) console.warn(`[engine][diag] TICK OVERLAP skipped now=${Date.now()}`);
      return;
    }
    this.tickRunning = true;
    const t0 = Date.now();
    try {
      await this.runTick();
    } finally {
      this.tickRunning = false;
      if (config.diag) {
        const dt = Date.now() - t0;
        if (dt > config.tickMs) console.warn(`[engine][diag] SLOW TICK ${dt}ms`);
      }
    }
  }

  private async runTick(): Promise<void> {
    const now = Date.now();
    const tickEnd = now + config.tickMs;

    this.updateTransition(now);
    this.maybeRefreshProgramming(now);
    const liveGain = this.liveGainAt(now);
    const automGain = this.automGainAt(now);
    // Play events are only reported while automation is audible (suppressed
    // during live, including its fade-in).
    const reporting = !this.liveMode;

    this.ensureQueue();

    // Create decks for upcoming items (up to 2 ahead).
    while (this.decks.length < 2 && this.head < this.queue.length) {
      this.createDeck(this.queue[this.head]!);
      this.head++;
    }

    // Prime (spawn ffmpeg) decks whose start is near.
    for (const d of this.decks) {
      if (!d.primed && now >= d.startMs - d.fadeInMs - PRIME_MS) {
        d.primed = true;
        try {
          d.stream = new PcmStream(d.item.filePath, d.item.gainDb, d.item.kind);
        } catch {
          d.stream = null;
        }
      }
    }

    // If the on-air deck failed to decode, skip it and start the next one now.
    const air = this.currentOnAir(now);
    if (air && air.stream?.error) {
      air.failed = true;
      air.stream.kill();
      const replacement = this.decks.find((d) => d !== air && !d.failed);
      if (replacement) {
        replacement.startMs = now;
        replacement.endMs = now + replacement.item.durationSec * 1000;
        replacement.fadeInMs = 0;
        replacement.fadeOutMs = 0;
        replacement.primed = true;
        this.nextStartMs = replacement.endMs;
        if (!replacement.stream) {
          try {
            replacement.stream = new PcmStream(replacement.item.filePath, replacement.item.gainDb, replacement.item.kind);
          } catch {
            replacement.stream = null;
          }
        }
        console.warn("[engine] deck failed, skipping to next item", air.item.title);
      }
    }

    const master = new Float32Array(FRAMES_PER_TICK * CHANNELS);
    const nowOnAir = this.currentOnAir(now);

    for (const d of this.decks) {
      if (!d.stream || d.endMs <= now) continue;
      const startMs = d.startMs - d.fadeInMs;
      if (tickEnd < startMs) continue; // not audible yet
      const gain = this.envelope(d, now + config.tickMs / 2) * automGain;
      const frames = await d.stream.readFrames(FRAMES_PER_TICK);
      if (config.diag) d.paddedFrames += d.stream.lastPaddedFrames;
      // Track the on-air deck's own level so we can react to trailing silence.
      if (d === nowOnAir && frames.length > 0) {
        let sumSq = 0;
        for (let i = 0; i < frames.length; i++) sumSq += frames[i]! * frames[i]!;
        const rms = Math.sqrt(sumSq / frames.length);
        d.silentMs = rms < SILENCE_RMS ? d.silentMs + config.tickMs : 0;
      }
      if (gain !== 0) {
        const g = Math.max(0, Math.min(1.5, gain));
        for (let i = 0; i < frames.length; i++) master[i]! += frames[i]! * g;
      }
      if (d.stream.error) {
        d.failed = true;
      }
    }

    // Trailing-silence advance: if the on-air track has gone quiet near its end
    // and a production element is next, pull that element forward to start now so
    // the jingle lands the instant the music stops (no silent gap).
    if (nowOnAir && !nowOnAir.item.airAt && nowOnAir.silentMs >= TRAILING_SILENCE_HOLD_MS) {
      const idx = this.decks.indexOf(nowOnAir);
      const next = idx >= 0 ? this.decks[idx + 1] : undefined;
      const nearEnd = now >= nowOnAir.endMs - TRAILING_SILENCE_WINDOW_MS;
      if (next && nearEnd && PRODUCTION_KINDS.has(next.item.kind) && next.startMs > now + 30) {
        const delta = next.startMs - now;
        for (let i = idx + 1; i < this.decks.length; i++) {
          const dd = this.decks[i]!;
          dd.startMs -= delta;
          dd.endMs -= delta;
          for (const gp of dd.gainPoints) gp.atMs -= delta;
        }
        this.nextStartMs = Math.max(0, this.nextStartMs - delta);
        this.queueEnd = Math.max(0, this.queueEnd - delta);
        // Do NOT hard-cut the track. The tail is essentially silent, so we simply
        // let the jingle start now and blend in gently over it — the music's own
        // natural end still lands underneath, so nothing sounds chopped.
        next.fadeInMs = Math.max(next.fadeInMs, 120);
        // Prime the pulled-forward deck now so it starts without waiting a tick.
        if (!next.primed) {
          next.primed = true;
          if (!next.stream) {
            try {
              next.stream = new PcmStream(next.item.filePath, next.item.gainDb, next.item.kind);
            } catch {
              next.stream = null;
            }
          }
        }
        console.log(
          `[engine] trailing silence on "${nowOnAir.item.title}" — starting "${next.item.title}" ${Math.round(delta)}ms early`,
        );
      }
    }

    // Mix the live input (unity during a broadcast, ramping during handovers).
    if (liveGain > 0) {
      const live = this.pullLive(FRAMES_PER_TICK);
      const g = Math.max(0, Math.min(1.5, liveGain));
      for (let i = 0; i < live.length; i++) master[i]! += live[i]! * g;
    }

    // Keep the on-air reference current in every mode (it drives status).
    if (nowOnAir !== this.onAir) {
      if (reporting && this.onAir && !this.onAir.reportedEnd && this.onAir.startedAt != null) {
        this.onAir.reportedEnd = true;
        this.events.onPlayEnd(this.onAir, now);
      }
      if (reporting && nowOnAir && !nowOnAir.reportedStart) {
        nowOnAir.reportedStart = true;
        nowOnAir.startedAt = nowOnAir.startMs;
        this.events.onPlayStart(nowOnAir);
      }
      this.onAir = nowOnAir;
    }

    // Report end for decks that finished this tick.
    if (reporting) {
      for (const d of this.decks) {
        if (d !== this.onAir && d.endMs <= now && !d.reportedEnd && d.startedAt != null) {
          d.reportedEnd = true;
          this.events.onPlayEnd(d, now);
        }
      }
    }

    // Drop finished or failed decks (keep the on-air one during its final ticks).
    const kept: Planned[] = [];
    for (const d of this.decks) {
      const dropping = d.failed || (d !== this.onAir && d.endMs <= now);
      if (dropping && config.diag) {
        const expected = Math.round(d.item.durationSec * SAMPLE_RATE);
        const real = d.stream?.realFrames ?? 0;
        const shortSec = (expected - real) / SAMPLE_RATE;
        if (d.paddedFrames > SAMPLE_RATE / 10 || shortSec > 1) {
          console.warn(
            `[engine][diag] END "${d.item.title}" (${d.item.kind}) dur=${d.item.durationSec.toFixed(1)}s realAudio=${(real / SAMPLE_RATE).toFixed(1)}s starved=${(d.paddedFrames / SAMPLE_RATE).toFixed(2)}s shortOfDur=${shortSec.toFixed(2)}s eof=${d.stream?.ended ?? "?"} failed=${d.failed}`,
          );
        }
      }
      if (!dropping) kept.push(d);
    }
    this.decks = kept;

    this.writeMaster(master, now);
  }

  private currentOnAir(now: number): Planned | null {
    const active = this.decks.filter((d) => !d.failed && now >= d.startMs - d.fadeInMs && now < d.endMs);
    const voice = active.find((d) => d.item.kind === "voice");
    if (voice) return voice;
    let best: Planned | null = null;
    for (const d of active) {
      if (!best || d.startMs > best.startMs) best = d;
    }
    return best;
  }

  private envelope(d: Planned, t: number): number {
    return gainEnvelope(d.startMs, d.endMs, d.fadeInMs, d.fadeOutMs, t) * this.automationGain(d, t);
  }

  private automationGain(d: Planned, t: number): number {
    if (d.gainPoints.length === 0) return 1;
    const pts = d.gainPoints;
    if (t <= pts[0]!.atMs) return pts[0]!.gain;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      if (t <= b.atMs) {
        const span = Math.max(1, b.atMs - a.atMs);
        const p = (t - a.atMs) / span;
        return a.gain + (b.gain - a.gain) * p;
      }
    }
    return pts[pts.length - 1]!.gain;
  }

  private addGainPoint(d: Planned, atMs: number, gain: number): void {
    d.gainPoints.push({ atMs, gain });
    d.gainPoints.sort((a, b) => a.atMs - b.atMs);
  }

  private createDeck(item: EngineItem): void {
    const prev = this.decks[this.decks.length - 1] ?? null;
    // Never schedule backwards: anchored items (ads) that arrive late are
    // pushed forward onto the master timeline rather than lost in the past.
    let startMs = Math.max(item.airAt ?? this.nextStartMs, this.nextStartMs);
    let endMs = item.cutoffAt ?? startMs + item.durationSec * 1000;
    let fadeInMs = 0;
    let fadeOutMs = 250;
    let gainPoints: Array<{ atMs: number; gain: number }> = [];

    if (prev && !item.airAt && prev.item.kind === "music" && item.kind === "voice") {
      startMs = Math.max(prev.startMs, prev.endMs - VOICE_LINK_OVERLAP_IN_MS);
      endMs = startMs + item.durationSec * 1000;
      fadeOutMs = 120;
      this.addGainPoint(prev, Math.max(prev.startMs, startMs - VOICE_LINK_DUCK_RAMP_MS), 1);
      this.addGainPoint(prev, Math.min(prev.endMs, startMs + VOICE_LINK_DUCK_RAMP_MS), VOICE_LINK_DUCK_GAIN);
    }

    if (prev && !item.airAt && prev.item.kind === "voice" && item.kind === "music") {
      startMs = Math.max(prev.startMs, prev.endMs - VOICE_LINK_OVERLAP_OUT_MS);
      endMs = item.cutoffAt ?? startMs + item.durationSec * 1000;
      fadeInMs = 0;
      // Keep the incoming music DUCKED for the whole voice link, then bring it
      // up quickly once the voice has finished — otherwise the track swells up
      // under the last words and drowns the mic (sounds harsher than live).
      gainPoints = [
        { atMs: startMs, gain: VOICE_LINK_DUCK_GAIN },
        { atMs: prev.endMs, gain: VOICE_LINK_DUCK_GAIN },
        { atMs: prev.endMs + VOICE_LINK_DUCK_RAMP_MS, gain: 1 },
      ];
    }

    if (gainPoints.length === 0) gainPoints = [{ atMs: startMs, gain: 1 }];

    if (
      prev &&
      prev.item.kind === "music" &&
      item.kind === "music" &&
      startMs === prev.endMs
    ) {
      fadeInMs = this.crossfadeMs;
      prev.fadeOutMs = this.crossfadeMs;
    }

    // Strict radio rule for production elements (jingle / sweeper / station ID):
    // when one meets music or another element in a tight gapless join, land it
    // punchy. Songs usually carry a little trailing silence in the file, so when
    // an element FOLLOWS music we pull it forward to OVERLAP the tail of the song
    // by a small lead — the element starts just as the song's audible music ends,
    // hiding any file tail-silence so there's never a dead gap before the hit.
    // The song's own tail is faded across that overlap so a real ending glues.
    // Top-of-hour/anchored items (item.airAt) and voice overlaps keep their own
    // handling.
    const itemIsElement = PRODUCTION_KINDS.has(item.kind);
    const prevIsElement = prev != null && PRODUCTION_KINDS.has(prev.item.kind);
    if (!item.airAt && prev != null && prev.item.kind !== "voice" && item.kind !== "voice" && (itemIsElement || prevIsElement)) {
      const prevMusic = prev.item.kind === "music";
      if (itemIsElement && prevMusic && PRODUCTION_LEAD_MS > 0) {
        startMs = Math.max(prev.startMs, prev.endMs - PRODUCTION_LEAD_MS);
        endMs = item.cutoffAt ?? startMs + item.durationSec * 1000;
        // Smooth duck, not a cut: the jingle eases in while the song eases out
        // across the overlap, so the music never stops abruptly under it.
        fadeInMs = PRODUCTION_SMOOTH_MS;
        prev.fadeOutMs = Math.min(prev.fadeOutMs, Math.max(0, prev.endMs - startMs));
        if (gainPoints.length === 0 || gainPoints[0]!.gain === 1) {
          gainPoints = [{ atMs: startMs, gain: 1 }];
        } else if (gainPoints.length > 0 && gainPoints[0]!.atMs > startMs) {
          gainPoints[0] = { atMs: startMs, gain: gainPoints[0]!.gain };
        }
      } else if (itemIsElement) {
        // element after an element (or after itself) — tight, no song tail involved
        fadeInMs = PRODUCTION_ATTACK_MS;
        fadeOutMs = PRODUCTION_TAIL_MS;
        prev.fadeOutMs = Math.min(prev.fadeOutMs, PRODUCTION_TAIL_MS);
      }
      // element tail stays tight whether we led-in or not
      if (itemIsElement) fadeOutMs = Math.min(fadeOutMs, PRODUCTION_TAIL_MS);
      // music that RESUMES after an element eases in smoothly (no hard start)
      if (!itemIsElement && prevIsElement) {
        prev.fadeOutMs = Math.min(prev.fadeOutMs, PRODUCTION_TAIL_MS);
        fadeInMs = Math.max(fadeInMs, PRODUCTION_SMOOTH_MS);
      }
    }

    if (!prev) fadeOutMs = 0;
    this.decks.push({
      item,
      startMs,
      endMs,
      fadeInMs,
      fadeOutMs,
      gainPoints,
      stream: null,
      primed: false,
      reportedStart: false,
      reportedEnd: false,
      startedAt: null,
      failed: false,
      paddedFrames: 0,
      silentMs: 0,
    });
    this.nextStartMs = Math.max(this.nextStartMs, endMs);
    this.queueEnd = Math.max(this.queueEnd, endMs);
  }

  private pullLive(frames: number): Float32Array {
    const out = new Float32Array(frames * CHANNELS);
    let offset = 0;
    while (offset < frames && this.liveBuffer.length > 0) {
      const head = this.liveBuffer[0]!;
      const take = Math.min(frames - offset, head.length / CHANNELS);
      out.set(head.subarray(0, take * CHANNELS), offset * CHANNELS);
      if (take * CHANNELS === head.length) {
        this.liveBuffer.shift();
      } else {
        this.liveBuffer[0] = head.subarray(take * CHANNELS);
      }
      this.liveBytes -= take * CHANNELS * 4;
      offset += take;
    }
    return out;
  }

  /** Soft-clip the master and write to the sink (plus any recorder). */
  private writeMaster(master: Float32Array, _now: number): void {
    // Gentle soft clip to avoid digital overs.
    for (let i = 0; i < master.length; i++) {
      const x = master[i]!;
      if (x > 1) master[i] = 1 - Math.exp(-x);
      else if (x < -1) master[i] = -1 + Math.exp(x);
    }
    this.sink.write(Buffer.from(master.buffer, master.byteOffset, master.byteLength));
  }

  getStatusPayload() {
    const current = this.onAir?.item ?? null;
    const buffered = this.decks
      .filter((d) => d !== this.onAir)
      .map((d) => d.item);
    const queued = this.queue.slice(this.head);
    const upcomingItems = [...buffered, ...queued]
      .filter((item, index, arr) => arr.findIndex((candidate) => candidate.id === item.id) === index)
      .slice(0, 5);
    const next = upcomingItems[0] ?? null;
    return { currentItem: current, nextItem: next, upcomingItems, mode: this.liveMode ? "live" : "automation" };
  }

  setCrossfade(ms: number): void {
    this.crossfadeMs = ms;
  }
}
