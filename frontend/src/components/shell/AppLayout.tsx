import { Lock } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { useApp } from '../../state/store';
import type { Area } from '../../state/roles';
import { personaFor } from '../../state/roles';
import { useSessionOptional } from '../../api/session';
import chatIcon from '../../assets/ai-chat-icon.png';
import { Sidebar } from './Sidebar';
import { Toasts } from './Toasts';
import { Topbar } from './Topbar';

const AssistantDrawer = lazy(() => import('../../pages/planning/AssistantDrawer'));

export function AppLayout() {
  const { perms } = useApp();
  const session = useSessionOptional();
  const canChat = session ? session.scopes.includes('chat') : perms.areas.includes('planning');
  const [assistant, setAssistant] = useState(false);
  // Once opened, the assistant stays mounted (hidden when closed) so the conversation survives closing the panel.
  const [mounted, setMounted] = useState(false);
  const [initial, setInitial] = useState<string | null>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const h = (e: Event) => {
      setInitial((e as CustomEvent<string | null>).detail);
      setMounted(true);
      setAssistant(true);
    };
    window.addEventListener('kpcl:assistant', h);
    return () => window.removeEventListener('kpcl:assistant', h);
  }, []);
  const closeAssistant = () => {
    setAssistant(false);
    launcherRef.current?.focus();
  };
  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        <Topbar />
        <main className="content" id="main">
          <Outlet />
        </main>
      </div>
      <Toasts />
      {mounted && (
        <Suspense fallback={null}>
          <AssistantDrawer key={initial ?? 'open'} open={assistant} initialQuestion={initial} onClose={closeAssistant} />
        </Suspense>
      )}
      {canChat && (
        <button
          ref={launcherRef}
          type="button"
          className="chat-launcher"
          aria-label={assistant ? 'Close planning assistant' : 'Open planning assistant'}
          aria-expanded={assistant}
          aria-controls="assistant-panel"
          title="Assistant: ask why, what to do, options, next steps"
          onClick={() => {
            if (assistant) return setAssistant(false);
            setMounted(true);
            setAssistant(true);
          }}
        >
          <img src={chatIcon} alt="" width={160} height={160} draggable={false} />
        </button>
      )}
    </div>
  );
}

export function Guard({ area, children }: { area: Area; children: ReactNode }) {
  const { perms, state } = useApp();
  if (perms.areas.includes(area)) return <>{children}</>;
  const p = personaFor(state.role);
  return (
    <div className="restricted">
      <Lock aria-hidden />
      <h1 style={{ fontSize: 17 }}>Not available for the {p.roleLabel} profile</h1>
      <p className="muted" style={{ marginTop: 6 }}>
        This workspace is outside your profile ({p.roleLabel}: {p.scopeLabel.toLowerCase()}). Your profile comes from your employee record, and the API enforces the same limits on every request.
      </p>
      <p style={{ marginTop: 14 }}>
        <Link to={perms.landing}>Go to your start page</Link>
      </p>
    </div>
  );
}
