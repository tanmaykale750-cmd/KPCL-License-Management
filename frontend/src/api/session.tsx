import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Field } from '../components/ui/basics';
import { ApiError, currentUser, fetchDemoAccounts, signIn, type DemoAccount, type SessionUser } from './client';

const SessionCtx = createContext<SessionUser | null>(null);

/** The signed-in employee (server-verified). Only rendered inside AuthGate, so never null there. */
export function useSession(): SessionUser {
  return useContext(SessionCtx)!;
}

export function useSessionOptional(): SessionUser | null {
  return useContext(SessionCtx);
}

/** Shows the employee sign-in until the API has verified the employee record. */
export function AuthGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    currentUser().then((u) => {
      setUser(u);
      setChecking(false);
    });
  }, []);
  if (checking) return <div className="empty">Checking session…</div>;
  if (!user) return <SignInPage onSignedIn={setUser} />;
  return <SessionCtx.Provider value={user}>{children}</SessionCtx.Provider>;
}

const PROFILES: { label: string; what: string }[] = [
  { label: 'Admin (Head)', what: 'Everything: all departments, projects, licences and costs' },
  { label: 'Department Head', what: "Their department's access, seats and approvals" },
  { label: 'Project Head', what: "Their projects' timelines, demand and team access" },
  { label: 'Engineer', what: 'Their licences, availability and requests' },
];

function SignInPage({ onSignedIn }: { onSignedIn: (u: SessionUser) => void }) {
  const [id, setId] = useState('');
  const [email, setEmail] = useState('');
  const [designation, setDesignation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState<DemoAccount[]>([]);
  useEffect(() => {
    fetchDemoAccounts().then(setDemo).catch(() => setDemo([]));
  }, []);
  const use = (a: DemoAccount) => {
    setId(a.employee_id);
    setEmail(a.email);
    setDesignation(a.designation);
    setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await signIn(id.trim(), email.trim(), designation.trim()));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <section className="panel" style={{ width: 'min(420px, 100%)' }}>
        <div className="panel-head">
          <div className="grow">
            <h2>Sign in</h2>
            <div className="sub">Engineering Licence Intelligence · KPCL. Your access is set by your employee record.</div>
          </div>
        </div>
        <form className="panel-body stack-lg" onSubmit={submit}>
          <Field label="Employee ID" htmlFor="si-id">
            <input id="si-id" className="input" autoComplete="username" value={id} onChange={(e) => setId(e.target.value)} placeholder="EMP001" required />
          </Field>
          <Field label="Work email" htmlFor="si-email">
            <input id="si-email" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@kpcl.com" required />
          </Field>
          <Field label="Designation" hint="Exactly as in your HR record, e.g. Senior Mechanical Engineer" error={error ?? undefined} htmlFor="si-des">
            <input id="si-des" className="input" value={designation} onChange={(e) => setDesignation(e.target.value)} required />
          </Field>
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'Verifying…' : 'Sign in'}
          </button>
        </form>
        <div className="panel-body" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="label-caps" style={{ marginBottom: 6 }}>
            Four profiles
          </div>
          <ul className="small" style={{ margin: '0 0 10px', paddingLeft: 16 }}>
            {PROFILES.map((p) => (
              <li key={p.label}>
                <b>{p.label}</b> — {p.what}
              </li>
            ))}
          </ul>
          {demo.length > 0 && (
            <>
              <div className="label-caps" style={{ marginBottom: 6 }}>
                Demo sign-ins (prototype · from employees.xlsx)
              </div>
              <div className="stack" style={{ gap: 4 }}>
                {demo.map((a) => (
                  <button key={a.employee_id} type="button" className="suggest" onClick={() => use(a)} title={`${a.email} · ${a.designation}`}>
                    <span>
                      <b style={{ fontWeight: 600 }}>{a.profile_label}</b> · {a.name} <span className="muted small">({a.employee_id}, {a.department})</span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
