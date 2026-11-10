import { useState } from "react";
import { api } from "../api";
import { Badge, Button, Card, Empty, PageHead, Select, Spinner, useFetch } from "../components/ui";
import type { RequestEntry } from "@airshift/shared";

export function Requests() {
  const [filter, setFilter] = useState("pending");
  const { data, loading, reload } = useFetch(() => api<{ requests: RequestEntry[] }>(`/requests?status=${filter}`), [filter]);

  const act = async (id: string, status: "approved" | "rejected") => {
    await api(`/requests/${id}`, { method: "PATCH", body: { status } });
    reload();
  };

  const del = async (id: string) => {
    await api(`/requests/${id}`, { method: "DELETE" });
    reload();
  };

  return (
    <>
      <PageHead
        title="Listener Requests"
        sub="Approve a request and the scheduler plays it on air — usually within the next few tracks"
        actions={
          <Select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="played">Played</option>
            <option value="all">All</option>
          </Select>
        }
      />
      {loading ? <Spinner /> : null}
      {!loading && data && data.requests.length === 0 ? <Card><Empty>Nothing here. The request box widget lets listeners ask for songs — approve them here.</Empty></Card> : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {data?.requests.map((r) => (
          <Card key={r.id}>
            <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
              <div>
                <strong>🎵 {r.songQuery}</strong>
                {r.listenerName ? <span className="muted"> · from {r.listenerName}</span> : null}
                {r.message ? <div className="small muted">{r.message}</div> : null}
              </div>
              <div className="row">
                <Badge tone={r.status === "approved" ? "green" : r.status === "played" ? "blue" : r.status === "rejected" ? "red" : "amber"}>{r.status}</Badge>
                <span className="small muted">{new Date(r.createdAt).toLocaleString()}</span>
              </div>
            </div>
            {r.status === "pending" ? (
              <div className="row" style={{ marginTop: 10 }}>
                <Button className="btn-sm" variant="primary" onClick={() => void act(r.id, "approved")}>✓ Approve</Button>
                <Button className="btn-sm" onClick={() => void act(r.id, "rejected")}>✗ Reject</Button>
                <Button className="btn-sm btn-danger" onClick={() => void del(r.id)}>Delete</Button>
              </div>
            ) : null}
          </Card>
        ))}
      </div>
    </>
  );
}
