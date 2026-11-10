export interface WidgetConfig {
  base: string;
  theme: "dark" | "light";
  script: HTMLScriptElement | null;
}

export function config(): WidgetConfig {
  const script = document.currentScript as HTMLScriptElement | null;
  const base = script?.getAttribute("data-station") ?? window.location.origin;
  return {
    base: base.replace(/\/$/, ""),
    theme: (script?.getAttribute("data-theme") as "dark" | "light") ?? "dark",
    script,
  };
}

export async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/** Escape text before it goes into an innerHTML template. */
export function esc(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Station-local minutes past midnight (as stored in the schedule) → "HH:MM". */
export function clock(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Turn a relative media path returned by the API into an absolute URL. */
export function absolute(base: string, url: string | null | undefined): string {
  if (!url) return "";
  return /^https?:\/\//i.test(url) ? url : `${base}${url.startsWith("/") ? "" : "/"}${url}`;
}

/** Seconds → "1h 04m" / "42m" for episode durations. */
export function duration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

/** Today's day index (0 = Sunday … 6 = Saturday) in the station's timezone. */
export function todayIndex(timeZone: string): number {
  try {
    const wd = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(new Date());
    const i = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
    return i === -1 ? new Date().getDay() : i;
  } catch {
    return new Date().getDay();
  }
}

/** Station-local minutes past midnight right now, in the station's timezone. */
export function nowMinutes(timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    return (h % 24) * 60 + m;
  } catch {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }
}

export function css(theme: "dark" | "light"): string {
  return theme === "dark"
    ? `:host{--bg:#0b1220;--panel:#141f38;--border:#243356;--text:#e5ecf7;--muted:#8fa3c4;--accent:#38bdf8;--accent2:#6366f1;--green:#34d399;}`
    : `:host{--bg:#ffffff;--panel:#f1f5f9;--border:#e2e8f0;--text:#0f172a;--muted:#64748b;--accent:#0284c7;--accent2:#6366f1;--green:#059669;}`;
}

export const BASE_CSS = `
  *{box-sizing:border-box}
  .airshift-widget{background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:14px;color:var(--text);font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.4;max-width:340px}
  .airshift-row{display:flex;align-items:center;gap:10px}
  .airshift-btn{background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;color:#fff;border-radius:8px;padding:8px 14px;font-size:14px;font-weight:600;cursor:pointer;min-width:44px}
  .airshift-btn:active{transform:scale(.97)}
  .airshift-title{font-weight:700}
  .airshift-muted{color:var(--muted);font-size:12px}
  .airshift-meta{color:var(--muted);font-size:11px;margin-top:8px}
  .airshift-live{color:var(--green);font-weight:700}
  .airshift-badge{display:inline-flex;align-items:center;gap:4px;background:var(--panel);border:1px solid var(--border);border-radius:999px;padding:2px 8px;font-size:11px;color:var(--muted)}
  .airshift-badge-live{color:#fff;background:#e11d48;border-color:#e11d48;font-weight:700}
  .airshift-truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .airshift-bar{background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:8px 12px;color:var(--text);font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:13px;display:flex;align-items:center;gap:10px}
  .airshift-art{max-width:260px}
  .airshift-art-img{width:100%;aspect-ratio:1/1;border-radius:10px;overflow:hidden;background:var(--panel);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:40px;color:var(--muted);margin-bottom:12px}
  .airshift-art-img img{width:100%;height:100%;object-fit:cover;display:block}
  .airshift-list{display:flex;flex-direction:column;gap:6px;margin-top:4px;max-height:260px;overflow:auto}
  .airshift-item{display:flex;align-items:center;gap:10px;padding:6px;border-radius:8px;border:1px solid transparent}
  .airshift-item-on{background:var(--panel);border-color:var(--border)}
  .airshift-item-art{width:38px;height:38px;flex:0 0 38px;border-radius:6px;overflow:hidden;background:var(--panel);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:16px;color:var(--muted)}
  .airshift-item-art img{width:100%;height:100%;object-fit:cover;display:block}
  .airshift-item-copy{min-width:0;flex:1}
  .airshift-item-name{font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .airshift-time{font-variant-numeric:tabular-nums;font-size:12px;color:var(--muted);flex:0 0 auto}
  .airshift-mini-btn{background:var(--panel);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:5px 9px;font-size:12px;cursor:pointer}
  .airshift-mini-btn:active{transform:scale(.97)}
`;

/** Creates a shadow root on a new container appended to the script's parent. */
export function mount(widgetId: string): { root: ShadowRoot; el: HTMLElement } {
  const el = document.createElement("div");
  el.className = "airshift-mount";
  document.currentScript?.parentElement?.appendChild(el);
  const root = el.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = BASE_CSS + css((document.currentScript as HTMLScriptElement | null)?.getAttribute("data-theme") === "light" ? "light" : "dark");
  root.appendChild(style);
  return { root, el };
}

/**
 * Writes widget markup into its own wrapper inside the shadow root. Never
 * assign `root.innerHTML` directly — that discards the <style> mount() added
 * and leaves the widget completely unstyled on the host page.
 */
export function render(root: ShadowRoot, html: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "airshift-host";
  wrap.innerHTML = html;
  root.appendChild(wrap);
  return wrap;
}
