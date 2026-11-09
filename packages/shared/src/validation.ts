import { z } from "zod";
import { KINDS, ROLES, EVENT_TYPES, DEFAULT_BREAKS, PROCESSING_PRESETS } from "./constants.js";

export const emailSchema = z.string().email().max(254);

export const registerSchema = z.object({
  email: emailSchema,
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(100),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

export const djLoginSchema = z.object({
  email: emailSchema,
  code: z.string().regex(/^\d{6}$/),
});

export const settingsSchema = z.object({
  stationName: z.string().min(1).max(120).optional(),
  tagline: z.string().max(300).optional(),
  timezone: z.string().min(1).max(80).optional(),
  streamBitrate: z.number().int().min(32).max(320).optional(),
  streamUrl: z.string().max(500).optional(),
  mount: z.string().min(1).max(120).optional(),
  logoPath: z.string().max(500).nullable().optional(),
  defaultPlaylistId: z.string().nullable().optional(),
  defaultClockwheelId: z.string().nullable().optional(),
  recordShows: z.boolean().optional(),
  crossfadeMs: z.number().int().min(0).max(15000).optional(),
  audioProcessingPreset: z.enum(PROCESSING_PRESETS).optional(),
  topOfHourTrackId: z.string().nullable().optional(),
  autoJingleEvery: z.number().int().min(0).max(50).optional(),
  autoJingleFolder: z.string().max(120).nullable().optional(),
  requestBoxEnabled: z.boolean().optional(),
  publicPageEnabled: z.boolean().optional(),
  recordingRetentionDays: z.number().int().min(1).max(365).optional(),
  geoMode: z.enum(["off", "block", "allow"]).optional(),
  geoCountries: z.string().max(120).optional(),
});

export const trackPatchSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  artist: z.string().max(300).optional(),
  album: z.string().max(300).optional(),
  folder: z.string().max(120).nullable().optional(),
  kind: z.enum(KINDS).optional(),
  isActive: z.boolean().optional(),
  bpm: z.number().nullable().optional(),
});

export const playlistSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  artistSeparation: z.number().int().min(0).max(50).default(3),
  trackSeparationMinutes: z.number().int().min(0).max(24 * 60).default(30),
  shuffle: z.boolean().default(false),
});

export const playlistPatchSchema = playlistSchema.partial();

export const playlistGenerateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  hours: z.number().int().min(1).max(24),
  musicFolders: z.array(z.string().min(1).max(120)).max(50).default([]),
  includeJingles: z.boolean().default(true),
  jingleEvery: z.number().int().min(1).max(20).default(3),
  jingleFolder: z.string().max(120).nullable().optional(),
  shuffle: z.boolean().default(false),
});

const stationRotationFields = {
  name: z.string().min(1).max(120),
  dayOfWeek: z.number().int().min(0).max(6).nullable(),
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(1).max(24),
  playlistId: z.string().min(1).nullable().optional(),
  clockwheelId: z.string().nullable().optional(),
  sundayPlaylistId: z.string().min(1).nullable().optional(),
  mondayPlaylistId: z.string().min(1).nullable().optional(),
  tuesdayPlaylistId: z.string().min(1).nullable().optional(),
  wednesdayPlaylistId: z.string().min(1).nullable().optional(),
  thursdayPlaylistId: z.string().min(1).nullable().optional(),
  fridayPlaylistId: z.string().min(1).nullable().optional(),
  saturdayPlaylistId: z.string().min(1).nullable().optional(),
  autoGenerate: z.boolean().default(false),
  shufflePlaylist: z.boolean().default(false),
  musicFolders: z.array(z.string().min(1).max(120)).max(50).default([]),
  includeJingles: z.boolean().default(true),
  jingleEvery: z.number().int().min(1).max(20).default(3),
  jingleFolder: z.string().max(120).nullable().optional(),
  priority: z.number().int().min(0).max(100).default(0),
  isActive: z.boolean().default(true),
} satisfies z.ZodRawShape;

function addStationRotationTimeIssue(
  ctx: z.RefinementCtx,
): void {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: "endHour must be after startHour",
    path: ["endHour"],
  });
}

export const stationRotationSchema = z.object(stationRotationFields).superRefine((value, ctx) => {
  if (value.endHour <= value.startHour) {
    addStationRotationTimeIssue(ctx);
  }
});

export const stationRotationPatchSchema = z.object(stationRotationFields).partial().superRefine((value, ctx) => {
  if (
    value.startHour !== undefined &&
    value.endHour !== undefined &&
    value.endHour <= value.startHour
  ) {
    addStationRotationTimeIssue(ctx);
  }
});

export const clockwheelSchema = z.object({
  name: z.string().min(1).max(120),
});

export const clockSlotSchema = z.object({
  position: z.number().int().min(0),
  type: z.enum(["music", "jingle", "sweeper", "station_id", "anchored", "ad_break"]),
  playlistId: z.string().nullable().optional(),
  trackId: z.string().nullable().optional(),
  label: z.string().max(120).nullable().optional(),
  durationSeconds: z.number().int().min(1).max(3600).nullable().optional(),
});

