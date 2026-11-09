import { useEffect, useRef, useState } from "react";
import { getToken } from "./api";
import type { EngineStatus } from "@radiohost/shared";

export interface StatusSnapshot {
  status: EngineStatus;
  show: { id: string | null; name: string | null } | null;
  currentItemStartedAt: string | null;
  programming: {
    mode: "rundown" | "clockwheel" | "playlist" | "idle";
    automationSource: "show" | "rotation" | "default" | "idle";
    playlistId: string | null;
    playlistName: string | null;
    clockwheelId: string | null;
    clockwheelName: string | null;
    stationRotationId: string | null;
    stationRotationName: string | null;
    next: {
      atMs: number | null;
      mode: "rundown" | "clockwheel" | "playlist" | "idle";
      automationSource: "show" | "rotation" | "default" | "idle";
      showName: string | null;
      playlistName: string | null;
      clockwheelName: string | null;
      stationRotationName: string | null;
    } | null;
  } | null;
}

/** Connects to the dashboard status websocket and keeps the latest snapshot. */
export function useStatus(): StatusSnapshot | null {
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      const token = getToken();
      if (!token) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws/dashboard?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.type === "init") {
            setSnapshot({ status: msg.status, show: msg.show, programming: msg.programming ?? null, currentItemStartedAt: msg.currentItemStartedAt ?? null });
          } else if (msg.type === "status") {
            setSnapshot((prev) => ({
              status: msg.status,
              show: msg.show ?? prev?.show ?? null,
              programming: msg.programming ?? prev?.programming ?? null,
              currentItemStartedAt: msg.currentItemStartedAt ?? prev?.currentItemStartedAt ?? null,
            }));
          } else if (msg.type === "show") {
            setSnapshot((prev) => (prev ? { ...prev, show: msg.show } : prev));
          } else if (msg.type === "programming") {
            setSnapshot((prev) => (prev ? { ...prev, programming: msg.programming } : prev));
          } else if (msg.type === "current-item-started") {
            setSnapshot((prev) => (prev ? { ...prev, currentItemStartedAt: msg.currentItemStartedAt ?? null } : prev));
          }
        } catch {
          /* ignore malformed */
        }
      };
      ws.onclose = () => {
        if (!closed) retry = setTimeout(connect, 3000);
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  return snapshot;
}
