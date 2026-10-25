import { Download, UserMinus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { daysToRenewal, lastActiveBand, licenceSpend } from '../../calc/metrics';
import { EditLicenceDialog } from '../../components/records/EditLicenceDialog';
import { RecommendationDrawer, recStatusChip } from '../../components/records/RecommendationDrawer';
import { SoftwareDrawer } from '../../components/records/SoftwareDrawer';
import { DataTable } from '../../components/ui/DataTable';
import { Dialog } from '../../components/ui/Overlay';
import { StatusChip } from '../../components/ui/StatusChip';
import { Callout, Field, MiniBar, PageHead, Panel, Tabs } from '../../components/ui/basics';
import type { Licence, Recommendation } from '../../domain/types';
import { downloadCSV } from '../../lib/csv';
import { DEMO_TODAY, daysBetween, fmtDate, fmtDateTime } from '../../lib/dates';
import { inr, inrShort, num, pct } from '../../lib/format';
import { STEP_LABEL } from '../../state/roles';
import { useApp } from '../../state/store';
import { canDecideRecommendation } from '../../state/workflow';
import { ProjectsView } from '../ops/ProjectsPage';
import { RequestsView } from '../ops/RequestsPage';
import { ImportTab } from './ImportTab';

type Tab = 'inventory' | 'projects' | 'assignments' | 'requests' | 'approvals' | 'imports' | 'limits' | 'audit';

const TYPE_SHORT = { floating: 'Floating', named: 'Named', 'node-locked': 'Node-locked', token: 'Token' } as const;

function InventoryTab() {
  const { ds, perms, state } = useApp();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [type, setType] = useState('all');
  const [vendor, setVendor] = useState('all');
  const [editing, setEditing] = useState<Licence | null>(null);
  const lics = ds.licences.filter(
    (l) =>
      (perms.deptScope ? (l.allocations[perms.deptScope] ?? 0) > 0 : true) &&
      (type === 'all' || l.type === type) &&
      (vendor === 'all' || l.vendorId === vendor) &&
      [l.product, l.id, l.feature, l.contractRef, l.poRef].some((x) => x.toLowerCase().includes(q.toLowerCase())),
  );
  const openId = params.get('open');
  const holders = (l: Licence) => ds.assignments.filter((a) => a.licenceId === l.id).length;
  const assigned = (l: Licence) => (l.type === 'named' ? holders(l) : Object.values(l.allocations).reduce((s, n) => s + n, 0));
  const peak = (l: Licence) => {
    const w = ds.weekly.filter((x) => x.licenceId === l.id).slice(-4);
    return w.length ? Math.max(...w.map((x) => x.observedPeak)) : 0;
  };
  const available = (l: Licence) => (l.type === 'named' ? l.seats - holders(l) : Math.max(0, l.seats - peak(l)));
  const total = lics.reduce((s, l) => s + licenceSpend(l), 0);

  return (
    <>
      <div className="filter-row">
        <input className="input" style={{ width: 260 }} placeholder="Search product, feature, contract or PO…" aria-label="Search inventory" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="select" aria-label="Licence type" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="all">All licence types</option>
          <option value="floating">Floating</option>
          <option value="named">Named user</option>
          <option value="node-locked">Node-locked</option>
          <option value="token">Token / unit</option>
        </select>
        <select className="select" aria-label="Vendor" value={vendor} onChange={(e) => setVendor(e.target.value)}>
          <option value="all">All vendors</option>
          {ds.vendors.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
        <div className="spacer" />
        {perms.seesCosts && (
          <button
            className="btn"
            onClick={() =>
              downloadCSV(
                'licence-inventory-sample.csv',
                lics.map((l) => ({ id: l.id, product: l.product, feature: l.feature, vendor: ds.vendors.find((v) => v.id === l.vendorId)?.name, type: l.type, seats: l.seats, cost_per_seat_inr: l.costPerSeat, annual_inr: l.seats * l.costPerSeat, contract: l.contractRef, po: l.poRef, renewal: l.renewalDate, owner_cost_centre: ds.departments.find((d) => d.id === l.ownerDeptId)?.costCentre, server: l.server, status: l.status })),
              )
            }
          >
            <Download /> Export register
          </button>
        )}
      </div>
      {!perms.editRegistry && (
        <div style={{ marginBottom: 10 }}>
          <Callout>Read-only for your role. Only licence administrators change the registry; every change is logged.</Callout>
        </div>
      )}
      <Panel flush>
        <DataTable
          rows={lics}
          rowKey={(l) => l.id}
          onRowClick={(l) => {
            params.set('open', l.id);
            setParams(params);
          }}
          selectedKey={openId}
          initialSort={{ key: 'ren', dir: 'asc' }}
          columns={[
            { key: 'p', header: 'Software · feature', render: (l) => <span>{l.product}<span className="sub mono">{l.feature}</span></span>, sort: (l) => l.product },
            { key: 'v', header: 'Vendor', render: (l) => <span className="small">{ds.vendors.find((v) => v.id === l.vendorId)?.name}</span>, sort: (l) => l.vendorId },
            { key: 't', header: 'Type', render: (l) => TYPE_SHORT[l.type], sort: (l) => l.type },
            { key: 's', header: 'Owned', num: true, render: (l) => num(l.seats), sort: (l) => l.seats },
            { key: 'a', header: 'Assigned', num: true, render: (l) => num(assigned(l)), title: 'Named holders, or seats allocated to department groups for shared pools' },
            { key: 'av', header: 'Available', num: true, render: (l) => num(available(l)), title: 'Named: seats without a holder. Shared: owned minus the last 4 weeks’ peak' },
            ...(perms.seesCosts
              ? [
                  { key: 'c', header: '₹ / seat / yr', num: true, render: (l: Licence) => inr(l.costPerSeat), sort: (l: Licence) => l.costPerSeat },
                  { key: 'tot', header: 'Annual', num: true, render: (l: Licence) => inrShort(licenceSpend(l)), sort: (l: Licence) => licenceSpend(l) },
                  { key: 'ctr', header: 'Contract · PO', render: (l: Licence) => <span className="mono small">{l.contractRef}<span className="sub">{l.poRef}</span></span> },
                ]
              : []),
            { key: 'ren', header: 'Renewal', render: (l) => { const d = daysToRenewal(l); return <span className="nowrap">{fmtDate(l.renewalDate)}<span className="sub">{d} days · notice {l.noticeDays}</span></span>; }, sort: (l) => l.renewalDate },
            { key: 'cc', header: 'Cost centre', render: (l) => <span className="mono small">{ds.departments.find((d) => d.id === l.ownerDeptId)?.costCentre}</span> },
            { key: 'st', header: 'Status', render: (l) => (state.licenceEdits[l.id]?.status ?? l.status) === 'renewal-due' ? <StatusChip status="renewal-soon">Renewal due</StatusChip> : l.status === 'retiring' ? <StatusChip status="not-implemented">Retiring</StatusChip> : l.status === 'under-review' ? <StatusChip status="pending">Under review</StatusChip> : <StatusChip status="healthy">Active</StatusChip> },
          ]}
          footer={
            perms.seesCosts ? (
              <tr>
                <td colSpan={3}>Total ({lics.length} records)</td>
                <td className="num">{num(lics.reduce((s, l) => s + l.seats, 0))}</td>
                <td colSpan={3} />
                <td className="num">{inrShort(total)}</td>
                <td colSpan={4} />
              </tr>
            ) : undefined
          }
        />
      </Panel>
      {openId && ds.licences.some((l) => l.id === openId) && (
        <SoftwareDrawer
          licenceId={openId}
          onEdit={perms.editRegistry ? () => setEditing(ds.licences.find((l) => l.id === openId)!) : undefined}
          onClose={() => {
            params.delete('open');
            setParams(params, { replace: true });
          }}
        />
      )}
      {editing && <EditLicenceDialog licence={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function AssignmentsTab() {
  const { ds, perms, actions } = useApp();
  const [release, setRelease] = useState<{ licenceId: string; userId: string } | null>(null);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [band, setBand] = useState('all');
  const named = ds.assignments
    .filter((a) => (perms.deptScope ? ds.users.find((u) => u.id === a.userId)?.deptId === perms.deptScope : true))
    .filter((a) => band === 'all' || lastActiveBand(a.lastActive) === band);
  const pools = ds.licences.filter((l) => l.type !== 'named');
  return (
    <div className="stack-lg">
      <Panel
        flush
        title="Named-user holders"
        sub="Reassignments need a reason; released seats return to the pool"
        actions={
          <select className="select" aria-label="Last used" value={band} onChange={(e) => setBand(e.target.value)}>
            <option value="all">All holders</option>
            <option value="90+ days">Unused 90+ days</option>
            <option value="60–90 days">Unused 60–90 days</option>
            <option value="30–60 days">Unused 30–60 days</option>
            <option value="Active">Active</option>
          </select>
        }
      >
        {perms.seesIndividuals ? (
          <DataTable
            rows={named}
            rowKey={(a) => `${a.licenceId}-${a.userId}`}
            pageSize={12}
            initialSort={{ key: 'last', dir: 'desc' }}
            columns={[
              { key: 'u', header: 'Holder', render: (a) => { const u = ds.users.find((x) => x.id === a.userId)!; return <span>{u.name}<span className="sub">{u.team}</span></span>; }, sort: (a) => ds.users.find((x) => x.id === a.userId)!.name },
              { key: 'l', header: 'Licence', render: (a) => ds.licences.find((l) => l.id === a.licenceId)?.product, sort: (a) => a.licenceId },
              { key: 'h', header: 'Active h (12m)', num: true, render: (a) => num(a.activeHours12m), sort: (a) => a.activeHours12m },
              { key: 'last', header: 'Last used', render: (a) => { const d = daysBetween(a.lastActive, DEMO_TODAY); return d >= 90 ? <StatusChip status="unverified">{d} days ago</StatusChip> : <span>{fmtDate(a.lastActive)} <span className="muted small">({d} d)</span></span>; }, sort: (a) => -daysBetween(a.lastActive, DEMO_TODAY) },
              ...(perms.editAssignments
                ? [
                    {
                      key: 'act',
                      header: '',
                      render: (a: (typeof named)[number]) => (
                        <button className="btn sm" onClick={() => setRelease({ licenceId: a.licenceId, userId: a.userId })}>
                          <UserMinus /> Release seat
                        </button>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        ) : (
          <div className="empty">Individual holders are visible to administrators and to department heads for their own department (privacy rule). Department totals appear in the Overview.</div>
        )}
      </Panel>
      <Panel flush title="Shared-pool allocations" sub="Floating, node-locked and token pools · seats reserved per department group in the licence server options file">
        <DataTable
          rows={pools.flatMap((l) => Object.entries(l.allocations).map(([d, n]) => ({ l, d, n })))}
          rowKey={(r) => `${r.l.id}-${r.d}`}
          columns={[
            { key: 'l', header: 'Pool', render: (r) => <span>{r.l.product}<span className="sub mono">{r.l.server}</span></span> },
            { key: 'd', header: 'Department group', render: (r) => ds.departments.find((x) => x.id === r.d)?.name },
            { key: 'n', header: 'Allocated', num: true, render: (r) => `${r.n} of ${r.l.seats}` },
            { key: 's', header: 'Share', render: (r) => <span className="bar-cell" style={{ minWidth: 140 }}><MiniBar value={r.n} max={r.l.seats} /> {pct(r.n / r.l.seats)}</span> },
          ]}
        />
      </Panel>
      {release && (
        <Dialog
          title="Release named seat"
          onClose={() => setRelease(null)}
          footer={
            <>
              <button className="btn" onClick={() => setRelease(null)}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  if (reason.trim().length < 8) {
                    setErr('A reason is required (at least 8 characters).');
                    return;
                  }
                  actions.changeAssignment({ ...release, action: 'revoke', reason: reason.trim() });
                  setRelease(null);
                  setReason('');
                  setErr('');
                }}
              >
                Release seat
              </button>
            </>
          }
        >
          <p className="small" style={{ marginBottom: 10 }}>
            {ds.users.find((u) => u.id === release.userId)?.name} · {ds.licences.find((l) => l.id === release.licenceId)?.product}. Confirm with the holder first. In production this would also update the vendor portal; here it is recorded in the prototype only.
          </p>
          <Field label="Reason" error={err} htmlFor="rel-r">
            <input id="rel-r" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Holder confirmed no use since July" />
          </Field>
        </Dialog>
      )}
    </div>
  );
}

function ApprovalsTab() {
  const { ds, state, perms, me } = useApp();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<'queue' | 'all' | 'reduction'>('queue');
  const openId = params.get('open');
  const open = state.recommendations.find((r) => r.id === openId);
  const mine = (r: Recommendation) => {
    const lic = ds.licences.find((l) => l.id === r.licenceId)!;
    return canDecideRecommendation(r, state.role, me.name, perms.approvalSteps, perms.deptScope, lic.ownerDeptId).ok;
  };
  const scoped = state.recommendations.filter((r) => !perms.deptScope || (ds.licences.find((l) => l.id === r.licenceId)?.allocations[perms.deptScope] ?? 0) > 0);
  const rows = view === 'queue' ? scoped.filter((r) => r.status === 'pending') : view === 'reduction' ? scoped.filter((r) => r.actions.includes('reduce')) : scoped;
  return (
    <>
      <div className="row-between">
        <div className="segmented" style={{ marginBottom: 12 }}>
          <button aria-pressed={view === 'queue'} onClick={() => setView('queue')}>
            Approval queue ({scoped.filter((r) => r.status === 'pending').length})
          </button>
          <button aria-pressed={view === 'reduction'} onClick={() => setView('reduction')}>
            Reduction &amp; retirement report
          </button>
          <button aria-pressed={view === 'all'} onClick={() => setView('all')}>
            All decisions
          </button>
        </div>
        <span className="small muted">Limits: tier 1 ≤ {inrShort(state.limits.tier1)} · tier 2 ≤ {inrShort(state.limits.tier2)} · above needs a second administrator's sign-off</span>
      </div>
      {view === 'reduction' && (
        <div style={{ marginBottom: 10 }}>
          <Callout>Removals are timed to renewal dates because vendor contracts typically allow seat reductions only at renewal. Records are archived, never erased.</Callout>
        </div>
      )}
      <Panel flush>
        <DataTable
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => {
            params.set('open', r.id);
            setParams(params);
          }}
          selectedKey={openId}
          rowClass={(r) => (mine(r) ? 'flag-warn' : '')}
          initialSort={{ key: 'cr', dir: 'desc' }}
          empty={<div className="empty"><b>No recommendations waiting.</b>Submit one from the Planning Studio.</div>}
          columns={[
            { key: 'id', header: 'ID', render: (r) => <span className="mono">{r.id}</span>, sort: (r) => r.id },
            { key: 't', header: 'Recommendation', render: (r) => <span>{r.title}<span className="sub">{ds.licences.find((l) => l.id === r.licenceId)?.product}</span></span> },
            ...(perms.seesCosts ? [{ key: 'v', header: 'Annual impact', num: true, render: (r: Recommendation) => <span className="est">{r.annualImpact >= 0 ? inrShort(r.annualImpact) : `−${inrShort(-r.annualImpact)}`}</span>, sort: (r: Recommendation) => r.annualImpact }] : []),
            { key: 'tier', header: 'Tier', num: true, render: (r) => r.approvalTier },
            ...(view === 'reduction' ? [{ key: 'eff', header: 'Earliest effect', render: (r: Recommendation) => fmtDate(ds.licences.find((l) => l.id === r.licenceId)!.renewalDate) }] : []),
            { key: 'next', header: 'Status', render: (r) => recStatusChip(r) },
            { key: 'you', header: '', render: (r) => (mine(r) ? <span className="chip warn">Your decision</span> : null) },
            { key: 'cr', header: 'Created', render: (r) => <span className="mono small">{fmtDateTime(r.createdAt)}</span>, sort: (r) => r.createdAt },
          ]}
        />
      </Panel>
      <p className="small muted" style={{ marginTop: 8 }}>
        Steps: tier 1 — {STEP_LABEL.admin}; tier 2 — {STEP_LABEL.deptHead} → {STEP_LABEL.admin}; tier 3 — {STEP_LABEL.deptHead} → {STEP_LABEL.admin} → {STEP_LABEL.leadership}. Nobody approves their own submission.
      </p>
      {open && (
        <RecommendationDrawer
          rec={open}
          onClose={() => {
            params.delete('open');
            setParams(params, { replace: true });
          }}
        />
      )}
    </>
  );
}

function LimitsTab() {
  const { ds, state, perms, actions } = useApp();
  const [t1, setT1] = useState(String(state.limits.tier1 / 1e5));
  const [t2, setT2] = useState(String(state.limits.tier2 / 1e5));
  const [err, setErr] = useState('');
  const depts = ds.departments.filter((d) => !perms.deptScope || d.id === perms.deptScope);
  const rows = depts.map((d) => {
    const use = state.budgetUse[d.id] ?? { committed: 0, spent: 0 };
    const approved = state.review.filter((r) => r.state === 'awaiting-implementation' && ds.licences.find((l) => l.id === r.licenceId)?.ownerDeptId === d.id && r.approvedValue < 0).reduce((s, r) => s - r.approvedValue, 0);
    const committed = use.committed + approved;
    return { d, budget: d.annualBudget, committed, spent: use.spent, remaining: d.annualBudget - committed - use.spent };
  });
  const save = () => {
    const a = Number(t1) * 1e5;
    const b = Number(t2) * 1e5;
    if (!(a > 0) || !(b > 0)) return setErr('Enter both limits in ₹ lakh.');
    if (a >= b) return setErr('Tier 1 must be lower than tier 2.');
    setErr('');
    actions.updateLimits({ tier1: a, tier2: b });
  };
  return (
    <div className="grid-side">
      <Panel flush title="Department licence budgets · FY27" sub="Budget set by the Admin (Head) · committed = approved, not yet invoiced · spent = invoiced">
        <DataTable
          rows={rows}
          rowKey={(r) => r.d.id}
          columns={[
            { key: 'd', header: 'Department', render: (r) => <span>{r.d.fullName}<span className="sub mono">{r.d.costCentre}</span></span> },
            { key: 'b', header: 'Budget', num: true, render: (r) => inrShort(r.budget) },
            { key: 'c', header: 'Committed', num: true, render: (r) => inrShort(r.committed) },
            { key: 's', header: 'Spent', num: true, render: (r) => inrShort(r.spent) },
            { key: 'r', header: 'Remaining', num: true, render: (r) => <span className={r.remaining < r.budget * 0.1 ? 'text-warn' : ''}>{inrShort(r.remaining)}</span> },
            { key: 'u', header: 'Used', render: (r) => <span className="bar-cell" style={{ minWidth: 140 }}><MiniBar value={r.committed + r.spent} max={r.budget} /> {pct((r.committed + r.spent) / r.budget)}</span> },
          ]}
        />
      </Panel>
      <Panel title="Approval tiers" sub="KPCL’s delegation-of-authority rules, entered once">
        <table className="statement">
          <tbody>
            <tr>
              <td>Up to tier 1</td>
              <td className="num">{inrShort(state.limits.tier1)}</td>
            </tr>
            <tr>
              <td className="small muted" colSpan={2}>
                Administrator approves (department head may endorse)
              </td>
            </tr>
            <tr>
              <td>Tier 1 to tier 2</td>
              <td className="num">{inrShort(state.limits.tier2)}</td>
            </tr>
            <tr>
              <td className="small muted" colSpan={2}>
                Department head approves, then administrator
              </td>
            </tr>
            <tr>
              <td>Above tier 2</td>
              <td className="num">—</td>
            </tr>
            <tr>
              <td className="small muted" colSpan={2}>
                + final sign-off by a second administrator
              </td>
            </tr>
          </tbody>
        </table>
        <p className="small muted" style={{ marginTop: 8 }}>
          Last changed by {state.limits.updatedBy}, {fmtDateTime(state.limits.updatedAt)}.
        </p>
        {perms.setLimits ? (
          <div className="stack" style={{ marginTop: 12 }}>
            <Field label="Tier 1 limit (₹ lakh)" htmlFor="lim1">
              <input id="lim1" className="input" type="number" value={t1} onChange={(e) => setT1(e.target.value)} />
            </Field>
            <Field label="Tier 2 limit (₹ lakh)" error={err} htmlFor="lim2">
              <input id="lim2" className="input" type="number" value={t2} onChange={(e) => setT2(e.target.value)} />
            </Field>
            <button className="btn primary" onClick={save}>
              Save limits
            </button>
          </div>
        ) : (
          <p className="small muted" style={{ marginTop: 8 }}>
            {state.role === 'deptHead' ? 'Department heads propose limits for their department; the Admin (Head) approves changes.' : 'The Admin (Head) sets these limits; changes are logged.'}
          </p>
        )}
      </Panel>
    </div>
  );
}

function AuditTab() {
  const { state } = useApp();
  const [q, setQ] = useState('');
  const rows = useMemo(() => state.audit.filter((a) => [a.actor, a.entity, a.entityId, a.action, a.after ?? ''].some((x) => x.toLowerCase().includes(q.toLowerCase()))), [state.audit, q]);
  return (
    <>
      <div className="filter-row">
        <input className="input" style={{ width: 280 }} placeholder="Filter by person, record or action…" aria-label="Filter audit trail" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="spacer" />
        <button className="btn" onClick={() => downloadCSV('audit-trail-sample.csv', rows.map((a) => ({ id: a.id, at: a.at, actor: a.actor, role: a.role, entity: a.entity, record: a.entityId, action: a.action, before: a.before ?? '', after: a.after ?? '' })))}>
          <Download /> Export for audit
        </button>
      </div>
      <Panel flush>
        <DataTable
          rows={rows}
          rowKey={(a) => a.id}
          pageSize={15}
          initialSort={{ key: 'at', dir: 'desc' }}
          columns={[
            { key: 'at', header: 'When', render: (a) => <span className="mono small">{fmtDateTime(a.at)}</span>, sort: (a) => a.at },
            { key: 'who', header: 'Who', render: (a) => <span>{a.actor}<span className="sub">{a.role}</span></span>, sort: (a) => a.actor },
            { key: 'e', header: 'Record', render: (a) => <span>{a.entity} <span className="mono small">{a.entityId}</span></span>, sort: (a) => a.entity },
            { key: 'a', header: 'Action', render: (a) => a.action },
            { key: 'b', header: 'Before', render: (a) => <span className="small muted">{a.before ?? '—'}</span> },
            { key: 'af', header: 'After', render: (a) => <span className="small">{a.after ?? '—'}</span> },
          ]}
        />
      </Panel>
    </>
  );
}

export default function RegistryPage() {
  const { state, perms, ds, me } = useApp();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'inventory';
  const setTab = (t: Tab) => setParams({ tab: t });
  const pendingForMe = state.recommendations.filter((r) => r.status === 'pending' && canDecideRecommendation(r, state.role, me.name, perms.approvalSteps, perms.deptScope, ds.licences.find((l) => l.id === r.licenceId)!.ownerDeptId).ok).length;
  return (
    <>
      <PageHead title="Licence & Project Registry" sub={perms.editRegistry ? 'The single source of truth for what KPCL owns and what its projects need. Every change is recorded.' : 'What KPCL owns and what projects need — read-only for your role; decisions are recorded here.'} />
      <Tabs
        label="Registry sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'inventory', label: 'Licence inventory', count: ds.licences.length },
          { id: 'projects', label: 'Projects' },
          { id: 'assignments', label: 'Assignments' },
          { id: 'requests', label: 'Access requests', count: state.requests.filter((r) => r.status === 'submitted' || r.status === 'approved').length },
          { id: 'approvals', label: 'Approvals', count: pendingForMe || undefined },
          { id: 'imports', label: 'Imports' },
          { id: 'limits', label: 'Spending limits' },
          { id: 'audit', label: 'Audit trail', hidden: !perms.editRegistry },
        ]}
      />
      {tab === 'inventory' && <InventoryTab />}
      {tab === 'projects' && <ProjectsView embedded />}
      {tab === 'assignments' && <AssignmentsTab />}
      {tab === 'requests' && <RequestsView embedded />}
      {tab === 'approvals' && <ApprovalsTab />}
      {tab === 'imports' && <ImportTab />}
      {tab === 'limits' && <LimitsTab />}
      {tab === 'audit' && <AuditTab />}
    </>
  );
}
