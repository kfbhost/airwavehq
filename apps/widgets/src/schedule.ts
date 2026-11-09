import { clock, config, esc, getJSON, mount, render, nowMinutes, todayIndex } from "./common.js";

/**
 * "On air today" schedule widget.
 * <script src="https://radio.example.com/widgets/schedule.js" data-station="https://radio.example.com" data-theme="dark"></script>
 */
const { base } = config();
const { root } = mount("rhs-schedule");

render(root, `
  <div class="rhs-widget">
    <div class="rhs-row" style="justify-content:space-between">
      <div class="rhs-title" id="rhs-head">On air today</div>
      <span class="rhs-badge rhs-badge-live" id="rhs-live" style="display:none">🔴 LIVE</span>
    </div>
    <div class="rhs-list" id="rhs-list"><div class="rhs-muted">loading…</div></div>
  </div>
`);

const headEl = root.getElementById("rhs-head")!;
const listEl = root.getElementById("rhs-list")!;
const liveEl = root.getElementById("rhs-live")!;

interface ScheduleItem {
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  show: { name: string; color: string | null; presenters: string | null };
}

async function poll(): Promise<void> {
  try {
    const [schedule, now] = await Promise.all([
      getJSON<{ timezone: string; items: ScheduleItem[] }>(`${base}/api/public/schedule`),
      getJSON<{ live: boolean }>(`${base}/api/public/now-playing`).catch(() => null),
    ]);

    const live = !!now?.live;
    liveEl.style.display = live ? "" : "none";

    const tz = schedule.timezone || "UTC";
    const today = todayIndex(tz);
    const minutes = nowMinutes(tz);

    // Daily entries (dayOfWeek -1) run every day; other entries match the weekday.
    const todayItems = schedule.items
      .filter((item) => item.dayOfWeek === -1 || item.dayOfWeek === today)
      .sort((a, b) => a.startMinutes - b.startMinutes);

    if (todayItems.length === 0) {
      headEl.textContent = "On air today";
      listEl.innerHTML = `<div class="rhs-muted">Nothing scheduled yet today.</div>`;
      return;
    }

    const current = live ? undefined : todayItems.find((item) => minutes >= item.startMinutes && minutes < item.endMinutes);
    const next = todayItems.find((item) => item.startMinutes > minutes);

    listEl.innerHTML = todayItems
      .map((item) => {
        const onAir = item === current;
        const color = item.show.color || "#64748b";
        return `<div class="rhs-item${onAir ? " rhs-item-on" : ""}">
          <span style="width:8px;height:8px;border-radius:50%;background:${esc(color)};flex:0 0 8px"></span>
          <div class="rhs-item-copy">
            <div class="rhs-item-name">${esc(item.show.name)}</div>
            <div class="rhs-muted rhs-truncate">${esc(item.show.presenters ?? "")}</div>
          </div>
          <span class="rhs-time">${clock(item.startMinutes)}</span>
        </div>`;
      })
      .join("");

    headEl.textContent = live || current ? "On air now" : next ? `Next at ${clock(next.startMinutes)}` : "That's all for today";
  } catch {
    listEl.innerHTML = `<div class="rhs-muted">station unreachable</div>`;
  }
}

void poll();
setInterval(() => void poll(), 60_000);
