import { absolute, config, esc, getJSON, mount, render } from "./common.js";

/**
 * Artwork-only "now playing" card.
 * <script src="https://radio.example.com/widgets/artwork.js" data-station="https://radio.example.com" data-theme="dark"></script>
 */
const { base } = config();
const { root } = mount("airwavehq-artwork");

render(root, `
  <div class="airwavehq-widget airwavehq-art">
    <div class="airwavehq-art-img" id="airwavehq-art"><span>🎵</span></div>
    <div class="airwavehq-row" style="align-items:flex-start;gap:8px">
      <div style="flex:1;min-width:0">
        <div class="airwavehq-title airwavehq-truncate" id="airwavehq-title">on air</div>
        <div class="airwavehq-muted airwavehq-truncate" id="airwavehq-artist"></div>
      </div>
      <span class="airwavehq-badge" id="airwavehq-badge" style="display:none">LIVE</span>
    </div>
    <div class="airwavehq-meta" id="airwavehq-foot"></div>
  </div>
`);

const artEl = root.getElementById("airwavehq-art")!;
const titleEl = root.getElementById("airwavehq-title")!;
const artistEl = root.getElementById("airwavehq-artist")!;
const badgeEl = root.getElementById("airwavehq-badge")!;
const footEl = root.getElementById("airwavehq-foot")!;

let lastArt = "";

interface NowPlaying {
  stationName: string;
  nowPlaying: { title: string; artist: string; artworkUrl: string | null } | null;
  listeners: number;
  live: boolean;
  liveDjName: string | null;
  showName: string | null;
}

function setArt(url: string): void {
  if (url === lastArt) return;
  lastArt = url;
  if (!url) {
    artEl.innerHTML = "<span>🎵</span>";
    return;
  }
  // The image goes into the DOM straight away: a detached image is never
  // "in view", so lazy loading (or a load-gated append) can leave the artwork
  // blank forever. Fade it in once it's decoded instead.
  const img = document.createElement("img");
  img.alt = "";
  img.style.opacity = "0";
  img.style.transition = "opacity .25s ease";
  img.addEventListener("load", () => {
    img.style.opacity = "1";
  });
  img.addEventListener("error", () => {
    lastArt = "";
    if (img.parentElement === artEl) img.remove();
    if (!artEl.querySelector("img")) artEl.innerHTML = "<span>🎵</span>";
  });
  artEl.replaceChildren(img);
  img.src = url;
}

async function poll(): Promise<void> {
  try {
    const info = await getJSON<NowPlaying>(`${base}/api/public/now-playing`);

    setArt(absolute(base, info.nowPlaying?.artworkUrl));
    if (info.live) {
      badgeEl.style.display = "";
      badgeEl.textContent = "🔴 LIVE";
      badgeEl.className = "airwavehq-badge airwavehq-badge-live";
      titleEl.textContent = info.liveDjName ? info.liveDjName : "Live now";
      artistEl.textContent = info.showName ?? "";
    } else {
      badgeEl.style.display = "none";
      titleEl.textContent = info.nowPlaying?.title ?? "on air";
      artistEl.textContent = info.nowPlaying?.artist ?? "";
    }
    const bits: string[] = [];
    if (info.stationName) bits.push(esc(info.stationName));
    if (info.listeners > 0) bits.push(`👥 ${info.listeners} listening`);
    footEl.innerHTML = bits.join(" · ");
  } catch {
    footEl.textContent = "station unreachable";
  }
}

void poll();
setInterval(() => void poll(), 15_000);
