import { useState } from "react";
import { Button, Card, PageHead } from "../components/ui";

/** The app's current theme — widgets and snippets follow it so previews match your site. */
function currentTheme(): "dark" | "light" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      className="btn-sm"
      onClick={() => {
        void navigator.clipboard?.writeText(text).catch(() => {});
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Copied ✓" : label}
    </Button>
  );
}

/**
 * Renders the real widget script inside a same-origin frame, so the preview is
 * the actual embed (live data, real styling) rather than a mock-up.
 */
function WidgetPreview({ snippet, height, title }: { snippet: string; height: number; title: string }) {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:10px;background:transparent}</style></head><body>${snippet}</body></html>`;
  return <iframe className="widgets-preview" style={{ height }} title={`${title} preview`} srcDoc={doc} loading="lazy" />;
}

interface WidgetDef {
  key: string;
  file: string;
  title: string;
  sub: string;
  copy: string;
  height: number;
  attrs?: string;
}

export function Widgets() {
  const origin = location.origin;
  const theme = currentTheme();
  const publicPlayerUrl = `${origin}/listen`;

  const script = (file: string, extra = "") =>
    `<script src="${origin}/widgets/${file}.js" data-station="${origin}" data-theme="${theme}"${extra}></script>`;

  const widgets: WidgetDef[] = [
    {
      key: "player",
      file: "player",
      title: "Player widget",
      sub: "A full listen-live player for your website",
      copy: "Paste this where you want the player to sit on your page. It shows the live stream, the current track (or the DJ and show when live) and the listener count.",
      height: 132,
    },
    {
      key: "bar",
      file: "bar",
      title: "Compact player bar",
      sub: "A slim listen-live bar for a site header or footer",
      copy: "A single-line bar with a play button — ideal for the top of a website where a full player would take up too much room.",
      height: 92,
    },
    {
      key: "nowplaying",
      file: "nowplaying",
      title: "Now playing ticker",
      sub: "One-line track title and artist",
      copy: "Use this anywhere you just want the current song details. It swaps to the DJ name and show title when someone is live, and it's the one-line \"Now playing:\" strip.",
      height: 84,
    },
    {
      key: "artwork",
      file: "artwork",
      title: "Artwork now playing",
      sub: "Album art with track details",
      copy: "A square artwork card for sidebars. It shows the cover image of whatever is playing, with the title and artist underneath.",
      height: 400,
    },
    {
      key: "schedule",
      file: "schedule",
      title: "Today's schedule",
      sub: "What's on air today",
      copy: "Lists today's shows in station time with the current show highlighted, and a LIVE badge while a DJ is on air.",
      height: 360,
    },
    {
      key: "listenagain",
      file: "listenagain",
      title: "Listen again / latest shows",
      sub: "Catch-up list with in-page playback",
      copy: "Shows your latest published recordings and lets listeners play them right there in the widget, without leaving the page.",
      height: 300,
      attrs: ' data-limit="4"',
    },
    {
      key: "requests",
      file: "requests",
      title: "Song request box",
      sub: "Listeners request tracks from your site",
      copy: "A request form with track search. Requests land in the Requests page of your dashboard. Only works while the request box is enabled in Settings.",
      height: 480,
    },
  ];

  return (
    <>
      <PageHead
        title="Widgets"
        sub="Embeddable tools for your website — each one previewed live below with the code you need"
      />

      <Card className="widgets-card widgets-card-wide" title="Standalone public player" sub="A shareable page for listeners outside the app">
        <p className="hint widgets-copy">
          Share this page directly with listeners when you want the player on its own without the dashboard around it.
        </p>
        <iframe className="widgets-preview" style={{ height: 460 }} title="Standalone public player preview" src="/listen" loading="lazy" />
        <div className="widgets-preview-foot">
          <code className="widgets-code mono">{publicPlayerUrl}</code>
          <CopyButton text={publicPlayerUrl} />
        </div>
      </Card>

      <div className="widgets-grid">
        {widgets.map((w) => {
          const snippet = script(w.file, w.attrs ?? "");
          return (
            <Card key={w.key} className="widgets-card" title={w.title} sub={w.sub} actions={<CopyButton text={snippet} label="Copy code" />}>
              <p className="hint widgets-copy">{w.copy}</p>
              <WidgetPreview snippet={snippet} height={w.height} title={w.title} />
              <div className="widgets-preview-foot">
                <code className="widgets-code mono">{snippet}</code>
              </div>
            </Card>
          );
        })}
      </div>

      <Card title="Widget options" sub="Attributes you can add to any embed">
        <div className="widgets-list">
          <div className="widgets-list-item">
            <strong>data-station</strong> <span className="hint">— your station address, e.g. {origin}. Required when the widget is on a different site.</span>
          </div>
          <div className="widgets-list-item">
            <strong>data-theme</strong> <span className="hint">— "dark" or "light" to match your website. Currently set to {theme} to match your dashboard.</span>
          </div>
          <div className="widgets-list-item">
            <strong>data-limit</strong> <span className="hint">— on the listen again widget, how many episodes to list (1–10, default 4).</span>
          </div>
          <div className="widgets-list-item">
            <strong>Podcast feed</strong> <span className="hint">— podcast apps can subscribe to {origin}/api/public/podcasts.rss</span>
          </div>
        </div>
      </Card>
    </>
  );
}
