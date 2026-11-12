import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PcmStream } from "../src/decode.js";
import { Playout, gainEnvelope, transitionGains } from "../src/playout.js";
import { VOICE_LINK_OVERLAP_IN_MS, VOICE_LINK_OVERLAP_OUT_MS, type EngineItem } from "@airwavehq/shared";

describe("gainEnvelope", () => {
  const start = 100_000;
  const end = 104_000; // 4 s
  const fade = 2000;

  it("is silent outside the window", () => {
    expect(gainEnvelope(start, end, fade, fade, start - fade - 1)).toBe(0);
    expect(gainEnvelope(start, end, fade, fade, end)).toBe(0);
  });

  it("is at unity in the middle", () => {
    expect(gainEnvelope(start, end, fade, fade, start + 500)).toBe(1);
  });

  it("crossfades with equal power", () => {
    // Halfway through the fade-in: sin(45°) ≈ 0.7071
    const g = gainEnvelope(start, end, fade, fade, start - fade / 2);
    expect(g).toBeCloseTo(0.7071, 3);
    const gOut = gainEnvelope(start, end, fade, fade, end - fade / 2);
    expect(gOut).toBeCloseTo(0.7071, 3);
  });

  it("hard cuts when fades are zero", () => {
    expect(gainEnvelope(start, end, 0, 0, start - 1)).toBe(0);
    expect(gainEnvelope(start, end, 0, 0, start)).toBe(1);
    expect(gainEnvelope(start, end, 0, 0, end - 1)).toBe(1);
  });
});

describe("transitionGains", () => {
  const total = 2500;

  it("starts with the outgoing source at unity", () => {
    expect(transitionGains("to-live", 0, total)).toEqual({ live: 0, auto: 1 });
    expect(transitionGains("to-auto", 0, total)).toEqual({ live: 1, auto: 0 });
  });

  it("crossfades with equal power halfway through", () => {
    const toLive = transitionGains("to-live", total / 2, total);
    expect(toLive.live).toBeCloseTo(0.7071, 3);
    expect(toLive.auto).toBeCloseTo(0.7071, 3);
  });

  it("completes with the incoming source at unity", () => {
    expect(transitionGains("to-live", total, total)).toEqual({ live: 1, auto: 0 });
    expect(transitionGains("to-auto", total, total)).toEqual({ live: 0, auto: 1 });
  });

  it("clamps elapsed time outside the window", () => {
    expect(transitionGains("to-auto", 99_999, total)).toEqual({ live: 0, auto: 1 });
    expect(transitionGains("to-live", -50, total)).toEqual({ live: 0, auto: 1 });
  });
});

describe("PcmStream (real ffmpeg)", () => {
  let dir: string;
  let file: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "airwavehq-test-"));
    file = join(dir, "tone.mp3");
    execFileSync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:a", "libmp3lame", "-y", file,
    ]);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("decodes PCM at 48 kHz stereo and terminates at EOF", async () => {
    const stream = new PcmStream(file, 0);
    const frames = await stream.readFrames(4800); // 100 ms
    expect(frames.length).toBe(4800 * 2);
    // The sine wave should be audible (non-zero).
    let energy = 0;
    for (let i = 0; i < frames.length; i++) energy += Math.abs(frames[i]!);
    expect(energy).toBeGreaterThan(0);
    stream.kill();
  });

  it("pads short reads at EOF", async () => {
    const stream = new PcmStream(file, 0);
    // Drain the whole file (2 s = 96000 frames) then ask for more.
    let total = 0;
    while (total < 200_000) {
      const frames = await stream.readFrames(9600);
      total += frames.length / 2;
      if (frames.every((f) => f === 0) && frames.length > 0) break;
    }
    expect(total).toBeGreaterThan(95_000); // read most of the file
    stream.kill();
  });
});

