import { config, getJSON, mount, render } from "./common.js";

/**
 * Embeddable now-playing ticker.
 * <script src="https://radio.example.com/widgets/nowplaying.js" data-station="https://radio.example.com"></script>
 */
const { base } = config();
const { root } = mount("airshift-nowplaying");

render(root, `
  <div class="airshift-widget" style="max-width:none;padding:8px 14px;display:flex;align-items:center;gap:10px;flex-wrap:nowrap">
    <span class="airshift-live" id="airshift-live-dot" style="display:none">🔴</span>
    <span class="airshift-muted" style="white-space:nowrap">Now playing:</span>
    <span id="airshift-text" class="airshift-truncate" style="font-weight:600;flex:1;min-width:0">…</span>
    <span class="airshift-muted" id="airshift-listeners" style="white-space:nowrap"></span>
  </div>
`);

const textEl = root.getElementById("airshift-text")!;
const liveEl = root.getElementById("airshift-live-dot")!;
const listenersEl = root.getElementById("airshift-listeners")!;

async function poll(): Promise<void> {
  try {
    const info = await getJSON<{
      nowPlaying: { title: string; artist: string } | null;
      listeners: number;
      live: boolean;
      liveDjName: string | null;
      showName: string | null;
    }>(`${base}/api/public/now-playing`);

    if (info.live) {
      liveEl.style.display = "";
      const parts = [];
      if (info.liveDjName) parts.push(`with ${info.liveDjName}`);
      if (info.showName) parts.push(`in ${info.showName}`);
      textEl.textContent = parts.length > 0 ? `LIVE ${parts.join(" ")}` : "LIVE";
    } else if (info.nowPlaying) {
      liveEl.style.display = "none";
      textEl.textContent = `${info.nowPlaying.title}${info.nowPlaying.artist ? ` — ${info.nowPlaying.artist}` : ""}`;
    } else {
      liveEl.style.display = "none";
      textEl.textContent = "on air";
    }
    listenersEl.textContent = info.listeners > 0 ? `👥 ${info.listeners}` : "";
  } catch {
    textEl.textContent = "station unreachable";
  }
}

void poll();
setInterval(() => void poll(), 15_000);
