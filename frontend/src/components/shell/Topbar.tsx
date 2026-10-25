import { Bell, ChevronDown, Database, LogOut, RotateCcw, Search, UserRound } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PERSONAS } from '../../data/people';
import { useNotifications } from '../../hooks/useNotifications';
import { fmtDateTime } from '../../lib/dates';
import { getServices } from '../../data/services';
import { useApp } from '../../state/store';
import { PERMISSIONS } from '../../state/roles';
import { KEY_USERS } from '../../data/people';
import type { RoleId } from '../../domain/types';
import { useSessionOptional } from '../../api/session';
import { signOut } from '../../api/client';
import { scopeText } from '../../lib/scope';

function useOutside(ref: React.RefObject<HTMLElement | null>, onOut: () => void) {
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOut();
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [ref, onOut]);
}

interface Hit {
  group: string;
  id: string;
  label: string;
  sub: string;
  to: string;
}

function GlobalSearch() {
  const { ds, state, perms } = useApp();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false));

  const hits = useMemo<Hit[]>(() => {
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    const out: Hit[] = [];
    const m = (...xs: string[]) => xs.some((x) => x.toLowerCase().includes(s));
    if (perms.areas.includes('software'))
      ds.licences.filter((l) => m(l.product, l.id, l.feature, l.contractRef, l.poRef)).forEach((l) => out.push({ group: 'Software', id: l.id, label: l.product, sub: `${l.id} · ${l.feature}`, to: `/software?open=${l.id}` }));
    if (perms.areas.includes('projects'))
      ds.projects
        .filter((p) => (perms.projectScope ? perms.projectScope.includes(p.id) : true) && m(p.name, p.code, p.shortName))
        .forEach((p) => out.push({ group: 'Projects', id: p.id, label: p.name, sub: `${p.code} · ${p.ownerDeptName}`, to: `/projects?open=${p.id}` }));
    if (perms.seesIndividuals && perms.areas.includes('software'))
      ds.users.filter((u) => (!perms.deptScope || u.deptId === perms.deptScope) && m(u.name, u.username)).slice(0, 6).forEach((u) => out.push({ group: 'People', id: u.id, label: u.name, sub: `${u.username} · ${u.team}`, to: `/software?user=${u.id}` }));
    if (perms.areas.includes('requests'))
      state.requests.filter((r) => m(r.id, r.justification)).forEach((r) => out.push({ group: 'Access requests', id: r.id, label: r.id, sub: r.justification.slice(0, 60), to: `/access-requests?open=${r.id}` }));
    if (perms.areas.includes('registry'))
      state.recommendations.filter((r) => m(r.id, r.title)).forEach((r) => out.push({ group: 'Recommendations', id: r.id, label: r.id, sub: r.title, to: `/registry?tab=approvals&open=${r.id}` }));
    if (perms.areas.includes('review'))
      state.review.filter((r) => m(r.id, r.title, r.poRef ?? '')).forEach((r) => out.push({ group: 'Review records', id: r.id, label: r.id, sub: r.title, to: `/review?open=${r.id}` }));
    if (perms.areas.includes('services'))
      getServices()
        .filter((svc) => (!perms.deptScope || svc.deptId === perms.deptScope) && m(svc.name, svc.provider, svc.id, ...svc.keys.map((k) => k.masked)))
        .forEach((svc) => out.push({ group: 'Other services', id: svc.id, label: svc.name, sub: `${svc.provider} · ${svc.id}`, to: `/other-services?open=${svc.id}` }));
    if (perms.areas.includes('vendors')) ds.vendors.filter((v) => m(v.name)).forEach((v) => out.push({ group: 'Vendors', id: v.id, label: v.name, sub: v.accountManager, to: `/vendors?open=${v.id}` }));
    return out.slice(0, 14);
  }, [q, ds, state, perms]);

  const go = (h: Hit) => {
    setOpen(false);
    setQ('');
    nav(h.to);
  };

  return (
    <div className="search" ref={ref}>
      <Search aria-hidden />
      <input
        type="search"
        aria-label="Search software, projects, people and records"
        placeholder="Search software, projects, users…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, hits.length - 1));
          if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
          if (e.key === 'Enter' && hits[active]) go(hits[active]);
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && q.trim().length >= 2 && (
        <div className="search-results" role="listbox">
          {hits.length === 0 && <div className="empty">No matches within your role's scope.</div>}
          {hits.map((h, i) => (
            <div key={`${h.group}-${h.id}`}>
              {(i === 0 || hits[i - 1].group !== h.group) && <div className="group label-caps">{h.group}</div>}
              <button className={`search-hit${i === active ? ' active' : ''}`} onClick={() => go(h)} role="option" aria-selected={i === active}>
                <span className="grow">
                  <b style={{ fontWeight: 600 }}>{h.label}</b>
                  <span className="sub muted small" style={{ display: 'block' }}>
                    {h.sub}
                  </span>
                </span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const { items, unread } = useNotifications();
  const { actions, state } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false));
  const nav = useNavigate();
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="icon-btn" aria-label={`Notifications, ${unread} unread`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Bell />
        {unread > 0 && <span className="badge-dot">{unread}</span>}
      </button>
      {open && (
        <div className="menu" style={{ width: 400 }}>
          <div className="menu-head row-between">
            <span className="label-caps">Alerts for your role</span>
            <button className="link-btn small" onClick={() => actions.markNotificationsRead(items.map((i) => i.id))}>
              Mark all read
            </button>
          </div>
          <div style={{ maxHeight: 420, overflowY: 'auto' }}>
            {items.length === 0 && <div className="empty">Nothing needs your attention.</div>}
            {items.map((n) => {
              const unreadItem = !state.readNotifications.includes(n.id);
              return (
                <button
                  key={n.id}
                  className="menu-item"
                  onClick={() => {
                    actions.markNotificationsRead([n.id]);
                    setOpen(false);
                    nav(n.link);
                  }}
                >
                  <span
                    aria-hidden
                    style={{ width: 8, height: 8, marginTop: 5, borderRadius: 4, flex: 'none', background: n.severity === 'crit' ? 'var(--crit)' : n.severity === 'warn' ? 'var(--warn)' : 'var(--info)', opacity: unreadItem ? 1 : 0.25 }}
                  />
                  <span className="grow">
                    <b style={{ fontWeight: unreadItem ? 600 : 500, display: 'block' }}>{n.title}</b>
                    <span className="muted small">{n.detail}</span>
                    <span className="mono muted" style={{ display: 'block', fontSize: 10.5, marginTop: 2 }}>
                      {n.kind} · {fmtDateTime(n.at)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="menu-sep" />
          <div className="small muted" style={{ padding: '2px 14px 6px' }}>
            In production these also go by email or Microsoft Teams. Not connected in this prototype.
          </div>
        </div>
      )}
    </div>
  );
}

function RoleMenu() {
  const { state, actions, me } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  useOutside(ref, () => setOpen(false));
  const initials = me.name
    .split(' ')
    .map((x) => x[0])
    .slice(0, 2)
    .join('');
  const persona = PERSONAS.find((p) => p.role === state.role)!;
  const session = useSessionOptional();
  const pick = (role: RoleId) => {
    actions.setRole(role);
    setOpen(false);
    nav(PERMISSIONS[role].landing);
  };
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="user-menu" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="avatar">{initials}</span>
        <span className="who">
          <b>{me.name}</b>
          <span>{session?.profile_label ?? persona.roleLabel}</span>
        </span>
        <ChevronDown size={14} className="muted" />
      </button>
      {open && (
        <div className="menu" role="menu" style={{ width: 330 }}>
          <div className="menu-head">
            <div className="label-caps">Signed in</div>
            <div className="small muted" style={{ marginTop: 3 }}>
              {session ? `${session.name} · ${session.employee_id} · ${session.designation} · ${session.department}.` : ''}
            </div>
          </div>
          {session ? (
            <div className="menu-item" role="note" style={{ cursor: 'default' }}>
              <UserRound aria-hidden />
              <span className="grow">
                <b style={{ fontWeight: 600 }}>{session.profile_label}</b>
                <span className="muted small" style={{ display: 'block' }}>
                  Scope: {scopeText(session.scope.level, session.department, session.scope.projects)}. {session.profile_summary}
                </span>
              </span>
            </div>
          ) : (
            PERSONAS.map((p) => {
              const u = KEY_USERS.find((x) => x.id === p.userId)!;
              return (
                <button key={p.role} className="menu-item" role="menuitemradio" aria-checked={p.role === state.role} onClick={() => pick(p.role)}>
                  <UserRound aria-hidden />
                  <span className="grow">
                    <b style={{ fontWeight: 600 }}>{p.roleLabel}</b>
                    <span className="muted small" style={{ display: 'block' }}>
                      {u.name} · {p.scopeLabel}
                    </span>
                  </span>
                </button>
              );
            })
          )}
          <div className="menu-sep" />
          <button
            className="menu-item"
            onClick={() => {
              setOpen(false);
              actions.reset();
            }}
          >
            <RotateCcw aria-hidden />
            <span className="grow">
              <b style={{ fontWeight: 600 }}>Reset to sample data</b>
              <span className="muted small" style={{ display: 'block' }}>
                Clears requests, approvals, scenarios and imports made in this browser.
              </span>
            </span>
          </button>
          <button className="menu-item" onClick={() => signOut()}>
            <LogOut aria-hidden />
            <span className="grow">
              <b style={{ fontWeight: 600 }}>Sign out</b>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

export function Topbar() {
  return (
    <header className="topbar">
      <GlobalSearch />
      <div className="spacer" />
      <span className="sample-badge" title="All figures, names, contracts and invoices are synthetic demonstration data. No KPCL system is connected.">
        <Database size={13} aria-hidden />
        Sample data
      </span>
      <div className="spacer" />
      <Notifications />
      <RoleMenu />
    </header>
  );
}
