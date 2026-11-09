import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, setToken } from "../api";
import { Button, Field, Input } from "../components/ui";
import type { User } from "@radiohost/shared";

interface InviteInfo {
  valid: boolean;
  reason?: string;
  email?: string;
  role?: "admin" | "dj";
  stationName?: string;
}

export function AcceptInvite() {
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setInfo({ valid: false, reason: "This invite link is missing its token." });
      return;
    }
    api<InviteInfo>(`/invites/accept?token=${encodeURIComponent(token)}`)
      .then(setInfo)
      .catch(() => setInfo({ valid: false, reason: "We couldn't verify this invite link." }));
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ token: string; user: User }>("/invites/accept", {
        method: "POST",
        body: { token, name: name.trim(), password },
      });
      setToken(res.token);
      window.location.href = res.user.role === "dj" ? "/live" : "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not accept the invite.");
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <div style={{ textAlign: "center", marginBottom: 18 }}>
          <div className="logo" style={{ width: 44, height: 44, borderRadius: 12, fontSize: 22, margin: "0 auto 10px", background: "linear-gradient(135deg, var(--accent), var(--accent2))", display: "grid", placeItems: "center" }}>📻</div>
          <h2 style={{ margin: 0 }}>You're invited</h2>
          <div className="muted small">{info?.stationName ? `${info.stationName} · RadioHost Studio` : "RadioHost Studio"}</div>
        </div>

        {!info ? (
          <div style={{ textAlign: "center", padding: "12px 0" }}><span className="spinner" /></div>
        ) : !info.valid ? (
          <>
            <div className="badge red" style={{ display: "block", textAlign: "center", marginBottom: 14 }}>{info.reason}</div>
            <div style={{ textAlign: "center" }}>
              <Link className="small" to="/login">Go to sign in</Link>
            </div>
          </>
        ) : (
          <form onSubmit={submit}>
            <p className="muted small" style={{ textAlign: "center", marginTop: 0 }}>
              Accepting as <strong>{info.email}</strong> · {info.role === "admin" ? "Administrator" : "DJ"}
            </p>
            <Field label="Your name"><Input required value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Alex Smith" /></Field>
            <Field label="Choose a password" hint="At least 8 characters"><Input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
            <Field label="Confirm password"><Input type="password" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
            {error ? <div className="badge red" style={{ marginBottom: 12 }}>{error}</div> : null}
            <Button type="submit" variant="primary" style={{ width: "100%" }} disabled={busy}>
              {busy ? "Setting up…" : "Create account & sign in"}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
