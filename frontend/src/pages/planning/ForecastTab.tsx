import { useMemo, useState } from 'react';
import { baselineDetail, forecast, shortageSummary } from '../../calc/forecast';
import { CanvasLegend, PlanningCanvas } from '../../components/charts/PlanningCanvas';
import { Gantt, makeScale } from '../../components/charts/Gantt';
import { Callout, Panel } from '../../components/ui/basics';
import { StatusChip } from '../../components/ui/StatusChip';
import { HISTORY_WEEKS } from '../../data/generate';
import { useWidth } from '../../hooks/useWidth';
import { DEMO_TODAY, addWeeks, fmtDate } from '../../lib/dates';
import { hours, inrShort, num, pct } from '../../lib/format';
import { useApp } from '../../state/store';
import { EnginePanel } from './EnginePanel';

export function ForecastTab({ licenceId, horizon }: { licenceId: string; horizon: number }) {
  const { ds, state, perms } = useApp();
  const fin = state.finance[0];
  const f = useMemo(() => forecast(ds, licenceId, { horizonWeeks: horizon }), [ds, licenceId, horizon]);
  const s = useMemo(() => shortageSummary(f), [f]);
  const [ref, width] = useWidth<HTMLDivElement>(1000);
  const histWeeks = 26;
  const start = addWeeks(f.points[0].week, -histWeeks);
  const end = addWeeks(f.points[f.points.length - 1].week, 1);
  const scale = makeScale(start, end, 190, Math.max(300, width - 190 - 70));
  const worst = f.points.reduce((m, p) => (p.p90 - p.capacity > m.p90 - m.capacity ? p : m), f.points[0]);
  const [week, setWeek] = useState<string | null>(null);
  const sel = f.points.find((p) => p.week === week) ?? worst;
  const bd = baselineDetail(f, sel.week);
  const projName = (id: string) => ds.projects.find((p) => p.id === id)?.shortName ?? id;
  const relevant = ds.projects.filter((p) => p.status !== 'completed' && p.phases.some((ph) => ph.demand.some((d) => d.licenceId === licenceId) && ph.end >= start));
  const visibleProjects = perms.projectScope ? relevant.filter((p) => perms.projectScope!.includes(p.id)) : relevant;
  const totalPlanned = f.ratio.source.reduce((a, r) => a + r.planned, 0);
  const totalActual = f.ratio.source.reduce((a, r) => a + r.actual, 0);
  const lic = f.licence;

  return (
    <div className="grid-side" style={{ gridTemplateColumns: 'minmax(0,1fr) 400px' }}>
      <div className="stack-lg">
        <EnginePanel />
        <Panel
          title={`${lic.product} · weekly peak concurrent demand`}
          sub={`Last ${histWeeks} weeks of actuals, then a ${horizon}-week forecast · baseline from usage history + project layer from the registry`}
          footer={<CanvasLegend />}
        >
          <div ref={ref}>
            <PlanningCanvas f={f} scale={scale} height={300} historyWeeks={histWeeks} selectedWeek={sel.week} onSelectWeek={(w) => w >= f.points[0].week && setWeek(w)} projectName={projName} unit={lic.unitLabel} />
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 2 }}>
              <div className="label-caps" style={{ padding: '6px 0 0' }}>
                Project phases needing {lic.id} · same time axis
              </div>
              <Gantt projects={visibleProjects} scale={scale} today={DEMO_TODAY} highlightLicence={licenceId} rowHeight={28} todayLabel={false} />
            </div>
          </div>
        </Panel>
        <div className="grid-2">
          <Panel title="Forecast accuracy (backtest)" sub={`Re-run as if a year earlier, compared with what happened · ${f.backtest.weeks} weeks`} footer={<span className="takeaway">Measured on the synthetic sample data. It shows the method works, not real-world accuracy, which the pilot will measure on KPCL's logs.</span>}>
            <table className="statement">
              <tbody>
                <tr>
                  <td>Mean absolute error (peak seats)</td>
                  <td className="num">{f.backtest.mae.toFixed(2)}</td>
                </tr>
                <tr>
                  <td>Weighted absolute % error (WAPE)</td>
                  <td className="num">{pct(f.backtest.wape, 1)}</td>
                </tr>
                <tr>
                  <td>Error vs “same week last year” (MASE)</td>
                  <td className="num">
                    {f.backtest.mase.toFixed(2)} {f.backtest.beatsNaive ? <StatusChip status="healthy">beats baseline</StatusChip> : <StatusChip status="forecast-shortage">does not beat baseline</StatusChip>}
                  </td>
                </tr>
                <tr>
                  <td>Weeks at or below P90 (target ≈ 90%)</td>
                  <td className="num">{pct(f.backtest.coverage)}</td>
                </tr>
                <tr>
                  <td>Spread of errors (σ)</td>
                  <td className="num">{f.backtest.sigma.toFixed(2)} seats</td>
                </tr>
              </tbody>
            </table>
          </Panel>
          <Panel title="Data and assumptions" sub="What this forecast uses">
            <dl className="dl" style={{ gridTemplateColumns: '150px 1fr', fontSize: 12 }}>
              <dt>Usage history</dt>
              <dd>{HISTORY_WEEKS} weeks of weekly peaks, including denied requests</dd>
              <dt>Headcount growth</dt>
              <dd>× {f.growth.toFixed(3)} (department plans, weighted by allocation)</dd>
              <dt>Calibration ratio</dt>
              <dd>
                {f.ratio.value.toFixed(2)} {f.ratio.fallback ? '(all-tools fallback)' : `from ${f.ratio.source.length} past phase${f.ratio.source.length === 1 ? '' : 's'}`}
              </dd>
              <dt>Tentative projects</dt>
              <dd>Weighted by confidence in P50; full demand in P90</dd>
              <dt>Licence rules</dt>
              <dd>
                {lic.type === 'floating' ? 'Floating seats are shared within this pool only' : lic.type === 'token' ? 'Seat-equivalents of a unit pool' : lic.type === 'node-locked' ? 'Node-locked: limited to licensed workstations' : 'Named seats cannot be shared'}
                {lic.baseLicenceId ? `; add-on requires ${lic.baseLicenceId}` : ''}
              </dd>
              <dt>Blocked hours / seat-week</dt>
              <dd>{f.beta.toFixed(1)} h, measured from past denials</dd>
            </dl>
          </Panel>
        </div>
      </div>

      <Panel
        title="Explain this forecast"
        sub={`Week of ${fmtDate(sel.week, 'long')} · click any forecast week to change`}
        footer={perms.seesCosts && s.blockedHours > 0 ? <span className="takeaway">Doing nothing: about <b>{hours(s.blockedHours)}</b> blocked over the horizon ≈ <b>{inrShort(s.blockedHours * fin.loadedHourlyCost * fin.productivityLoss)}</b> at finance’s rate.</span> : undefined}
      >
        <table className="statement">
          <tbody>
            <tr>
              <td>
                <b style={{ fontWeight: 600 }}>Baseline demand</b>
                <div className="small muted">
                  Routine peak in the same week of the last two years ({bd.y1 !== null ? bd.y1.toFixed(1) : '—'} and {bd.y2 !== null ? bd.y2.toFixed(1) : '—'}, average {bd.avg.toFixed(1)}) × growth {bd.growth.toFixed(3)}
                </div>
              </td>
              <td className="num">{sel.baseline.toFixed(1)}</td>
            </tr>
            {sel.projects.map((c) => (
              <tr key={c.phaseId}>
                <td>
                  <b style={{ fontWeight: 600 }}>
                    {projName(c.projectId)}: {c.phaseName}
                  </b>
                  <div className="small muted">
                    {c.planned} planned × ratio {f.ratio.value.toFixed(2)}
                    {c.tentative ? ` × ${Math.round((ds.projects.find((p) => p.id === c.projectId)?.confidence ?? 1) * 100)}% confidence` : ''}
                    {c.seats < c.planned * f.ratio.value * 0.99 && !c.tentative ? ' (phase ramp)' : ''}
                  </div>
                </td>
                <td className="num">+{c.seats.toFixed(1)}</td>
              </tr>
            ))}
            <tr className="total">
              <td>Expected demand (P50)</td>
              <td className="num">{sel.p50.toFixed(1)}</td>
            </tr>
            <tr>
              <td>
                High-demand case (P90)
                <div className="small muted">P50 + 1.28 × σ ({f.backtest.sigma.toFixed(2)}){sel.p90 - sel.p50 - 1.28 * f.backtest.sigma > 0.05 ? ' + tentative upside' : ''}</div>
              </td>
              <td className="num">{sel.p90.toFixed(1)}</td>
            </tr>
            <tr>
              <td>Owned {lic.unitLabel}</td>
              <td className="num">{sel.capacity}</td>
            </tr>
            <tr className="total">
              <td>Gap at P50 / P90</td>
              <td className="num">
                {sel.p90 > sel.capacity ? (
                  <span className="text-warn">
                    {Math.max(0, sel.p50 - sel.capacity).toFixed(1)} to {(sel.p90 - sel.capacity).toFixed(1)} short
                  </span>
                ) : (
                  <span className="text-ok">covered</span>
                )}
              </td>
            </tr>
          </tbody>
        </table>

        <div className="block">
          <h3>Calibration from past projects</h3>
          {f.ratio.source.length ? (
            <table className="table table-compact" style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th>Past project · phase</th>
                  <th className="num">Planned</th>
                  <th className="num">Actual</th>
                  <th className="num">Ratio</th>
                </tr>
              </thead>
              <tbody>
                {f.ratio.source.map((r) => (
                  <tr key={r.projectId}>
                    <td>
                      {r.projectName}
                      <span className="sub">{r.phaseName}</span>
                    </td>
                    <td className="num">{r.planned}</td>
                    <td className="num">{r.actual}</td>
                    <td className="num">{(r.actual / r.planned).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Combined</td>
                  <td className="num">{num(totalPlanned)}</td>
                  <td className="num">{num(totalActual)}</td>
                  <td className="num">{f.ratio.value.toFixed(2)}</td>
                </tr>
              </tfoot>
            </table>
          ) : (
            <Callout>No completed phases used this tool, so the all-tools ratio ({f.ratio.value.toFixed(2)}) is applied and the forecast is labelled lower confidence.</Callout>
          )}
          <p className="small muted" style={{ marginTop: 6 }}>
            The ratio corrects for planned seats rarely all running at the same moment.
          </p>
        </div>
      </Panel>
    </div>
  );
}
