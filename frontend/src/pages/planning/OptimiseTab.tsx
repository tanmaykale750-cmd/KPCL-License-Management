import { ArrowRight, Send } from 'lucide-react';
import { useMemo, useState } from 'react';
import { enumerateOptions, renewalAdvice, TEMP_PREMIUM, IDLE_RECOVERY_SHARE, type PlanOption } from '../../calc/plan';
import { DataTable } from '../../components/ui/DataTable';
import { Callout, Panel } from '../../components/ui/basics';
import { StatusChip } from '../../components/ui/StatusChip';
import { fmtDate } from '../../lib/dates';
import { hours, inrShort } from '../../lib/format';
import { useApp } from '../../state/store';

const ACTION_LABEL = { reallocate: 'Re-host idle seats', 'recover-idle': 'Recover idle check-outs', stagger: 'Stagger non-critical work', temporary: 'Temporary / pay-per-use', buy: 'Buy seats', reduce: 'Reduce at renewal', 'token-mix': 'Token mix' } as const;

export function OptimiseTab({ licenceId, horizon, onWhatIf }: { licenceId: string; horizon: number; onWhatIf: (o: PlanOption) => void }) {
  const { ds, state, perms, actions } = useApp();
  const fin = state.finance[0];
  const options = useMemo(() => enumerateOptions(ds, licenceId, fin, horizon), [ds, licenceId, fin, horizon]);
  const best = options.find((o) => o.feasible) ?? options[0];
  const [selId, setSelId] = useState<string | null>(null);
  const sel = options.find((o) => o.id === selId) ?? best;
  const lic = ds.licences.find((l) => l.id === licenceId)!;
  const advice = useMemo(() => renewalAdvice(ds, licenceId), [ds, licenceId]);
  const projName = (id: string) => ds.projects.find((p) => p.id === id)?.shortName ?? id;
  const already = state.recommendations.find((r) => r.licenceId === licenceId && r.status === 'pending' && r.source !== 'renewal-review');
  const noShort = options.length === 1;

  const submit = (o: PlanOption) => {
    const ev = o.evaluation;
    const affected = [...new Set(ev.forecast.points.filter((p) => p.p90 > p.capacity || p.projects.length).flatMap((p) => p.projects.map((c) => c.projectId)))];
    actions.submitRecommendation(
      {
        title: `${lic.product}: ${o.label}`,
        licenceId,
        projectIds: affected,
        actions: o.actions,
        rationale: `${o.summary} Ranked ${o.rank} of ${options.length} by total cost (licence cost + cost of blocked engineering time) over ${horizon} weeks. ${o.feasibilityNote}`,
        evidence: [...o.evidence, `Forecast run ${fmtDate('2026-10-25')} · ${horizon}-week horizon`],
        annualImpact: -Math.round(ev.extraCost),
        oneOffCost: 0,
        blockedHoursExpected: Math.round(ev.blockedHours),
        confidence: ev.forecast.backtest.beatsNaive ? 'medium' : 'low',
        source: 'optimiser',
        dueDate: ev.shortage.firstShortWeek ?? lic.renewalDate,
        seatsBefore: lic.seats,
        seatsAfter: lic.seats + Math.max(0, ev.input.seatsDelta),
      },
      lic.ownerDeptId,
    );
  };

  return (
    <div className="stack-lg">
      <Callout tone="teal">
        <b>How options are ranked.</b> Each plan is evaluated on the same forecast: <span className="mono">total cost = extra licence cost in the horizon + expected blocked hours × ₹{fin.loadedHourlyCost}/h × {fin.productivityLoss}</span>. A plan that leaves a forecast (P90) shortage while a <b>critical project</b> needs the tool is infeasible, however cheap. This is deterministic scenario enumeration over a fixed option set — not a trained optimiser.
      </Callout>
      {noShort ? (
        <Panel title="No shortage to solve" sub={`${lic.product} stays within ${lic.seats} ${lic.unitLabel} at P90 for ${horizon} weeks`}>
          {advice.reduceBy > 0 ? (
            <Callout tone="teal">
              <b>Renewal option:</b> keep {advice.keep} of {lic.seats}, saving <b>{inrShort(advice.annualSaving)}</b> a year from {fmtDate(lic.renewalDate)}. {advice.reason}
            </Callout>
          ) : (
            <Callout>Keep the current quantity. {advice.reason}</Callout>
          )}
        </Panel>
      ) : (
        <div className="grid-side" style={{ gridTemplateColumns: 'minmax(0,1fr) 380px' }}>
          <Panel flush title={`Options for the ${lic.product} shortage`} sub={`${options.length} plans · ${horizon}-week horizon · cheapest feasible first`}>
            <DataTable
              rows={options}
              rowKey={(o) => o.id}
              onRowClick={(o) => setSelId(o.id)}
              selectedKey={sel.id}
              rowClass={(o) => (o.feasible ? '' : '')}
              columns={[
                { key: 'r', header: '#', render: (o) => <span className="mono">{o.rank}</span> },
                { key: 'l', header: 'Plan', width: 260, render: (o) => <span>{o.label}<span className="sub">{o.actions.map((a) => ACTION_LABEL[a]).join(' + ') || 'No change'}</span></span> },
                ...(perms.seesCosts ? [{ key: 'x', header: 'Licence cost', num: true, render: (o: PlanOption) => <span className="est">{inrShort(o.evaluation.extraCost)}</span> }] : []),
                { key: 'b', header: 'Blocked h', num: true, render: (o) => `${Math.round(o.evaluation.blockedRange[0])}–${Math.round(o.evaluation.blockedRange[1])}`, title: 'Expected blocked engineer-hours, range for demand ±0.5σ' },
                ...(perms.seesCosts
                  ? [
                      { key: 'bc', header: 'Blocked cost', num: true, render: (o: PlanOption) => inrShort(o.evaluation.blockedCost) },
                      { key: 't', header: 'Total cost', num: true, render: (o: PlanOption) => <b style={{ fontWeight: 600 }}>{inrShort(o.evaluation.totalCost)}</b> },
                    ]
                  : []),
                { key: 'f', header: 'Feasible', render: (o) => (o.feasible ? <StatusChip status="healthy">{o.rank === best.rank ? 'Best feasible' : 'Feasible'}</StatusChip> : <StatusChip status="rejected">Breaks rule</StatusChip>) },
              ]}
            />
          </Panel>
          <Panel
            title={sel.label}
            sub={`Rank ${sel.rank} · lead time ${sel.leadTime}`}
            footer={
              <>
                <button className="btn" onClick={() => onWhatIf(sel)}>
                  Open in what-if <ArrowRight />
                </button>
                {perms.submitRecommendations && sel.feasible && sel.id !== 'do-nothing' && (
                  <button className="btn primary" onClick={() => submit(sel)} disabled={!!already}>
                    <Send /> Submit for approval
                  </button>
                )}
              </>
            }
          >
            <p style={{ fontSize: 12.5, lineHeight: 1.5 }}>{sel.summary}</p>
            <div style={{ marginTop: 10 }}>{sel.feasible ? <Callout tone="ok">{sel.feasibilityNote}</Callout> : <Callout tone="warn">{sel.feasibilityNote}</Callout>}</div>
            <table className="statement" style={{ marginTop: 10 }}>
              <tbody>
                {perms.seesCosts && (
                  <tr>
                    <td>Extra licence cost (estimate)</td>
                    <td className="num est">{inrShort(sel.evaluation.extraCost)}</td>
                  </tr>
                )}
                <tr>
                  <td>Forecast shortage weeks left</td>
                  <td className="num">{sel.evaluation.shortage.forecastShortWeeks.length}</td>
                </tr>
                <tr>
                  <td>Expected blocked hours</td>
                  <td className="num">
                    {hours(sel.evaluation.blockedHours)} <span className="muted small">({Math.round(sel.evaluation.blockedRange[0])}–{Math.round(sel.evaluation.blockedRange[1])})</span>
                  </td>
                </tr>
                {sel.evaluation.donorImpact && (
                  <tr>
                    <td>Impact on {sel.evaluation.donorImpact.licenceId}</td>
                    <td className="num">{sel.evaluation.donorImpact.shortWeeks} shortage weeks</td>
                  </tr>
                )}
                {perms.seesCosts && (
                  <tr className="total">
                    <td>Total cost (licence + blocked time)</td>
                    <td className="num">{inrShort(sel.evaluation.totalCost)}</td>
                  </tr>
                )}
              </tbody>
            </table>
            <div className="block">
              <h3>Affected projects</h3>
              <p className="small">{[...new Set(sel.evaluation.forecast.points.filter((p) => p.projects.length).flatMap((p) => p.projects.map((c) => projName(c.projectId))))].join(', ') || '—'}</p>
            </div>
            <div className="block">
              <h3>Assumptions</h3>
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                {sel.assumptions.length ? sel.assumptions.map((a) => <li key={a}>{a}</li>) : <li>None beyond the forecast</li>}
              </ul>
            </div>
            <div className="block">
              <h3>Risks</h3>
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                {sel.risks.length ? sel.risks.map((a) => <li key={a}>{a}</li>) : <li>—</li>}
              </ul>
            </div>
            <div className="block">
              <h3>Evidence</h3>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                {sel.evidence.map((e) => (
                  <span key={e} className="chip neutral" style={{ fontWeight: 500 }}>
                    {e}
                  </span>
                ))}
              </div>
            </div>
            {already && <p className="small muted block">A plan for this pool is already awaiting approval ({already.id}).</p>}
          </Panel>
        </div>
      )}
      <p className="small muted">
        Fixed assumptions: temporary access at {TEMP_PREMIUM}× the annual seat’s weekly rate; idle time-out recovers {Math.round(IDLE_RECOVERY_SHARE * 100)}% of idle check-out time; purchases have a 12-month minimum term. Replace with vendor quotes before approval.
      </p>
    </div>
  );
}
