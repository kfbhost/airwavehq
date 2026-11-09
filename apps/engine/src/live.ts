import { WebSocketServer, type WebSocket } from "ws";
import { createServer } from "node:http";
import { jwtVerify } from "jose";
import type { Playout } from "./playout.js";
import type { RecordingManager } from "./recording.js";
import { config } from "./config.js";

async function validateDjSlot(token: string): Promise<{ ok: boolean; showName: string | null; showId: string | null; reason?: string }> {
  try {
    const res = await fetch(`${config.apiUrl}/dj-slots/current`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, showName: null, showId: null, reason: "No DJ slot is active right now" };
    return await res.json() as { ok: boolean; showName: string | null; showId: string | null; reason?: string };
  } catch {
    return { ok: false, showName: null, showId: null, reason: "Could not verify your DJ slot" };
  }
}

const secret = new TextEncoder().encode(config.jwtSecret);

/**
 * Browser DJs connect here with ?token=<JWT> and stream 48 kHz stereo f32le
 * PCM (the mixed output of their Live Studio). While connected, the playout
 * switches to live mode; on disconnect it resumes automation.
 */
export function startLiveServer(playout: Playout, onDjChange: (name: string | null, showName?: string | null) => void, recording: RecordingManager): () => void {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  let djName: string | null = null;
  let lastDataAt = 0;

  wss.on("connection", (socket: WebSocket, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const token = url.searchParams.get("token") ?? "";
    // Optional show name chosen by the DJ when going live (displayed on the
    // public player and widgets while the broadcast is live).
    const showName = (url.searchParams.get("show") ?? "").trim().slice(0, 80) || null;
    void (async () => {
      let payload: { sub?: string; name?: string; role?: string; impersonatedBy?: string } | null = null;
      try {
        const { payload: p } = await jwtVerify(token, secret);
        payload = p as { sub?: string; name?: string; role?: string };
      } catch {
        socket.close(4001, "Unauthorized");
        return;
      }
      if (!payload || (payload.role !== "admin" && payload.role !== "dj")) {
        socket.close(4003, "Forbidden");
        return;
      }

      let allocatedShowName: string | null = null;
      let allocatedShowId: string | null = null;
      if (payload.role === "dj" && !payload.impersonatedBy) {
        const slot = await validateDjSlot(token);
        if (!slot.ok) {
          socket.close(4004, slot.reason ?? "You are not allocated a live slot right now");
          return;
        }
        allocatedShowName = slot.showName;
        allocatedShowId = slot.showId;
      }

      const thisDj = payload.name ?? "DJ";
      djName = thisDj;
      lastDataAt = Date.now();
      // Report the name (and optional show name) before switching modes so the
      // first status includes them.
      onDjChange(thisDj, showName ?? allocatedShowName);
      playout.setLiveMode(true);
      // Going live is itself a show to record (DJs are slot-restricted), so the
      // set lands in Listen Again even when it isn't on the weekly schedule.
      recording.setLive({
        showId: allocatedShowId,
        djId: payload.sub ?? null,
        title: (allocatedShowName ?? showName ?? `${thisDj} — Live`).trim(),
        startedAt: new Date().toISOString(),
      });
      console.log(`[engine] LIVE: ${thisDj} connected`);

      socket.on("message", (data) => {
        if (Buffer.isBuffer(data)) {
          lastDataAt = Date.now();
          playout.pushLivePcm(data);
        }
      });

      socket.on("close", () => {
        if (djName === thisDj) {
          djName = null;
          playout.setLiveMode(false);
          onDjChange(null);
          recording.setLive(null);
          console.log(`[engine] LIVE: ${thisDj} disconnected — automation resumed`);
        }
      });

      socket.on("error", () => {
        /* handled by close */
      });
    })();
  });

  // Safety: if a "live" DJ stops sending audio (but keeps the socket open),
  // drop live after 5 s of silence.
  const watchdog = setInterval(() => {
    if (playout.isLive && Date.now() - lastDataAt > 5000) {
      console.warn("[engine] live input silent — resuming automation");
      playout.setLiveMode(false);
      onDjChange(null);
      recording.setLive(null);
    }
  }, 2000);
  watchdog.unref();

  server.listen(config.livePort, "0.0.0.0", () => {
    console.log(`[engine] live WS listening on :${config.livePort}`);
  });

  return () => {
    clearInterval(watchdog);
    wss.close();
    server.close();
  };
}
