import { ArrowRight, MessageSquareText, Plus, UserMinus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../../api/session';
import { accessRoute, shortWeeks } from '../../calc/access';
import { DataTable } from '../../components/ui/DataTable';
import { Dialog } from '../../components/ui/Overlay';
import { StatusChip } from '../../components/ui/StatusChip';
import { Callout, Field, PageHead, Panel } from '../../components/ui/basics';
import type { AccessRequest, Licence } from '../../domain/types';
import { DEMO_TODAY, daysBetween, fmtDate } from '../../lib/dates';
import { num, pct } from '../../lib/format';
import { openAssistant } from '../../lib/scope';
import { useApp } from '../../state/store';
import { RequestStatusChip } from '../ops/RequestsPage';

/**
 * My Licences — the engineer's landing page: the licences they use and how they get each one, whether those tools
 * will be available, their last logged session, their access requests and who to contact.
 */

interface Entitlement {
  key: string;
  lic: Licence;
  how: string;
  source: string;
  status: 'active' | 'granted' | 'approved' | 'requested';
  until?: string;
  lastActive?: string;
  activeHours?: number;
}

export default function MyLicencesPage() {
  const { ds, state, me, team, actions } = useApp();
  const session = useSession();
  const [release, setRelease] = useState<Entitlement | null>(null);
  const [reason, setReason] = useState('Released by the holder: no longer needed');
  const [err, setErr] = useState('');
  const myDept = ds.departments.find((d) => d.id === me.deptId);
  const self = team?.members.find((m) => m.employee_id === session.employee_id);
  const sessions = self?.sessions ?? [];
  const myRequests = state.requests.filter((r) => r.requesterId === me.id);

  const ents = useMemo<Entitlement[]>(() => {
    const out: Entitlement[] = [];
    const seen = new Set<string>();
    for (const id of session.scope.app_licence_ids ?? []) {
      const lic = ds.licences.find((l) => l.id === id);
      if (!lic) continue;
      seen.add(lic.id);
      out.push({ key: `hr-${id}`, lic, how: accessRoute(lic, me.deptId, myDept?.name ?? session.department), source: 'Primary tool in your employee record', status: 'active' });
    }
    for (const a of ds.assignments.filter((x) => x.userId === me.id)) {
      const lic = ds.licences.find((l) => l.id === a.licenceId)!;
      if (seen.has(lic.id)) continue;
      seen.add(lic.id);
      out.push({ key: `as-${a.licenceId}`, lic, how: 'Named seat assigned to you', source: `Assigned ${fmtDate(a.assignedOn)}`, status: 'active', lastActive: a.lastActive, activeHours: a.activeHours12m });
    }
    for (const r of myRequests.filter((x) => x.status === 'fulfilled' || x.status === 'approved' || x.status === 'submitted' || x.status === 'more-info')) {
      const lic = ds.licences.find((l) => l.id === r.licenceId)!;
      out.push({
        key: `rq-${r.id}`,
        lic,
        how: r.status === 'fulfilled' ? r.fulfilment ?? 'Granted' : r.status === 'approved' ? 'Approved — the licence administrator fulfils it next' : 'Requested — waiting for your department head',
        source: `Request ${r.id}`,
        status: r.status === 'fulfilled' ? 'granted' : r.status === 'approved' ? 'approved' : 'requested',
        until: r.until,
      });
    }
    return out;
  }, [ds, me.id, me.deptId, myDept, session, myRequests]);

  const contacts = team?.contacts ?? [];
  const last = sessions[0];
  const idleShare = last ? last.Idle_Duration_Hrs / Math.max(0.1, last.Session_Duration_Hrs) : 0;
  const tight = ents.filter((e) => e.lic.forecastable && shortWeeks(ds, e.lic, 12) !== 'none');

  return (
    <>
      <PageHead
        title="My Licences"
        sub="The licences you use, how you get each one, whether they will be available, and your requests."
        actions={
          <Link className="btn primary" to="/access-requests?new=1">
            <Plus /> Request software
          </Link>
        }
      />
      {tight.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <Callout tone="warn">
            <b>{tight.map((e) => e.lic.product).join(', ')}</b> {tight.length === 1 ? 'is' : 'are'} forecast to be short in the next 12 weeks ({tight.map((e) => shortWeeks(ds, e.lic, 12)).join('; ')}). If you need {tight.length === 1 ? 'it' : 'them'} then, request early and close the tool when idle.
          </Callout>
        </div>
      )}
      <div className="grid-2-wide">
        <div className="stack-lg">
          <Panel flush title="Your licences" sub="From your employee record, seats assigned to you and requests you made">
            <DataTable
              rows={ents}
              rowKey={(e) => e.key}
              empty={<div className="empty"><b>No licences yet.</b><Link className="btn primary" style={{ marginTop: 10 }} to="/access-requests?new=1"><Plus /> Request software</Link></div>}
              columns={[
                { key: 'sw', header: 'Software', render: (e) => <span>{e.lic.product}<span className="sub mono">{e.lic.id} · {e.lic.type}</span></span> },
                { key: 'how', header: 'How you get it', render: (e) => <span>{e.how}<span className="sub">{e.source}{e.until ? ` · until ${fmtDate(e.until)}` : ''}</span></span> },
                {
                  key: 'st',
                  header: 'Status',
                  render: (e) =>
                    e.status === 'active' ? (
                      e.lastActive && daysBetween(e.lastActive, DEMO_TODAY) >= 90 ? <StatusChip status="underused">Unused {daysBetween(e.lastActive, DEMO_TODAY)} days</StatusChip> : <StatusChip status="healthy">Active</StatusChip>
                    ) : e.status === 'granted' ? (
                      <StatusChip status="implemented">Granted</StatusChip>
                    ) : e.status === 'approved' ? (
                      <StatusChip status="approved">Approved</StatusChip>
                    ) : (
                      <StatusChip status="submitted">Requested</StatusChip>
                    ),
                },
                { key: 'av', header: 'Availability, next 12 weeks', render: (e) => { const w = shortWeeks(ds, e.lic, 12); return w === 'none' ? <span>Expected available</span> : w === '—' ? <span className="muted">{e.lic.type === 'named' ? 'Yours while assigned' : 'Not forecast'}</span> : <span className="text-warn">Tight: {w}</span>; } },
                { key: 'act', header: '', render: (e) => (e.key.startsWith('as-') ? <button className="btn sm" onClick={() => setRelease(e)}><UserMinus /> Release</button> : null) },
              ]}
            />
          </Panel>

          <Panel title="Your last logged session" sub="From the licence telemetry in your employee record">
            {last ? (
              <>
                <div className="kv-strip" style={{ marginBottom: 8 }}>
                  <span>
                    Tool <b>{last.Software_Tool}</b>
                  </span>
                  <span>
                    Started <b>{last.Session_Start.slice(0, 16)}</b>
                  </span>
                  <span>
                    Checked out <b>{num(last.Session_Duration_Hrs, 1)} h</b>
                  </span>
                  <span>
                    Active <b>{num(last.Active_Usage_Hrs, 1)} h</b>
                  </span>
                  <span>
                    Idle <b>{num(last.Idle_Duration_Hrs, 1)} h ({pct(idleShare)})</b>
                  </span>
                  <span>
                    CPU/GPU <b>{pct(last.CPU_GPU_Utilization_Pct)}</b>
                  </span>
                </div>
                {last.Idle_Session_Flag === 1 ? (
                  <Callout tone="warn">
                    This session was flagged <b>idle</b> ({last.Recommended_Action}). An idle checkout holds a licence a colleague could use — close {last.Software_Tool} when you step away, especially in busy weeks.
                  </Callout>
                ) : (
                  <Callout tone="ok">Active session — the licence was in real use. Thank you for closing it when done.</Callout>
                )}
              </>
            ) : (
              <p className="small muted">No session is logged for you yet.</p>
            )}
          </Panel>

          <Panel
            flush
            title="Your access requests"
            sub="Your department head decides; the licence administrator fulfils by the cheapest route that works"
            actions={
              <Link className="btn sm" to="/access-requests">
                All requests <ArrowRight />
              </Link>
            }
          >
            <DataTable
              rows={myRequests}
              rowKey={(r: AccessRequest) => r.id}
              initialSort={{ key: 'sub', dir: 'desc' }}
              empty={<div className="empty">No requests yet.</div>}
              columns={[
                { key: 'id', header: 'ID', render: (r) => <Link className="mono" to={`/access-requests?open=${r.id}`}>{r.id}</Link> },
                { key: 'sw', header: 'Software', render: (r) => ds.licences.find((l) => l.id === r.licenceId)?.product },
                { key: 'dt', header: 'Needed', render: (r) => <span className="nowrap">{fmtDate(r.from)} → {fmtDate(r.until)}</span> },
                { key: 'st', header: 'Status', render: (r) => <RequestStatusChip status={r.status} /> },
                { key: 'sub', header: 'Submitted', render: (r) => <span className="mono small">{r.submittedAt}</span>, sort: (r) => r.submittedAt },
              ]}
            />
          </Panel>
        </div>

        <div className="stack-lg">
          <Panel title="You">
            <dl className="dl">
              <dt>Name</dt>
              <dd>
                {session.name} <span className="mono muted">{session.employee_id}</span>
              </dd>
              <dt>Designation</dt>
              <dd>{session.designation}</dd>
              <dt>Department</dt>
              <dd>
                {session.department}
                {myDept && <span className="muted"> · licence group {myDept.fullName}</span>}
              </dd>
              <dt>Project</dt>
              <dd>{session.scope.app_project_ids.map((id) => ds.projects.find((p) => p.id === id)?.name ?? id).join(', ') || session.scope.projects.join(', ') || '—'}</dd>
              <dt>Primary tool</dt>
              <dd>{session.scope.primary_tool ?? '—'}</dd>
            </dl>
          </Panel>
          <Panel title="Who to contact">
            {contacts.length === 0 && <p className="small muted">Loading…</p>}
            <ul className="timeline-list">
              {contacts.map((c) => (
                <li key={c.employee_id}>
                  <div className="when">{c.relation}</div>
                  <div>
                    <b style={{ fontWeight: 600 }}>{c.name}</b> · {c.designation}
                    <div className="muted small">{c.email}</div>
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title="Ask the assistant" sub="Answers come from the forecast, the simulation and the recommendation engine">
            <div className="stack">
              {[
                `Which pools are riskiest for ${session.scope.primary_tool ?? 'ANSYS'}?`,
                'Will ANSYS be available for PF001 in December?',
                'What does shortage chance mean?',
              ].map((q) => (
                <button key={q} className="suggest" onClick={() => openAssistant(q)}>
                  {q} <MessageSquareText aria-hidden />
                </button>
              ))}
            </div>
          </Panel>
        </div>
      </div>

      {release && (
        <Dialog
          title="Release your seat"
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
                  actions.changeAssignment({ licenceId: release.lic.id, userId: me.id, action: 'revoke', reason: reason.trim() });
                  setRelease(null);
                }}
              >
                Release
              </button>
            </>
          }
        >
          <p className="small" style={{ marginBottom: 10 }}>
            {release.lic.product}: the seat goes back to the pool for a colleague. You can request it again later.
          </p>
          <Field label="Reason" error={err} htmlFor="ml-rel">
            <input id="ml-rel" className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </Dialog>
      )}
    </>
  );
}
