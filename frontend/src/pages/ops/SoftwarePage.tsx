import { Download, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DEFAULT_FILTERS, lastActiveBand, licenceRows } from '../../calc/metrics';
import { renewalAdvice } from '../../calc/plan';
import { EditLicenceDialog } from '../../components/records/EditLicenceDialog';
import { SoftwareDrawer } from '../../components/records/SoftwareDrawer';
import { DataTable } from '../../components/ui/DataTable';
import { Drawer } from '../../components/ui/Overlay';
import { StatusChip, UtilChip } from '../../components/ui/StatusChip';
import { Callout, MiniBar, PageHead, Panel, Tabs } from '../../components/ui/basics';
import type { Licence } from '../../domain/types';
import { downloadCSV } from '../../lib/csv';
import { daysBetween, DEMO_TODAY, fmtDate } from '../../lib/dates';
import { hours, inrShort, num, pct } from '../../lib/format';
import { scopedFilters, useApp } from '../../state/store';

type View = 'software' | 'users' | 'renewals';

function UserDrawer({ userId, onClose, onOpenLicence }: { userId: string; onClose: () => void; onOpenLicence: (id: string) => void }) {
  const { ds } = useApp();
  const u = ds.users.find((x) => x.id === userId);
  if (!u) return null;
  const rows = ds.userUsage.filter((x) => x.userId === userId);
  const named = ds.assignments.filter((a) => a.userId === userId);
  return (
    <Drawer eyebrow={`${u.username} · ${u.team}`} title={u.name} onClose={onClose}>
      <Callout icon={ShieldCheck}>Individual usage is shown to licence administrators and project leaders only, to free idle seats — not to measure performance.</Callout>
      <div className="block">
        <h3>Tools used in the last 12 months</h3>
        <table className="table table-compact">
          <thead>
            <tr>
              <th>Software</th>
              <th className="num">Active</th>
              <th className="num">Idle check-out</th>
              <th className="num">Denied</th>
              <th>Last active</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const l = ds.licences.find((x) => x.id === r.licenceId)!;
              return (
                <tr key={r.licenceId} className="ink-row" onClick={() => onOpenLicence(l.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpenLicence(l.id)}>
                  <td>
                    {l.product}
                    <span className="sub mono">{l.id}</span>
                  </td>
                  <td className="num">{hours(r.activeHours12m)}</td>
                  <td className="num">{hours(r.idleHours12m)}</td>
                  <td className="num">{r.denials12m}</td>
                  <td className="nowrap">{fmtDate(r.lastActive)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {named.length > 0 && (
        <div className="block">
          <h3>Named seats held</h3>
          {named.map((a) => {
            const l = ds.licences.find((x) => x.id === a.licenceId)!;
            const band = lastActiveBand(a.lastActive);
            return (
              <div key={a.licenceId} className="row-between small" style={{ padding: '6px 0', borderTop: '1px solid var(--border)' }}>
                <span>
                  {l.product} · since {fmtDate(a.assignedOn)}
                </span>
                {band === 'Active' ? <StatusChip status="healthy">Active</StatusChip> : <StatusChip status="underused">Unused {band}</StatusChip>}
              </div>
            );
          })}
        </div>
      )}
    </Drawer>
  );
}

export default function SoftwarePage() {
  const { ds, perms } = useApp();
  const [params, setParams] = useSearchParams();
  const asked = ((params.get('view') as View) || 'software') as View;
  const view: View = asked === 'users' && !perms.seesIndividuals ? 'software' : asked;
  const openId = params.get('open');
  const userId = params.get('user');
  const [months, setMonths] = useState<3 | 6 | 12>(12);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Licence | null>(null);
  const filters = scopedFilters({ ...DEFAULT_FILTERS, months }, perms);
  const rows = useMemo(() => licenceRows(ds, filters), [ds, filters.months, filters.deptId]); // eslint-disable-line react-hooks/exhaustive-deps
  const ql = q.trim().toLowerCase();
  const shown = rows.filter((r) => !ql || `${r.licence.product} ${r.licence.id} ${r.licence.feature}`.toLowerCase().includes(ql));

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };

  const userRows = useMemo(() => {
    if (!perms.seesIndividuals) return [];
    return ds.users
      .filter((u) => !perms.deptScope || u.deptId === perms.deptScope)
      .map((u) => {
        const us = ds.userUsage.filter((x) => x.userId === u.id);
        const active = us.reduce((a, x) => a + x.activeHours12m, 0);
        const idle = us.reduce((a, x) => a + x.idleHours12m, 0);
        const last = us.reduce((m, x) => (x.lastActive > m ? x.lastActive : m), '2000-01-01');
        return { u, tools: us.length, active, idle, idleShare: active + idle ? idle / (active + idle) : 0, last, denials: us.reduce((a, x) => a + x.denials12m, 0) };
      })
      .filter((r) => r.tools > 0 && (!ql || `${r.u.name} ${r.u.username} ${r.u.team}`.toLowerCase().includes(ql)));
  }, [ds, perms.seesIndividuals, perms.deptScope, ql]);

  const renewals = rows
    .filter((r) => r.daysToRenewal >= 0 && r.daysToRenewal <= 365)
    .sort((a, b) => a.daysToRenewal - b.daysToRenewal)
    .map((r) => ({ ...r, advice: renewalAdvice(ds, r.licence.id) }));

  const exportCsv = () =>
    downloadCSV(
      `software-${view}-sample.csv`,
      view === 'users'
        ? userRows.map((r) => ({ user: r.u.name, username: r.u.username, team: r.u.team, tools: r.tools, active_hours_12m: r.active, idle_hours_12m: r.idle, last_active: r.last }))
        : shown.map((r) => ({ id: r.licence.id, product: r.licence.product, type: r.licence.type, seats: r.seats, utilisation_pct: Math.round(r.util * 100), ...(perms.seesCosts ? { annual_spend_inr: r.spend, idle_spend_inr: Math.round(r.idleSpend) } : {}), denials: r.denials, renewal: r.licence.renewalDate })),
    );

  return (
    <>
      <PageHead
        title="Software"
        sub="Every licence pool with use, idle time, denials and renewal."
        actions={
          <>
            <input className="input" style={{ width: 240 }} placeholder={view === 'users' ? 'Search people or teams…' : 'Search software…'} aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} />
            <select className="select" aria-label="Period" value={months} onChange={(e) => setMonths(Number(e.target.value) as 3 | 6 | 12)}>
              <option value={3}>Last 3 months</option>
              <option value={6}>Last 6 months</option>
              <option value={12}>Last 12 months</option>
            </select>
            <button className="btn" onClick={exportCsv}>
              <Download /> Export
            </button>
          </>
        }
      />
      {perms.deptScope && <div className="scope-note">Showing your department’s share of each pool.</div>}
      <Tabs
        label="Software views"
        value={view}
        onChange={(v) => set({ view: v === 'software' ? null : v })}
        tabs={[
          { id: 'software', label: 'By software', count: rows.length },
          { id: 'users', label: 'By user', hidden: !perms.seesIndividuals },
          { id: 'renewals', label: 'Renewals', count: renewals.length },
        ]}
      />
      <div className="section-gap">
        {view === 'software' && (
          <Panel flush>
            <DataTable
              rows={shown}
              rowKey={(r) => r.licence.id}
              onRowClick={(r) => set({ open: r.licence.id })}
              selectedKey={openId}
              initialSort={perms.seesCosts ? { key: 'idle', dir: 'desc' } : { key: 'util', dir: 'asc' }}
              columns={[
                { key: 'p', header: 'Software · feature', render: (r) => <span>{r.licence.product}<span className="sub mono">{r.licence.id} · {r.licence.feature}</span></span>, sort: (r) => r.licence.product },
                { key: 't', header: 'Type', render: (r) => <span className="small">{r.licence.type}</span>, sort: (r) => r.licence.type },
                { key: 's', header: 'Seats', num: true, render: (r) => num(r.seats, r.seats % 1 ? 1 : 0), sort: (r) => r.seats },
                { key: 'util', header: 'Utilisation', render: (r) => <span className="row" style={{ gap: 8 }}><MiniBar value={r.util} /> <span className="mono small">{pct(r.util)}</span></span>, sort: (r) => r.util },
                { key: 'pk', header: 'Peak / avg', num: true, render: (r) => `${num(r.peak, 1)} / ${num(r.avgPeak, 1)}`, sort: (r) => r.peak, title: 'Highest and average weekly peak concurrent use' },
                ...(perms.seesCosts
                  ? [
                      { key: 'sp', header: 'Annual spend', num: true, render: (r: (typeof rows)[number]) => inrShort(r.spend), sort: (r: (typeof rows)[number]) => r.spend },
                      { key: 'idle', header: 'Idle spend', num: true, render: (r: (typeof rows)[number]) => <span className="est">{inrShort(r.idleSpend)}</span>, sort: (r: (typeof rows)[number]) => r.idleSpend },
                    ]
                  : []),
                { key: 'd', header: 'Denials', num: true, render: (r) => (r.denials ? <span className="text-warn">{r.denials}</span> : <span className="muted">0</span>), sort: (r) => r.denials },
                { key: 'r', header: 'Renewal', render: (r) => (r.daysToRenewal <= 90 ? <StatusChip status="renewal-soon">{fmtDate(r.licence.renewalDate)}</StatusChip> : <span className="nowrap small">{fmtDate(r.licence.renewalDate)}</span>), sort: (r) => r.daysToRenewal },
                { key: 'st', header: 'Status', render: (r) => <UtilChip util={r.util} />, sort: (r) => r.util },
              ]}
            />
          </Panel>
        )}

        {view === 'users' && perms.seesIndividuals && (
          <>
            <Callout icon={ShieldCheck}>People view is for freeing idle seats and fixing access. Hours are licence check-out time from server logs (sample), not a measure of work.</Callout>
            <div className="section-gap">
              <Panel flush>
                <DataTable
                  rows={userRows}
                  rowKey={(r) => r.u.id}
                  onRowClick={(r) => set({ user: r.u.id })}
                  selectedKey={userId}
                  initialSort={{ key: 'idle', dir: 'desc' }}
                  pageSize={25}
                  columns={[
                    { key: 'n', header: 'Person', render: (r) => <span>{r.u.name}<span className="sub mono">{r.u.username}</span></span>, sort: (r) => r.u.name },
                    { key: 'tm', header: 'Team', render: (r) => <span className="small">{r.u.team}</span>, sort: (r) => r.u.team },
                    { key: 'tl', header: 'Tools', num: true, render: (r) => r.tools, sort: (r) => r.tools },
                    { key: 'a', header: 'Active (12 m)', num: true, render: (r) => hours(r.active), sort: (r) => r.active },
                    { key: 'idle', header: 'Idle check-out', num: true, render: (r) => <span>{hours(r.idle)} <span className="muted small">({pct(r.idleShare)})</span></span>, sort: (r) => r.idleShare },
                    { key: 'dn', header: 'Denied', num: true, render: (r) => r.denials, sort: (r) => r.denials },
                    { key: 'l', header: 'Last active', render: (r) => { const d = daysBetween(r.last, DEMO_TODAY); return d >= 90 ? <StatusChip status="underused">{fmtDate(r.last)}</StatusChip> : <span className="nowrap small">{fmtDate(r.last)}</span>; }, sort: (r) => r.last },
                  ]}
                />
              </Panel>
            </div>
          </>
        )}

        {view === 'renewals' && (
          <Panel flush title="Renewals in the next 12 months" sub="Recommended quantity uses named-seat activity or the 52-week high-demand forecast">
            <DataTable
              rows={renewals}
              rowKey={(r) => r.licence.id}
              onRowClick={(r) => set({ open: r.licence.id })}
              columns={[
                { key: 'p', header: 'Software', render: (r) => <span>{r.licence.product}<span className="sub mono">{r.licence.contractRef}</span></span> },
                { key: 'd', header: 'Renewal', render: (r) => <span className="nowrap">{fmtDate(r.licence.renewalDate)} <span className="muted small">· {r.daysToRenewal} d</span></span> },
                { key: 'n', header: 'Notice by', render: (r) => { const by = new Date(new Date(r.licence.renewalDate).getTime() - r.licence.noticeDays * 864e5).toISOString().slice(0, 10); return by < DEMO_TODAY ? <StatusChip status="rejected">Passed {fmtDate(by)}</StatusChip> : <span className="nowrap small">{fmtDate(by)}</span>; } },
                { key: 's', header: 'Owned', num: true, render: (r) => r.licence.seats },
                { key: 'k', header: 'Recommended', num: true, render: (r) => (r.advice.reduceBy > 0 ? <b style={{ fontWeight: 600, color: 'var(--teal-strong)' }}>{r.advice.keep}</b> : r.advice.keep) },
                ...(perms.seesCosts ? [{ key: 'v', header: 'Annual value', num: true, render: (r: (typeof renewals)[number]) => inrShort(r.licence.seats * r.licence.costPerSeat) }, { key: 'sv', header: 'Possible saving', num: true, render: (r: (typeof renewals)[number]) => (r.advice.annualSaving ? <span className="est">{inrShort(r.advice.annualSaving)}</span> : <span className="muted">—</span>) }] : []),
                { key: 'why', header: 'Basis', render: (r) => <span className="small muted">{r.advice.reason}</span> },
              ]}
            />
          </Panel>
        )}
      </div>

      {openId && ds.licences.some((l) => l.id === openId) && <SoftwareDrawer licenceId={openId} onClose={() => set({ open: null })} onEdit={perms.editRegistry ? () => setEditing(ds.licences.find((l) => l.id === openId)!) : undefined} />}
      {userId && perms.seesIndividuals && <UserDrawer userId={userId} onClose={() => set({ user: null })} onOpenLicence={(id) => set({ user: null, open: id })} />}
      {editing && <EditLicenceDialog licence={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
