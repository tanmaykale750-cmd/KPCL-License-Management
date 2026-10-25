import { Check, Plus, Send, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { forecast } from '../../calc/forecast';
import { DataTable } from '../../components/ui/DataTable';
import { Drawer } from '../../components/ui/Overlay';
import { StatusChip, type Status } from '../../components/ui/StatusChip';
import { Callout, Field, PageHead, Panel, Tabs } from '../../components/ui/basics';
import type { AccessRequest, RequestStatus } from '../../domain/types';
import { DEMO_TODAY, addDays, daysBetween, fmtDate, fmtDateTime, overlaps } from '../../lib/dates';
import { useApp } from '../../state/store';

const STATUS: Record<RequestStatus, { s: Status; label: string }> = {
  submitted: { s: 'submitted', label: 'Awaiting department head' },
  'more-info': { s: 'pending', label: 'More information requested' },
  approved: { s: 'approved', label: 'Approved · to fulfil' },
  rejected: { s: 'rejected', label: 'Rejected' },
  fulfilled: { s: 'implemented', label: 'Fulfilled' },
  cancelled: { s: 'cancelled', label: 'Cancelled' },
};

const USE_LABEL = { daily: 'Daily', 'few-days-month': 'A few days a month', 'one-off': 'One-off run' } as const;

export function RequestStatusChip({ status }: { status: RequestStatus }) {
  return <StatusChip status={STATUS[status].s}>{STATUS[status].label}</StatusChip>;
}

/** Cheapest route that meets the need, as described in the solution. */
export function suggestRoute(ds: ReturnType<typeof useApp>['ds'], r: AccessRequest): { route: string; detail: string; needsSpend: boolean } {
  const lic = ds.licences.find((l) => l.id === r.licenceId)!;
  if (lic.type === 'named') {
    const dormant = ds.assignments.filter((a) => a.licenceId === lic.id && daysBetween(a.lastActive, DEMO_TODAY) >= 90);
    if (r.expectedUse !== 'daily' && lic.vendorId === 'v-autodesk')
      return { route: 'Autodesk Flex tokens (occasional use)', detail: 'Cheaper than a named seat for a few days a month.', needsSpend: false };
    if (dormant.length) return { route: `Reassign an idle named seat (${dormant.length} unused 90+ days)`, detail: 'Release a dormant seat after confirming with its holder; no new spend.', needsSpend: false };
    return { route: 'Purchase a named seat', detail: 'No idle seat available — goes through spending limits.', needsSpend: true };
  }
  if (!lic.forecastable) return { route: `Add to the ${lic.product} pool`, detail: 'Shared pool with spare capacity.', needsSpend: false };
  const f = forecast(ds, lic.id, { horizonWeeks: 26 });
  const window = f.points.filter((p) => p.week >= r.from.slice(0, 10) && p.week <= r.until);
  const extra = r.expectedUse === 'daily' ? 1 : r.expectedUse === 'few-days-month' ? 0.4 : 0.15;
  const short = window.some((p) => p.p90 + extra > p.capacity);
  if (!short) return { route: `Add to the ${lic.product} floating group`, detail: `Forecast peak stays within ${lic.seats} ${lic.unitLabel} for the requested dates.`, needsSpend: false };
  return {
    route: 'Temporary access for the requested weeks',
    detail: `Forecast (P90) already exceeds ${lic.seats} ${lic.unitLabel} in part of this window — raise temporary access through spending limits, or stagger with the project leader.`,
    needsSpend: true,
  };
}

function NewRequestDrawer({ onClose }: { onClose: () => void }) {
  const { ds, me, actions } = useApp();
  const projects = ds.projects.filter((p) => p.status !== 'completed');
  const [form, setForm] = useState({ licenceId: '', projectId: '', phaseId: '', from: addDays(DEMO_TODAY, 7), until: addDays(DEMO_TODAY, 60), expectedUse: 'daily' as AccessRequest['expectedUse'], justification: '', urgency: 'normal' as AccessRequest['urgency'] });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const phases = projects.find((p) => p.id === form.projectId)?.phases ?? [];
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const validate = () => {
    const e: Record<string, string> = {};
    if (!form.licenceId) e.licenceId = 'Choose the software and module you need.';
    if (!form.projectId) e.projectId = 'Pick the project this work is for.';
    if (!form.from) e.from = 'Start date is required.';
    else if (form.from < DEMO_TODAY) e.from = 'Start date cannot be in the past.';
    if (!form.until) e.until = 'End date is required.';
    else if (form.until <= form.from) e.until = 'End date must be after the start date.';
    else if (daysBetween(form.from, form.until) > 366) e.until = 'Requests are limited to 12 months; renew later if needed.';
    if (form.justification.trim().length < 20) e.justification = 'Describe the business reason (at least 20 characters).';
    const ph = phases.find((p) => p.id === form.phaseId);
    if (ph && !overlaps(form.from, form.until, ph.start, ph.end)) e.phaseId = `Dates do not overlap the ${ph.name} phase (${fmtDate(ph.start)}–${fmtDate(ph.end)}).`;
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = () => {
    if (!validate()) return;
    actions.submitRequest({ requesterId: me.id, licenceId: form.licenceId, projectId: form.projectId, phaseId: form.phaseId || undefined, from: form.from, until: form.until, expectedUse: form.expectedUse, justification: form.justification.trim(), urgency: form.urgency });
    onClose();
  };

  return (
    <Drawer
      title="Request software access"
      eyebrow="New access request"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit}>
            <Send /> Submit request
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Software and module" error={errors.licenceId} full htmlFor="rq-lic">
          <select id="rq-lic" className="select" value={form.licenceId} onChange={(e) => set('licenceId', e.target.value)}>
            <option value="">Select…</option>
            {ds.licences.map((l) => (
              <option key={l.id} value={l.id}>
                {l.product} — {l.feature}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Project" error={errors.projectId} htmlFor="rq-prj" hint="From the project registry, so the request is tied to a phase">
          <select id="rq-prj" className="select" value={form.projectId} onChange={(e) => setForm((f) => ({ ...f, projectId: e.target.value, phaseId: '' }))}>
            <option value="">Select…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} · {p.shortName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Phase (optional)" error={errors.phaseId} htmlFor="rq-ph">
          <select id="rq-ph" className="select" value={form.phaseId} onChange={(e) => set('phaseId', e.target.value)} disabled={!phases.length}>
            <option value="">—</option>
            {phases.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({fmtDate(p.start)}–{fmtDate(p.end)})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Needed from" error={errors.from} htmlFor="rq-from">
          <input id="rq-from" type="date" className="input" value={form.from} onChange={(e) => set('from', e.target.value)} />
        </Field>
        <Field label="Until" error={errors.until} htmlFor="rq-until">
          <input id="rq-until" type="date" className="input" value={form.until} onChange={(e) => set('until', e.target.value)} />
        </Field>
        <Field label="Expected use" htmlFor="rq-use">
          <select id="rq-use" className="select" value={form.expectedUse} onChange={(e) => set('expectedUse', e.target.value)}>
            <option value="daily">Daily</option>
            <option value="few-days-month">A few days a month</option>
            <option value="one-off">One-off simulation run</option>
          </select>
        </Field>
        <Field label="Urgency" htmlFor="rq-urg">
          <select id="rq-urg" className="select" value={form.urgency} onChange={(e) => set('urgency', e.target.value)}>
            <option value="normal">Normal</option>
            <option value="blocking">Blocking current work</option>
          </select>
        </Field>
        <Field label="Business reason" error={errors.justification} full htmlFor="rq-just" hint="Required. What the work is and why this tool is needed.">
          <textarea id="rq-just" className="textarea" value={form.justification} onChange={(e) => set('justification', e.target.value)} placeholder="Fatigue analysis for the new compressor housing" />
        </Field>
      </div>
      <div style={{ marginTop: 16 }}>
        <Callout>Your department head reviews the request (target: two working days, then a reminder and escalation). The administrator then fulfils it by the cheapest route that meets the need.</Callout>
      </div>
    </Drawer>
  );
}

function RequestDrawer({ r, onClose }: { r: AccessRequest; onClose: () => void }) {
  const { ds, perms, me, actions } = useApp();
  const lic = ds.licences.find((l) => l.id === r.licenceId)!;
  const proj = ds.projects.find((p) => p.id === r.projectId);
  const phase = proj?.phases.find((p) => p.id === r.phaseId);
  const requester = ds.users.find((u) => u.id === r.requesterId);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const route = useMemo(() => suggestRoute(ds, r), [ds, r]);
  const f = useMemo(() => (lic.forecastable ? forecast(ds, lic.id, { horizonWeeks: 26 }) : null), [ds, lic]);
  const windowPts = f?.points.filter((p) => p.week >= r.from.slice(0, 10) && p.week <= r.until) ?? [];
  const peak = windowPts.reduce((m, p) => Math.max(m, p.p90), 0);
  const canDecide = perms.approveRequests && requester?.deptId === perms.deptScope && (r.status === 'submitted') && requester?.id !== me.id;
  const canFulfil = perms.fulfilRequests && r.status === 'approved';
  const isMine = r.requesterId === me.id;

  const decide = (d: 'approved' | 'rejected' | 'more-info') => {
    if ((d === 'rejected' || d === 'more-info') && reason.trim().length < 5) {
      setErr(d === 'rejected' ? 'A reason is mandatory for every rejection.' : 'Say what information is needed.');
      return;
    }
    actions.decideRequest(r.id, d, reason.trim());
    onClose();
  };

  return (
    <Drawer
      eyebrow={`${r.id} · submitted ${fmtDateTime(r.submittedAt)}`}
      title={`${lic.product}`}
      onClose={onClose}
      aside={
        <div className="row" style={{ marginTop: 8 }}>
          <RequestStatusChip status={r.status} />
          {r.urgency === 'blocking' && <StatusChip status="critical-project">Blocking work</StatusChip>}
        </div>
      }
      footer={
        canDecide ? (
          <>
            <button className="btn" onClick={() => decide('more-info')}>
              Ask for more information
            </button>
            <button className="btn danger" onClick={() => decide('rejected')}>
              <X /> Reject
            </button>
            <button className="btn primary" onClick={() => decide('approved')}>
              <Check /> Approve
            </button>
          </>
        ) : canFulfil ? (
          <>
            {route.needsSpend && <span className="small muted" style={{ marginRight: 'auto' }}>Needs spend — will route through spending limits.</span>}
            <button
              className="btn primary"
              onClick={() => {
                actions.fulfilRequest(r.id, route.route);
                onClose();
              }}
            >
              <Check /> Fulfil: {route.route.split(' (')[0]}
            </button>
          </>
        ) : isMine && (r.status === 'submitted' || r.status === 'more-info') ? (
          <>
            <button
              className="btn danger"
              onClick={() => {
                actions.cancelRequest(r.id);
                onClose();
              }}
            >
              Cancel request
            </button>
            {r.status === 'more-info' && (
              <button
                className="btn primary"
                onClick={() => {
                  if (note.trim().length < 5) {
                    setErr('Add the requested information.');
                    return;
                  }
                  actions.respondMoreInfo(r.id, note.trim());
                  onClose();
                }}
              >
                <Send /> Resubmit
              </button>
            )}
          </>
        ) : undefined
      }
    >
      <dl className="dl">
        <dt>Requester</dt>
        <dd>
          {requester?.name} · {requester?.team}
        </dd>
        <dt>Module</dt>
        <dd>
          {lic.feature} <span className="mono muted">{lic.id}</span> · {lic.type}
        </dd>
        <dt>Project</dt>
        <dd>
          {proj ? `${proj.code} · ${proj.name}` : r.projectId}
          {phase && <span className="muted"> · {phase.name} ({fmtDate(phase.start)}–{fmtDate(phase.end)})</span>}
        </dd>
        <dt>Needed</dt>
        <dd>
          {fmtDate(r.from, 'long')} → {fmtDate(r.until, 'long')} · {USE_LABEL[r.expectedUse]}
        </dd>
        <dt>Business reason</dt>
        <dd style={{ whiteSpace: 'pre-wrap' }}>{r.justification}</dd>
        {r.decisionReason && (
          <>
            <dt>Decision reason</dt>
            <dd>{r.decisionReason}</dd>
          </>
        )}
        {r.fulfilment && (
          <>
            <dt>Fulfilled by</dt>
            <dd>{r.fulfilment}</dd>
          </>
        )}
      </dl>

      {(canDecide || canFulfil || perms.approveRequests || perms.fulfilRequests) && (
        <div className="block">
          <h3>Capacity context</h3>
          {f ? (
            <div className="kv-strip" style={{ marginBottom: 8 }}>
              <span>
                Owned <b>{lic.seats} {lic.unitLabel}</b>
              </span>
              <span>
                Forecast P90 peak in window <b>{peak ? peak.toFixed(1) : '—'}</b>
              </span>
              <span>
                Weeks over capacity <b>{windowPts.filter((p) => p.p90 > p.capacity).length}</b> of {windowPts.length || '—'}
              </span>
            </div>
          ) : (
            <div className="kv-strip" style={{ marginBottom: 8 }}>
              <span>
                Named seats <b>{lic.seats}</b>
              </span>
              <span>
                Unused 90+ days <b>{ds.assignments.filter((a) => a.licenceId === lic.id && daysBetween(a.lastActive, DEMO_TODAY) >= 90).length}</b>
              </span>
            </div>
          )}
          <Callout tone={route.needsSpend ? 'warn' : 'teal'}>
            <b>Suggested fulfilment:</b> {route.route}. {route.detail}
          </Callout>
        </div>
      )}

      {canDecide && (
        <div className="block">
          <Field label="Reason (mandatory to reject or ask for information)" error={err} htmlFor="rq-reason">
            <textarea id="rq-reason" className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
      )}
      {isMine && r.status === 'more-info' && (
        <div className="block">
          <Field label="Information requested by your department head" error={err} htmlFor="rq-note">
            <textarea id="rq-note" className="textarea" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
      )}

      <div className="block">
        <h3>History</h3>
        <ul className="timeline-list">
          {[...r.history].reverse().map((h, i) => (
            <li key={i}>
              <div className="when">{fmtDateTime(h.at)}</div>
              <div>
                <b style={{ fontWeight: 600 }}>{h.action}</b> · {h.actor}
                {h.note && <div className="muted small">{h.note}</div>}
              </div>
            </li>
          ))}
        </ul>
      </div>
      <p className="small muted block">Fulfilment is recorded in this prototype only. No licence server options file or vendor portal is changed.</p>
    </Drawer>
  );
}

type View = 'queue' | 'mine' | 'all';

export function RequestsView({ embedded }: { embedded?: boolean }) {
  const { ds, state, perms, me } = useApp();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(params.get('new') === '1' && perms.submitRequests);
  const openId = params.get('open');
  const defaultView: View = perms.submitRequests ? 'mine' : 'queue';
  const [view, setView] = useState<View>(defaultView);
  const [q, setQ] = useState('');

  useEffect(() => setView(defaultView), [defaultView]);

  const scoped = state.requests.filter((r) => {
    const u = ds.users.find((x) => x.id === r.requesterId);
    if (state.role === 'engineer') return r.requesterId === me.id;
    if (state.role === 'deptHead') return u?.deptId === perms.deptScope;
    if (state.role === 'projectLead') return perms.projectScope?.includes(r.projectId);
    return true;
  });
  const queue = scoped.filter((r) => (perms.approveRequests ? r.status === 'submitted' : perms.fulfilRequests ? r.status === 'approved' : r.status === 'submitted' || r.status === 'approved'));
  const list = (view === 'queue' ? queue : view === 'mine' ? scoped.filter((r) => r.requesterId === me.id) : scoped).filter((r) => {
    const s = q.trim().toLowerCase();
    if (!s) return true;
    const lic = ds.licences.find((l) => l.id === r.licenceId);
    const u = ds.users.find((x) => x.id === r.requesterId);
    return [r.id, r.justification, lic?.product ?? '', u?.name ?? ''].some((x) => x.toLowerCase().includes(s));
  });
  const open = state.requests.find((r) => r.id === openId);
  const close = () => {
    params.delete('open');
    setParams(params, { replace: true });
  };

  const tabs = [
    { id: 'queue' as const, label: perms.approveRequests ? 'To decide' : perms.fulfilRequests ? 'To fulfil' : 'Open', count: queue.length, hidden: perms.submitRequests },
    { id: 'mine' as const, label: 'My requests', count: scoped.filter((r) => r.requesterId === me.id).length, hidden: !perms.submitRequests },
    { id: 'all' as const, label: state.role === 'deptHead' ? 'Department history' : state.role === 'projectLead' ? 'Tied to my projects' : 'All requests', count: scoped.length },
  ];

  return (
    <>
      {!embedded && (
        <PageHead
          title="Access Requests"
          sub={perms.submitRequests ? 'Request software for a project and track the decision.' : perms.approveRequests ? 'Decide on your department’s software requests, with capacity in view.' : 'Who needs which tool, for which project, when and why.'}
          actions={
            perms.submitRequests && (
              <button className="btn primary" onClick={() => setCreating(true)}>
                <Plus /> New request
              </button>
            )
          }
        />
      )}
      <div className="row-between" style={{ marginBottom: 0 }}>
        <Tabs label="Request views" tabs={tabs} value={tabs.find((t) => t.id === view && !t.hidden) ? view : 'all'} onChange={setView} />
        <input className="input" style={{ width: 240 }} placeholder="Filter requests…" aria-label="Filter requests" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Panel flush>
        <DataTable
          rows={list}
          rowKey={(r) => r.id}
          onRowClick={(r) => {
            params.set('open', r.id);
            setParams(params);
          }}
          selectedKey={openId}
          initialSort={{ key: 'sub', dir: 'desc' }}
          rowClass={(r) => (r.urgency === 'blocking' && (r.status === 'submitted' || r.status === 'approved') ? 'flag-warn' : '')}
          empty={
            <div className="empty">
              <b>{view === 'queue' ? 'Nothing waiting for you.' : 'No requests yet.'}</b>
              {perms.submitRequests && (
                <button className="btn primary" style={{ marginTop: 10 }} onClick={() => setCreating(true)}>
                  <Plus /> New request
                </button>
              )}
            </div>
          }
          columns={[
            { key: 'id', header: 'ID', render: (r) => <span className="mono">{r.id}</span>, sort: (r) => r.id },
            ...(state.role === 'engineer' ? [] : [{ key: 'who', header: 'Requester', render: (r: AccessRequest) => ds.users.find((u) => u.id === r.requesterId)?.name ?? r.requesterId, sort: (r: AccessRequest) => ds.users.find((u) => u.id === r.requesterId)?.name ?? '' }]),
            { key: 'sw', header: 'Software', render: (r) => ds.licences.find((l) => l.id === r.licenceId)?.product, sort: (r) => r.licenceId },
            { key: 'prj', header: 'Project', render: (r) => ds.projects.find((p) => p.id === r.projectId)?.shortName ?? r.projectId },
            { key: 'dates', header: 'Needed', render: (r) => <span className="nowrap">{fmtDate(r.from)} → {fmtDate(r.until)}</span>, sort: (r) => r.from },
            { key: 'use', header: 'Use', render: (r) => USE_LABEL[r.expectedUse] },
            { key: 'st', header: 'Status', render: (r) => <RequestStatusChip status={r.status} />, sort: (r) => r.status },
            { key: 'sub', header: 'Submitted', render: (r) => <span className="mono small">{fmtDateTime(r.submittedAt)}</span>, sort: (r) => r.submittedAt },
          ]}
        />
      </Panel>
      {creating && <NewRequestDrawer onClose={() => setCreating(false)} />}
      {open && <RequestDrawer r={open} onClose={close} />}
    </>
  );
}

export default function RequestsPage() {
  return <RequestsView />;
}
