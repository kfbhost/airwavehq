import { createSink, type Sink } from "./icecast.js";
import { Playout } from "./playout.js";
import { Telemetry } from "./telemetry.js";
import { RecordingManager } from "./recording.js";
import { startLiveServer } from "./live.js";
import { config } from "./config.js";
import { api } from "./api.js";
import type { ProcessingPreset } from "@airshift/shared";

async function main(): Promise<void> {
  console.log(`[engine] starting · api=${config.apiUrl} ice=${config.iceHost || "(none)"} bitrate=${config.iceBitrate}k`);

  let crossfadeMs = config.crossfadeMs;
  let processingPreset: ProcessingPreset = "radio";
  try {
    const cfg = await api.config();
    crossfadeMs = cfg.crossfadeMs || config.crossfadeMs;
    if (cfg.bitrate > 0) {
      config.iceBitrate = cfg.bitrate;
    }
    processingPreset = (cfg.processingPreset as ProcessingPreset) || "radio";
  } catch {
    console.warn("[engine] could not reach API at startup — will retry on fetch");
  }

  const sink: Sink = createSink(processingPreset);
  const recording = new RecordingManager();
  // Tee the master into the recorder as well as the broadcast sink.
  // NB: delegate explicitly — spreading the sink would copy its methods as
  // unbound functions, so `this` inside them would be the tee, not the sink.
  const tee: Sink = {
    write: (pcm) => {
      sink.write(pcm);
      recording.write(pcm);
    },
    setMetadata: (song) => sink.setMetadata(song),
    listeners: () => sink.listeners(),
    close: () => sink.close(),
    applyFilterArgs: (args) => sink.applyFilterArgs(args),
  };

  let telemetry: Telemetry;
  const playout = new Playout(
    tee,
    {
      onStatus: () => {},
      onPlayStart: (p) => telemetry.onPlayStart(p),
      onPlayEnd: (p, endedAt) => telemetry.onPlayEnd(p, endedAt),
      onLiveToggle: (live) => telemetry.onLiveToggle(live),
    },
    crossfadeMs,
  );
  telemetry = new Telemetry(playout, sink);

  telemetry.start();
  recording.start();
  playout.start();
  const stopLive = startLiveServer(playout, (name, showName) => telemetry.setLiveDj(name, showName), recording);

  const shutdown = async () => {
    console.log("[engine] shutting down");
    playout.stop();
    recording.stop();
    telemetry.stop();
    sink.close();
    stopLive();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Keep the process alive (all timers are unref'd).
  setInterval(() => {}, 1 << 30);
}

main().catch((err) => {
  console.error("[engine] fatal", err);
  process.exit(1);
});
