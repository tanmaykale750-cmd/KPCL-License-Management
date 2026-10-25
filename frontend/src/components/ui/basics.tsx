import { ArrowDownRight, ArrowUpRight, CircleAlert, Info, Minus, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export function Panel({
  title,
  sub,
  actions,
  children,
  footer,
  dark,
  className,
  flush,
  id,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  dark?: boolean;
  className?: string;
  flush?: boolean;
  id?: string;
}) {
  return (
    <section id={id} className={`panel${dark ? ' panel-dark' : ''}${className ? ` ${className}` : ''}`}>
      {(title || actions) && (
        <div className="panel-head">
          <div className="grow">
            {title && <h2>{title}</h2>}
            {sub && <div className="sub">{sub}</div>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      <div className={`panel-body${flush ? ' flush' : ''}`}>{children}</div>
      {footer && <div className="panel-foot">{footer}</div>}
    </section>
  );
}

export function Delta({ value, goodWhen, digits = 0, suffix = 'vs previous period' }: { value: number; goodWhen: 'up' | 'down'; digits?: number; suffix?: string }) {
  if (!isFinite(value)) return null;
  const flat = Math.abs(value) < 0.005;
  const up = value > 0;
  const good = flat ? null : (up && goodWhen === 'up') || (!up && goodWhen === 'down');
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  const pct = `${up ? '+' : flat ? '' : '−'}${Math.abs(value * 100).toFixed(digits)}%`;
  return (
    <span className="row" style={{ gap: 6 }}>
      <span className={`delta ${flat ? 'flat' : good ? 'good' : 'bad'}`}>
        <Icon aria-hidden />
        {pct}
      </span>
      <span>{suffix}</span>
    </span>
  );
}

export function Callout({ tone = 'info', icon: Icon = tone === 'warn' ? CircleAlert : Info, children }: { tone?: 'info' | 'warn' | 'ok' | 'teal'; icon?: LucideIcon; children: ReactNode }) {
  return (
    <div className={`callout ${tone}`}>
      <Icon aria-hidden />
      <div className="grow">{children}</div>
    </div>
  );
}

export function Field({ label, hint, error, children, full, htmlFor }: { label: string; hint?: string; error?: string; children: ReactNode; full?: boolean; htmlFor?: string }) {
  return (
    <div className={`field${error ? ' invalid' : ''}${full ? ' full' : ''}`}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? (
        <span className="error" role="alert">
          <CircleAlert size={12} aria-hidden />
          {error}
        </span>
      ) : (
        hint && <span className="hint">{hint}</span>
      )}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: ReactNode; count?: number; hidden?: boolean }[]; value: T; onChange: (t: T) => void; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs
        .filter((t) => !t.hidden)
        .map((t) => (
          <button key={t.id} role="tab" className="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}>
            {t.label}
            {t.count !== undefined && <span className="count">{t.count}</span>}
          </button>
        ))}
    </div>
  );
}

export function PageHead({ title, sub, actions }: { title: string; sub: string; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="page-title">
        <h1>{title}</h1>
        <p>{sub}</p>
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function SectionLabel({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="section-label">
      <h2>{children}</h2>
      {actions}
    </div>
  );
}

export function MiniBar({ value, max = 1, marker }: { value: number; max?: number; marker?: number }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <span className="mini-bar" aria-hidden>
      <span style={{ width: `${pct}%` }} />
      {marker !== undefined && <em style={{ left: `${Math.min(100, (marker / max) * 100)}%` }} />}
    </span>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children}
      {action && <div style={{ marginTop: 10 }}>{action}</div>}
    </div>
  );
}
