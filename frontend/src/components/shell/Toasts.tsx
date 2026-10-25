import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { useApp } from '../../state/store';

export function Toasts() {
  const { toasts, dismissToast } = useApp();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => {
        const Icon = t.tone === 'ok' ? CircleCheck : t.tone === 'info' ? Info : CircleAlert;
        return (
          <div key={t.id} className={`toast ${t.tone}`}>
            <Icon aria-hidden style={{ color: t.tone === 'ok' ? 'var(--ok)' : t.tone === 'info' ? 'var(--info)' : t.tone === 'warn' ? 'var(--warn)' : 'var(--crit)' }} />
            <span className="grow">{t.text}</span>
            <button className="icon-btn" style={{ width: 22, height: 22 }} aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
