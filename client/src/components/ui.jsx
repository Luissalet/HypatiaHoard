import React, { useEffect } from "react";

export function Toast({ message, onClose }) {
  useEffect(() => {
    if (!message) return undefined;
    const timer = setTimeout(onClose, 4000);
    return () => clearTimeout(timer);
  }, [message, onClose]);
  if (!message) return null;
  return (
    <div className="toast" role="status">
      {message} <button type="button" className="ml-3 underline" onClick={onClose}>Cerrar</button>
    </div>
  );
}

export function Switch({ checked, onChange, label }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)} />;
}

export function Empty({ title, children, action }) {
  return (
    <div className="rounded-lg border border-dashed p-8 text-center" style={{ borderColor: "var(--field-line)" }}>
      <p className="font-semibold">{title}</p>
      <p className="help mt-1">{children}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, description, children }) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[26px] font-semibold leading-tight md:text-[30px]">{title}</h1>
        {description && <p className="help mt-1 max-w-[70ch]">{description}</p>}
      </div>
      {children}
    </header>
  );
}

export function Chip({ className, children }) {
  return <span className={`chip ${className || ""}`}>{children}</span>;
}

export function ProgressBar({ pct }) {
  return (
    <div className="bar" aria-hidden="true">
      <span style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

export function StatTile({ label, value, hint }) {
  return (
    <div className="stat-tile">
      <div className="help">{label}</div>
      <div className="stat-number num">{value}</div>
      {hint && <div className="help mt-1">{hint}</div>}
    </div>
  );
}
