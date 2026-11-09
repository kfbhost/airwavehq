import { useEffect, useState } from "react";
import { api } from "../api";
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHead, Select, Spinner, useFetch } from "../components/ui";
import type { AdCampaign, Track } from "@radiohost/shared";
import { BREAK_NAMES } from "@radiohost/shared";

interface CampaignRow extends AdCampaign {
  summary: {
    days: number; daysElapsed: number; expectedSpots: number; booked: number;
    delivered: number; behind: number; valueDelivered: number; totalValue: number; currency: string;
  };
}

export function Campaigns() {
  const { data, loading, reload } = useFetch(() => api<{ campaigns: CampaignRow[] }>("/campaigns"));
  const [open, setOpen] = useState<CampaignRow | null>(null);

  return (
    <>
      <PageHead
        title="Ad Campaigns"
        sub="Book a sponsor, rotate the copy, and prove what went out"
        actions={<Button variant="primary" onClick={() => setOpen(blank())}>+ New campaign</Button>}
      />
      {loading ? <Spinner /> : null}
      {!loading && data && data.campaigns.length === 0 ? (
        <Card><Empty>No campaigns. Breaks at :15 and :45 are honoured every hour automatically — book a sponsor and the scheduler fills them.</Empty></Card>
      ) : null}
      <div className="grid grid-2">
        {data?.campaigns.map((c) => {
          const s = c.summary;
          const pct = s.expectedSpots > 0 ? Math.round((s.delivered / s.expectedSpots) * 100) : 0;
          return (
            <Card key={c.id} title={c.advertiser} actions={<Button className="btn-sm" onClick={() => setOpen(c)}>Open</Button>}>
              <div className="kv">
                <dt>Status</dt><dd><Badge tone={c.status === "active" ? "green" : c.status === "paused" ? "amber" : "default"}>{c.status}</Badge></dd>
                <dt>Schedule</dt><dd>{BREAK_NAMES[c.whenRule] ?? c.whenRule} · {c.spotsPerDay}/day</dd>
                <dt>Window</dt><dd>{c.startDate} → {c.endDate}</dd>
                <dt>Delivery</dt><dd>{s.delivered} of {s.expectedSpots} · {pct}%</dd>
                <dt>Value</dt><dd>{s.currency} {s.valueDelivered.toFixed(2)} / {s.totalValue.toFixed(2)}</dd>
              </div>
              {s.behind > 0 ? <div className="badge amber" style={{ marginTop: 10 }}>{s.behind} behind pace</div> : <div className="badge green" style={{ marginTop: 10 }}>On pace</div>}
            </Card>
          );
        })}
      </div>
      {open ? <CampaignEditor campaign={open} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); reload(); }} /> : null}
    </>
  );
}

const blank = (): CampaignRow =>
  ({
    id: "", advertiser: "", startDate: today(), endDate: inDays(14), spotsPerDay: 6, maxPerHour: 2,
    whenRule: "weekday_drivetime", customDays: [], ratePerSpot: 25, currency: "USD", audioTrackId: null,
    status: "draft", createdAt: "",
    summary: { days: 0, daysElapsed: 0, expectedSpots: 0, booked: 0, delivered: 0, behind: 0, valueDelivered: 0, totalValue: 0, currency: "USD" },
  }) as unknown as CampaignRow;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function inDays(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}

function CampaignEditor({ campaign, onClose, onSaved }: { campaign: CampaignRow; onClose: () => void; onSaved: () => void }) {
  const isNew = !campaign.id;
  const [advertiser, setAdvertiser] = useState(campaign.advertiser);
  const [startDate, setStartDate] = useState(campaign.startDate);
  const [endDate, setEndDate] = useState(campaign.endDate);
  const [spotsPerDay, setSpotsPerDay] = useState(campaign.spotsPerDay);
  const [maxPerHour, setMaxPerHour] = useState(campaign.maxPerHour);
  const [whenRule, setWhenRule] = useState(campaign.whenRule);
  const [ratePerSpot, setRatePerSpot] = useState(campaign.ratePerSpot);
  const [currency, setCurrency] = useState(campaign.currency);
  const [audioTrackId, setAudioTrackId] = useState(campaign.audioTrackId ?? "");
  const [status, setStatus] = useState<AdCampaign["status"]>(campaign.status);
  const [feas, setFeas] = useState<{ ok: boolean; reason?: string; feasiblePerDay?: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: tracks } = useFetch(() => api<{ tracks: Track[] }>("/tracks?kind=ad&pageSize=100"));

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        advertiser, startDate, endDate, spotsPerDay, maxPerHour, whenRule,
        customDays: whenRule === "custom" ? [1, 2, 3, 4, 5] : [],
        ratePerSpot, currency, audioTrackId: audioTrackId || null, status,
      };
      const res = await api<{ feasibility: typeof feas }>(
        isNew ? "/campaigns" : `/campaigns/${campaign.id}`,
        { method: isNew ? "POST" : "PATCH", body },
      );
      setFeas(res.feasibility);
      if (res.feasibility?.ok) onSaved();
      else alert(`Booking problem: ${res.feasibility?.reason}`);
    } finally {
      setBusy(false);
    }
  };

  const total = spotsPerDay * Math.max(0, Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000) + 1);

  return (
    <Modal open onClose={onClose} title={isNew ? "New campaign" : `Campaign — ${campaign.advertiser}`} footer={
      <>
        <Button variant="ghost" onClick={onClose}>Close</Button>
        <Button variant="primary" disabled={busy || !advertiser.trim()} onClick={() => void save()}>Save & check feasibility</Button>
      </>
    }>
      <div className="form-row">
        <Field label="Advertiser"><Input value={advertiser} onChange={(e) => setAdvertiser(e.target.value)} autoFocus /></Field>
        <Field label="Ad copy (audio track)">
          <Select value={audioTrackId} onChange={(e) => setAudioTrackId(e.target.value)}>
            <option value="">— none —</option>
            {tracks?.tracks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </Select>
        </Field>
      </div>
      <div className="form-row">
        <Field label="Start"><Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field>
        <Field label="End"><Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></Field>
        <Field label="Spots / day"><Input type="number" min={1} max={144} value={spotsPerDay} onChange={(e) => setSpotsPerDay(Number(e.target.value))} /></Field>
        <Field label="Max / hour"><Input type="number" min={1} max={24} value={maxPerHour} onChange={(e) => setMaxPerHour(Number(e.target.value))} /></Field>
      </div>
      <div className="form-row">
        <Field label="When">
          <Select value={whenRule} onChange={(e) => setWhenRule(e.target.value as AdCampaign["whenRule"])}>
            {Object.entries(BREAK_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="Rate / spot"><Input type="number" min={0} step={0.01} value={ratePerSpot} onChange={(e) => setRatePerSpot(Number(e.target.value))} /></Field>
        <Field label="Currency"><Input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} /></Field>
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as AdCampaign["status"])}>
            <option value="draft">Draft</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="completed">Completed</option>
          </Select>
        </Field>
      </div>
      {feas ? (
        feas.ok ? (
          <div className="badge green">Fits — up to {feas.feasiblePerDay} spots/day possible.</div>
        ) : (
          <div className="badge red">{feas.reason}</div>
        )
      ) : null}
      <div className="hint" style={{ marginTop: 10 }}>
        ~{total} airings booked across the window at {currency} {ratePerSpot.toFixed(2)} = {currency} {(total * ratePerSpot).toFixed(2)}.
        Caps hold: never the same advertiser twice in a row, per-hour ceilings enforced at booking time.
      </div>
    </Modal>
  );
}
