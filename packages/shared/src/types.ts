import type {
  TrackKind,
  Role,
  PlaySource,
  WebhookEvent,
  ProcessingPreset,
} from "./constants.js";

export type {
  TrackKind,
  Role,
  PlaySource,
  WebhookEvent,
  ProcessingPreset,
};

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  djCode: string | null;
  avatarPath: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface Invite {
  id: string;
  email: string;
  role: Role;
  invitedBy: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

export interface StationSettings {
  stationName: string;
  tagline: string;
  timezone: string;
  streamBitrate: number;
  streamUrl: string;
  mount: string;
  logoPath: string | null;
  defaultPlaylistId: string | null;
  defaultClockwheelId: string | null;
  recordShows: boolean;
  crossfadeMs: number;
  audioProcessingPreset: ProcessingPreset;
  topOfHourTrackId: string | null;
  autoJingleEvery: number;
  autoJingleFolder: string | null;
  requestBoxEnabled: boolean;
  publicPageEnabled: boolean;
  recordingRetentionDays: number;
  geoMode: "off" | "block" | "allow";
  geoCountries: string;
}

export interface Track {
  id: string; title: string; artist: string; album: string; folder: string | null; kind: TrackKind;
  durationSeconds: number; filePath: string; fileHash: string | null; fileSize: number; mime: string; codec: string | null;
  bitrateKbps: number | null; loudnessGainDb: number;
  loudnessLufs: number | null; artworkPath: string | null; bpm: number | null; playCount: number;
  lastPlayedAt: string | null; isActive: boolean; createdAt: string; updatedAt: string;
}

export interface Playlist { id: string; name: string; description: string | null; artistSeparation: number; trackSeparationMinutes: number; shuffle: boolean; createdAt: string; }
export interface PlaylistItem { id: string; playlistId: string; trackId: string; position: number; weight: number; }
export interface StationRotation { id: string; name: string; dayOfWeek: number | null; startHour: number; endHour: number; playlistId: string | null; clockwheelId: string | null; sundayPlaylistId: string | null; mondayPlaylistId: string | null; tuesdayPlaylistId: string | null; wednesdayPlaylistId: string | null; thursdayPlaylistId: string | null; fridayPlaylistId: string | null; saturdayPlaylistId: string | null; autoGenerate: boolean; shufflePlaylist: boolean; musicFolders: string[]; includeJingles: boolean; jingleEvery: number; jingleFolder: string | null; priority: number; isActive: boolean; createdAt: string; }
export interface Clockwheel { id: string; name: string; createdAt: string; }
export type ClockSlotType = "music" | "jingle" | "sweeper" | "station_id" | "anchored" | "ad_break";
export interface ClockSlot { id: string; clockwheelId: string; position: number; type: ClockSlotType; playlistId: string | null; trackId: string | null; label: string | null; durationSeconds: number | null; createdAt: string; }

export interface Show {
  id: string;
  ownerId: string | null;
  name: string;
  description: string | null;
  color: string;
  imagePath: string | null;
  playlistId: string | null;
  clockwheelId: string | null;
  presenters: string;
  createdAt: string;
  /** Total planned length of the show's rundown in seconds (0 when none). */
  plannedDurationSec?: number;
  /** True when the show was created from a recording and replays its audio. */
  isRecorded?: boolean;
}

export interface Djslot {
  id: string;
  djId: string;
  showId: string | null;
  dayOfWeek: number | null;
  startMinutes: number;
  endMinutes: number;
  createdAt: string;
  updatedAt: string;
  dj: { id: string; name: string; email: string } | null;
  show: Show | null;
}

export interface ScheduleEntry { id: string; showId: string; dayOfWeek: number | null; startMinutes: number; endMinutes: number; createdAt: string; }
export interface VoiceTrack { id: string; title: string; showId: string | null; filePath: string; durationSeconds: number; playEvery: number; isActive: boolean; createdAt: string; }
export interface RundownItem {
  id: string; showId: string; position: number; kind: "track" | "voice"; trackId: string | null; voiceTrackId: string | null; createdAt: string;
  track: { id: string; title: string; artist: string; durationSeconds: number; kind: string; filePath: string } | null;
  voice: { id: string; title: string; durationSeconds: number } | null;
}
export interface AdCampaign { id: string; advertiser: string; startDate: string; endDate: string; spotsPerDay: number; maxPerHour: number; whenRule: "weekday_drivetime" | "weekends" | "all_day" | "custom"; customDays: number[]; ratePerSpot: number; currency: string; audioTrackId: string | null; status: "draft" | "active" | "paused" | "completed"; createdAt: string; }
export interface Airing { id: string; campaignId: string; trackId: string | null; scheduledFor: string; airedAt: string | null; listeners: number | null; confirmed: boolean; source: PlaySource; }
export interface PlayLogEntry { id: string; trackId: string | null; title: string; artist: string; startedAt: string; endedAt: string | null; durationSeconds: number; source: PlaySource; listenersAtStart: number | null; listenersAtEnd: number | null; showId: string | null; campaignId: string | null; }
export interface ListenerStat { at: string; listeners: number; }
export interface RequestEntry { id: string; trackId: string | null; songQuery: string; listenerName: string; message: string; status: "pending" | "approved" | "rejected" | "played"; createdAt: string; playedAt: string | null; }
export interface ApiKey { id: string; name: string; scopes: string[]; lastUsedAt: string | null; createdAt: string; }
export interface Webhook { id: string; url: string; events: WebhookEvent[]; isActive: boolean; createdAt: string; }
export interface Recording { id: string; showId: string | null; djId: string | null; title: string; startedAt: string; endedAt: string | null; filePath: string; durationSeconds: number; isPodcast: boolean; createdAt: string; }
export interface RecordingRow extends Recording { showName: string | null; djName: string | null; djAvatarUrl: string | null; }

export interface EngineItem { id: string; trackId: string | null; artworkPath: string | null; kind: TrackKind; title: string; artist: string; durationSec: number; gainDb: number; filePath: string; airAt: number | null; cutoffAt: number | null; source: PlaySource; showId: string | null; campaignId: string | null; voiceTrackId: string | null; }
export interface EngineSequence { items: EngineItem[]; mode: "rundown" | "clockwheel" | "playlist" | "idle"; fetchedAt: number; }
export interface EngineStatus { online: boolean; mode: "automation" | "live" | "off"; currentItem: EngineItem | null; nextItem: EngineItem | null; upcomingItems: EngineItem[]; listeners: number; liveDjName: string | null; liveShowName: string | null; encoderBitrateKbps: number | null; engineTime: string; uptimeSec: number; }
export interface EnginePlayEvent { playId: string; trackId: string | null; title: string; artist: string; startedAt: string; endedAt: string | null; durationSeconds: number; source: PlaySource; showId: string | null; campaignId: string | null; voiceTrackId: string | null; listenersAtStart: number | null; listenersAtEnd: number | null; }
export interface EngineRecording { showId: string | null; title: string; startedAt: string; endedAt: string; filePath: string; durationSeconds: number; }
export interface PublicNowPlaying { stationName: string; streamUrl: string; nowPlaying: { title: string; artist: string; startedAt: string | null; artworkUrl: string | null } | null; listeners: number; live: boolean; liveDjName: string | null; showName: string | null; geoBlocked: boolean; updatedAt: string; }
export interface PublicScheduleItem { dayOfWeek: number; startMinutes: number; endMinutes: number; show: { name: string; color: string; description: string | null; presenters?: string }; }
export interface PublicPodcast { title: string; description: string | null; audioUrl: string; publishedAt: string; durationSeconds: number; }
export interface PublicListenAgainItem {
  id: string;
  title: string;
  showId: string | null;
  showName: string | null;
  presenters: string | null;
  djName: string | null;
  djAvatarUrl: string | null;
  artworkUrl: string | null;
  color: string | null;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  audioUrl: string;
}