export const clockSlotPatchSchema = clockSlotSchema.partial();

export const showSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#3b82f6"),
  imagePath: z.string().max(500).nullable().optional(),
  playlistId: z.string().nullable().optional(),
  clockwheelId: z.string().nullable().optional(),
  presenters: z.string().max(300).optional(),
});

export const showPatchSchema = showSchema.partial();

export const scheduleEntrySchema = z.object({
  showId: z.string().min(1),
  dayOfWeek: z.number().int().min(0).max(6).nullable(),
  startMinutes: z.number().int().min(0).max(1439),
  endMinutes: z.number().int().min(1).max(1440),
});

export const scheduleEntryPatchSchema = scheduleEntrySchema.partial();

const djSlotFields = {
  djId: z.string().min(1),
  showId: z.string().nullable().optional(),
  dayOfWeek: z.number().int().min(0).max(6).nullable(),
  startMinutes: z.number().int().min(0).max(1439),
  endMinutes: z.number().int().min(1).max(1440),
} satisfies z.ZodRawShape;

export const djSlotSchema = z.object(djSlotFields).superRefine((value, ctx) => {
  if (value.endMinutes <= value.startMinutes) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "endMinutes must be after startMinutes", path: ["endMinutes"] });
  }
});

export const djSlotPatchSchema = z.object(djSlotFields).partial();

export const voiceTrackSchema = z.object({
  title: z.string().min(1).max(200),
  showId: z.string().nullable().optional(),
  playEvery: z.number().int().min(1).max(50).default(3),
  isActive: z.boolean().optional(),
});

export const rundownItemSchema = z.object({
  kind: z.enum(["track", "voice"]),
  trackId: z.string().min(1).nullable().optional(),
  voiceTrackId: z.string().min(1).nullable().optional(),
  position: z.number().int().min(0).optional(),
});

export const rundownAutoSchema = z.object({
  folder: z.string().max(120).optional(), // "" / undefined = all folders, "unfiled" = no folder
  targetMinutes: z.union([z.literal(60), z.literal(120), z.literal(180)]).default(60),
  voiceEvery: z.number().int().min(1).max(8).default(3),
  mode: z.enum(["replace", "append"]).default("append"),
});

export const campaignSchema = z.object({
  advertiser: z.string().min(1).max(200),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  spotsPerDay: z.number().int().min(1).max(144),
  maxPerHour: z.number().int().min(1).max(24),
  whenRule: z.enum(["weekday_drivetime", "weekends", "all_day", "custom"]),
  customDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  ratePerSpot: z.number().min(0).max(1_000_000),
  currency: z.string().min(3).max(3).default("USD"),
  audioTrackId: z.string().nullable().optional(),
  status: z.enum(["draft", "active", "paused", "completed"]).optional(),
});

export const campaignPatchSchema = campaignSchema.partial();

export const recordingPatchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  isPodcast: z.boolean().optional(),
  djId: z.string().uuid().nullable().optional(),
});

export const requestSchema = z.object({
  songQuery: z.string().min(1).max(300),
  trackId: z.string().nullable().optional(),
  listenerName: z.string().max(120).optional(),
  message: z.string().max(500).optional(),
});

export const requestPatchSchema = z.object({
  status: z.enum(["pending", "approved", "rejected"]),
});

export const listenerHeartbeatSchema = z.object({
  sessionId: z.string().min(8).max(120),
});

export const apiKeySchema = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(z.string()).max(20).default(["read"]),
});

export const webhookSchema = z.object({
  url: z.string().url().max(500),
  events: z.array(z.enum(EVENT_TYPES)).min(1),
  secret: z.string().min(8).max(200).optional(),
  isActive: z.boolean().optional(),
});

export const webhookPatchSchema = webhookSchema.partial();

export const djCreateSchema = z.object({
  email: emailSchema,
  name: z.string().min(1).max(100),
});

export const djPatchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  isActive: z.boolean().optional(),
});

export const inviteCreateSchema = z.object({
  email: emailSchema,
  role: z.enum(["admin", "dj"]),
});

export const inviteAcceptSchema = z.object({
  token: z.string().min(8).max(200),
  name: z.string().min(1).max(100),
  password: z.string().min(8).max(200),
});

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});

export const adminAccountUpdateSchema = z.object({
  name: z.string().min(1).max(100),
  email: emailSchema,
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200).optional().or(z.literal("")),
});

/** Feasibility check for a campaign booking: returns per-day capacity. */
export interface CampaignFeasibility {
  ok: boolean;
  days: number;
  breaksPerDay: number;
  maxSpotsPerBreak: number;
  feasiblePerDay: number;
  reason: string;
}

/** Hours considered "weekday drivetime" — 06:00-20:00 Mon-Fri (2 breaks/hour). */
export function drivetimeHours(): number[] {
  return Array.from({ length: 14 }, (_, i) => i + 6); // 6..19
}

export { DEFAULT_BREAKS, ROLES };
