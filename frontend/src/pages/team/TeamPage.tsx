import { ArrowRight, UserMinus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { RosterPerson } from '../../api/client';
import { accessRoute, shortWeeks } from '../../calc/access';
import { DataTable } from '../../components/ui/DataTable';
import { Dialog } from '../../components/ui/Overlay';
import { StatusChip } from '../../components/ui/StatusChip';
import { Callout, Field, MiniBar, PageHead, Panel } from '../../components/ui/basics';
import type { Project } from '../../domain/types';
import { DEMO_TODAY, daysBetween, fmtDate } from '../../lib/dates';
import { num, plural } from '../../lib/format';
import { rosterUser, useApp } from '../../state/store';
import { RequestStatusChip } from '../ops/RequestsPage';

/**
 * Team & Access — one page, three views:
 *   Department Head  the department's people (HR roster), what each holds, the department's share of every pool,
 *                    idle seats to release and access requests to decide
 *   Project Head     the project team, the licences each project phase needs and the requests tied to the project
 *   Admin (Head)     every department, with a department filter
 */

const PROJECT_CODES: Record<string, string> = { 'ALL-DEPT': 'All department projects', 'PRJ-SYS-00': 'Licence administration' };

const PROFILE_TONE: Record<string, 'info' | 'approved' | 'pending' | 'healthy'> = { admin: 'info', deptHead: 'approved', projectLead: 'pending', engineer: 'healthy' };

export function LastSession({ p }: { p: RosterPerson }) {
  const s = p.sessions?.[0];
  if (!s) return <span className="muted small">no session logged</span>;
  const idle = s.Idle_Session_Flag === 1;
  return (
    <span className="nowrap">
      {fmtDate(s.Session_Start.slice(0, 10))} · {num(s.Active_Usage_Hrs, 1)} h active / {num(s.Session_Duration_Hrs, 1)} h
      <span style={{ marginLeft: 6 }}>{idle ? <StatusChip status="underused">Idle {num(s.Idle_Duration_Hrs, 1)} h</StatusChip> : <StatusChip status="healthy">Active</StatusChip>}</span>
    </span>
  );
}

export default function TeamPage() {
  const { ds, state, perms, team, actions, me } = useApp();
  const role = state.role;
  const [deptFilter, setDeptFilter] = useState<string>(perms.deptScope ?? 'all');
  const [release, setRelease] = useState<{ licenceId: string; userId: string } | null>(null);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');

  const deptId = perms.deptScope ?? (deptFilter === 'all' ? null : deptFilter);
  const dept = ds.departments.find((d) => d.id === deptId);
  const deptName = dept?.fullName ?? 'all departments';
  const members = useMemo(() => (team?.members ?? []).filter((m) => !deptId || role !== 'admin' || m.app_dept_id === deptId), [team, deptId, role]);
  const userId = (p: RosterPerson) => rosterUser(p).id;

  const myProjects: Project[] = useMemo(() => ds.projects.filter((p) => perms.projectScope?.includes(p.id)), [ds.projects, perms.projectScope]);
  const scopedRequests = state.requests.filter((r) => {
    if (role === 'projectLead') return perms.projectScope?.includes(r.projectId);
    if (!deptId) return true;
    return ds.users.find((u) => u.id === r.requesterId)?.deptId === deptId;
  });
  const toDecide = scopedRequests.filter((r) => (perms.approveRequests ? r.status === 'submitted' : perms.fulfilRequests ? r.status === 'approved' : r.status === 'submitted' || r.status === 'approved'));

  const deptLicences = ds.licences.filter((l) => !deptId || (l.allocations[deptId] ?? 0) > 0 || ds.assignments.some((a) => a.licenceId === l.id && ds.users.find((u) => u.id === a.userId)?.deptId === deptId));
  const deptAssignments = ds.assignments.filter((a) => !deptId || ds.users.find((u) => u.id === a.userId)?.deptId === deptId);
  const idle = deptAssignments.filter((a) => daysBetween(a.lastActive, DEMO_TODAY) >= 90);
  const idleSessions = members.filter((m) => m.sessions?.[0]?.Idle_Session_Flag === 1).length;

  const title = 'Team & Access';
  const sub =
    role === 'deptHead'
      ? `${dept?.fullName ?? ''} — who uses which licence, the department's share of every pool, idle seats to release and the access requests you decide.`
      : role === 'projectLead'
        ? `Your project team, the licences each phase of ${myProjects.map((p) => p.shortName).join(', ') || 'your project'} needs, and the requests tied to it.`
        : 'Every department: people from the HR roster, their licence access, idle seats and access decisions.';

  const kpis =
    role === 'projectLead'
      ? [
          { label: 'People on your projects', value: members.length, meta: 'HR roster' },
          { label: 'Phases still to come', value: myProjects.flatMap((p) => p.phases).filter((ph) => ph.end >= DEMO_TODAY).length, meta: 'with licence demand' },
          { label: 'Requests tied to your projects', value: scopedRequests.length, meta: `${toDecide.length} open` },
          { label: 'Idle sessions (last log)', value: idleSessions, meta: 'team members flagged idle' },
        ]
      : [
          { label: role === 'admin' && !deptId ? 'People (HR roster)' : 'People in the department', value: members.length, meta: 'HR roster' },
          { label: 'Named seats held', value: deptAssignments.length, meta: `${deptName} · sample registry` },
          { label: 'Idle 90+ days', value: idle.length, meta: perms.editAssignments ? 'release to free a seat' : 'seats nobody opened' },
          { label: perms.approveRequests ? 'Requests to decide' : perms.fulfilRequests ? 'Requests to fulfil' : 'Open requests', value: toDecide.length, meta: 'Access Requests' },
        ];

  return (
    <>
      <PageHead
        title={title}
        sub={sub}
        actions={
          role === 'admin' ? (
            <label className="field-inline">
              <span>Department</span>
              <select className="select" value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} aria-label="Department">
                <option value="all">All departments</option>
                {ds.departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.fullName}
                  </option>
                ))}
              </select>
            </label>
          ) : undefined
        }
      />
      <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
        {kpis.map((k) => (
          <div key={k.label} className="kpi">
            <div className="kpi-label">{k.label}</div>
            <div className="kpi-value">{k.value}</div>
            <div className="kpi-meta">{k.meta}</div>
          </div>
        ))}
      </div>

      {toDecide.length > 0 && (perms.approveRequests || perms.fulfilRequests) && (
        <div style={{ marginBottom: 12 }}>
          <Callout tone="warn">
            <b>{plural(toDecide.length, 'access request')} waiting for you.</b> <Link to="/access-requests">Open Access Requests</Link> to {perms.approveRequests ? 'approve, reject or ask for information' : 'fulfil by the cheapest route'}.
          </Callout>
        </div>
      )}

      <div className="stack-lg">
        <Panel flush title={role === 'projectLead' ? 'Project team (HR roster)' : 'People (HR roster)'} sub="From the employee records; the last logged licence session comes from the roster's telemetry sheet">
          <DataTable
            rows={members}
            rowKey={(m) => m.employee_id}
            initialSort={{ key: 'p', dir: 'asc' }}
            empty={<div className="empty">{team ? 'Nobody in this scope.' : 'Loading the roster…'}</div>}
            columns={[
              { key: 'n', header: 'Person', render: (m) => <span>{m.name}<span className="sub">{m.employee_id} · {m.designation}</span></span>, sort: (m) => m.name },
              { key: 'p', header: 'Profile', render: (m) => <StatusChip status={PROFILE_TONE[m.role ?? 'engineer'] ?? 'info'}>{m.profile_label}</StatusChip>, sort: (m) => ['admin', 'deptHead', 'projectLead', 'engineer'].indexOf(m.role ?? 'engineer') },
              ...(role === 'admin' ? [{ key: 'd', header: 'Department', render: (m: RosterPerson) => m.department, sort: (m: RosterPerson) => m.department }] : []),
              { key: 'pr', header: 'Project', render: (m) => m.app_project_ids.map((id) => ds.projects.find((p) => p.id === id)?.shortName ?? id).join(', ') || <span className="muted">{m.projects.map((x) => PROJECT_CODES[x] ?? x).join(', ')}</span> },
              {
                key: 't',
                header: 'Primary tool · access route',
                render: (m) => {
                  const lic = ds.licences.find((l) => l.id === m.app_licence_id);
                  const dn = ds.departments.find((d) => d.id === m.app_dept_id)?.name ?? m.department;
                  return lic ? <span>{m.primary_tool}<span className="sub">{accessRoute(lic, m.app_dept_id, dn)}</span></span> : <span className="muted">{m.primary_tool ?? '—'}</span>;
                },
              },
              { key: 's', header: 'Last logged session', render: (m) => <LastSession p={m} />, sort: (m) => m.sessions?.[0]?.Idle_Session_Flag ?? -1 },
              { key: 'r', header: 'Requests', num: true, render: (m) => num(state.requests.filter((r) => r.requesterId === userId(m)).length), sort: (m) => state.requests.filter((r) => r.requesterId === userId(m)).length },
            ]}
          />
        </Panel>

        {role === 'projectLead' && <ProjectDemand projects={myProjects} />}

        {role !== 'projectLead' && (
          <Panel flush title={`Licence access for ${deptName}`} sub="Shared pools: seats reserved for the department group. Named licences: seats held by the department's people. Shortage = weeks where the forecast high case (P90) exceeds the pool.">
            <DataTable
              rows={deptLicences}
              rowKey={(l) => l.id}
              initialSort={{ key: 'sw', dir: 'asc' }}
              columns={[
                { key: 'sw', header: 'Software', render: (l) => <span>{l.product}<span className="sub mono">{l.id} · {l.type}</span></span>, sort: (l) => l.product },
                {
                  key: 'al',
                  header: 'Department share',
                  render: (l) => {
                    if (l.type === 'named') {
                      const n = deptAssignments.filter((a) => a.licenceId === l.id).length;
                      return <span className="bar-cell" style={{ minWidth: 150 }}><MiniBar value={n} max={l.seats} /> {n} of {l.seats} named</span>;
                    }
                    const n = deptId ? l.allocations[deptId] ?? 0 : Object.values(l.allocations).reduce((a, b) => a + b, 0);
                    return <span className="bar-cell" style={{ minWidth: 150 }}><MiniBar value={n} max={l.seats} /> {n} of {l.seats} reserved</span>;
                  },
                },
                { key: 'id', header: 'Idle 90+ days', num: true, render: (l) => (l.type === 'named' ? num(idle.filter((a) => a.licenceId === l.id).length) : '—') },
                { key: 'rq', header: 'Pending requests', num: true, render: (l) => num(scopedRequests.filter((r) => r.licenceId === l.id && (r.status === 'submitted' || r.status === 'approved')).length) },
                { key: 'sh', header: 'Forecast shortage (26 wk)', render: (l) => { const w = shortWeeks(ds, l); return w === 'none' ? <span className="muted">none</span> : w === '—' ? <span className="muted">not forecast</span> : <span className="text-warn">{w}</span>; } },
                { key: 'go', header: '', render: (l) => (l.forecastable && perms.areas.includes('planning') ? <Link className="btn sm" to={`/planning?tab=forecast&licence=${l.id}`}>Forecast <ArrowRight /></Link> : null) },
              ]}
            />
          </Panel>
        )}

        {role !== 'projectLead' && (
          <Panel flush title="Named seats unused for 90+ days" sub={perms.editAssignments ? 'Confirm with the holder, then release the seat back to the pool (recorded in the audit trail)' : 'Seats nobody has opened in three months'}>
            <DataTable
              rows={idle}
              rowKey={(a) => `${a.licenceId}-${a.userId}`}
              pageSize={10}
              initialSort={{ key: 'last', dir: 'desc' }}
              empty={<div className="empty">No idle named seats.</div>}
              columns={[
                { key: 'u', header: 'Holder', render: (a) => { const u = ds.users.find((x) => x.id === a.userId); return <span>{u?.name}<span className="sub">{u?.team}</span></span>; } },
                { key: 'l', header: 'Licence', render: (a) => ds.licences.find((l) => l.id === a.licenceId)?.product },
                { key: 'last', header: 'Last used', render: (a) => <StatusChip status="unverified">{daysBetween(a.lastActive, DEMO_TODAY)} days ago</StatusChip>, sort: (a) => daysBetween(a.lastActive, DEMO_TODAY) },
                { key: 'h', header: 'Active h (12m)', num: true, render: (a) => num(a.activeHours12m) },
                ...(perms.editAssignments
                  ? [{ key: 'act', header: '', render: (a: (typeof idle)[number]) => (a.userId === me.id ? null : <button className="btn sm" onClick={() => setRelease({ licenceId: a.licenceId, userId: a.userId })}><UserMinus /> Release seat</button>) }]
                  : []),
              ]}
            />
          </Panel>
        )}

        <Panel flush title={role === 'projectLead' ? 'Access requests tied to your projects' : `Access requests · ${deptName}`} sub="Engineers request; the department head decides; the licence administrator fulfils">
          <DataTable
            rows={scopedRequests}
            rowKey={(r) => r.id}
            pageSize={8}
            initialSort={{ key: 'sub', dir: 'desc' }}
            empty={<div className="empty">No requests.</div>}
            columns={[
              { key: 'id', header: 'ID', render: (r) => <Link className="mono" to={`/access-requests?open=${r.id}`}>{r.id}</Link> },
              { key: 'who', header: 'Requester', render: (r) => ds.users.find((u) => u.id === r.requesterId)?.name ?? r.requesterId },
              { key: 'sw', header: 'Software', render: (r) => ds.licences.find((l) => l.id === r.licenceId)?.product },
              { key: 'prj', header: 'Project', render: (r) => ds.projects.find((p) => p.id === r.projectId)?.shortName ?? r.projectId },
              { key: 'dt', header: 'Needed', render: (r) => <span className="nowrap">{fmtDate(r.from)} → {fmtDate(r.until)}</span> },
              { key: 'st', header: 'Status', render: (r) => <RequestStatusChip status={r.status} /> },
              { key: 'sub', header: 'Submitted', render: (r) => <span className="mono small">{r.submittedAt}</span>, sort: (r) => r.submittedAt },
            ]}
          />
        </Panel>
      </div>

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
                  if (reason.trim().length < 8) return setErr('A reason is required (at least 8 characters).');
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
            {ds.users.find((u) => u.id === release.userId)?.name} · {ds.licences.find((l) => l.id === release.licenceId)?.product}. Confirm with the holder first. Recorded in the prototype only; no vendor portal is changed.
          </p>
          <Field label="Reason" error={err} htmlFor="tm-rel">
            <input id="tm-rel" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Holder confirmed no use since July" />
          </Field>
        </Dialog>
      )}
    </>
  );
}

