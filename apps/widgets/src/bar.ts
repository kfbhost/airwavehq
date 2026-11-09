import { config, getJSON, mount, render } from "./common.js";

/**
 * Compact "listen live" bar for the top of a website.
 * <script src="https://radio.example.com/widgets/bar.js" data-station="https://radio.example.com" data-theme="dark"></script>
 */
const { base } = config();
const { root } = mount("rhs-bar");

render(root, `
  <div class="rhs-bar">
    <button class="rhs-btn" id="rhs-toggle" style="padding:6px 12px">▶</button>
    <span class="rhs-live" style="font-size:12px">●</span>
    <div style="flex:1;min-width:0">
      <div class="rhs-truncate" id="rhs-text" style="font-weight:600">connecting…</div>
      <div class="rhs-truncate" id="rhs-sub" style="font-size:11px;color:var(--muted)"></div>
    </div>
    <span class="rhs-muted" id="rhs-listeners"></span>
  </div>
`);

const audio = new Audio();
let playing = false;
let heartbeatId: number | null = null;

const btn = root.getElementById("rhs-toggle") as HTMLButtonElement;
const textEl = root.getElementById("rhs-text")!;
const subEl = root.getElementById("rhs-sub")!;
const liveEl = root.querySelector(".rhs-live") as HTMLElement;
const listenersEl = root.getElementById("rhs-listeners")!;

function listenerSessionId(): string {
  const key = "rhs_widget_listener_session";
  const existing = safeStorage(key);
  if (existing) return existing;
  const next = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  try {
    sessionStorage.setItem(key, next);
  } catch {
    /* ignore */
  }
  return next;
}

function safeStorage(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

async function heartbeat(): Promise<void> {
  await fetch(`${base}/api/public/listener-heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ sessionId: listenerSessionId() }),
  }).catch(() => {});
}

btn.addEventListener("click", () => {
  if (playing) audio.pause();
  else void audio.play();
});

audio.addEventListener("play", () => {
  playing = true;
  btn.textContent = "⏸";
  void heartbeat();
  if (heartbeatId != null) clearInterval(heartbeatId);
  heartbeatId = window.setInterval(() => void heartbeat(), 30_000);
});
audio.addEventListener("pause", () => {
  playing = false;
  btn.textContent = "▶";
  if (heartbeatId != null) {
    clearInterval(heartbeatId);
    heartbeatId = null;
  }
});
audio.addEventListener("error", () => {
  subEl.textContent = "stream unavailable";
});

async function poll(): Promise<void> {
  try {
    const info = await getJSON<{
      stationName: string;
      streamUrl: string;
      nowPlaying: { title: string; artist: string } | null;
      listeners: number;
      live: boolean;
      liveDjName: string | null;
      showName: string | null;
    }>(`${base}/api/public/now-playing`);

    if (!audio.src && info.streamUrl) audio.src = info.streamUrl;
    listenersEl.textContent = info.listeners > 0 ? `👥 ${info.listeners}` : "";
    liveEl.style.display = info.live ? "" : "none";
    if (info.live) {
      textEl.textContent = info.liveDjName ? `LIVE — ${info.liveDjName}` : "LIVE now";
      subEl.textContent = info.showName ?? info.stationName;
    } else {
      textEl.textContent = info.stationName;
      subEl.textContent = info.nowPlaying ? `${info.nowPlaying.title} — ${info.nowPlaying.artist}` : "on air";
    }
  } catch {
    subEl.textContent = "station unreachable";
  }
}

void poll();
setInterval(() => void poll(), 15_000);
