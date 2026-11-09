import { config, getJSON, mount, render } from "./common.js";

/**
 * Embeddable request box.
 * <script src="https://radio.example.com/widgets/requests.js" data-station="https://radio.example.com"></script>
 */
const { base } = config();
const { root } = mount("rhs-requests");

render(root, `
  <div class="rhs-widget">
    <div class="rhs-title">Request a song</div>
    <div class="rhs-meta" style="margin:4px 0 10px">We'll play it on air soon.</div>
    <input id="rhs-query" placeholder="Song or artist…" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:8px 10px;font-size:14px;margin-bottom:8px">
    <div id="rhs-suggest" style="display:flex;flex-direction:column;gap:4px;margin-bottom:8px"></div>
    <input id="rhs-name" placeholder="Your name (optional)" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:8px 10px;font-size:14px;margin-bottom:8px">
    <textarea id="rhs-msg" placeholder="Message (optional)" rows="2" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:8px 10px;font-size:14px;margin-bottom:10px;resize:vertical"></textarea>
    <button id="rhs-submit" class="rhs-btn" style="width:100%">Send request</button>
    <div id="rhs-status" class="rhs-meta" style="margin-top:8px"></div>
  </div>
`);

const queryEl = root.getElementById("rhs-query") as HTMLInputElement;
const nameEl = root.getElementById("rhs-name") as HTMLInputElement;
const msgEl = root.getElementById("rhs-msg") as HTMLTextAreaElement;
const suggestEl = root.getElementById("rhs-suggest")!;
const submitEl = root.getElementById("rhs-submit") as HTMLButtonElement;
const statusEl = root.getElementById("rhs-status")!;

let selectedId: string | null = null;
let searchTimer: ReturnType<typeof setTimeout>;

queryEl.addEventListener("input", () => {
  clearTimeout(searchTimer);
  selectedId = null;
  const q = queryEl.value.trim();
  if (q.length < 2) {
    suggestEl.innerHTML = "";
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      const res = await getJSON<{ results: Array<{ id: string; title: string; artist: string }> }>(
        `${base}/api/public/search?q=${encodeURIComponent(q)}`,
      );
      suggestEl.innerHTML = res.results
        .slice(0, 5)
        .map(
          (r, i) =>
            `<button data-i="${i}" style="text-align:left;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:6px 8px;font-size:12px;cursor:pointer">${r.title} — ${r.artist}</button>`,
        )
        .join("");
      suggestEl.querySelectorAll("button").forEach((b, i) => {
        b.addEventListener("click", () => {
          const r = res.results[i]!;
          selectedId = r.id;
          queryEl.value = `${r.title} — ${r.artist}`;
          suggestEl.innerHTML = "";
        });
      });
    } catch {
      suggestEl.innerHTML = "";
    }
  }, 300);
});

submitEl.addEventListener("click", async () => {
  const song = queryEl.value.trim();
  if (!song) {
    statusEl.textContent = "Type a song or artist first.";
    return;
  }
  submitEl.disabled = true;
  try {
    const res = await fetch(`${base}/api/public/requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        songQuery: song,
        trackId: selectedId,
        listenerName: nameEl.value.trim(),
        message: msgEl.value.trim(),
      }),
    });
    if (!res.ok) throw new Error("failed");
    statusEl.textContent = "✅ Request sent — thanks!";
    queryEl.value = "";
    nameEl.value = "";
    msgEl.value = "";
  } catch {
    statusEl.textContent = "Couldn't send — try again in a moment.";
  } finally {
    submitEl.disabled = false;
  }
});
