import { config } from "./config.js";
import type { ProcessingPreset } from "@airwavehq/shared";

/**
 * Broadcast-style dynamics processing applied to the final output before it
 * is encoded (Icecast broadcast, dev file sink, and show recordings).
 *
 * Each preset is a 3-band "radio" processor — the same recipe big stations
 * use: split into bass / mid / treble with 4th-order (Linkwitz-Riley style)
 * crossovers at 250 Hz and 4 kHz (two cascaded 2-pole filters per edge, so
 * the bands sum back flat), one compressor per band with makeup gain, then
 * recombine and brickwall-limit at the ceiling.
 *
 * All filters are ffmpeg C filters, so CPU cost stays small (fine for a
 * low-spec VPS). The active preset is picked in Settings (no redeploy — the
 * engine polls /engine/config and hot-swaps the encoder filter), and
 * AUDIO_PROCESSING=0 remains a master kill-switch.
 *
 * Tuning the numbers below: `threshold` is linear (0.1 ≈ -20 dBFS),
 * `ratio` is the compression ratio, `attack`/`release` are in ms, and
 * `makeup` is linear gain applied after compression (1.7 ≈ +4.6 dB) — this
 * is what makes a preset sound louder/"hotter".
 */
export const PROCESSING_PRESETS: Record<ProcessingPreset, string> = {
  off: "",
  gentle: [
    "asplit=3[low][mid][high]",
    "[low]lowpass=f=250,lowpass=f=250,acompressor=threshold=0.2:ratio=2.5:attack=10:release=150:makeup=1.25:knee=4[lowc]",
    "[mid]highpass=f=250,highpass=f=250,lowpass=f=4000,lowpass=f=4000,acompressor=threshold=0.18:ratio=3:attack=8:release=130:makeup=1.35:knee=3[midc]",
    "[high]highpass=f=4000,highpass=f=4000,acompressor=threshold=0.15:ratio=3.5:attack=6:release=110:makeup=1.45:knee=3[highc]",
    "[lowc][midc][highc]amix=inputs=3:normalize=0,alimiter=limit=-1.5dB:attack=5:release=60:level=disabled:level_out=1",
  ].join(";"),
  radio: [
    "asplit=3[low][mid][high]",
    "[low]lowpass=f=250,lowpass=f=250,acompressor=threshold=0.18:ratio=3:attack=8:release=120:makeup=1.7:knee=4[lowc]",
    "[mid]highpass=f=250,highpass=f=250,lowpass=f=4000,lowpass=f=4000,acompressor=threshold=0.15:ratio=4:attack=5:release=100:makeup=1.9:knee=3[midc]",
    "[high]highpass=f=4000,highpass=f=4000,acompressor=threshold=0.12:ratio=5:attack=4:release=90:makeup=2.1:knee=3[highc]",
    "[lowc][midc][highc]amix=inputs=3:normalize=0,alimiter=limit=-1dB:attack=3:release=50:level=disabled:level_out=1",
  ].join(";"),
  punch: [
    "asplit=3[low][mid][high]",
    "[low]lowpass=f=250,lowpass=f=250,acompressor=threshold=0.15:ratio=4:attack=5:release=100:makeup=2.0:knee=3[lowc]",
    "[mid]highpass=f=250,highpass=f=250,lowpass=f=4000,lowpass=f=4000,acompressor=threshold=0.12:ratio=5:attack=4:release=80:makeup=2.2:knee=2[midc]",
    "[high]highpass=f=4000,highpass=f=4000,acompressor=threshold=0.1:ratio=6:attack=3:release=70:makeup=2.4:knee=2[highc]",
    "[lowc][midc][highc]amix=inputs=3:normalize=0,alimiter=limit=-0.8dB:attack=2:release=40:level=disabled:level_out=1",
  ].join(";"),
};

/** The "radio" preset — kept for convenience and as the historical default. */
export const BROADCAST_FILTER = PROCESSING_PRESETS.radio;

/**
 * Returns the ffmpeg output-filter args (`-filter_complex <graph>`) for a
 * preset, or `[]` when the preset is off (or processing is disabled).
 */
export function broadcastFilterArgsFor(
  preset: ProcessingPreset,
  enabled = config.processingEnabled,
): string[] {
  const graph = PROCESSING_PRESETS[preset] ?? "";
  return enabled && graph ? ["-filter_complex", graph] : [];
}
