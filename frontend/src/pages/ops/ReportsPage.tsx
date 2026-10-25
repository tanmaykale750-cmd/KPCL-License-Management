import { Download, FileSpreadsheet, Printer } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { forecast, shortageSummary } from '../../calc/forecast';
import { DEFAULT_FILTERS, departmentBreakdown, licenceRows } from '../../calc/metrics';
import { renewalAdvice } from '../../calc/plan';
import { verifiedSaving } from '../../calc/review';
import { recStatusChip } from '../../components/records/RecommendationDrawer';
import { Field, PageHead, Panel, SectionLabel } from '../../components/ui/basics';
import { downloadCSV } from '../../lib/csv';
import { addDays, DEMO_TODAY, fmtDate } from '../../lib/dates';
import { inrShort, pct } from '../../lib/format';
import { scopedFilters, useApp } from '../../state/store';

export default function ReportsPage() {
  const { ds, state, perms } = useApp();
  const filters = scopedFilters({ ...DEFAULT_FILTERS, months: 12 }, perms);
  const rows = useMemo(() => licenceRows(ds, filters), [ds, filters.deptId]); // eslint-disable-line react-hooks/exhaustive-deps
  const due = rows.filter((r) => r.daysToRenewal >= 0 && r.daysToRenewal <= 365).sort((a, b) => a.daysToRenewal - b.daysToRenewal);
  const [licId, setLicId] = useState(due.find((r) => renewalAdvice(ds, r.licence.id).reduceBy > 0)?.licence.id ?? due[0]?.licence.id ?? ds.licences[0].id);
  const row = rows.find((r) => r.licence.id === licId)!;
  const lic = row.licence;
  const advice = useMemo(() => renewalAdvice(ds, licId), [ds, licId]);
  const fc = useMemo(() => (lic.forecastable ? forecast(ds, licId, { horizonWeeks: 52 }) : null), [ds, licId, lic.forecastable]);
  const short = fc ? shortageSummary(fc) : null;
  const holders = ds.assignments.filter((a) => a.licenceId === licId);
  const recs = state.recommendations.filter((r) => r.licenceId === licId);
  const noticeBy = addDays(lic.renewalDate, -lic.noticeDays);
  const vendor = ds.vendors.find((v) => v.id === lic.vendorId);

  const exportsList = [
    {
      name: 'Licence inventory',
      desc: 'Every pool with type, seats, contract, renewal and utilisation (12 months).',
      run: () => downloadCSV('licence-inventory-sample.csv', rows.map((r) => ({ id: r.licence.id, product: r.licence.product, type: r.licence.type, seats: r.seats, utilisation_pct: Math.round(r.util * 100), denials: r.denials, renewal: r.licence.renewalDate, contract: r.licence.contractRef, ...(perms.seesCosts ? { annual_spend_inr: r.spend, idle_spend_inr: Math.round(r.idleSpend) } : {}) }))),
    },
    {
      name: 'Department utilisation',
      desc: 'Spend and use by department group.',
      hidden: !perms.seesCosts,
      run: () => downloadCSV('department-utilisation-sample.csv', departmentBreakdown(ds, filters).map((d) => ({ department: d.name, seats: d.seats, utilisation_pct: Math.round(d.util * 100), spend_inr: d.spend, idle_spend_inr: Math.round(d.idleSpend), blocked_hours: Math.round(d.blocked) }))),
    },
    {
      name: 'Shortage forecast (26 weeks)',
      desc: 'Weekly P50, P90 and owned capacity for every forecast pool.',
      run: () =>
        downloadCSV(
          'shortage-forecast-sample.csv',
          ds.licences
            .filter((l) => l.forecastable)
            .flatMap((l) => forecast(ds, l.id, { horizonWeeks: 26 }).points.map((p) => ({ pool: l.id, week: p.week, p50: p.p50.toFixed(2), p90: p.p90.toFixed(2), owned: p.capacity }))),
        ),
    },
    {
      name: 'Outcome register',
      desc: 'Approved actions, implementation state and verified savings.',
      hidden: !perms.areas.includes('review'),
      run: () => downloadCSV('outcome-register-sample.csv', state.review.map((r) => ({ record: r.id, action: r.title, state: r.state, approved_inr: r.approvedValue, verified_inr: verifiedSaving(r), po: r.poRef ?? '' }))),
    },
    {
      name: 'Access requests',
      desc: 'All requests with status and decision reason.',
      hidden: !perms.areas.includes('requests'),
      run: () => downloadCSV('access-requests-sample.csv', state.requests.filter((r) => !perms.deptScope || ds.users.find((u) => u.id === r.requesterId)?.deptId === perms.deptScope).map((r) => ({ id: r.id, licence: r.licenceId, project: r.projectId, from: r.from, until: r.until, status: r.status, urgency: r.urgency, decided_by: r.decidedBy ?? '', reason: r.decisionReason ?? '' }))),
    },
    {
      name: 'Audit log',
      desc: 'Every change made in this demo session, with actor and role.',
      hidden: !perms.editRegistry,
      run: () => downloadCSV('audit-log-sample.csv', state.audit.map((a) => ({ id: a.id, at: a.at, actor: a.actor, role: a.role, entity: a.entity, entity_id: a.entityId, action: a.action, before: a.before ?? '', after: a.after ?? '' }))),
    },
  ].filter((e) => !e.hidden);

  return (
    <>
      <div className="no-print">
        <PageHead
          title="Reports"
          sub="Renewal briefs and data exports. Every export is labelled as sample data."
          actions={
            <>
              <Field label="Renewal brief for" htmlFor="rep-lic">
                <select id="rep-lic" className="select" value={licId} onChange={(e) => setLicId(e.target.value)}>
                  {due.map((r) => (
                    <option key={r.licence.id} value={r.licence.id}>
                      {fmtDate(r.licence.renewalDate)} · {r.licence.product}
                    </option>
                  ))}
                </select>
              </Field>
              <button className="btn primary" onClick={() => window.print()} style={{ alignSelf: 'flex-end' }}>
                <Printer /> Print brief
              </button>
            </>
          }
        />
      </div>

      <div className="grid-side" style={{ gridTemplateColumns: 'minmax(0, 1fr) 340px' }}>
        <article className="panel brief print-area" aria-label="Renewal brief">
          <div className="panel-body">
            <div className="brief-head">
              <div>
                <div className="label-caps">Renewal brief · sample data</div>
                <h2>{lic.product}</h2>
                <div className="small muted mono">
                  {lic.id} · {lic.contractRef} · {vendor?.name}
                </div>
              </div>
              <div className="right small">
                Prepared {fmtDate(DEMO_TODAY, 'long')}
                <div className="muted">Licence Intelligence (prototype)</div>
              </div>
            </div>

            <div className="brief-answer">
              {advice.reduceBy > 0 ? (
                <>
                  Renew <b>{advice.keep}</b> of {lic.seats} {lic.unitLabel}
                  {perms.seesCosts && (
                    <>
                      {' '}
                      — saving <b>{inrShort(advice.annualSaving)}</b> a year (estimate)
                    </>
                  )}
                  .
                </>
              ) : short && short.forecastShortWeeks.length ? (
                <>
                  Renew all {lic.seats} {lic.unitLabel}; the forecast shows a shortage of up to {short.maxGapP90.toFixed(1)} in the next 52 weeks.
                </>
              ) : (
                <>Renew {lic.seats} {lic.unitLabel}; use supports the current quantity.</>
              )}
            </div>

            <table className="statement">
              <tbody>
                <tr>
                  <td>Renewal date</td>
                  <td className="num">{fmtDate(lic.renewalDate, 'long')}</td>
                </tr>
                <tr>
                  <td>Notice deadline ({lic.noticeDays} days)</td>
                  <td className="num">{noticeBy < DEMO_TODAY ? <span className="text-crit">{fmtDate(noticeBy, 'long')} — passed</span> : fmtDate(noticeBy, 'long')}</td>
                </tr>
                <tr>
                  <td>Owned / contract minimum</td>
                  <td className="num">
                    {lic.seats} / {lic.contractMinSeats} {lic.unitLabel}
                  </td>
                </tr>
                <tr>
                  <td>Utilisation, last 12 months</td>
                  <td className="num">{pct(row.util)}</td>
                </tr>
                <tr>
                  <td>Peak concurrent use (weekly)</td>
                  <td className="num">{row.peak.toFixed(1)}</td>
                </tr>
                <tr>
                  <td>Denied requests, last 12 months</td>
                  <td className="num">{row.denials}</td>
                </tr>
                {lic.type === 'named' && (
                  <tr>
                    <td>Named holders · unused 90+ days</td>
                    <td className="num">
                      {holders.length} · {holders.filter((a) => a.lastActive <= addDays(DEMO_TODAY, -90)).length}
                    </td>
                  </tr>
                )}
                {fc && (
                  <tr>
                    <td>52-week high-demand peak (P90)</td>
                    <td className="num">{Math.max(...fc.points.map((p) => p.p90)).toFixed(1)}</td>
                  </tr>
                )}
                {perms.seesCosts && (
                  <>
                    <tr className="total">
                      <td>Current annual cost</td>
                      <td className="num">{inrShort(lic.seats * lic.costPerSeat)}</td>
                    </tr>
                    <tr>
                      <td>Recommended annual cost</td>
                      <td className="num est">{inrShort(advice.keep * lic.costPerSeat)}</td>
                    </tr>
                  </>
                )}
              </tbody>
            </table>

            <div className="block">
              <h3>Basis</h3>
              <p className="small">{advice.reason}</p>
              <p className="small muted">Evidence: {advice.evidence.join(' · ')}. Figures come from synthetic sample data and must be replaced with KPCL’s licence logs and invoices before a real decision.</p>
            </div>

            <div className="block">
              <h3>Approval status</h3>
              {recs.length ? (
                recs.map((r) => (
                  <div key={r.id} className="row-between small" style={{ padding: '6px 0', borderTop: '1px solid var(--border)' }}>
                    <span>
                      <span className="mono">{r.id}</span> · {r.title}
                    </span>
                    {recStatusChip(r)}
                  </div>
                ))
              ) : (
                <p className="small muted">No recommendation submitted for this renewal yet.</p>
              )}
            </div>
            <div className="brief-sign">
              <div>Licence administrator</div>
              <div>Department head</div>
              <div>Finance</div>
            </div>
          </div>
        </article>

        <div className="stack-lg no-print">
          <Panel title="Data exports" sub="CSV · opens in Excel · first line marks it as sample data">
            <div className="stack" style={{ gap: 0 }}>
              {exportsList.map((e) => (
                <div key={e.name} className="row-between" style={{ padding: '10px 0', borderTop: '1px solid var(--border)', gap: 10 }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 12.5 }}>
                      <FileSpreadsheet style={{ width: 14, height: 14, verticalAlign: -2, color: 'var(--teal)' }} /> {e.name}
                    </div>
                    <div className="small muted">{e.desc}</div>
                  </div>
                  <button className="btn sm" onClick={e.run} aria-label={`Download ${e.name}`}>
                    <Download />
                  </button>
                </div>
              ))}
            </div>
          </Panel>
          {perms.areas.includes('planning') && (
            <>
              <SectionLabel>Related</SectionLabel>
              <div className="small">
                <Link to={`/planning?tab=forecast&licence=${lic.forecastable ? lic.id : 'ANS-MECH'}`}>Open the forecast →</Link>
                <br />
                <Link to="/software?view=renewals">All renewals →</Link>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
