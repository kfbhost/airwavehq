import { config, getJSON, mount, render } from "./common.js";

/**
 * Embeddable live player.
 * <script src="https://radio.example.com/widgets/player.js" data-station="https://radio.example.com" data-theme="dark"></script>
 */
const { base } = config();
const { root } = mount("rhs-player");

render(root, `
  <div class="rhs-widget">
    <div class="rhs-row">
      <button class="rhs-btn" id="rhs-toggle">▶</button>
      <div style="flex:1;min-width:0">
        <div class="rhs-title" id="rhs-station">Radio</div>
        <div class="rhs-meta" id="rhs-now">connecting…</div>
      </div>
      <span class="rhs-muted" id="rhs-listeners"></span>
    </div>
  </div>
`);

const audio = new Audio();
let playing = false;
let heartbeatId: number | null = null;

const btn = root.getElementById("rhs-toggle")!;
const stationEl = root.getElementById("rhs-station")!;
const nowEl = root.getElementById("rhs-now")!;
const listenersEl = root.getElementById("rhs-listeners")!;

function listenerSessionId(): string {
  const key = "rhs_widget_listener_session";
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const next = crypto.randomUUID();
  sessionStorage.setItem(key, next);
  return next;
}

async function heartbeat(): Promise<void> {
  await fetch(`${base}/api/public/listener-heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ sessionId: listenerSessionId() }),
  }).catch(() => {});
}

function startHeartbeat(): void {
  void heartbeat();
  if (heartbeatId != null) clearInterval(heartbeatId);
  heartbeatId = window.setInterval(() => void heartbeat(), 30_000);
}

function stopHeartbeat(): void {
  if (heartbeatId != null) {
    clearInterval(heartbeatId);
    heartbeatId = null;
  }
}

btn.addEventListener("click", () => {
  if (playing) {
    audio.pause();
  } else {
    void audio.play();
  }
});

audio.addEventListener("play", () => {
  playing = true;
  btn.textContent = "⏸";
  startHeartbeat();
});
audio.addEventListener("pause", () => {
  playing = false;
  btn.textContent = "▶";
  stopHeartbeat();
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
    stationEl.textContent = info.stationName;
    listenersEl.textContent = info.listeners > 0 ? `👥 ${info.listeners}` : "";
    if (info.live) {
      const parts = ["🔴 LIVE"];
      if (info.liveDjName) parts.push(`— ${info.liveDjName}`);
      if (info.showName) parts.push(`· ${info.showName}`);
      nowEl.innerHTML = `<span class="rhs-live">${parts.join(" ")}</span>`;
    } else if (info.nowPlaying) {
      nowEl.textContent = `${info.nowPlaying.title} — ${info.nowPlaying.artist}`;
    } else {
      nowEl.textContent = "on air";
    }
  } catch {
    nowEl.textContent = "station unreachable";
  }
}

void poll();
setInterval(() => void poll(), 15_000);
