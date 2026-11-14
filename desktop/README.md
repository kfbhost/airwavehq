# AirwaveHQ Desktop (Windows)

A local, single-computer version of AirwaveHQ: radio automation that plays out
of the machine's own speakers, with no server, no Icecast and nothing to upload.

Status: **exploration + proof of concept**. Nothing here is wired into the main
app yet; the server product in `apps/` keeps working exactly as before.

## Why a separate build

The server product assumes things a desktop user doesn't have or want:

| Server version | Desktop version |
| --- | --- |
| PostgreSQL | SQLite file next to the app |
| Icecast + Caddy + Docker | direct audio output to the default device |
| Browser UI over HTTP | an Electron window with the same React UI |
| Listener analytics over the network | optional: local listeners / none |
| Backups to a data volume | one folder the user can copy |

The good news: the hard part is reusable. The playout engine already renders a
master mix into a `Sink` (`apps/engine/src/icecast.ts` implements Icecast), and
`PcmStream` (`apps/engine/src/decode.ts`) already decodes any file to 48 kHz
stereo PCM with ffmpeg. A desktop version needs a **different sink** — one that
writes PCM to ffplay (the speakers) instead of an encoder to Icecast.

## Two possible architectures

### A. Native-ish single process (recommended)

Electron shell + a local core process in Node/TypeScript:

- **Audio:** reuse `PcmStream` + the playout mixer; add a `LocalSink` that spawns
  one long-lived `ffplay -f s16le -ar 48000 -ac 2 -` and writes the master mix
  into its stdin. Same crossfades, jingles and voice links as the server.
- **Storage:** replace PostgreSQL with SQLite. Node 22 ships `node:sqlite`
  (`DatabaseSync`), so no native module to compile — a big deal for a Windows
  installer.
- **UI:** reuse the React pages (`apps/web`) with a small local API that talks to
  SQLite. Start with Library / Now playing / Schedule; Live Studio later (mic
  capture in Electron works through Web Audio like the browser).
- **Packaging:** `electron-builder` producing an NSIS `.exe` plus a portable
  build; ffmpeg/ffplay/ffprobe bundled in `resources/`.
- **Size:** roughly 150–250 MB installed (Electron + ffmpeg).

Effort: the audio path is small (this POC proves it); the real work is porting
the database layer and the scheduler.

### B. Bundle the existing stack

Ship the current Docker-less stack in an installer: portable PostgreSQL, Icecast
and the API/engine, with an Electron window pointing at `localhost`.

- **Pro:** near-full parity almost immediately; almost no new code.
- **Con:** ~400 MB+, three or four processes, a database the user must not touch,
  ports on `localhost`, and an upgrade story that is much harder.
- Worth it only as a stopgap.

**Recommendation:** A, in phases, so there is something usable early.

## Phases

1. **Local core / POC (this folder).** Folder of music → continuous playout with
   crossfades to the speakers. No UI, no database.
2. **Electron shell.** Window with a minimal UI reusing the web components; the
   core runs in the main process.
3. **Library + playlists on SQLite.** Scan a folder, read tags with ffprobe,
   store in `node:sqlite`; simple rotation rules.
4. **Schedule + clockwheels.** Port `scheduler.ts` to the SQLite schema.
5. **Live Studio.** Mic through Web Audio in the renderer, mixed into the local
   sink over IPC.
6. **Packaging.** Installer, bundled ffmpeg, start-at-login, single-instance.

Deliberately out of scope for v1: listener analytics, Icecast output, multi-user,
remote access. (An optional "also stream to Icecast" output could come later, and
would reuse the existing sink.)

## Proof of concept

`poc/play-folder.ts` plays a folder as a continuous station: it decodes each
track with `PcmStream`, crossfades into the next one, and writes the mix to
ffplay (or to a WAV file with `--out`, which is how it is tested without
speakers).

```bash
# from the repository root
node node_modules/tsx/dist/cli.mjs desktop/poc/play-folder.ts "C:\path\to\music"

# render 30 seconds to a file instead of playing it
node node_modules/tsx/dist/cli.mjs desktop/poc/play-folder.ts "C:\path\to\music" --out .tmp/poc.wav --seconds 30

# options
--crossfade <ms>   crossfade between tracks (default 3000)
--seconds <n>      stop after n seconds (default: play forever)
--shuffle          random order
```

### Verified on this machine (2026-11-14)

- A 34-track folder was scanned and read with ffprobe (96.3 minutes total).
- 200 seconds of the mix rendered to WAV in **8.5 s**; audio is present
  (mean -9.8 dB) and the crossfade across the first track boundary is in the file.
- The soft-knee limiter holds peaks at **-0.3 dBFS**, so a crossfade between two
  loud tracks no longer clips.
- Real-time playback through `ffplay` works — it accepts `-ch_layout stereo`,
  not ffmpeg's `-ac`.
- Worth knowing: the engine's `readFrames` pads silence when the decoder is
  starved (correct for real-time ticks). A non-paced render must wait for PCM,
  which is why the POC has a blocking read path.
Requirements: `ffmpeg`, `ffprobe` and `ffplay` on `PATH` (the project's
`tools\ffmpeg\bin` has all three).

## Open questions

- Is the target "one station on this PC", or several stations from one library?
- Should it optionally stream to Icecast as well as play locally?
- Windows only for v1, or macOS/Linux too (Electron gives all three nearly free)?
- Does it need to run in the tray / start with Windows?
