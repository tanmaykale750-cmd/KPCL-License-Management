import { Check, GitPullRequestArrow, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { phaseCover, type Cover } from '../../calc/cover';
import type { ForecastResult } from '../../calc/forecast';
import { Gantt, makeScale, PhaseLegend } from '../../components/charts/Gantt';
import { DataTable } from '../../components/ui/DataTable';
import { Drawer } from '../../components/ui/Overlay';
import { StatusChip } from '../../components/ui/StatusChip';
import { Callout, Field, PageHead, Panel } from '../../components/ui/basics';
import type { Project, ProjectChange } from '../../domain/types';
import { useWidth } from '../../hooks/useWidth';
import { DEMO_TODAY, fmtDate, fmtDateTime, monthLabel } from '../../lib/dates';
import { useForecasts } from '../../hooks/useForecasts';
import { useApp } from '../../state/store';
import { RequestStatusChip } from './RequestsPage';

export function CoverChip({ cover, weeks }: { cover: Cover; weeks: number }) {
  if (cover === 'covered') return <StatusChip status="healthy">Covered</StatusChip>;
  if (cover === 'tight') return <StatusChip status="forecast-shortage">Tight · {weeks} wk at P90</StatusChip>;
  if (cover === 'short') return <span className="chip crit hatched" style={{ background: 'repeating-linear-gradient(135deg, rgba(166,27,27,0.12) 0 3px, transparent 3px 6px)' }}>Short · {weeks} wk expected</span>;
  if (cover === 'past') return <span className="chip neutral">Completed</span>;
  return <span className="chip neutral">Named seats</span>;
}

function ChangeForm({ project, onDone }: { project: Project; onDone: () => void }) {
  const { actions } = useApp();
  const [phaseId, setPhaseId] = useState(project.phases.find((p) => p.end >= DEMO_TODAY)?.id ?? project.phases[0].id);
  const phase = project.phases.find((p) => p.id === phaseId)!;
  const [field, setField] = useState<'dates' | 'seats'>('dates');
  const [start, setStart] = useState(phase.start);
  const [end, setEnd] = useState(phase.end);
  const [licenceId, setLicenceId] = useState(phase.demand[0]?.licenceId ?? '');
  const [seats, setSeats] = useState(String(phase.demand[0]?.seats ?? 1));
  const [reason, setReason] = useState('');
  const [errs, setErrs] = useState<Record<string, string>>({});

  const submit = () => {
    const e: Record<string, string> = {};
    if (field === 'dates') {
      if (!start || !end) e.dates = 'Both dates are required.';
      else if (end <= start) e.dates = 'The phase must end after it starts.';
      else if (start === phase.start && end === phase.end) e.dates = 'Dates are unchanged.';
    } else {
      const n = Number(seats);
      if (!Number.isFinite(n) || n < 0 || n > 30) e.seats = 'Enter 0–30 concurrent seats.';
      else if (n === phase.demand.find((d) => d.licenceId === licenceId)?.seats) e.seats = 'Seat demand is unchanged.';
    }
    if (reason.trim().length < 10) e.reason = 'Give a reason (at least 10 characters).';
    setErrs(e);
    if (Object.keys(e).length) return;
    const cur = phase.demand.find((d) => d.licenceId === licenceId)?.seats;
    actions.proposeProjectChange({
      projectId: project.id,
      phaseId,
      field,
      before: field === 'dates' ? `${phase.name}: ${fmtDate(phase.start)}–${fmtDate(phase.end)}` : `${phase.name} ${licenceId}: ${cur} seats`,
      after: field === 'dates' ? `${fmtDate(start)}–${fmtDate(end)}` : `${seats} seats`,
      newStart: field === 'dates' ? start : undefined,
      newEnd: field === 'dates' ? end : undefined,
      licenceId: field === 'seats' ? licenceId : undefined,
      newSeats: field === 'seats' ? Number(seats) : undefined,
      reason: reason.trim(),
    });
    onDone();
  };

  return (
    <div className="panel" style={{ padding: 14, marginTop: 10 }}>
      <div className="form-grid">
        <Field label="Phase" htmlFor="pc-ph">
          <select
            id="pc-ph"
            className="select"
            value={phaseId}
            onChange={(e) => {
              const ph = project.phases.find((p) => p.id === e.target.value)!;
              setPhaseId(ph.id);
              setStart(ph.start);
              setEnd(ph.end);
              setLicenceId(ph.demand[0]?.licenceId ?? '');
              setSeats(String(ph.demand[0]?.seats ?? 1));
            }}
          >
            {project.phases.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Change" htmlFor="pc-f">
          <div className="segmented" id="pc-f">
            <button aria-pressed={field === 'dates'} onClick={() => setField('dates')}>
              Dates
            </button>
            <button aria-pressed={field === 'seats'} onClick={() => setField('seats')}>
              Seat demand
            </button>
          </div>
        </Field>
        {field === 'dates' ? (
          <>
            <Field label="New start" error={errs.dates} htmlFor="pc-s">
              <input id="pc-s" type="date" className="input" value={start} onChange={(e) => setStart(e.target.value)} />
            </Field>
            <Field label="New end" htmlFor="pc-e">
              <input id="pc-e" type="date" className="input" value={end} onChange={(e) => setEnd(e.target.value)} />
            </Field>
          </>
        ) : (
          <>
            <Field label="Software" htmlFor="pc-l">
              <select id="pc-l" className="select" value={licenceId} onChange={(e) => setLicenceId(e.target.value)}>
                {phase.demand.map((d) => (
                  <option key={d.licenceId} value={d.licenceId}>
                    {d.licenceId}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Concurrent seats" error={errs.seats} htmlFor="pc-n">
              <input id="pc-n" type="number" min={0} max={30} className="input" value={seats} onChange={(e) => setSeats(e.target.value)} />
            </Field>
          </>
        )}
        <Field label="Reason" error={errs.reason} full htmlFor="pc-r">
          <input id="pc-r" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer moved the design review by three weeks" />
        </Field>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button className="btn" onClick={onDone}>
          Cancel
        </button>
        <button className="btn primary" onClick={submit}>
          <GitPullRequestArrow /> Propose change
        </button>
      </div>
    </div>
  );
}

function ProjectDrawer({ project, onClose }: { project: Project; onClose: () => void }) {
  const { ds, state, perms, actions } = useApp();
  const nav = useNavigate();
  const [proposing, setProposing] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a new cache whenever the dataset changes
  const cache = useMemo(() => new Map<string, ForecastResult>(), [ds]);
  const leader = ds.users.find((u) => u.id === project.leaderUserId);
  const requests = state.requests.filter((r) => r.projectId === project.id);
  const changes = state.projectChanges.filter((c) => c.projectId === project.id);
  const canPropose = perms.proposeProjectChanges && perms.projectScope?.includes(project.id);
  const decide = (c: ProjectChange, d: 'approve' | 'reject') => actions.decideProjectChange(c.id, d, d === 'reject' ? 'Not agreed' : '');
  return (
    <Drawer
      wide
      eyebrow={`${project.code} · ${project.ownerDeptName}`}
      title={project.name}
      onClose={onClose}
      aside={
        <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          {project.critical && <StatusChip status="critical-project">Critical project</StatusChip>}
          <span className="chip neutral">{project.status}</span>
          <span className={`chip ${project.dateStatus === 'confirmed' ? 'teal' : 'warn dashed'}`}>{project.dateStatus === 'confirmed' ? 'Dates confirmed' : `Tentative · ${Math.round(project.confidence * 100)}% confidence`}</span>
        </div>
      }
      footer={
        perms.areas.includes('planning') && project.status !== 'completed' ? (
          <button className="btn primary" onClick={() => nav(`/planning?tab=whatif&project=${project.id}`)}>
            What-if on this project’s dates
          </button>
        ) : undefined
      }
    >
      <dl className="dl">
        <dt>Leader</dt>
        <dd>{leader?.name}</dd>
        <dt>Teams</dt>
        <dd>{project.teams.join(', ')}</dd>
        <dt>Priority</dt>
        <dd style={{ textTransform: 'capitalize' }}>{project.priority}</dd>
      </dl>

      <div className="block">
        <h3>Phases, software and licence cover</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Phase</th>
              <th>Dates</th>
              <th>Software · seats</th>
              <th>Licence cover</th>
              <th>Competing demand</th>
            </tr>
          </thead>
          <tbody>
            {project.phases.flatMap((ph) => {
              const covers = phaseCover(ds, project, ph, cache);
              return covers.map((c, i) => (
                <tr key={`${ph.id}-${c.licenceId}`}>
                  {i === 0 && (
                    <>
                      <td rowSpan={covers.length}>
                        <b style={{ fontWeight: 600 }}>{ph.name}</b>
                      </td>
                      <td rowSpan={covers.length} className="nowrap small">
                        {fmtDate(ph.start)} – {fmtDate(ph.end)}
                      </td>
                    </>
                  )}
                  <td>
                    <span className="mono small">{c.licenceId}</span> · {c.seats}
                    {ph.actualPeak?.[c.licenceId] !== undefined && <span className="muted small"> (actual peak {ph.actualPeak[c.licenceId]})</span>}
                  </td>
                  <td>
                    <CoverChip cover={c.cover} weeks={c.shortWeeks.length} />
                  </td>
                  <td className="small muted">{c.competing.projects ? `${c.competing.projects} other project${c.competing.projects > 1 ? 's' : ''} · ${c.competing.seats} seats` : '—'}</td>
                </tr>
              ));
            })}
          </tbody>
        </table>
        <p className="small muted" style={{ marginTop: 6 }}>
          Cover compares the forecast for each week of the phase with owned capacity: covered (P90 within capacity), tight (P90 above), short (expected P50 above). Competing demand counts other projects without naming them.
        </p>
      </div>

      <div className="block">
        <div className="row-between" style={{ marginBottom: 8 }}>
          <h3 style={{ border: 0, margin: 0, padding: 0 }}>Change requests</h3>
          {canPropose && !proposing && (
            <button className="btn sm" onClick={() => setProposing(true)}>
              <GitPullRequestArrow /> Propose a change
            </button>
          )}
        </div>
        {proposing && <ChangeForm project={project} onDone={() => setProposing(false)} />}
        {changes.length === 0 && !proposing && <p className="small muted">No changes proposed. Changes go to the department head for approval and the administrator for confirmation before the forecast uses them.</p>}
        {changes.map((c) => (
          <div key={c.id} className="row-between" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
            <span className="small">
              <span className="mono">{c.id}</span> · {c.before} → <b>{c.after}</b>
              <span className="muted" style={{ display: 'block' }}>
                {c.reason} · {c.proposedBy}, {fmtDateTime(c.proposedAt)}
              </span>
            </span>
            <span className="row">
              {c.status === 'applied' ? (
                <StatusChip status="implemented">Applied to forecast</StatusChip>
              ) : c.status === 'rejected' ? (
                <StatusChip status="rejected">Rejected</StatusChip>
              ) : (
                <StatusChip status="pending">{c.status === 'pending-dept' ? 'Awaiting department head' : 'Awaiting administrator'}</StatusChip>
              )}
              {((c.status === 'pending-dept' && perms.approveProjectChanges) || (c.status === 'pending-admin' && perms.confirmProjectChanges)) && (
                <>
                  <button className="btn sm danger" onClick={() => decide(c, 'reject')} aria-label="Reject change">
                    <X />
                  </button>
                  <button className="btn sm primary" onClick={() => decide(c, 'approve')}>
                    <Check /> {c.status === 'pending-dept' ? 'Approve' : 'Confirm'}
                  </button>
                </>
              )}
            </span>
          </div>
        ))}
      </div>

      <div className="block">
        <h3>Access requests tied to this project</h3>
        {requests.length === 0 && <p className="small muted">None.</p>}
        {requests.map((r) => (
          <div key={r.id} className="row-between small" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
            <span>
              <span className="mono">{r.id}</span> · {ds.users.find((u) => u.id === r.requesterId)?.name} · {ds.licences.find((l) => l.id === r.licenceId)?.product}
            </span>
            <RequestStatusChip status={r.status} />
          </div>
        ))}
      </div>
      {!perms.seesCosts && <p className="small muted block">Licence costs, contracts and other projects’ details are not shown for your role.</p>}
    </Drawer>
  );
}

export function ProjectsView({ embedded }: { embedded?: boolean }) {
  const { ds, state, perms } = useApp();
  const [params, setParams] = useSearchParams();
  const [showDone, setShowDone] = useState(false);
  const [view, setView] = useState<'timeline' | 'table'>('timeline');
  const [ref, width] = useWidth<HTMLDivElement>(1100);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a new cache whenever the dataset changes
  const cache = useMemo(() => new Map<string, ForecastResult>(), [ds]);
  void ds;

  const visible = ds.projects.filter((p) => {
    if (perms.projectScope && !perms.projectScope.includes(p.id)) return false;
    if (perms.deptScope && p.deptId !== perms.deptScope && !p.phases.some((ph) => ph.demand.some((d) => (ds.licences.find((l) => l.id === d.licenceId)?.allocations[perms.deptScope!] ?? 0) > 0))) return false;
    return showDone || p.status !== 'completed';
  });
  const start = showDone ? '2025-01-01' : '2026-09-01';
  const scale = makeScale(start, '2027-06-30', 230, Math.max(300, width - 240));
  const openId = params.get('open');
  const changeId = params.get('change');
  const changeProject = changeId ? state.projectChanges.find((c) => c.id === changeId)?.projectId : undefined;
  const open = ds.projects.find((p) => p.id === (openId ?? changeProject));
  const select = (p: Project) => {
    params.set('open', p.id);
    params.delete('change');
    setParams(params);
  };
  const pending = state.projectChanges.filter((c) => (c.status === 'pending-dept' && perms.approveProjectChanges) || (c.status === 'pending-admin' && perms.confirmProjectChanges));

  return (
    <>
      {!embedded && (
        <PageHead
          title={state.role === 'projectLead' ? 'My Project Timeline' : 'Projects'}
          sub={state.role === 'projectLead' ? 'Phases, software demand and whether licence capacity covers each phase.' : 'Every project on one timeline, with licence demand and cover per phase.'}
        />
      )}
      {pending.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <Callout tone="warn">
            <b>{pending.length} project change{pending.length > 1 ? 's' : ''} waiting for you.</b>{' '}
            {pending.map((c) => (
              <button key={c.id} className="code-ref" style={{ marginLeft: 6 }} onClick={() => select(ds.projects.find((p) => p.id === c.projectId)!)}>
                {c.id}
              </button>
            ))}
          </Callout>
        </div>
      )}
      <Panel
        flush
        title={view === 'timeline' ? 'Shared project timeline' : 'Project register'}
        sub={state.role === 'deptHead' ? 'Projects in or using your department’s licences — overlapping phases are visible before they collide' : 'Click a project for phases, licence cover and change requests'}
        actions={
          <>
            <label className="checkbox small">
              <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show completed
            </label>
            <div className="segmented">
              <button aria-pressed={view === 'timeline'} onClick={() => setView('timeline')}>
                Timeline
              </button>
              <button aria-pressed={view === 'table'} onClick={() => setView('table')}>
                Table
              </button>
            </div>
          </>
        }
        footer={view === 'timeline' ? <PhaseLegend /> : undefined}
      >
        <div ref={ref} style={{ padding: view === 'timeline' ? '4px 16px 12px' : 0 }}>
          {view === 'timeline' ? (
            <Gantt
              projects={visible}
              scale={scale}
              today={DEMO_TODAY}
              onSelect={select}
              selectedId={open?.id}
              shortWeeksFor={(p, ph) => phaseCover(ds, p, ph, cache).flatMap((c) => (c.cover === 'tight' || c.cover === 'short' ? c.shortWeeks : []))}
            />
          ) : (
            <DataTable
              rows={visible}
              rowKey={(p) => p.id}
              onRowClick={select}
              selectedKey={open?.id}
              columns={[
                { key: 'c', header: 'ID', render: (p) => <span className="mono">{p.code}</span>, sort: (p) => p.code },
                { key: 'n', header: 'Project', render: (p) => <span>{p.name} {p.critical && <StatusChip status="critical-project">Critical</StatusChip>}</span>, sort: (p) => p.name },
                { key: 'd', header: 'Department', render: (p) => p.ownerDeptName, sort: (p) => p.ownerDeptName },
                { key: 'l', header: 'Leader', render: (p) => ds.users.find((u) => u.id === p.leaderUserId)?.name },
                { key: 'pr', header: 'Priority', render: (p) => <span style={{ textTransform: 'capitalize' }}>{p.priority}</span>, sort: (p) => p.priority },
                { key: 's', header: 'Status', render: (p) => p.status, sort: (p) => p.status },
                { key: 'dt', header: 'Dates', render: (p) => <span className="nowrap">{fmtDate(p.phases[0].start)} – {fmtDate(p.phases[p.phases.length - 1].end)}</span>, sort: (p) => p.phases[0].start },
                { key: 'cf', header: 'Date status', render: (p) => (p.dateStatus === 'confirmed' ? 'Confirmed' : `Tentative (${Math.round(p.confidence * 100)}%)`) },
                { key: 'sw', header: 'Software needed', render: (p) => <span className="small">{[...new Set(p.phases.flatMap((ph) => ph.demand.map((d) => d.licenceId)))].join(', ')}</span> },
              ]}
            />
          )}
        </div>
      </Panel>
      {view === 'timeline' && <CombinedDemand projects={visible.filter((p) => p.status !== 'completed')} />}
      {open && (
        <ProjectDrawer
          project={open}
          onClose={() => {
            params.delete('open');
            params.delete('change');
            setParams(params, { replace: true });
          }}
        />
      )}
    </>
  );
}

const MONTHS = ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05'];

/** Combined demand per tool by month, so overlapping phases are visible before they collide. */
function CombinedDemand({ projects }: { projects: Project[] }) {
  const { ds } = useApp();
  const fcs = useForecasts(30);
  const tools = [...new Set(projects.flatMap((p) => p.phases.flatMap((ph) => ph.demand.map((d) => d.licenceId))))]
    .map((id) => ds.licences.find((l) => l.id === id)!)
    .filter(Boolean);
  const planned = (licId: string, month: string) => {
    let peak = 0;
    for (let d = 1; d <= 28; d += 7) {
      const day = `${month}-${String(d).padStart(2, '0')}`;
      const s = projects.reduce((a, p) => a + p.phases.filter((ph) => ph.start <= day && day <= ph.end).reduce((b, ph) => b + (ph.demand.find((x) => x.licenceId === licId)?.seats ?? 0), 0), 0);
      peak = Math.max(peak, s);
    }
    return peak;
  };
  const p90 = (licId: string, month: string) => {
    const pts = fcs[licId]?.f.points.filter((p) => p.week.startsWith(month)) ?? [];
    return pts.length ? Math.max(...pts.map((p) => p.p90)) : null;
  };
  if (!tools.length) return null;
  return (
    <Panel flush title="Combined demand per tool" sub="Peak planned project seats by month, with the forecast high-demand case (P90) against owned capacity" className="section-gap">
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Tool</th>
              <th className="num">Owned</th>
              {MONTHS.map((m) => (
                <th key={m} className="num">
                  {monthLabel(m, m.endsWith('-01') || m === MONTHS[0])}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tools.map((l) => (
              <tr key={l.id}>
                <td>
                  {l.product}
                  <span className="sub mono">{l.id}</span>
                </td>
                <td className="num">{l.seats}</td>
                {MONTHS.map((m) => {
                  const pl = planned(l.id, m);
                  const f = p90(l.id, m);
                  const over = f !== null && f > l.seats + 0.05;
                  return (
                    <td key={m} className="num" style={over ? { background: 'repeating-linear-gradient(135deg, rgba(154,91,0,0.10) 0 4px, transparent 4px 8px)' } : undefined} title={f !== null ? `Projects ${pl} seats · P90 ${f.toFixed(1)} vs ${l.seats} owned` : `Projects ${pl} named seats`}>
                      <b style={{ fontWeight: pl ? 600 : 400, color: pl ? 'var(--text)' : 'var(--text-3)' }}>{pl ? Math.round(pl * 10) / 10 : '·'}</b>
                      {f !== null && <span className={`sub ${over ? 'text-warn' : ''}`}>P90 {f.toFixed(1)}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export default function ProjectsPage() {
  return <ProjectsView />;
}
