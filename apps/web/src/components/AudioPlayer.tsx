import { useEffect, useRef, useState } from "react";

interface AudioPlayerProps {
  src: string;
  autoPlay?: boolean;
}

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function AudioPlayer({ src, autoPlay = false }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [seeking, setSeeking] = useState(false);

  useEffect(() => {
    const a = new Audio();
    audioRef.current = a;
    a.preload = "none";
    a.src = src;
    if (autoPlay) void a.play().catch(() => setError("Playback unavailable"));

    const onTime = () => setCurrent(a.currentTime);
    const onMeta = () => setDuration(Number.isFinite(a.duration) ? a.duration : 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onWaiting = () => setLoading(true);
    const onReady = () => setLoading(false);
    const onEnded = () => {
      setPlaying(false);
      setCurrent(0);
    };
    const onError = () => {
      setError("Playback unavailable");
      setLoading(false);
    };

    a.addEventListener("timeupdate", onTime);
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("durationchange", onMeta);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("waiting", onWaiting);
    a.addEventListener("canplay", onReady);
    a.addEventListener("playing", onReady);
    a.addEventListener("ended", onEnded);
    a.addEventListener("error", onError);

    return () => {
      a.pause();
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("durationchange", onMeta);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("waiting", onWaiting);
      a.removeEventListener("canplay", onReady);
      a.removeEventListener("playing", onReady);
      a.removeEventListener("ended", onEnded);
      a.removeEventListener("error", onError);
    };
  }, [src, autoPlay]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (error) setError(null);
    if (a.paused) void a.play().catch(() => setError("Playback unavailable"));
    else a.pause();
  };

  const seekClientX = (clientX: number) => {
    const a = audioRef.current;
    const bar = barRef.current;
    if (!a || !bar || !duration) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    a.currentTime = ratio * duration;
    setCurrent(a.currentTime);
  };

  const pct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;

  return (
    <div className="audioplayer" role="group" aria-label="Audio player">
      <button
        className="audioplayer-play"
        onClick={toggle}
        disabled={!src}
        aria-label={playing ? "Pause" : "Play"}
      >
        {loading ? (
          <span className="audioplayer-spinner" />
        ) : playing ? (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
            <rect x="2" y="1.5" width="3.4" height="11" rx="1" />
            <rect x="8.6" y="1.5" width="3.4" height="11" rx="1" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
            <path d="M3 1.6a1 1 0 0 1 1.52-.86l8.2 5.4a1 1 0 0 1 0 1.72l-8.2 5.4A1 1 0 0 1 3 12.4V1.6Z" />
          </svg>
        )}
      </button>
      <div className="audioplayer-track">
        <div
          ref={barRef}
          className={`audioplayer-bar${seeking ? " dragging" : ""}`}
          onMouseDown={(e) => {
            setSeeking(true);
            seekClientX(e.clientX);
          }}
          onMouseMove={(e) => {
            if (seeking) seekClientX(e.clientX);
          }}
          onMouseUp={() => setSeeking(false)}
          onMouseLeave={() => setSeeking(false)}
        >
          <div className="audioplayer-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="audioplayer-time">
          <span>{error ?? fmt(current)}</span>
          <span>{fmt(duration)}</span>
        </div>
      </div>
    </div>
  );
}
