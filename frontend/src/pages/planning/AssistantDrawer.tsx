import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Assistant } from './Assistant';

/**
 * Floating chat panel for the planning assistant, anchored above the bottom-right launcher.
 * It stays mounted while hidden so the conversation is kept between open and close.
 */
export default function AssistantDrawer({ open, onClose, initialQuestion }: { open: boolean; onClose: () => void; initialQuestion?: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);
  return createPortal(
    <div
      ref={ref}
      id="assistant-panel"
      className="chat-panel"
      role="dialog"
      aria-modal="false"
      aria-label="Planning assistant"
      tabIndex={-1}
      hidden={!open}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="drawer-head">
        <div className="grow">
          <div className="eyebrow">RAG · live forecast, simulation and recommendation engine</div>
          <h2>Planning assistant</h2>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close planning assistant">
          <X />
        </button>
      </div>
      <div className="drawer-body">
        <Assistant initialQuestion={initialQuestion} />
      </div>
    </div>,
    document.body,
  );
}