/** Project head: which licences each phase needs, when, and whether access has been arranged. */
function ProjectDemand({ projects }: { projects: Project[] }) {
  const { ds, state, perms } = useApp();
  const rows = projects.flatMap((p) =>
    p.phases.flatMap((ph) =>
      ph.demand.map((d) => {
        const lic = ds.licences.find((l) => l.id === d.licenceId)!;
        const arranged = state.requests.filter((r) => r.projectId === p.id && r.licenceId === d.licenceId && (r.status === 'fulfilled' || r.status === 'approved')).length;
        const open = state.requests.filter((r) => r.projectId === p.id && r.licenceId === d.licenceId && (r.status === 'submitted' || r.status === 'more-info')).length;
        const when = ph.end < DEMO_TODAY ? 'done' : ph.start <= DEMO_TODAY ? 'now' : 'upcoming';
        return { p, ph, d, lic, arranged, open, when };
      }),
    ),
  );
  return (
    <Panel flush title="Licences your project phases need" sub="Planned seats per phase from the project registry; shortage weeks are for the whole pool, not only your project">
      <DataTable
        rows={rows}
        rowKey={(r) => `${r.ph.id}-${r.d.licenceId}`}
        initialSort={{ key: 'start', dir: 'asc' }}
        rowClass={(r) => (r.when === 'done' ? 'muted' : '')}
        columns={[
          { key: 'ph', header: 'Phase', render: (r) => <span>{r.ph.name}<span className="sub">{r.p.shortName}</span></span> },
          { key: 'start', header: 'Dates', render: (r) => <span className="nowrap">{fmtDate(r.ph.start)} → {fmtDate(r.ph.end)}</span>, sort: (r) => r.ph.start },
          { key: 'w', header: 'When', render: (r) => (r.when === 'now' ? <StatusChip status="approved">In progress</StatusChip> : r.when === 'done' ? <StatusChip status="cancelled">Done</StatusChip> : <StatusChip status="pending">Upcoming</StatusChip>) },
          { key: 'l', header: 'Licence', render: (r) => r.lic.product },
          { key: 's', header: 'Seats planned', num: true, render: (r) => num(r.d.seats) },
          { key: 'a', header: 'Access arranged', num: true, render: (r) => `${r.arranged}${r.open ? ` (+${r.open} open)` : ''}` },
          { key: 'f', header: 'Pool shortage (26 wk)', render: (r) => { const w = shortWeeks(ds, r.lic); return w === 'none' ? <span className="muted">none</span> : w === '—' ? <span className="muted">not forecast</span> : <span className="text-warn">{w}</span>; } },
          {
            key: 'go',
            header: '',
            render: (r) =>
              r.when === 'upcoming' && r.lic.forecastable && perms.runWhatIf !== 'none' ? (
                <Link className="btn sm" to={`/planning?tab=whatif&licence=${r.lic.id}&project=${r.p.id}&shift=2`}>
                  What if +2 wk <ArrowRight />
                </Link>
              ) : null,
          },
        ]}
      />
    </Panel>
  );
}
