import { ArrowRight, Check, CircleDashed, Hourglass, X } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Recommendation } from '../../domain/types';
import { fmtDate, fmtDateTime } from '../../lib/dates';
import { inrShort, num } from '../../lib/format';
import { STEP_LABEL } from '../../state/roles';
import { useApp } from '../../state/store';
import { canDecideRecommendation, nextStep } from '../../state/workflow';
import { Drawer } from '../ui/Overlay';
import { StatusChip } from '../ui/StatusChip';
import { Callout, Field } from '../ui/basics';

export function recStatusChip(r: Recommendation) {
  switch (r.status) {
    case 'pending': {
      const s = nextStep(r);
      return <StatusChip status="pending">Awaiting {s ? STEP_LABEL[s].toLowerCase() : 'decision'}</StatusChip>;
    }
    case 'approved':
      return <StatusChip status="approved">Approved</StatusChip>;
    case 'rejected':
      return <StatusChip status="rejected">Rejected</StatusChip>;
    case 'implemented':
      return <StatusChip status="implemented">Implemented</StatusChip>;
    default:
      return <span className="chip neutral">{r.status}</span>;
  }
}

export function RecommendationDrawer({ rec, onClose }: { rec: Recommendation; onClose: () => void }) {
  const { ds, state, perms, me, actions } = useApp();
  const nav = useNavigate();
  const lic = ds.licences.find((l) => l.id === rec.licenceId)!;
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const can = canDecideRecommendation(rec, state.role, me.name, perms.approvalSteps, perms.deptScope, lic.ownerDeptId);
  const fin = state.finance[0];
  const projectNames = rec.projectIds.map((id) => ds.projects.find((p) => p.id === id)?.shortName ?? id).join(', ');

  const decide = (d: 'approved' | 'rejected') => {
    if (d === 'rejected' && reason.trim().length < 5) {
      setErr('A reason is required to reject (at least 5 characters).');
      return;
    }
    actions.decideRecommendation(rec.id, d, reason.trim());
    setReason('');
    setErr('');
  };

  return (
    <Drawer
      wide
      eyebrow={`${rec.id} · ${rec.source === 'renewal-review' ? 'Renewal review' : rec.source === 'scenario' ? `Scenario ${rec.scenarioRev ?? ''}` : 'Optimiser'} · Tier ${rec.approvalTier}`}
      title={rec.title}
      onClose={onClose}
      aside={<div className="row" style={{ marginTop: 8 }}>{recStatusChip(rec)}</div>}
      footer={
        rec.status === 'pending' ? (
          can.ok ? (
            <>
              <button className="btn danger" onClick={() => decide('rejected')}>
                <X /> {can.step === 'deptHead' && !can.blocking ? 'Object' : 'Reject'}
              </button>
              <button className="btn primary" onClick={() => decide('approved')}>
                <Check /> {can.step === 'deptHead' && !can.blocking ? 'Endorse' : 'Approve'} as {STEP_LABEL[can.step!]}
              </button>
            </>
          ) : (
            <span className="small muted">{can.reason}</span>
          )
        ) : rec.status === 'approved' ? (
          <button className="btn primary" onClick={() => nav('/review')}>
            Open implementation record <ArrowRight />
          </button>
        ) : undefined
      }
    >
      {/* Recommendation panel order: action, ₹ impact, risk, confidence, evidence, alternatives, approval status */}
      <table className="statement" style={{ marginBottom: 6 }}>
        <tbody>
          <tr>
            <td style={{ width: 190 }} className="muted">Action</td>
            <td>{rec.title}{rec.seatsBefore !== undefined && rec.seatsAfter !== undefined && <span className="muted"> · {rec.seatsBefore} → {rec.seatsAfter} {lic.unitLabel}</span>}</td>
          </tr>
          <tr>
            <td className="muted">₹ impact (estimate)</td>
            <td className="num">
              {perms.seesCosts ? (
                <span className="est">
                  {rec.annualImpact >= 0 ? `${inrShort(rec.annualImpact)} a year saved` : `${inrShort(-rec.annualImpact)} extra`}
                  {rec.oneOffCost > 0 && ` · one-off ${inrShort(rec.oneOffCost)}`}
                </span>
              ) : (
                <span className="muted">Not shown for your role</span>
              )}
            </td>
          </tr>
          <tr>
            <td className="muted">Risk</td>
            <td>{rec.blockedHoursExpected > 0 ? `${num(rec.blockedHoursExpected)} expected blocked engineer-hours (≈ ${inrShort(rec.blockedHoursExpected * fin.loadedHourlyCost * fin.productivityLoss)} at finance's rate)` : 'No expected shortage from this change'}</td>
          </tr>
          <tr>
            <td className="muted">Confidence</td>
            <td style={{ textTransform: 'capitalize' }}>{rec.confidence}</td>
          </tr>
          <tr>
            <td className="muted">Affected</td>
            <td>
              {lic.product} <span className="mono muted">{lic.id}</span>
              {projectNames && <span className="muted"> · {projectNames}</span>}
            </td>
          </tr>
          <tr>
            <td className="muted">Due</td>
            <td>{fmtDate(rec.dueDate, 'long')} (renewal {fmtDate(lic.renewalDate)})</td>
          </tr>
        </tbody>
      </table>

      <div className="block">
        <h3>Why</h3>
        <p style={{ fontSize: 12.5, lineHeight: 1.55 }}>{rec.rationale}</p>
        <div className="row" style={{ flexWrap: 'wrap', marginTop: 8 }}>
          {rec.evidence.map((e) => (
            <span key={e} className="chip neutral" style={{ fontWeight: 500 }}>
              {e}
            </span>
          ))}
        </div>
      </div>

      <div className="block">
        <h3>Sign-off</h3>
        <div className="signoff">
          {(['deptHead', ...rec.requiredApprovers.filter((x) => x !== 'deptHead')] as const).map((step) => {
            const a = rec.approvals.find((x) => x.step === step);
            const waiting = !a && nextStep(rec) === step;
            const consulted = step === 'deptHead' && !rec.requiredApprovers.includes('deptHead');
            return (
              <div key={step} className="signoff-row">
                {a ? a.decision === 'approved' ? <Check color="var(--ok)" /> : <X color="var(--crit)" /> : waiting ? <Hourglass color="var(--warn)" /> : <CircleDashed color="var(--text-3)" />}
                <b style={{ fontWeight: 600 }}>
                  {STEP_LABEL[step]}
                  {consulted && <span className="muted" style={{ fontWeight: 400 }}> (consulted)</span>}
                </b>
                <span className="muted">{a ? `${a.decision === 'approved' ? (consulted ? 'Endorsed' : 'Approved') : consulted ? 'Objected' : 'Rejected'} · ${a.by}${a.reason ? ` — “${a.reason}”` : ''}` : waiting ? 'Waiting' : consulted ? 'Not yet consulted' : 'Not yet'}</span>
                <span className="mono muted small">{a ? fmtDateTime(a.at) : ''}</span>
              </div>
            );
          })}
        </div>
        <p className="small muted" style={{ marginTop: 6 }}>
          Tier {rec.approvalTier} by value against the limits set by the Admin (Head) ({inrShort(state.limits.tier1)} / {inrShort(state.limits.tier2)}). Tier 1: administrator (department head consulted). Tier 2: department head, then administrator. Tier 3: plus a final sign-off by a second administrator. Nobody approves their own submission.
        </p>
      </div>

      {rec.status === 'pending' && can.ok && (
        <div className="block">
          <Field label="Reason (required to reject, optional to approve)" error={err} htmlFor="rec-reason">
            <textarea id="rec-reason" className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Confirmed with the department head; keep two buffer seats." />
          </Field>
        </div>
      )}
      {rec.status === 'approved' && (
        <div className="block">
          <Callout tone="ok">Approved. An implementation record is open in Review &amp; Savings. The saving is <b>approved, not verified</b>, until invoice evidence confirms it.</Callout>
        </div>
      )}

      <div className="block">
        <h3>History</h3>
        <ul className="timeline-list">
          {[...rec.history].reverse().map((h, i) => (
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
      <p className="small muted block">AI recommends; a person approves. Approving records the decision only — no licence server, vendor portal or ERP is changed by this prototype.</p>
    </Drawer>
  );
}
