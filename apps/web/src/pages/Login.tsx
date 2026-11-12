import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, setToken } from "../api";
import { Button, Field, Input } from "../components/ui";
import type { User } from "@airwavehq/shared";

function useAuth(onDone: (u: User) => void) {
  const nav = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (path: string, body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ token: string; user: User }>(path, { method: "POST", body });
      setToken(res.token);
      onDone(res.user);
      nav(res.user.role === "dj" ? "/studio" : "/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, submit };
}

export function Login({ onDone }: { onDone: (u: User) => void }) {
  const { error, busy, submit } = useAuth(onDone);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const go = (e: FormEvent) => {
    e.preventDefault();
    void submit("/auth/login", { email, password });
  };

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <div style={{ textAlign: "center", marginBottom: 18 }}>
          <div className="logo" style={{ width: 44, height: 44, borderRadius: 12, fontSize: 22, margin: "0 auto 10px", background: "linear-gradient(135deg, var(--accent), var(--accent2))", display: "grid", placeItems: "center" }}>📻</div>
          <h2 style={{ margin: 0 }}>AirwaveHQ</h2>
          <div className="muted small">Sign in to your station</div>
        </div>
        <form onSubmit={go}>
          <Field label="Email">
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </Field>
          <Field label="Password">
            <Input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {error ? <div className="badge red" style={{ marginBottom: 12 }}>{error}</div> : null}
          <Button type="submit" variant="primary" style={{ width: "100%" }} disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <div className="row wrap" style={{ justifyContent: "center", marginTop: 14 }}>
          <Link className="small" to="/register">First run? Create account</Link>
          <span className="muted small">·</span>
          <Link className="small" to="/dj">DJ sign-in</Link>
        </div>
      </div>
    </div>
  );
}

export function Register({ onDone }: { onDone: (u: User) => void }) {
  const { error, busy, submit } = useAuth(onDone);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");

  const go = (e: FormEvent) => {
    e.preventDefault();
    void submit("/auth/register", { email, name, password });
  };

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <h2 style={{ textAlign: "center", marginTop: 0 }}>Create your station</h2>
        <form onSubmit={go}>
          <Field label="Your name"><Input required value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
          <Field label="Email"><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Password" hint="At least 8 characters"><Input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          {error ? <div className="badge red" style={{ marginBottom: 12 }}>{error}</div> : null}
          <Button type="submit" variant="primary" style={{ width: "100%" }} disabled={busy}>
            {busy ? "Creating…" : "Create account"}
          </Button>
        </form>
        <div style={{ textAlign: "center", marginTop: 14 }}>
          <Link className="small" to="/login">Back to sign in</Link>
        </div>
      </div>
    </div>
  );
}

export function DjLogin({ onDone }: { onDone: (u: User) => void }) {
  const { error, busy, submit } = useAuth(onDone);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");

  const go = (e: FormEvent) => {
    e.preventDefault();
    void submit("/auth/dj-login", { email, code });
  };

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <h2 style={{ textAlign: "center", marginTop: 0 }}>DJ sign-in</h2>
        <p className="muted small" style={{ textAlign: "center" }}>
          Enter the email your station invited, plus your 6-digit code.
        </p>
        <form onSubmit={go}>
          <Field label="Email"><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></Field>
          <Field label="Access code"><Input required inputMode="numeric" pattern="\d{6}" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
          {error ? <div className="badge red" style={{ marginBottom: 12 }}>{error}</div> : null}
          <Button type="submit" variant="primary" style={{ width: "100%" }} disabled={busy}>
            {busy ? "Signing in…" : "Go live"}
          </Button>
        </form>
      </div>
    </div>
  );
}
