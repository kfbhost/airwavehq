import { describe, expect, it } from "vitest";
import { airedLabel, escapeHtml, renderSharePage } from "../src/routes/share.js";
import { formatEpisodeDuration } from "../src/services/listenAgain.js";
import type { PublicListenAgainItem } from "@airshift/shared";

function episode(overrides: Partial<PublicListenAgainItem> = {}): PublicListenAgainItem {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    title: "Weekend Warmup",
    showId: "show-1",
    showName: "Weekend Warmup",
    presenters: null,
    djName: "DJ Nova",
    djAvatarUrl: "/media/avatar-1.jpg",
    artworkUrl: "/media/artwork-1.jpg",
    color: "#ef4444",
    startedAt: "2026-09-11T18:18:00.000Z",
    endedAt: "2026-09-11T19:59:00.000Z",
    durationSeconds: 6060,
    audioUrl: "https://stream.example.com/api/public/podcasts/1/audio",
    ...overrides,
  };
}

const base = {
  id: "11111111-2222-3333-4444-555555555555",
  origin: "https://stream.example.com",
  stationName: "Radio 247",
  timezone: "Europe/London",
};

describe("share page", () => {
  it("gives each episode its own preview title, description and artwork", () => {
    const html = renderSharePage({ ...base, episode: episode() });
    expect(html).toContain('<meta property="og:title" content="Weekend Warmup · Weekend Warmup — Radio 247" />');
    expect(html).toContain('<meta property="og:image" content="https://stream.example.com/media/artwork-1.jpg" />');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(html).toContain("DJ Nova");
    expect(html).toContain("1h 41m");
    expect(html).toContain('<meta property="og:audio" content="https://stream.example.com/api/public/podcasts/1/audio" />');
  });

  it("falls back to the DJ picture when the show has no artwork", () => {
    const html = renderSharePage({ ...base, episode: episode({ artworkUrl: null }) });
    expect(html).toContain('content="https://stream.example.com/media/avatar-1.jpg"');
  });

  it("uses summary (not large image) when there is no image at all", () => {
    const html = renderSharePage({ ...base, episode: episode({ artworkUrl: null, djAvatarUrl: null }) });
    expect(html).toContain('<meta name="twitter:card" content="summary" />');
    expect(html).not.toContain('property="og:image"');
  });

  it("points humans at the episode route and tells crawlers the real address", () => {
    const html = renderSharePage({ ...base, episode: episode() });
    expect(html).toContain(`<link rel="canonical" href="https://stream.example.com/listen-again/${base.id}" />`);
    expect(html).toContain(`location.replace("https://stream.example.com/listen-again/${base.id}")`);
    expect(html).toContain(`<meta property="og:url" content="https://stream.example.com/e/${base.id}" />`);
  });

  it("escapes user-supplied titles so a show name cannot inject markup", () => {
    const html = renderSharePage({
      ...base,
      episode: episode({ title: '"><script>alert(1)</script>', showName: "A & B" }),
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("A &amp; B");
    // The redirect script must not be breakable out of either.
    expect(html).not.toContain('</script><script>');
  });

  it("formats the air date in the station's timezone", () => {
    // 18:18 UTC is 19:18 BST — the label must follow the station clock, not UTC.
    expect(airedLabel("2026-09-11T18:18:00.000Z", "Europe/London")).toContain("11 September 2026");
    expect(airedLabel("2026-09-11T18:18:00.000Z", "Europe/London")).toContain("19:18");
    expect(airedLabel("2026-09-11T18:18:00.000Z", "UTC")).toContain("18:18");
    expect(airedLabel("not-a-date", "Europe/London")).toBe("Invalid Date");
  });

  it("escapes every dangerous HTML character", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });

  it("renders running times the way the cards do", () => {
    expect(formatEpisodeDuration(6060)).toBe("1h 41m");
    expect(formatEpisodeDuration(2880)).toBe("48m");
    expect(formatEpisodeDuration(0)).toBe("0m");
  });
});
