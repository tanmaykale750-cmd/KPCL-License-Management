import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

function useEscape(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
}

function useFocusOnOpen() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => prev?.focus?.();
  }, []);
  return ref;
}

export function Drawer({
  title,
  eyebrow,
  onClose,
  children,
  footer,
  wide,
  aside,
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  aside?: ReactNode;
}) {
  useEscape(onClose);
  const ref = useFocusOnOpen();
  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <div ref={ref} className={`drawer${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} tabIndex={-1}>
        <div className="drawer-head">
          <div className="grow">
            {eyebrow && <div className="eyebrow">{eyebrow}</div>}
            <h2>{title}</h2>
            {aside}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </div>
    </>,
    document.body,
  );
}

export function Dialog({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  useEscape(onClose);
  const ref = useFocusOnOpen();
  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className="dialog-body">
          <h2>{title}</h2>
          {children}
        </div>
        <div className="drawer-foot">{footer}</div>
      </div>
    </>,
    document.body,
  );
}
