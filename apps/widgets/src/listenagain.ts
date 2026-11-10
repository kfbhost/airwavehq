import { absolute, config, duration, esc, getJSON, mount, render } from "./common.js";

/**
 * Latest episodes / listen again widget.
 * <script src="https://radio.example.com/widgets/listenagain.js" data-station="https://radio.example.com" data-theme="dark" data-limit="4"></script>
 */
const { base, script } = config();
const { root } = mount("airshift-episodes");
const limit = Math.min(Math.max(Number(script?.getAttribute("data-limit") ?? "4") || 4, 1), 10);

render(root, `
  <div class="airshift-widget">
    <div class="airshift-title">Listen again</div>
    <div class="airshift-meta" style="margin:4px 0 8px">Latest shows you can catch up on</div>
    <div class="airshift-list" id="airshift-list"><div class="airshift-muted">loading…</div></div>
    <audio id="airshift-audio" preload="none"></audio>
  </div>
`);

const listEl = root.getElementById("airshift-list")!;
const audio = root.getElementById("airshift-audio") as HTMLAudioElement;

interface Episode {
  id: string;
  title: string;
  showName: string | null;
  djName: string | null;
  artworkUrl: string | null;
  startedAt: string;
  durationSeconds: number | null;
  audioUrl: string;
}

let currentId: string | null = null;

function renderList(episodes: Episode[]): void {
  listEl.innerHTML = episodes
    .map(
      (ep) => `<div class="airshift-item" data-id="${esc(ep.id)}">
        <span class="airshift-item-art">${ep.artworkUrl ? `<img alt="" src="${esc(absolute(base, ep.artworkUrl))}">` : "🎙️"}</span>
        <div class="airshift-item-copy">
          <div class="airshift-item-name">${esc(ep.title)}</div>
          <div class="airshift-muted airshift-truncate">${esc(ep.showName ?? ep.djName ?? "")}${
            duration(ep.durationSeconds) ? ` · ${duration(ep.durationSeconds)}` : ""
          }</div>
        </div>
        <button class="airshift-mini-btn" data-play="${esc(ep.id)}">▶</button>
      </div>`,
    )
    .join("");

  listEl.querySelectorAll<HTMLButtonElement>("button[data-play]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-play")!;
      const ep = episodes.find((e) => e.id === id);
      if (!ep) return;
      if (currentId === id && !audio.paused) {
        audio.pause();
        return;
      }
      currentId = id;
      audio.src = absolute(base, ep.audioUrl);
      void audio.play();
    });
  });
}

function markPlaying(): void {
  listEl.querySelectorAll<HTMLButtonElement>("button[data-play]").forEach((btn) => {
    const id = btn.getAttribute("data-play");
    btn.textContent = id === currentId && !audio.paused ? "⏸" : "▶";
  });
}

audio.addEventListener("play", markPlaying);
audio.addEventListener("pause", markPlaying);
audio.addEventListener("ended", () => {
  currentId = null;
  markPlaying();
});

async function poll(): Promise<void> {
  try {
    const res = await getJSON<{ episodes: Episode[] }>(`${base}/api/public/listen-again`);
    const episodes = res.episodes.slice(0, limit);
    if (episodes.length === 0) {
      listEl.innerHTML = `<div class="airshift-muted">No recorded shows published yet.</div>`;
      return;
    }
    renderList(episodes);
    markPlaying();
  } catch {
    listEl.innerHTML = `<div class="airshift-muted">station unreachable</div>`;
  }
}

void poll();
setInterval(() => void poll(), 120_000);
