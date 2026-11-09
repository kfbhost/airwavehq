import { useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes, type CSSProperties } from "react";

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "danger" | "ghost" }) {
  const { variant, className = "", ...rest } = props;
  return <button className={`btn ${variant === "primary" ? "btn-primary" : variant === "danger" ? "btn-danger" : variant === "ghost" ? "btn-ghost" : ""} ${className}`} {...rest} />;
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} />;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  className = "",
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal ${className}`.trim()} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-actions modal-footer">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Badge({ tone = "default", children }: { tone?: "default" | "green" | "amber" | "red" | "blue" | "live"; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Card({
  title,
  sub,
  actions,
  children,
  style,
  className = "",
}: {
  title?: string;
  sub?: string;
  actions?: ReactNode;
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <div className={`card ${className}`.trim()} style={style}>
      {title ? (
        <div className="card-head">
          <div className="card-head-copy">
            <strong className="card-title">{title}</strong>
            {sub ? <div className="card-sub">{sub}</div> : null}
          </div>
          {actions ? <div className="card-actions">{actions}</div> : null}
        </div>
      ) : null}
      <div className="card-body">{children}</div>
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  className = "",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`stat ${className}`.trim()}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub ? <div className="small muted" style={{ marginTop: 4 }}>{sub}</div> : null}
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** Circular avatar: shows the user's picture, or their initials as a fallback. */
export function UserAvatar({
  name,
  avatarPath,
  src,
  size = 40,
  className = "",
}: {
  name: string;
  avatarPath?: string | null;
  src?: string | null;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const url =
    src ??
    (avatarPath ? `/media/${encodeURIComponent(avatarPath.split(/[\\/]/).pop() ?? "")}` : null);
  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?";
  if (url && !failed) {
    return (
      <img
        className={`user-avatar ${className}`}
        src={url}
        alt={name}
        style={{ width: size, height: size }}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      className={`user-avatar user-avatar-initials ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}

export function PageHead({ title, sub, actions }: { title: string; sub?: string; actions?: ReactNode }) {  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub ? <div className="sub">{sub}</div> : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </div>
  );
}

import { useEffect, useRef } from "react";

export function useFetch<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fnRef.current()
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = () => setTick((t) => t + 1);
  return { data, loading, error, reload };
}