describe("Playout (end-to-end with injected sequence)", () => {
  it("overlaps music around a voice link for produced-show handoffs", () => {
    const musicA: EngineItem = {
      id: "mix-a",
      trackId: "ta",
      artworkPath: null,
      kind: "music",
      title: "Track A",
      artist: "Tests",
      durationSec: 180,
      gainDb: 0,
      filePath: "/tmp/a.mp3",
      airAt: null,
      cutoffAt: null,
      source: "automation",
      showId: "show-1",
      campaignId: null,
      voiceTrackId: null,
    };
    const voice: EngineItem = {
      id: "mix-v",
      trackId: null,
      artworkPath: null,
      kind: "voice",
      title: "Voice Link",
      artist: "",
      durationSec: 12,
      gainDb: 0,
      filePath: "/tmp/v.mp3",
      airAt: null,
      cutoffAt: null,
      source: "voice",
      showId: "show-1",
      campaignId: null,
      voiceTrackId: "voice-1",
    };
    const musicB: EngineItem = {
      ...musicA,
      id: "mix-b",
      trackId: "tb",
      title: "Track B",
      filePath: "/tmp/b.mp3",
    };

    const playout = new Playout(
      { write: () => {} },
      { onStatus: () => {}, onPlayStart: () => {}, onPlayEnd: () => {}, onLiveToggle: () => {} },
      0,
      async () => ({ items: [], mode: "rundown", fetchedAt: Date.now() }),
    );

    const p = playout as unknown as {
      nextStartMs: number;
      queueEnd: number;
      createDeck: (item: EngineItem) => void;
      decks: Array<{ item: EngineItem; startMs: number; endMs: number; gainPoints: Array<{ atMs: number; gain: number }> }>;
    };
    p.nextStartMs = 1_000_000;
    p.queueEnd = 1_000_000;
    p.createDeck(musicA);
    p.createDeck(voice);
    p.createDeck(musicB);

    const a = p.decks[0]!;
    const v = p.decks[1]!;
    const b = p.decks[2]!;
    expect(v.startMs).toBe(a.endMs - VOICE_LINK_OVERLAP_IN_MS);
    expect(b.startMs).toBe(v.endMs - VOICE_LINK_OVERLAP_OUT_MS);
    expect(a.gainPoints.some((pt) => pt.gain < 1)).toBe(true);
    expect(b.gainPoints[0]?.gain).toBeLessThan(1);
  });

  it("plays an injected item, reports start/end, and writes audio", async () => {
    const dir = mkdtempSync(join(tmpdir(), "airwavehq-play-"));
    const file = join(dir, "tone.mp3");
    execFileSync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "sine=frequency=330:duration=1.2",
      "-c:a", "libmp3lame", "-y", file,
    ]);

    const item: EngineItem = {
      id: "test-play-1",
      trackId: "t1",
      artworkPath: null,
      kind: "music",
      title: "Test Tone",
      artist: "Tests",
      durationSec: 1.2,
      gainDb: 0,
      filePath: file,
      airAt: null,
      cutoffAt: null,
      source: "automation",
      showId: null,
      campaignId: null,
      voiceTrackId: null,
    };

    let bytesWritten = 0;
    let fetches = 0;
    const starts: string[] = [];
    const ends: string[] = [];

    const playout = new Playout(
      { write: (pcm) => { bytesWritten += pcm.length; } },
      {
        onStatus: () => {},
        onPlayStart: (p) => starts.push(p.item.id),
        onPlayEnd: (p) => ends.push(p.item.id),
        onLiveToggle: () => {},
      },
      0,
      async () => {
        fetches++;
        return { items: fetches === 1 ? [item] : [], mode: "playlist", fetchedAt: Date.now() };
      },
    );

    playout.start();
    await sleep(2600); // item is 1.2 s
    playout.stop();

    expect(starts).toContain("test-play-1");
    expect(bytesWritten).toBeGreaterThan(0);
    expect(bytesWritten / (48000 * 2 * 4)).toBeGreaterThan(0.8); // at least ~0.8 s of audio
    rmSync(dir, { recursive: true, force: true });
  });

  it("hands over to a live DJ and back without a hard cut or gap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "airwavehq-live-"));
    const file = join(dir, "tone.mp3");
    execFileSync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "sine=frequency=330:duration=3",
      "-c:a", "libmp3lame", "-y", file,
    ]);

    const item: EngineItem = {
      id: "handover-tone",
      trackId: "t1",
      artworkPath: null,
      kind: "music",
      title: "Handover Tone",
      artist: "Tests",
      durationSec: 3,
      gainDb: 0,
      filePath: file,
      airAt: null,
      cutoffAt: null,
      source: "automation",
      showId: null,
      campaignId: null,
      voiceTrackId: null,
    };

    const starts: string[] = [];
    const ends: string[] = [];
    const toggles: boolean[] = [];
    // Energy of each sink write, timestamped, to prove continuity at the cut.
    const chunks: { t: number; e: number }[] = [];

    const playout = new Playout(
      {
        write: (pcm) => {
          const a = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
          let e = 0;
          for (let i = 0; i < a.length; i++) e += a[i]! * a[i]!;
          chunks.push({ t: Date.now(), e });
        },
      },
      {
        onStatus: () => {},
        onPlayStart: (p) => starts.push(p.item.id),
        onPlayEnd: (p) => ends.push(p.item.id),
        onLiveToggle: (live) => toggles.push(live),
      },
      0,
      async () => ({ items: [item], mode: "playlist", fetchedAt: Date.now() }),
    );

    // A 1 kHz tone at 0.4 amplitude to stand in for the DJ's mix.
    const liveTone = new Float32Array(4800 * 2);
    for (let i = 0; i < 4800; i++) {
      const s = 0.4 * Math.sin((2 * Math.PI * 1000 * i) / 48000);
      liveTone[i * 2] = s;
      liveTone[i * 2 + 1] = s;
    }
    const liveBuf = Buffer.from(liveTone.buffer);

    playout.start();
    await sleep(600); // automation audible

    // DJ connects: push audio and enter live mode.
    const pushTimer = setInterval(() => playout.pushLivePcm(liveBuf), 80);
    const liveStart = Date.now();
    playout.setLiveMode(true);
    await sleep(3500); // past the 2.5 s transition, still live

    // The audible automation track handed off — its end was reported.
    expect(ends).toContain("handover-tone");
    expect(toggles).toEqual([true]);
    // No silent ticks during the fade-in: every 100 ms write has energy.
    const duringLive = chunks.filter((c) => c.t >= liveStart && c.t <= liveStart + 3000);
    expect(duringLive.length).toBeGreaterThan(10);
    expect(duringLive.every((c) => c.e > 0)).toBe(true);

    // DJ disconnects: automation fades back in.
    const handback = Date.now();
    playout.setLiveMode(false);
    clearInterval(pushTimer);
    await sleep(800);

    expect(toggles).toEqual([true, false]);
    // The automation track resumed — a new play start was reported.
    expect(starts.length).toBeGreaterThanOrEqual(2);
    // No silent ticks during the fade back to automation.
    const afterHandback = chunks.filter((c) => c.t >= handback && c.t <= handback + 2500);
    expect(afterHandback.length).toBeGreaterThan(5);
    expect(afterHandback.every((c) => c.e > 0)).toBe(true);

    playout.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
