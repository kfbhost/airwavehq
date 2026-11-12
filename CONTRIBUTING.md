# Contributing to AirwaveHQ

Thanks for stopping by. AirwaveHQ is an early-stage, self-hosted internet radio
station that's being built in the open. Right now **testing, bug reports and
ideas are as valuable as code** — the project is far from finished and the
easiest way to help is to use it and tell me what happens.

## The most useful things you can do

### 1. Test an install

Please use a **spare VPS**, not your live station. A few things are still
unverified, and any one of them being tried is useful:

- Debian 12 (Ubuntu 22.04 is the tested path)
- arm64 / Raspberry Pi
- Re-running the installer on an existing install
- Backup → restore onto a fresh server
- The Live Studio on different browsers (microphone capture is the fragile part)

### 2. Report a bug

Open an issue using the bug template. The more of this you include, the faster
it can be fixed:

- the version (bottom of the sidebar, e.g. `2.0.0`)
- how it was installed (fresh install / upgrade / local dev)
- server OS and architecture
- what you did, what you expected, what actually happened
- relevant logs:

  ```bash
  docker compose -f infra/docker-compose.yml logs --tail=100 api engine
  ```

**Never paste secrets** — no `.env` contents, admin passwords or Icecast source
passwords. Redact anything you're unsure about.

### 3. Suggest an idea

Use the feature template. Describing your actual station workflow ("I do X every
Sunday and there's no way to...") is far more useful than a one-line wish.

## Working on the code

Requirements: Node 20+, PostgreSQL, and `ffmpeg`/`ffprobe` on your `PATH`.

```bash
npm install
npm run db:push       # create the schema
npm run dev:api       # :8080
npm run dev:engine    # :9002
npm run dev:web       # :5173
```

Before opening a pull request:

```bash
npm run typecheck
npm test
npm run build
```

**Layout:** `apps/api` (Fastify + Postgres), `apps/engine` (playout/audio),
`apps/web` (React dashboard and player), `apps/widgets` (embeddable bundles),
`packages/shared` (zod schemas, types, time helpers).

**Conventions:**

- Keep commits small and focused; explain the *why* in the message.
- Match the surrounding style. Please open an issue before adding a new
  framework or a large dependency.
- New behaviour should come with a test where it's practical (Vitest).
- The repo normalises line endings to LF via `.gitattributes` — don't fight it.
- Never commit `node_modules/`, `data/`, `.tmp/` or `.env`.

## Expectations

- This is a hobby project maintained in spare time, so replies can take a while.
- There's no roadmap committee: open an issue and let's talk it through.
- Be decent to each other. Disagreement about the software is fine; being
  unpleasant to people isn't.
