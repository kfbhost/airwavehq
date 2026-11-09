import {
  pgTable,
  text,
  integer,
  real,
  boolean,
  timestamp,
  jsonb,
  uuid,
  index,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("dj"), // admin | dj
  djCode: text("dj_code"),
  avatarPath: text("avatar_path"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const settings = pgTable("settings", {
  id: integer("id").primaryKey().default(1),
  stationName: text("station_name").notNull().default("My Radio Station"),
  tagline: text("tagline").notNull().default(""),
  timezone: text("timezone").notNull().default("UTC"),
  streamBitrate: integer("stream_bitrate").notNull().default(128),
  streamUrl: text("stream_url").notNull().default(""),
  mount: text("mount").notNull().default("/live"),
  logoPath: text("logo_path"),
  defaultPlaylistId: uuid("default_playlist_id"),
  defaultClockwheelId: uuid("default_clockwheel_id"),
  recordShows: boolean("record_shows").notNull().default(true),
  crossfadeMs: integer("crossfade_ms").notNull().default(2000),
  audioProcessingPreset: text("audio_processing_preset").notNull().default("radio"),
  topOfHourTrackId: uuid("top_of_hour_track_id"),
  // Automatic jingle layer for automation/pre-produced output: insert a jingle
  // every N music tracks (0 = off). autoJingleFolder restricts to one jingle
  // folder; null/empty = use any jingle. Skipped where jingles already run
  // (clockwheels, auto-generate-with-jingles) and for live/DJ output.
  autoJingleEvery: integer("auto_jingle_every").notNull().default(0),
  autoJingleFolder: text("auto_jingle_folder"),
  requestBoxEnabled: boolean("request_box_enabled").notNull().default(true),
  publicPageEnabled: boolean("public_page_enabled").notNull().default(true),
  recordingRetentionDays: integer("recording_retention_days").notNull().default(60),
  geoMode: text("geo_mode").notNull().default("off"), // off | block | allow
  geoCountries: text("geo_countries").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tracks = pgTable(
  "tracks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    artist: text("artist").notNull().default(""),
    album: text("album").notNull().default(""),
    folder: text("folder"), // user-defined folder (e.g. genre); null = unfiled
    kind: text("kind").notNull().default("music"), // music|jingle|sweeper|station_id|voice|ad
    durationSeconds: real("duration_seconds").notNull().default(0),
    filePath: text("file_path").notNull(),
    fileHash: text("file_hash"), // sha-256 of file content, used to detect duplicates
    fileSize: integer("file_size").notNull().default(0),
    mime: text("mime").notNull().default("audio/mpeg"),
    codec: text("codec"),
    bitrateKbps: integer("bitrate_kbps"),
    loudnessGainDb: real("loudness_gain_db").notNull().default(0),
    loudnessLufs: real("loudness_lufs"),
    artworkPath: text("artwork_path"),
    bpm: real("bpm"),
    playCount: integer("play_count").notNull().default(0),
    lastPlayedAt: timestamp("last_played_at", { withTimezone: true }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tracks_kind_idx").on(t.kind), index("tracks_title_idx").on(t.title)],
);

export const folders = pgTable("folders", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const playlists = pgTable("playlists", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  artistSeparation: integer("artist_separation").notNull().default(3),
  trackSeparationMinutes: integer("track_separation_minutes").notNull().default(30),
  // Play this playlist's MUSIC in a fresh order every time it loops, so a long
  // running default playlist never repeats the same running order. Jingles and
  // other production items stay in the positions they were placed in.
  shuffle: boolean("shuffle").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const playlistItems = pgTable(
  "playlist_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    playlistId: uuid("playlist_id")
      .notNull()
      .references(() => playlists.id, { onDelete: "cascade" }),
    trackId: uuid("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    weight: integer("weight").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("playlist_items_pl_idx").on(t.playlistId)],
);

export const stationRotations = pgTable(
  "station_rotations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    dayOfWeek: integer("day_of_week"),
    startHour: integer("start_hour").notNull().default(0),
    endHour: integer("end_hour").notNull().default(24),
  playlistId: uuid("playlist_id").references(() => playlists.id, { onDelete: "cascade" }),
  clockwheelId: uuid("clockwheel_id").references(() => clockwheels.id, { onDelete: "set null" }),
  // Per-day playlists: when dayOfWeek is null (daily block), the scheduler uses
  // today's playlist column if set, falling back to playlistId.
  sundayPlaylistId: uuid("sunday_playlist_id").references(() => playlists.id, { onDelete: "set null" }),
  mondayPlaylistId: uuid("monday_playlist_id").references(() => playlists.id, { onDelete: "set null" }),
  tuesdayPlaylistId: uuid("tuesday_playlist_id").references(() => playlists.id, { onDelete: "set null" }),
  wednesdayPlaylistId: uuid("wednesday_playlist_id").references(() => playlists.id, { onDelete: "set null" }),
  thursdayPlaylistId: uuid("thursday_playlist_id").references(() => playlists.id, { onDelete: "set null" }),
  fridayPlaylistId: uuid("friday_playlist_id").references(() => playlists.id, { onDelete: "set null" }),
  saturdayPlaylistId: uuid("saturday_playlist_id").references(() => playlists.id, { onDelete: "set null" }),
  // Auto-regenerate: when true, a daily block rebuilds a fresh track list each
  // day from the configured music folders (with optional jingles), instead of
  // replaying one fixed playlist. musicFolders is a JSON array of folder names.
  autoGenerate: boolean("auto_generate").notNull().default(false),
  // Shuffle the playlist's music into a fresh order each time this block airs
  // (jingles/cues stay placed). Ignored when autoGenerate is on.
  shufflePlaylist: boolean("shuffle_playlist").notNull().default(false),
  musicFolders: text("music_folders"),
  includeJingles: boolean("include_jingles").notNull().default(true),
  jingleEvery: integer("jingle_every").notNull().default(3),
  jingleFolder: text("jingle_folder"),
  priority: integer("priority").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("station_rotations_day_hour_idx").on(t.dayOfWeek, t.startHour, t.endHour)],
);

export const clockwheels = pgTable("clockwheels", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const clockwheelSlots = pgTable(
  "clockwheel_slots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clockwheelId: uuid("clockwheel_id")
      .notNull()
      .references(() => clockwheels.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    type: text("type").notNull().default("music"), // music|jingle|sweeper|station_id|anchored|ad_break
    playlistId: uuid("playlist_id"),
    trackId: uuid("track_id"),
    label: text("label"),
    durationSeconds: integer("duration_seconds"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("clockwheel_slots_cw_idx").on(t.clockwheelId)],
);

export const shows = pgTable("shows", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description"),
  color: text("color").notNull().default("#3b82f6"),
  imagePath: text("image_path"),
  playlistId: uuid("playlist_id"),
  clockwheelId: uuid("clockwheel_id"),
  presenters: text("presenters").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const djSlots = pgTable(
  "dj_slots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    djId: uuid("dj_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    showId: uuid("show_id").references(() => shows.id, { onDelete: "set null" }),
    dayOfWeek: integer("day_of_week"),
    startMinutes: integer("start_minutes").notNull().default(0),
    endMinutes: integer("end_minutes").notNull().default(60),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("dj_slots_dj_idx").on(t.djId), index("dj_slots_day_time_idx").on(t.dayOfWeek, t.startMinutes, t.endMinutes)],
);

export const scheduleEntries = pgTable(
  "schedule_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    showId: uuid("show_id")
      .notNull()
      .references(() => shows.id, { onDelete: "cascade" }),
    dayOfWeek: integer("day_of_week"), // 0=Sun..6=Sat, null = every day
    startMinutes: integer("start_minutes").notNull().default(0),
    endMinutes: integer("end_minutes").notNull().default(1440),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("schedule_entries_day_idx").on(t.dayOfWeek)],
);

export const rundownItems = pgTable(
  "rundown_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    showId: uuid("show_id")
      .notNull()
      .references(() => shows.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    kind: text("kind").notNull(), // "track" | "voice"
    trackId: uuid("track_id"),
    voiceTrackId: uuid("voice_track_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("rundown_items_show_idx").on(t.showId)],
);

export const voiceTracks = pgTable("voice_tracks", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  showId: uuid("show_id"),
  filePath: text("file_path").notNull(),
  durationSeconds: real("duration_seconds").notNull().default(0),
  loudnessGainDb: real("loudness_gain_db").notNull().default(0),
  playEvery: integer("play_every").notNull().default(3),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const adCampaigns = pgTable("ad_campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  advertiser: text("advertiser").notNull(),
  startDate: text("start_date").notNull(), // YYYY-MM-DD
  endDate: text("end_date").notNull(),
  spotsPerDay: integer("spots_per_day").notNull().default(6),
  maxPerHour: integer("max_per_hour").notNull().default(2),
  whenRule: text("when_rule").notNull().default("all_day"),
  customDays: jsonb("custom_days").$type<number[]>().notNull().default([]),
  ratePerSpot: real("rate_per_spot").notNull().default(0),
  currency: text("currency").notNull().default("USD"),
  audioTrackId: uuid("audio_track_id"),
  status: text("status").notNull().default("draft"), // draft|active|paused|completed
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const adAirings = pgTable(
  "ad_airings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => adCampaigns.id, { onDelete: "cascade" }),
    trackId: uuid("track_id"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    airedAt: timestamp("aired_at", { withTimezone: true }),
    listeners: integer("listeners"),
    confirmed: boolean("confirmed").notNull().default(false),
    source: text("source").notNull().default("ad"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ad_airings_campaign_idx").on(t.campaignId)],
);

export const playLog = pgTable(
  "play_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    playId: text("play_id").notNull().unique(),
    trackId: uuid("track_id"),
    title: text("title").notNull(),
    artist: text("artist").notNull().default(""),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationSeconds: real("duration_seconds").notNull().default(0),
    source: text("source").notNull().default("automation"),
    listenersAtStart: integer("listeners_at_start"),
    listenersAtEnd: integer("listeners_at_end"),
    showId: uuid("show_id"),
    campaignId: uuid("campaign_id"),
    voiceTrackId: uuid("voice_track_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("play_log_started_idx").on(t.startedAt), index("play_log_track_idx").on(t.trackId)],
);

export const listenerStats = pgTable("listener_stats", {
  id: uuid("id").primaryKey().defaultRandom(),
  at: timestamp("at", { withTimezone: true }).notNull(),
  listeners: integer("listeners").notNull().default(0),
  countries: jsonb("countries").$type<Record<string, number>>().notNull().default({}),
});

export const requests = pgTable("requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  trackId: uuid("track_id"),
  songQuery: text("song_query").notNull(),
  listenerName: text("listener_name").notNull().default(""),
  message: text("message").notNull().default(""),
  status: text("status").notNull().default("pending"), // pending|approved|rejected|played
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  playedAt: timestamp("played_at", { withTimezone: true }),
});

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull(),
  scopes: jsonb("scopes").$type<string[]>().notNull().default(["read"]),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const webhooks = pgTable("webhooks", {
  id: uuid("id").primaryKey().defaultRandom(),
  url: text("url").notNull(),
  secret: text("secret").notNull(),
  events: jsonb("events").$type<string[]>().notNull().default([]),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  webhookId: uuid("webhook_id")
    .notNull()
    .references(() => webhooks.id, { onDelete: "cascade" }),
  event: text("event").notNull(),
  payload: jsonb("payload").$type<unknown>().notNull(),
  status: text("status").notNull().default("pending"), // pending|delivered|failed|dead
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const recordings = pgTable("recordings", {
  id: uuid("id").primaryKey().defaultRandom(),
  showId: uuid("show_id"),
  djId: uuid("dj_id").references(() => users.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  filePath: text("file_path").notNull(),
  durationSeconds: real("duration_seconds").notNull().default(0),
  isPodcast: boolean("is_podcast").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    role: text("role").notNull(), // admin | dj
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("invites_email_idx").on(t.email)],
);

export type DbUser = typeof users.$inferSelect;
export type DbTrack = typeof tracks.$inferSelect;
export type DbFolder = typeof folders.$inferSelect;
export type DbPlaylist = typeof playlists.$inferSelect;
export type DbStationRotation = typeof stationRotations.$inferSelect;
export type DbScheduleEntry = typeof scheduleEntries.$inferSelect;
export type DbCampaign = typeof adCampaigns.$inferSelect;
