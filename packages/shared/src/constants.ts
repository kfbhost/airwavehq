/**
 * Shared constants for RadioHost Studio.
 */

export const APP_NAME = "RadioHost Studio";

/** Single source of truth for the app version, shown in the sidebar.
 * Bump this (and the package.json versions) on every deployed change. */
export const APP_VERSION = "1.9.0";

export const KINDS = [
  "music",
  "jingle",
  "sweeper",
  "station_id",
  "voice",
  "ad",
  "recording",
] as const;
export type TrackKind = (typeof KINDS)[number];

export const KIND_LABELS: Record<TrackKind, string> = {
  music: "Music",
  jingle: "Jingle",
  sweeper: "Sweeper",
  station_id: "Station ID",
  voice: "Voice track",
  ad: "Ad copy",
  recording: "Recorded show",
};

export const ROLES = ["admin", "dj"] as const;
export type Role = (typeof ROLES)[number];

export const SOURCES = ["automation", "live", "voice", "ad"] as const;
export type PlaySource = (typeof SOURCES)[number];

/** Broadcast processing presets selectable in Settings (engine applies them live). */
export const PROCESSING_PRESETS = ["off", "gentle", "radio", "punch"] as const;
export type ProcessingPreset = (typeof PROCESSING_PRESETS)[number];

/** Ad breaks are anchored at these minute offsets in each hour (unless a clockwheel overrides). */
export const DEFAULT_BREAKS = [15, 45];

/** How many tracks to fetch from the scheduler in one request. */
export const ENGINE_SEQUENCE_SIZE = 12;

/** Crossfade length in milliseconds between music tracks. */
export const DEFAULT_CROSSFADE_MS = 2000;

/** Voice-link overlap/ducking used for pre-produced shows. */
export const VOICE_LINK_OVERLAP_IN_MS = 4000;
/** Short overlap only — the next track stays ducked until the voice ends. */
export const VOICE_LINK_OVERLAP_OUT_MS = 500;
/** Default assumed length of a blank voice slot when planning a rundown. */
export const VOICE_SLOT_ESTIMATE_SEC = 15;
/**
 * How far over its slot a rundown should aim when building, so the last track
 * always fades into the top-of-hour jingle. 2 minutes also absorbs blank or
 * short voice links (6 slots x 15s = 90s) so a show never runs short.
 */
export const SHOW_OVERRUN_TARGET_SEC = 120;
export const VOICE_LINK_DUCK_GAIN = 0.2;
export const VOICE_LINK_DUCK_RAMP_MS = 300;

/** Sample rate of the master audio pipeline. */
export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;

export const MAX_REQUEST_MESSAGE = 500;
export const MAX_UPLOAD_BYTES = 400 * 1024 * 1024; // 400 MB per file

export const BREAK_NAMES: Record<string, string> = {
  weekday_drivetime: "Weekday drivetime",
  weekends: "Weekends",
  all_day: "All day",
  custom: "Custom days",
};

export const EVENT_TYPES = [
  "track.start",
  "track.end",
  "show.start",
  "show.end",
  "live.on",
  "live.off",
  "request.received",
  "request.approved",
  "campaign.airing",
] as const;
export type WebhookEvent = (typeof EVENT_TYPES)[number];
