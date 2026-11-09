import { useState } from "react";
import { Card, PageHead } from "../components/ui";

const SECTIONS = [
  { id: "topbar", title: "The top bar", icon: "🕒" },
  { id: "live", title: "Live Studio — going live", icon: "🔴" },
  { id: "shows", title: "My Shows & your slots", icon: "🎙️" },
  { id: "builder", title: "Show Builder & voice links", icon: "🎚️" },
  { id: "player", title: "Public player & Listen Again", icon: "🔊" },
  { id: "trouble", title: "DJ troubleshooting", icon: "🛠️" },
];

function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="help-h2">
      {children}
    </h2>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return <h3 className="help-h3">{children}</h3>;
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="help-p">{children}</p>;
}

function Li({ children }: { children: React.ReactNode }) {
  return (
    <li className="help-li">
      <span className="help-li-mark">•</span>
      <span>{children}</span>
    </li>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <div className="help-note">{children}</div>;
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="help-code">{children}</code>;
}

export function DjHelp() {
  const [q, setQ] = useState("");

  return (
    <div>
      <PageHead
        title="DJ Help Guide"
        sub="The essentials for DJs — your slots, your shows, and going live"
        actions={
          <input
            className="input"
            placeholder="Search the guide…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ width: 240 }}
          />
        }
      />

      <div className="help-grid">
        {/* Table of contents */}
        <aside className="help-toc card">
          <div className="help-toc-title">On this page</div>
          {SECTIONS.filter(
            (s) =>
              !q ||
              s.title.toLowerCase().includes(q.toLowerCase()),
          ).map((s) => (
            <a key={s.id} className="help-toc-link" href={`#${s.id}`}>
              <span>{s.icon}</span> {s.title}
            </a>
          ))}
          {q && SECTIONS.every((s) => !s.title.toLowerCase().includes(q.toLowerCase())) ? (
            <div className="muted small" style={{ padding: "8px 4px" }}>
              No section matches “{q}” — try a broader term.
            </div>
          ) : null}
        </aside>

        {/* Content */}
        <div className="help-body">
          <Card>
            <H2 id="topbar">🕒 The top bar</H2>
            <P>
              Everything you need while you're on air is along the top of the DJ panel:
            </P>
            <ul className="help-list">
              <Li>The <strong>studio clock</strong> — the station's real time with seconds, so you can time your links to the hour and the :15 / :45 breaks.</Li>
              <Li>The <strong>▶ play button</strong> — listen to the live output of the station without leaving the panel.</Li>
              <Li>The <strong>☀️/🌙 button</strong> — switch between light and dark themes; your choice is remembered on that browser.</Li>
              <Li>The <strong>⛶ full screen button</strong> — hides the browser's tabs and toolbars so the panel fills the screen like a desktop program. Press <strong>Esc</strong> to return to a normal window.</Li>
            </ul>
          </Card>

          <Card>
            <H2 id="live">🔴 Live Studio — going live</H2>
            <P>
              Live Studio is your browser mixer. When you press <strong>Go live</strong>, the engine blends you
              onto the broadcast with a short studio-style crossfade (~2.5 s) — the AutoDJ fades down as your audio
              fades up, so listeners can't hear the handover. While you're live, automation keeps running quietly in
              the background, so when you press <em>Stop</em> the scheduled programming <strong>fades back in
              mid-track</strong> exactly where it would have been — no restart, no dead air.
            </P>
            <ul className="help-ul">
              <Li><strong>Deck 1 &amp; Deck 2</strong> — click <em>Load</em>, pick a track from the library, and it loads with a waveform. Press <em>Play</em> to start, <em>Stop</em> to halt, <em>PFL</em> to hear it in your headphones before the audience does.</Li>
              <Li><strong>Volume sliders</strong> per deck — blend between decks: lower one as you raise the other.</Li>
              <Li><strong>Jingle carts</strong> — 8 slots (1–4 on Cart A, 5–8 on Cart B). Right-click a cart to load a jingle/sweeper from the library; click the cart to fire it instantly.</Li>
              <Li><strong>Microphone</strong> — press <em>Open mic</em> to talk. The music <strong>ducks automatically</strong> while the mic is open, so you don't have to pull faders to talk over a song.</Li>
              <Li><strong>Master level</strong> — controls everything you send out. Keep it sensible: if you turn it right up you can distort the broadcast. What you hear is what goes out.</Li>
              <Li><strong>Going live</strong> — press <em>Go live</em> to take over the broadcast. The ON AIR indicator confirms you're on. Press <em>Stop</em> when done.</Li>
              <Li><strong>Custom show name</strong> — when you go live you can set a show name (or keep the scheduled show's name). It appears on the public player and widgets right away, even outside a scheduled show.</Li>
              <Li><strong>Slot restriction</strong> — you can only go live during an <strong>admin-allocated slot</strong> for your account; the engine enforces this on the connection itself. Outside your slot you'll see a warning and the Go Live button stays disabled.</Li>
            </ul>
            <Note>
              Best practice: load both decks before going live, use PFL to cue your next track, and don't talk over a
              jingle. Everything you broadcast also runs through the station's audio processing, so it sounds as
              polished as the automated output.
            </Note>
          </Card>

          <Card>
            <H2 id="shows">🎙️ My Shows &amp; your slots</H2>
            <P>
              Your shows are controlled by the slots the admin gives you. In <strong>My Shows</strong> you'll only
              ever see <strong>your own allocated slots and shows</strong> — you can't edit anyone else's.
            </P>
            <ul className="help-ul">
              <Li>The admin allocates <strong>recurring slots</strong> to you: the days of the week and start/end times for each of your shows. You can't change those times yourself.</Li>
              <Li>For each slot you can <strong>create a show</strong>, <strong>build a rundown</strong> for it in Show Builder, or <strong>go live</strong> during that time.</Li>
              <Li>A slot with no show yet appears publicly as <em>“DJ name — Show to be configured”</em> until you set it up.</Li>
              <Li>You <strong>cannot create a show at all</strong> until the admin allocates you an unused slot — the panel warns you if you try.</Li>
              <Li>If you have several slots active at once, you choose which one you go live for.</Li>
              <Li>Once your show is set up or you pick a live show for a slot, it becomes part of the public schedule so listeners know what's on and when.</Li>
            </ul>
          </Card>

          <Card>
            <H2 id="builder">🎚️ Show Builder &amp; voice links</H2>
            <P>
              Show Builder is how you prepare a show in advance — perfect when you can't (or don't want to) be live.
              Build an <strong>ordered rundown</strong> — the exact tracks you want, with your voice links dropped in
              between them. When the show airs, the engine plays the rundown in that order.
            </P>
            <ul className="help-ul">
              <Li><strong>Add tracks</strong> from the library, drop in blank <strong>voice slots</strong>, then reorder with drag and drop or the ↑/↓ buttons.</Li>
              <Li><strong>Record right in the browser</strong> — press the <em>🎙</em> button on a voice slot, speak, listen back, and save directly into that exact place in the rundown.</Li>
              <Li>When the <em>🎙 Record</em> popup opens it shows the <strong>track just played and what's up next</strong> either side of the slot — handy for announcing them in your link.</Li>
              <Li><strong>▶ Preview voice links</strong> — plays a short intro from the song before, brings your voice in, then the opening of the next song, so you can judge the handoff like a live studio break.</Li>
              <Li><strong>Auto-build (quick build)</strong> — in a rush? Pick a genre folder, choose <strong>1 hr, 2 hrs or 3 hrs</strong>, how often you want a voice link (<strong>every 1–5 tracks</strong>), and whether to replace or append. Tracks are picked at random, so re-run for a different selection.</Li>
              <Li><strong>Timing</strong> — a blank voice slot counts as ~15 s in the plan; recorded links use their real length on air. Builds aim <strong>~2 minutes over the slot</strong>, so the last track fades out just before the top-of-hour jingle — the show always reaches the hour even if a link is short or left unrecorded.</Li>
              <Li>The station runs <strong>exactly to the clock</strong>, so aim your shows at the full hour (e.g. 20:00–21:00) and the top-of-hour jingle lands cleanly between shows.</Li>
            </ul>
            <Note>
              If a voice link is left unrecorded, it simply plays nothing on air (the ~15 s is just the planning
              estimate). For the smoothest result, record every slot — a fully voiced show sounds live around the
              clock.
            </Note>
          </Card>

          <Card>
            <H2 id="player">🔊 Public player &amp; Listen Again</H2>
            <P>
              What listeners see of your work:
            </P>
            <ul className="help-ul">
              <Li><strong>Public Player</strong> — the listener page with now-playing, the live listen button, and the schedule. When you go live it shows <strong>LIVE</strong>, your name, and your custom show name.</Li>
              <Li><strong>Listen Again</strong> — your aired shows are recorded automatically and appear on the public <strong>Listen Again</strong> page as cards with the show name, your name, air date/time and a player. Listeners reach it from the <strong>🎧 Listen Again</strong> button on the live player.</Li>
              <Li><strong>Sharing your show</strong> — each replay card has a share row (native share sheet, copy link, Facebook, WhatsApp). Every episode has its own link, so whoever opens it lands straight on your show and the link previews your show name, your name and the artwork.</Li>
              <Li><strong>Widgets</strong> — your station's player and now-playing widgets embed on your website; they also show your live show name while you're on air.</Li>
            </ul>
            <Note>Your show name (custom or scheduled) shows on the player and widgets the moment you go live — no one has to refresh a schedule.</Note>
          </Card>

          <Card>
            <H2 id="trouble">🛠️ DJ troubleshooting</H2>
            <ul className="help-ul">
              <Li><strong>“You can't go live” / Go Live button is disabled</strong> — you're outside your allocated slot. Check the slot's day and time in <strong>My Shows</strong>, and remember it follows the <strong>station timezone</strong> set by the admin.</Li>
              <Li><strong>“You have no shows allocated yet” when creating a show</strong> — the admin has to give you a slot first. Ask them to allocate you one in Settings → DJs.</Li>
              <Li><strong>Listeners can't hear my mic</strong> — make sure you pressed <em>Open mic</em> <em>and</em> a deck is playing (mic alone with nothing playing can be silent), and that you actually pressed <em>Go live</em>.</Li>
              <Li><strong>Audio sounds distorted</strong> — the master level is too high. Pull the master and deck levels back until it's clean.</Li>
              <Li><strong>My show name isn't showing on the public player</strong> — set the custom show name when you go live; it appears immediately. If a listener's page is open, they may need to refresh once.</Li>
              <Li><strong>Live Studio won't connect / keeps dropping</strong> — refresh the page. The engine reconnects to the API automatically within seconds.</Li>
              <Li><strong>I can't see other DJs' shows</strong> — that's by design; you only ever see and edit your own allocated shows.</Li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
