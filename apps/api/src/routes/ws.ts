import type { FastifyInstance } from "fastify";
import { verifyToken } from "../auth.js";
import { snapshot, subscribe } from "../services/engineState.js";
import { refreshProgramming } from "../services/programmingRefresh.js";

export function wsRoutes(app: FastifyInstance): void {
  app.get("/ws/dashboard", { websocket: true }, async (socket, req) => {
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");
    if (!token || !(await verifyToken(token))) {
      socket.close(4001, "Unauthorized");
      return;
    }

    // Make sure the source labels reflect now, not the engine's last fetch-ahead.
    await refreshProgramming();
    socket.send(JSON.stringify({ type: "init", ...snapshot() }));
    const unsub = subscribe((msg) => {
      if (socket.readyState === socket.OPEN) socket.send(msg);
    });

    const heartbeat = setInterval(() => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: "status", ...snapshot() }));
      }
    }, 5000);

    socket.on("close", () => {
      clearInterval(heartbeat);
      unsub();
    });
  });
}
