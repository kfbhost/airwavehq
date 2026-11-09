function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  apiUrl: env("API_URL", "http://localhost:8080/api"),
  engineKey: env("ENGINE_SECRET", "dev-engine-secret-change-me"),
  jwtSecret: env("JWT_SECRET", "dev-secret-change-me"),
  livePort: Number(env("ENGINE_PORT", "9002")),

  iceHost: env("ICE_HOST", ""), // empty = no icecast (dev file output)
  icePort: Number(env("ICE_PORT", "8000")),
  iceMount: env("ICE_MOUNT", "/live"),
  iceSourcePassword: env("ICE_SOURCE_PASSWORD", "sourcepass"),
  iceAdminPassword: env("ICE_ADMIN_PASSWORD", "adminpass"),
  iceBitrate: Number(env("ICE_BITRATE", "128")),
  icePublic: Number(env("ICE_PUBLIC", "0")),
  iceCodec: env("ICE_CODEC", "mp3"),
  // Broadcast dynamics (acompressor + alimiter) on the final output.
  processingEnabled: env("AUDIO_PROCESSING", "1") !== "0",

  dataDir: env("DATA_DIR", "../../data"),
  tickMs: 100,
  crossfadeMs: Number(env("CROSSFADE_MS", "2000")),
  liveTransitionMs: Number(env("LIVE_TRANSITION_MS", "2500")), // live<->automation handover blend
  queueLowWater: 8, // refill while the buffer is still healthy so the dashboard always shows 5+ lined up
  logLevel: env("LOG_LEVEL", "info"),
  // Diagnostics for the intermittent "track cuts off" issue. Off unless
  // ENGINE_DIAG=1; when off, every diag path is skipped (zero audio impact).
  diag: env("ENGINE_DIAG", "0") === "1",
};

export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;
export const F32_BYTES = 4;
