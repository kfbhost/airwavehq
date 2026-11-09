import { useState } from "react";
import { Badge, Card, PageHead } from "../components/ui";

const SECTIONS = [
  { id: "basics", title: "The basics", icon: "📻" },
  { id: "dashboard", title: "The dashboard", icon: "🛰️" },
  { id: "setup", title: "Getting on air", icon: "🚀" },
  { id: "accounts", title: "Accounts & sign-in", icon: "🔐" },
  { id: "library", title: "Media Library", icon: "🎵" },
  { id: "playlists", title: "Playlists", icon: "📋" },
  { id: "rotations", title: "Rotations", icon: "🔁" },
  { id: "clockwheels", title: "Clockwheels (jingles & sweepers)", icon: "🕐" },
  { id: "voice", title: "Show Builder & voice links", icon: "🎤" },
  { id: "schedule", title: "Schedule, shows & DJ slots", icon: "📅" },
  { id: "recordings", title: "Recordings & Listen Again", icon: "🎧" },
  { id: "backups", title: "Backups & restore", icon: "💾" },
  { id: "live", title: "Live Studio (DJ guide)", icon: "🔴" },
  { id: "analytics", title: "Analytics", icon: "📊" },
  { id: "settings", title: "Settings", icon: "⚙️" },
  { id: "player", title: "Public player & widgets", icon: "🔊" },
  { id: "trouble", title: "Troubleshooting", icon: "🛠️" },
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

export function Help() {
  const [q, setQ] = useState("");

  return (
    <div>
      <PageHead
        title="Help Guide"
        sub="Everything about running your station — written for owners, admins and DJs."
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
            <H2 id="basics">📻 The basics</H2>
            <P>
              RadioHost is an <strong>always-on internet radio station</strong> that runs itself. Your music
              library, playlists and rotation rules feed an automated player that broadcasts 24/7 to listeners
              through a streaming server (Icecast). You manage everything from this dashboard; DJs can jump in
              live from the <strong>Live Studio</strong> and take over the broadcast at any time.
            </P>
            <P>
              The station now works best if you think of it in layers: <strong>Playlists</strong> hold your music,
              <strong> Rotations</strong> decide which playlist should feed different hours of the day, and
              <strong> Clockwheels</strong> are optional structure for things like jingles and IDs. Scheduled shows
              override that automation during their slot, and <strong>Live Studio</strong> overrides everything while
              a DJ is live.
            </P>
            <P>
              Listen to your own stream at any time at <Code>http://your-server:8000/live</Code> (or the stream URL
              shown in <strong>Settings</strong>). The <strong>Public Player</strong> page is what listeners see.
            </P>
            <P>
              Four handy things live in the top bar: a clear <strong>studio clock</strong> showing the current time
              in your <strong>station timezone</strong> (with seconds, so you can hit the top of the hour and the
              :15 / :45 breaks exactly), the <strong>▶ play button</strong> which lets you listen to your own live
              stream right from the dashboard, the <strong>☀️/🌙 button</strong> which switches the whole app
              between light and dark themes (your choice is remembered on that browser), and the
              <strong>⛶ full screen button</strong>.
            </P>
            <P>
              <strong>Full screen</strong> hides the browser's address bar, tabs and toolbars so the app fills the
              whole screen and looks like a desktop program rather than a web page — handy for a studio machine
              that just sits on the dashboard. Press <strong>Esc</strong> (or the <strong>⤡ button</strong>) to come
              back to a normal window.
            </P>
          </Card>

          <Card>
            <H2 id="dashboard">🛰️ The dashboard</H2>
            <P>
              The dashboard is your broadcast control room. Across the top are live stats (status, listeners, bitrate,
              library size); the middle shows <strong>Now playing</strong> and the next few items the engine has lined
              up; and the right-hand column shows <strong>Automation health</strong> and your current source.
            </P>
            <H3>📺 Shows overview</H3>
            <P>
              The <strong>Shows</strong> card lists every show you've created, newest first, so you can see at a glance
              what's built and what's coming up:
            </P>
            <ul className="help-ul">
              <Li>A <Badge tone="green">Built · N items</Badge> badge means the show has a rundown in <a href="#voice">Show Builder</a>; <Badge tone="amber">Not built</Badge> means it still needs one.</Li>
              <Li>The <strong>Created</strong> date shows when the show was made.</Li>
              <Li><strong>Next …</strong> shows the show's next scheduled day and time (in your station timezone) and how far away it is — or <em>Not scheduled</em> if it isn't on the grid yet.</Li>
              <Li>Use <strong>Manage shows</strong> to jump to the Shows page.</Li>
            </ul>
          </Card>

          <Card>
            <H2 id="setup">🚀 Getting on air</H2>
            <P>
              The simplest setup order is:
              <strong> Media Library → Playlists → Rotations or Clockwheels → Settings</strong>.
            </P>
            <ul className="help-ul">
              <Li><strong>1. Upload music</strong> into the Media Library first.</Li>
              <Li><strong>2. Build at least one playlist</strong> from that music.</Li>
              <Li><strong>3. Choose a default playlist</strong> in Settings so AutoDJ has a fallback source.</Li>
              <Li><strong>4. Optionally add Rotations</strong> if you want different playlists by hour or day.</Li>
              <Li><strong>5. Optionally add a Clockwheel</strong> if you want a fixed radio format with jingles, sweepers or IDs.</Li>
              <Li><strong>6. Tune the sound in Settings</strong> — pick a processing preset (Gentle / Radio / Punch) and set the top-of-hour jingle.</Li>
            </ul>
            <Note>
              On a brand-new install, the station will not stay on air automatically until music has been uploaded and
              a default playlist has been selected in Settings.
            </Note>
          </Card>

          <Card>
            <H2 id="accounts">🔐 Accounts &amp; sign-in</H2>
            <P>
              There are two kinds of users: <strong>admins</strong> (full control of the station) and{" "}
              <strong>DJs</strong> (live broadcasting only).
            </P>
            <ul className="help-ul">
              <Li><strong>Admin</strong> — signs in with email + password on the main <em>Sign in</em> form. On a brand-new install the first account is created via <em>First run? Create account</em>. In Docker deployments the admin is created from the <Code>ADMIN_EMAIL</Code> / <Code>ADMIN_PASSWORD</Code> environment variables.</Li>
              <Li><strong>Multiple admins</strong> — you can have as many admins as you need, each with full access to the station manager. Add them from <strong>Settings → Admins &amp; invites</strong>. To protect you from lockout, the last remaining active admin can't be removed, disabled or demoted.</Li>
              <Li><strong>Invites</strong> — from <strong>Settings → Admins &amp; invites → Invite a teammate</strong>, enter their email and choose Administrator or DJ. You get a one-time <strong>invite link</strong> to copy and send them however you like (email, chat, etc.). They open it, set their own name and password, and are signed straight in. Links expire after 7 days. (Optional: automatic email sending can be enabled later via SMTP in the server's <Code>.env</Code> — it's not required.)</Li>
              <Li><strong>DJ</strong> — DJs can be invited with an email link (they set a password and sign in normally) or created with a <strong>6-digit access code</strong> (they sign in via the <em>DJ sign-in</em> link). DJs get the Live Studio, their own shows and the public player, but not the management pages.</Li>
              <Li><strong>Promote / demote</strong> — an admin can turn a DJ into an admin (they're given a temporary password to sign in with) or step an admin down to DJ, from the same panel.</Li>
              <Li>Change your own password any time from <strong>Settings → Admin account</strong>.</Li>
            </ul>
            <Note>Only admins can invite people and manage accounts. Each DJ can only work with the shows and time slots an admin allocates to them (see <a href="#schedule">Schedule, shows &amp; DJ slots</a>).</Note>
          </Card>

          <Card>
            <H2 id="library">🎵 Media Library</H2>
            <P>
              The library is the heart of your station — every audio file you upload. Supported formats include
              MP3, WAV, FLAC, OGG and M4A.
            </P>
            <ul className="help-ul">
              <Li><strong>Upload</strong> — drag &amp; drop files or use the Upload button. The system reads title, artist, album, duration, artwork and loudness automatically.</Li>
              <Li><strong>Kinds</strong> — every track is tagged with a kind, and the kind decides how it's used:
                <ul className="help-ul" style={{ marginTop: 6 }}>
                  <Li><Badge tone="blue">Music</Badge> — songs for the rotation.</Li>
                  <Li><Badge tone="green">Jingle</Badge> — short musical stingers, dropped between songs.</Li>
                  <Li><Badge tone="green">Sweeper</Badge> — sound effects/transition whooshes.</Li>
                  <Li><Badge tone="green">Station ID</Badge> — “You're listening to…” voice/music beds.</Li>
                  <Li><Badge tone="amber">Ad copy</Badge> — commercial spots for ad campaigns.</Li>
                  <Li><Badge tone="amber">Voice track</Badge> — presenter links used in Show Builder.</Li>
                </ul>
              </Li>
              <Li><strong>Folders</strong> — organise your library by genre or any grouping. Use the <strong>Folders</strong> panel to create, rename (<em>✎</em>) or delete (<em>×</em>) folders, click a folder to filter the list, and assign a track to a folder from its <strong>Edit</strong> dialog. Deleting a folder never deletes the audio — tracks simply become <em>unfiled</em>.</Li>
              <Li><strong>Loudness</strong> — each file is scanned for loudness (LUFS) on upload. The system stores a gain correction so all tracks play at a consistent volume.</Li>
              <Li><strong>Edit / delete</strong> — fix metadata (including folder) with the Edit button, or remove a track with ×.</Li>
            </ul>
            <Note>Short items (jingles, sweepers, IDs) are usually a few seconds. Music with no correct metadata can be edited after upload.</Note>
          </Card>

          <Card>
            <H2 id="playlists">📋 Playlists</H2>
            <P>
              Playlists are your music pools. They are the main source AutoDJ draws from when there is no live DJ or
              scheduled show on air.
            </P>
            <ul className="help-ul">
              <Li>Create playlists for different moods or dayparts, such as <strong>Breakfast</strong>, <strong>Daytime</strong>, <strong>Drive</strong> or <strong>Night</strong>.</Li>
              <Li>Keep at least <strong>one fallback playlist</strong> and set it as the default in <strong>Settings</strong>.</Li>
              <Li>You can also auto-build playlists to a target duration, for example <strong>1 hour</strong> or <strong>24 hours</strong>, using selected folders and optional jingles.</Li>
              <Li><strong>Shuffle each pass</strong> — a long playlist loops back to the top once it has played every track. With this switch on, the music is re-ordered for every loop, so the same running order never plays twice in a row. Jingles, sweepers and station IDs stay exactly where you placed them. Playlists with it on show a <Badge tone="green">🔀 Shuffle each pass</Badge> badge, and the Auto build dialog offers it for new playlists.</Li>
              <Li>Deleting the last remaining playlist is blocked so you do not accidentally leave AutoDJ with nothing to play.</Li>
            </ul>
          </Card>

          <Card>
            <H2 id="rotations">🔁 Rotations</H2>
            <P>
              Rotations decide <strong>which playlist feeds the station at different times of day</strong>. This is the
              easiest way to run different music through the day without changing settings manually.
            </P>
            <ul className="help-ul">
              <Li>Create a rule for a playlist, day, start hour and end hour. Leave <strong>Day</strong> on <strong>Every day</strong> to make it a catch-all for that window, or pick one weekday.</Li>
              <Li>Examples: <strong>Breakfast 06:00-10:00</strong>, <strong>Daytime 10:00-16:00</strong>, <strong>Evening 16:00-19:00</strong>.</Li>
              <Li><strong>Per-day playlists</strong> — for a daily rule you can assign a different playlist to each weekday (e.g. a Sunday specialty show). A day you leave blank uses the playlist set at the top of the rule.</Li>
              <Li><strong>Auto-generate a fresh list each day</strong> — instead of replaying one fixed playlist, a daily rule can rebuild a brand-new, shuffled list every local day from the music folders you pick (jingles every few tracks optional). Great for variety without curating dozens of playlists.</Li>
              <Li><strong>Shuffle music each time this rule airs</strong> — keep one curated playlist but let its <em>music</em> play in a fresh shuffled order every time the block airs (so a weekly slot sounds different each week). Jingles, sweepers and station IDs stay exactly where you placed them — only the music reorders. Turn it on per rule; rules using it show a <Badge tone="blue">shuffle on</Badge> tag in the list.</Li>
              <Li><strong>Priority</strong> — only breaks ties between two rules of the same kind that overlap the same window (e.g. two daily rules, or two same-day rules). A rule pinned to a specific weekday always beats an <strong>Every day</strong> rule, whatever their priorities.</Li>
              <Li>If no rule matches, the station falls back to the <strong>default playlist</strong> in Settings.</Li>
              <Li>You can create rotation blocks quickly from the <strong>Schedule page</strong> (Add schedule slot → Playlist or Rotation) instead of here.</Li>
            </ul>
            <Note>
              Rotations choose the playlist (or a clockwheel — a <strong>Clockwheel</strong> block on the Schedule page
              is a rotation whose clockwheel drives the hour). If you also use a clockwheel, it controls the shape of
              the hour and where jingles/IDs land. Shuffle and Auto-generate are alternatives: auto-generate already
              changes daily, so a rule can only use one of them.
            </Note>
          </Card>

          <Card>
            <H2 id="clockwheels">🕐 Clockwheels — jingles &amp; sweepers at regular intervals</H2>
            <P>
              A <strong>clockwheel</strong> is optional. Use one if you want a more structured radio sound with
              recurring jingles, sweepers and station IDs.
            </P>
            <ul className="help-ul">
              <Li><strong>Create a clockwheel</strong> and <strong>add slots</strong> in the order you want them to repeat. For example: <Code>Music → Music → Music → Sweeper</Code>.</Li>
              <Li><strong>Slot types:</strong>
                <ul className="help-ul" style={{ marginTop: 6 }}>
                  <Li><Badge tone="blue">Music</Badge> — pulls music from the active rotation playlist or the default playlist.</Li>
                  <Li><Badge tone="green">Jingle / Sweeper / Station ID</Badge> — pulls a random track of that kind from your library.</Li>
                  <Li><Badge tone="green">Anchored</Badge> — always plays one specific track (e.g. the “Top of hour” ID).</Li>
                </ul>
              </Li>
              <Li><strong>Reorder</strong> slots with the up/down buttons — the wheel loops around the hour, so the pattern repeats continuously.</Li>
              <Li><strong>Assign</strong> the wheel as the station default in <strong>Settings → Default clockwheel</strong>, or assign it to a specific show.</Li>
              <Li><strong>Schedule it as a block</strong> — drop a clockwheel onto the weekly grid via <strong>Schedule → Add schedule slot → Clockwheel</strong>, and it drives automation (jingles, IDs, music structure) for that whole window.</Li>
            </ul>
            <Note>
              If you do not need that structure, you can run the station perfectly well with just
              <strong> playlists + rotations + shows + live studio</strong>.
            </Note>
          </Card>

          <Card>
            <H2 id="voice">🎤 Show Builder &amp; voice links</H2>
            <P>
              Voice links are now handled directly inside <strong>Show Builder</strong>. There is no separate Voice
              Tracks workflow to manage day to day.
            </P>
            <ul className="help-ul">
              <Li>Each voice slot is tied to the show rundown, so the links stay organised with the show they belong to.</Li>
              <Li>Recorded links appear in playout as <Badge tone="blue">Voice</Badge> items and are timed with the surrounding songs.</Li>
              <Li>If a show is deleted, its archived voice recordings are cleaned up automatically.</Li>
            </ul>
            <H3>🎚️ Pre-produced shows (Show Builder)</H3>
            <P>
              Want the full “recorded live” experience? Open <strong>Show Builder</strong> and pick a show.
              Build an <strong>ordered rundown</strong> — the exact tracks you want, with your voice links
              dropped in <em>between</em> them wherever you like. When the show airs, the engine plays the
              rundown in that order (looping until the show ends), with ad breaks still airing on time and
              tracks trimmed near breaks so nothing overlaps.
            </P>
            <ul className="help-ul">
              <Li>Add tracks from your library, drop in blank voice slots, then reorder with drag and drop or the ↑/↓ buttons.</Li>
              <Li><strong>Record right in the browser</strong> — press the <em>🎙</em> button on a voice slot, speak, listen back, and save directly into that exact place in the rundown.</Li>
              <Li>Click the <strong>🎙 button on any voice slot</strong> to re-record that exact link in place — the new take replaces it between the same tracks.</Li>
              <Li><strong>▶ Preview voice links</strong> — focuses on the presenter links instead of playing the whole hour. For each link it plays a short intro from the song before, brings your voice in at full level, then plays the opening of the next song. The music is ducked underneath the link and faded at the edges, so you can judge whether the handoff sounds like a live studio break.</Li>
              <Li><strong>Timing rules</strong> — the summary shows music total, voice total, source total and aired length. Every blank voice slot counts as ~15 seconds until you record it, and the target aims <strong>~2 minutes over the slot</strong>: the last track fades out just before the top-of-hour jingle, so the show always reaches the hour even if a link is short or left unrecorded.</Li>
              <Li>When you press <em>🎙 Record</em>, the popup shows the <strong>last played and up-next tracks</strong> either side of the slot — handy for announcing them in your link.</Li>
              <Li>A show with a rundown plays that exact order when scheduled.</Li>
              <Li>Great for DJs without time for a live show: record your links once, build the hour, and it sounds live around the clock.</Li>
            </ul>
            <H3>⚡ Quick build (auto-build a show)</H3>
            <P>
              In a rush? The <strong>Auto-build rundown</strong> button fills a show from one of your genre
              folders instantly — pick a folder, choose <strong>1 hr, 2 hrs or 3 hrs</strong>, choose how often
              you want a voice link (<strong>every 1–5 tracks</strong>), and whether to replace or append to the
              current rundown. Tracks are picked at random, so re-run for a different selection.
            </P>
            <ul className="help-ul">
              <Li>The build fills to the requested length <strong>plus ~2 minutes</strong>, with blank 🎤 voice slots spaced through it — record your links and the show lands just past the hour, so the last track fades into the top-of-hour jingle.</Li>
              <Li>Blank slots count as ~15 s each in the plan; recorded links use their real length on air.</Li>
              <Li>DJs can only quick-build shows in slots the admin has allocated to them.</Li>
            </ul>
          </Card>

          <Card>
            <H2 id="schedule">📅 Schedule &amp; shows</H2>
            <P>
              The schedule calendar is your programming grid. Create <strong>shows</strong> and <strong>programming
              blocks</strong>, then place them on the schedule for the day and time they should air.
            </P>
            <ul className="help-ul">
              <Li>When a scheduled show is active, it overrides normal automation for that slot.</Li>
              <Li>If the show has a rundown from Show Builder, that rundown is what airs.</Li>
              <Li>A <strong>recorded show</strong> (created from a recording, tagged <Badge tone="blue">🔴 Recorded</Badge>) plays its audio once and then hands back to the default playlist — its slot auto-fills to the recording's length. See <a href="#recordings">Recordings &amp; Listen Again</a>.</Li>
              <Li>When the show ends, the station falls back to rotations/default automation automatically.</Li>
              <Li>Shows can be recorded automatically; recordings appear in <a href="#recordings">Recordings &amp; Listen Again</a>.</Li>
              <Li>The public schedule is visible to listeners on the Public Player page.</Li>
            </ul>
            <H3>➕ Adding programming with the schedule popup</H3>
            <P>
              The <strong>+ Add schedule slot</strong> button opens one popup that covers the whole week. Pick a
              <strong>Type</strong> at the top:
            </P>
            <ul className="help-ul">
              <Li><strong>Show</strong> — place a show at a day and start/end time.</Li>
              <Li><strong>Playlist</strong> — a quick block that plays a chosen playlist as automation in that window (named after the playlist).</Li>
              <Li><strong>Rotation</strong> — a full rotation rule with its own name, <strong>priority</strong> (higher wins overlapping windows) and an active toggle.</Li>
              <Li><strong>Clockwheel</strong> — runs a clockwheel (jingles, IDs, music structure) as automation in that window.</Li>
            </ul>
            <Note>
              Show, Playlist, Rotation and Clockwheel blocks all appear on the weekly grid and in
              “This week at a glance”, and the station hands over to them cleanly at the hour edges — the last track
              fades out just before the top-of-hour jingle.
            </Note>
            <H3>🗓️ DJ show slots (admin-allocated)</H3>
            <P>
              The admin controls every show time. In <strong>Settings → DJs</strong> you allocate
              <strong>recurring show slots</strong> to each DJ: pick the DJ, the days of the week, start and end
              times, and optionally an existing show. DJs cannot create or change their own times.
            </P>
            <ul className="help-ul">
              <Li>A DJ sees only <strong>their own allocated slots</strong> and can configure or build a show for each one.</Li>
              <Li>A slot with no show yet appears publicly as <em>“DJ name — Show to be configured”</em> until the DJ sets it up.</Li>
              <Li>DJs can only <strong>go live during an active allocated slot</strong> — outside it the Go Live button is disabled and the engine rejects the connection. If a DJ has several slots active at once, they choose which one to go live for. Admins can go live at any time.</Li>
              <Li>DJs cannot create a show at all until the admin allocates them an unused slot — the panel warns about this.</Li>
            </ul>
            <H3>🕐 Hour-to-hour discipline</H3>
            <P>
              The station runs <strong>exactly to the clock</strong>. Every track that would cross the top of the
              hour is cut short and faded out ~0.3 s before it, and the <strong>top-of-hour jingle</strong> (if set
              in <strong>Settings → Default programming</strong>) plays at exactly <Code>HH:00:00</Code>. Schedule
              shows hour-to-hour (10:00–11:00, 11:00–12:00) and the jingle lands perfectly between them. A live DJ
              keeps control of timing while broadcasting.
            </P>
            <Note>
              Override order is: <strong>Live Studio</strong> beats <strong>scheduled shows</strong>, scheduled shows
              beat <strong>rotations</strong>, and rotations beat the plain <strong>default playlist</strong>.
            </Note>
          </Card>

          <Card>
            <H2 id="recordings">🎧 Recordings &amp; Listen Again</H2>
            <P>
              The station records automatically as it airs — both <strong>scheduled shows</strong> and any{" "}
              <strong>live broadcast from the Live Studio</strong>. The <strong>Recordings</strong> page (sidebar) is
              the admin's control room for those files.
            </P>
            <ul className="help-ul">
              <Li><strong>Automatic capture</strong> — when a scheduled show is on air it is recorded for its whole slot; and whenever a DJ (or admin) presses <em>Go live</em>, that live set is recorded automatically too — even outside a scheduled show — so it lands in Listen Again.</Li>
              <Li><strong>▶ Listen</strong> — play any recording in the page with the station's custom audio player.</Li>
              <Li><strong>✎ Rename</strong> — change the title listeners see.</Li>
              <Li><strong>Publish / Hide</strong> — publish a recording to the public <strong>Listen Again</strong> page and podcast feed, or hide it so it stays private to the dashboard.</Li>
              <Li><strong>× Delete</strong> — remove the recording file from the server.</Li>
            </ul>
            <Note>Recording is controlled by the single <strong>Settings → Record shows</strong> switch. Keep it on to capture both scheduled and live output.</Note>
            <H3>↻ Turn a recording into a replayable show</H3>
            <P>
              Want to re-run a great recorded set later? On the <strong>Recordings</strong> page press{" "}
              <strong>→ Create show</strong> on any recording. This creates a normal <strong>Show</strong> (tagged{" "}
              <Badge tone="blue">🔴 Recorded</Badge> on the Shows page) whose content is that recording's audio, so you
              can drop it on the <a href="#schedule">Schedule</a> and it will re-air at another day and time.
            </P>
            <ul className="help-ul">
              <Li>When you schedule a recorded show, its slot <strong>auto-fills to the recording's length</strong> so the whole thing fits (it never gets cut short).</Li>
              <Li>It plays <strong>once</strong>, then the station <strong>automatically returns to the default playlist</strong> (or whatever else is scheduled, or a live DJ) — no looping, no dead air.</Li>
              <Li>The recording's audio is kept out of your Music library and won't be picked by random rotations or clockwheels.</Li>
              <Li>Pressing <em>Create show</em> twice won't duplicate it — it just points you back to the show it made.</Li>
            </ul>
            <Note>Because a recorded show plays the recording <em>file</em> itself, keep that recording (don't delete it, and watch the recording-retention window in Settings) or the re-run will have nothing to play.</Note>
            <H3>🌍 Listen Again (public)</H3>
            <P>
              Published recordings appear on the public <strong>Listen Again</strong> page — a tidy card layout
              with show artwork, show name, DJ names, air date and time, duration and an in-page player. Listeners
              reach it via the <strong>🎧 Listen Again</strong> button on the live player. Episodes appear
              automatically once a show finishes recording.
            </P>
            <ul>
              <Li><strong>Sharing an episode</strong> — every card has a share row: the native share sheet (on phones and tablets), <strong>Copy link</strong>, Facebook and WhatsApp. Each episode has its own link, so a link you post opens <em>that</em> show and previews it with its own title, show name, DJ and artwork.</Li>
              <Li><strong>Shared links land on the episode</strong> — a visitor following one sees just that episode with a highlighted card, plus <strong>◀ Browse all episodes</strong> to see the rest.</Li>
            </ul>
          </Card>

          <Card>
            <H2 id="backups">💾 Backups &amp; restore</H2>
            <P>
              The <strong>Backups</strong> page (sidebar) takes full snapshots of your station so you can
              recover from almost anything — a bad setting, a deleted library, or moving to a brand-new server.
              Backups are split into parts you can snapshot independently, so a quick settings-only copy stays seconds
              and a few megabytes even when your music library is enormous — tick what to include and press{" "}
              <strong>Create backup</strong>:
            </P>
            <ul className="help-ul">
              <Li><Badge tone="blue">🗄️ Database</Badge> — <Code>db-*.sql.gz</Code>: every setting, user, show, schedule entry, and the library index.</Li>
              <Li><Badge tone="green">🎵 Data</Badge> — <Code>data-*.tar.gz</Code>: the music library, auto-recorded show recordings, and recorded voice links, in one compressed archive.</Li>
              <Li><Badge tone="amber">🔑 Config</Badge> — <Code>config-*.env</Code>: your server's secrets (JWT keys, database password, Icecast passwords, domain), so a fresh install can be rebuilt.</Li>
            </ul>
            <P>
              Each row in the list shows the file, when it was made and its size, with an <strong>⬇ Download</strong>
              button to save it to your computer and a <strong>×</strong> to remove it from the server. For a large
              library the create button takes a few minutes — the files simply appear when it's done.
            </P>
            <H3>📥 Direct download — no server space needed</H3>
            <P>
              Creating a media backup first saves the archive <em>on the server</em>, which needs as much free space
              as your library itself. If the library is larger than the server's spare disk, use the{" "}
              <strong>Direct download</strong> buttons instead: the archive is built and streamed straight to your
              computer, and <strong>nothing is written to the server's disk at all</strong>. The page also warns you
              when a ticked component would not fit. Leave the tab open until the download finishes — stopping it
              means starting again — then keep the file safe, or upload it to another station with{" "}
              <strong>📤 Upload backup</strong> and restore it there.
            </P>
            <H3>♻️ Restoring</H3>
            <P>
              The <strong>Restore</strong> card lets you pick a database backup, a data backup, a config backup, or
              any combination, then applies them with one click. You must tick the confirmation box first, because
              restoring <strong>replaces the current station data</strong>:
            </P>
            <ul className="help-ul">
              <Li><strong>Database</strong> — wipes everything (settings, users, shows, schedule, library index) and reloads the snapshot.</Li>
              <Li><strong>Data</strong> — replaces the music library, show recordings and voice links with the archived copies.</Li>
              <Li><strong>Config</strong> — rewrites the server's <Code>.env</Code> file with the saved secrets; it takes effect on the next restart of the station (day-to-day changes stay in Settings, which apply instantly).</Li>
            </ul>
            <P>
              Music, recordings and voice archives each carry their own index, so you can restore just the
              recordings (for example) without also restoring the database — the files come back <em>and</em> show
              up in the lists. The restore reports how many entries it rebuilt, and both backup and restore show
              live progress while they run.
            </P>
            <Note>
              For a full rebuild on a brand-new server you need the three files <em>plus</em> the application code.
              The host backup script (<Code>infra/backup.sh</Code>, used by scheduled cron jobs) also bundles the
              code and <Code>.env</Code> automatically, and keeps the last 14 days. Treat your backups like the
              keys to the station — store a downloaded copy somewhere safe, off the server.
            </Note>
          </Card>

          <Card>
            <H2 id="live">🔴 Live Studio — the DJ guide</H2>
            <P>
              The Live Studio is a real mixer in your browser. When you press <strong>Go live</strong>, the engine
              blends you onto the broadcast with a short <strong>studio-style crossfade</strong> (~2.5 s): the
              AutoDJ fades down as your audio fades up, so listeners can't hear the handover. While you're live the
              automation clock keeps running quietly in the background, so when you press <em>Stop</em> the
              scheduled programming <strong>fades back in mid-track</strong> — exactly where it would have been —
              no restart, no dead air, no audible switch.
            </P>
            <ul className="help-ul">
              <Li><strong>Deck 1 &amp; Deck 2</strong> — click <em>Load</em>, pick a track from your library, and it loads with a waveform. Press <em>Play</em> (if available) to start, <em>Stop</em> to halt, <em>PFL</em> to hear it in your headphones before the audience does.</Li>
              <Li><strong>Volume sliders</strong> per deck — blend between decks with the <strong>crossfader</strong> concept: lower one deck as you raise the other.</Li>
              <Li><strong>Jingle carts</strong> — 8 slots (1–4 on Cart A, 5–8 on Cart B). Right-click a cart to load a jingle/sweeper from the library; click the cart to fire it instantly.</Li>
              <Li><strong>Microphone</strong> — <em>Open mic</em> to talk. The music <strong>ducks automatically</strong> while the mic is open, so you don't have to pull faders to talk over a song. The mic runs through its own built-in processor (a low-cut filter to remove rumble/plosives and a compressor to tame loud peaks), so you can speak up or get close to the mic and it stays clean rather than distorting. A gentle bus compressor also glues the whole mix together before it's sent out. The Microphone card has its own <strong>Level</strong> meter so you can set your mic gain to sit just under the red at your loudest, separately from the master.</Li>
              <Li><strong>Spacebar = mic on/off</strong> — press <em>Space</em> any time to toggle the microphone, no matter which deck or cart control has focus. (It's ignored while you're typing in a text box.) The <em>Open mic / Mute mic</em> button does the same thing.</Li>
              <Li><strong>Master VU meter</strong> — the <strong>Master</strong> card has a coloured level meter for the <strong>Output</strong> (what's actually going on air): it fills <strong>green</strong> through <strong>amber</strong> and turns <strong>red</strong> near the top/limit zone, with a white peak marker so you can keep your levels just under the red and avoid over-driving.</Li>
              <Li><strong>Master</strong> — the master level controls everything you send out. What you hear is what goes out.</Li>
              <Li><strong>Going live</strong> — press <em>Go live</em> to take over the broadcast. The ON AIR indicator confirms you're on. Press <em>Stop</em> when done.</Li>
              <Li><strong>Auto-recorded</strong> — every live set is captured automatically and appears in <a href="#recordings">Recordings &amp; Listen Again</a> (as long as <strong>Settings → Record shows</strong> is on). You can then publish it, or turn it into a replayable show.</Li>
              <Li><strong>Custom show name</strong> — when you go live you can set a show name (or leave the scheduled show's name). It appears on the public player and widgets, even outside a scheduled show.</Li>
              <Li><strong>Slot restriction</strong> — DJs can only go live during an admin-allocated slot for their account; the engine enforces this on the connection itself. Admins can go live any time.</Li>
              <Li><strong>Master output</strong> — the whole station's audio runs through the processing preset chosen in Settings, so the radio-style sound applies to live and automated output alike.</Li>
            </ul>
            <Note>Best practice: load both decks before going live, use PFL to cue your next track, and keep an eye on the countdown to the next cart so you don't talk over a jingle.</Note>
          </Card>

          <Card>
            <H2 id="analytics">📊 Analytics</H2>
            <P>
              Understand your audience: <strong>concurrent listeners</strong>, <strong>listening hours</strong>,{" "}
              <strong>top tracks/artists</strong> and a <strong>listener-country breakdown</strong>.
            </P>
            <ul className="help-ul">
              <Li>The <strong>play-log export</strong> produces a CSV of every play with source (automation / live / voice) for royalty and reporting use.</Li>
              <Li>Listener totals update while the engine is running.</Li>
              <Li>Country data builds up from the public player and listener widgets as people listen.</Li>
            </ul>
          </Card>

          <Card>
            <H2 id="settings">⚙️ Settings</H2>
            <P>
              Station identity (name, tagline, logo, timezone), the public <strong>stream URL</strong>, and the
              defaults that drive automation: <strong>default playlist</strong>, <strong>default
              clockwheel</strong>, crossfade length and more.
            </P>
            <ul className="help-ul">
              <Li>Set a <strong>default playlist</strong> here so the station always has a fallback music source.</Li>
              <Li>The <strong>default clockwheel</strong> is optional.</Li>
              <Li>Set the correct stream URL here — the Public Player and widgets use it for the Listen button.</Li>
              <Li>Use the recovery tools here to <strong>reload automation</strong> or <strong>restart the playout engine</strong> if a VPS deployment gets stuck.</Li>
              <Li><strong>Processing preset</strong> — pick <em>Gentle / Radio / Punch</em> for the station-wide audio processing (compression on the master output, applied before the stream). Change it any time without redeploying.</Li>
              <Li><strong>Top-of-hour jingle</strong> — in <em>Default programming</em>, choose a Station ID or Jingle track to play at exactly the top of every hour.</Li>
              <Li><strong>Automatic jingles</strong> — in <em>Default programming</em>, set <strong>Every N tracks</strong> and a jingle folder and the station drops a jingle between songs in your playlists and pre-produced shows. Jingles land <strong>tight and punchy</strong> at the end of a track — no gaps or crossfade — so they sound like a proper station. Where a clockwheel or auto-generate already places its own jingles, the layer steps aside so nothing doubles; live DJs still use their carts.</Li>
              <Li><strong>DJs</strong> — create DJ accounts, allocate their recurring show slots, and <em>Log in as DJ</em> to view a DJ's panel (a <em>Return to admin</em> button brings you back). Each DJ can have a <strong>profile picture</strong> (Settings → DJs → Add/Change photo); it appears on their recordings and on the public <strong>Listen Again</strong> episodes, with their initials as a fallback.</Li>
              <Li><strong>Geo-restrictions</strong> — in <em>Listeners</em>, block (or allow-list) countries by region code (e.g. <Code>US, GB</Code>). A blocked listener sees “Not available in your region” instead of the play button.</Li>
              <Li><strong>Recording retention</strong> — choose how many days to keep auto-recorded shows; older recordings are cleaned up automatically.</Li>
              <Li>Admins can also change their password here.</Li>
            </ul>
          </Card>

          <Card>
            <H2 id="player">🔊 Public player &amp; widgets</H2>
            <P>
              Your station has a shareable public page and embeddable widgets for your own website:
            </P>
            <ul className="help-ul">
              <Li><strong>Public Player</strong> (sidebar → Public Player) — full listener page with now-playing, live listen button and schedule.</Li>
              <Li><strong>Player widget</strong> — one-line embed for your website:
                <div className="help-code-block"><Code>&lt;script src="https://your-domain/widgets/player.js" data-station="https://your-domain"&gt;&lt;/script&gt;</Code></div>
              </Li>
              <Li><strong>Compact player bar</strong> — a slim listen-live bar for a site header or footer (<Code>widgets/bar.js</Code>).</Li>
              <Li><strong>Now-playing ticker</strong> — shows the current track on any page:
                <div className="help-code-block"><Code>&lt;script src="https://your-domain/widgets/nowplaying.js" data-station="https://your-domain"&gt;&lt;/script&gt;</Code></div>
              </Li>
              <Li><strong>Artwork now playing</strong> — album art card for sidebars (<Code>widgets/artwork.js</Code>).</Li>
              <Li><strong>Today's schedule</strong> — lists today's shows in station time, with a LIVE badge while a DJ is on air (<Code>widgets/schedule.js</Code>).</Li>
              <Li><strong>Listen again widget</strong> — lists your latest published recordings and plays them in the page; add <Code>data-limit="4"</Code> to change how many show (<Code>widgets/listenagain.js</Code>).</Li>
              <Li><strong>Song request box</strong> — a search-and-request form for your website; requests arrive in the Requests page (<Code>widgets/requests.js</Code>).</Li>
              <Li><strong>Every widget is previewed live</strong> on the Widgets page, where you can copy the exact embed code for your theme (add <Code>data-theme="light"</Code> for a light website).</Li>
              <Li><strong>Podcast RSS</strong> — published show recordings are exposed as a podcast feed (<Code>/api/public/podcasts.rss</Code>) that you can submit to podcast directories.</Li>
              <Li><strong>Listen Again</strong> — the public <Code>/listen-again</Code> page presents published recordings as cards with artwork, DJ names, air date/time and a built-in player; reach it from the <strong>🎧 Listen Again</strong> button on the live player.</Li>
              <Li><strong>Live show names</strong> — when a DJ goes live with a custom show name, it shows on the player and widgets right away, even outside a scheduled show.</Li>
            </ul>
          </Card>

          <Card>
            <H2 id="trouble">🛠️ Troubleshooting</H2>
            <ul className="help-ul">
              <Li><strong>“Off air” but audio plays</strong> — the ON AIR indicator reflects the latest engine heartbeat; if it flickers, the status connection is recovering. Refresh the page and it settles within seconds.</Li>
              <Li><strong>Stream silent on a new install</strong> — check that music has been uploaded and a default playlist has been chosen in Settings. Without both, AutoDJ has nothing to play.</Li>
              <Li><strong>Rotations do not seem to switch</strong> — check the current hour, the station timezone in Settings, and whether a scheduled show is overriding automation.</Li>
              <Li><strong>No jingles/sweepers on air</strong> — make sure the items are tagged with the right kind and referenced by a clockwheel slot (or that a playlist of them is assigned).</Li>
              <Li><strong>DJ can't connect</strong> — confirm the DJ account is active and they use the 6-digit code from the DJ sign-in page, not the admin password.</Li>
              <Li><strong>Live Studio audio not reaching listeners</strong> — check the mic isn't the only source (open mic + play a deck), and that you pressed <em>Go live</em>.</Li>
              <Li><strong>Engine offline for admins</strong> — if the engine service stopped, restart it (Docker: <Code>docker compose restart engine</Code>). It reconnects to the API and Icecast automatically.</Li>
              <Li><strong>Station suddenly goes silent</strong> — the playout engine now self-heals automatically: if it stops producing audio while the station is expected to be playing (a default playlist or music is set and nothing live is on), the watchdog restarts it within about ten minutes so the station can never sit silently off-air for long. A <Code>watchdog</Code> line in the API logs notes when it fires. If you want to force it sooner, restart the engine (<Code>docker compose restart engine</Code>) and it picks the schedule back up.</Li>
              <Li><strong>A recorded show won't play</strong> — it plays the recording <em>file</em>, so make sure that recording still exists (not deleted, and within the Settings → recording-retention window).</Li>
              <Li><strong>A show ends short</strong> — unrecorded voice slots play 0 s on air (the ~15 s is just the planning estimate). Builds aim ~2 min over the slot so the fade covers the difference, but if links are left blank in bulk, record the links or add a track.</Li>
              <Li><strong>“You can't go live”</strong> — DJs are restricted to their admin-allocated slots. Check the slot's day/time and the station timezone in Settings.</Li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
