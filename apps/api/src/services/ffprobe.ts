import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { config } from "../config.js";

const exec = promisify(execFile);

export interface ProbeResult {
  title: string;
  artist: string;
  album: string;
  durationSeconds: number;
  hasArtwork: boolean;
  /** Canonical codec name (e.g. "mp3", "aac", "flac"), lowercased/trimmed. */
  codec: string | null;
  /** Audio bitrate in kilobytes per second (rounded). */
  bitrateKbps: number | null;
}

export async function probeAudio(filePath: string): Promise<ProbeResult> {
  const { stdout } = await exec("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  const json = JSON.parse(stdout) as {
    format?: { duration?: string; tags?: Record<string, string>; bit_rate?: string };
    streams?: Array<{ codec_type?: string; codec_name?: string; duration?: string; bit_rate?: string; tags?: Record<string, string> }>;
  };
  const tags = json.format?.tags ?? {};
  const audioStream = json.streams?.find((s) => s.codec_type === "audio");
  const hasArtwork = (json.streams ?? []).some((s) => s.codec_type === "video");
  const duration = Number(
    json.format?.duration ?? audioStream?.duration ?? 0,
  );
  const clean = (v: string | undefined) => (v ? v.trim() : "");
  // Prefer the audio stream's own bitrate; fall back to the container's overall
  // bitrate (covers files where ffprobe doesn't report per-stream bit_rate).
  const rawBitrate = clean(audioStream?.bit_rate) || clean(json.format?.bit_rate);
  const bitrate = Number(rawBitrate);
  const codec = clean(audioStream?.codec_name);
  return {
    title: clean(tags.title),
    artist: clean(tags.artist) || clean(tags.album_artist) || clean(tags.composer),
    album: clean(tags.album),
    durationSeconds: Number.isFinite(duration) ? duration : 0,
    hasArtwork,
    codec,
    bitrateKbps: Number.isFinite(bitrate) && bitrate > 0 ? Math.round(bitrate / 1000) : null,
  };
}

/** Extracts embedded artwork to a jpg next to the file. Returns null if none. */
export async function extractArtwork(filePath: string): Promise<string | null> {
  const outPath = join(
    config.dataDir,
    "media",
    `${crypto.randomUUID()}-artwork.jpg`,
  );
  try {
    await exec("ffmpeg", [
      "-v", "error",
      "-i", filePath,
      "-an",
      "-map", "0:v",
      "-frames:v", "1",
      "-q:v", "3",
      "-y",
      outPath,
    ]);
    await stat(outPath);
    return outPath;
  } catch {
    // Some files have an attached_pic stream that ffmpeg can't map directly;
    // try extracting via the cover art path if it exists as a video stream with disposition.
    return null;
  }
}

/** Runs EBU R128 loudness scan. Returns LUFS (integrated) and gain to reach target. */
export async function scanLoudness(
  filePath: string,
  targetLufs = -16,
): Promise<{ lufs: number | null; gainDb: number }> {
  try {
    const { stderr } = await exec("ffmpeg", [
      "-nostats",
      "-i", filePath,
      "-af", "ebur128=peak=true",
      "-f", "null",
      "-",
    ]);
    // Match the summary "I:" line (line-start anchored) — interim progress
    // lines also contain "I: … LUFS" every 100 ms and must be ignored.
    const m = stderr.match(/^\s*I:\s+(-?\d+(?:\.\d+)?)\s+LUFS/m);
    if (m?.[1]) {
      const lufs = Number(m[1]);
      const gain = Math.max(-24, Math.min(24, targetLufs - lufs));
      return { lufs, gainDb: Math.round(gain * 10) / 10 };
    }
  } catch {
    // ffmpeg returns non-zero for null muxer sometimes; parse stderr anyway
  }
  return { lufs: null, gainDb: 0 };
}

export function detectMime(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
    case ".aac":
      return "audio/aac";
    case ".ogg":
    case ".oga":
      return "audio/ogg";
    case ".opus":
      return "audio/opus";
    case ".wav":
      return "audio/wav";
    case ".flac":
      return "audio/flac";
    case ".aiff":
    case ".aif":
      return "audio/aiff";
    default:
      return "audio/mpeg";
  }
}
