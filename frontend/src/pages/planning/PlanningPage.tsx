import { ArrowRight } from 'lucide-react';
import { useMemo } from 'react';
import { forecast, runs, shortageSummary } from '../../calc/forecast';
import { enumerateOptions, type PlanOption } from '../../calc/plan';
import { PageHead, Tabs } from '../../components/ui/basics';
import type { ScenarioParams } from '../../domain/types';
import { fmtDate } from '../../lib/dates';
import { hours, inrShort } from '../../lib/format';
import { useApp } from '../../state/store';
import { Assistant } from './Assistant';
import { ForecastTab } from './ForecastTab';
import { OptimiseTab } from './OptimiseTab';
import { SupplyTab } from './SupplyTab';
import { usePlanning, type PlanTab } from './usePlanning';
import { WhatIfTab, baselineParams } from './WhatIfTab';

const HORIZONS = [13, 26, 39];

function AnswerBand({ licenceId, horizon, onGo }: { licenceId: string; horizon: number; onGo: (tab: PlanTab) => void }) {
  const { ds, state, perms } = useApp();
  const fin = state.finance[0];
  const f = useMemo(() => forecast(ds, licenceId, { horizonWeeks: horizon }), [ds, licenceId, horizon]);
  const s = useMemo(() => shortageSummary(f), [f]);
  const best = useMemo(() => (perms.seesCosts && s.forecastShortWeeks.length ? enumerateOptions(ds, licenceId, fin, horizon).find((o) => o.feasible) : undefined), [ds, licenceId, fin, horizon, perms.seesCosts, s.forecastShortWeeks.length]);
  const lic = f.licence;
  const peak = f.points.reduce((m, p) => (p.p90 - p.capacity > m.p90 - m.capacity ? p : m), f.points[0]);
  const windows = runs(s.forecastShortWeeks);
  const critical = [...new Set(f.points.filter((p) => p.p90 > p.capacity).flatMap((p) => p.projects.map((c) => c.projectId)))]
    .map((id) => ds.projects.find((p) => p.id === id))
    .filter((p) => p?.critical);
  const short = s.forecastShortWeeks.length > 0;

  const cells: { label: string; value: string; note: string }[] = [
    { label: 'Peak P50–P90', value: `${peak.p50.toFixed(1)}–${peak.p90.toFixed(1)}`, note: `week of ${fmtDate(peak.week)}` },
    { label: `Owned ${lic.unitLabel}`, value: String(peak.capacity), note: lic.type },
    { label: 'Shortage', value: short ? `${s.forecastShortWeeks.length} wk` : 'None', note: short ? windows.map((w) => `${fmtDate(w.start).slice(0, 6)}–${fmtDate(w.end).slice(0, 6)}`).join(', ') : `within ${horizon} weeks` },
    { label: 'Blocked if no action', value: hours(s.blockedHours), note: perms.seesCosts ? `≈ ${inrShort(s.blockedHours * fin.loadedHourlyCost * fin.productivityLoss)}` : 'expected, estimate' },
  ];

  return (
    <section className="answer-band" aria-label="Planning answer">
      <div className="answer-q">
        <div className="label-caps">Will we have enough?</div>
        <h2>
          {short ? (
            <>
              <span className="text-warn-ink">No</span> — {lic.product} is short by up to {Math.ceil(peak.p90 - peak.capacity)} {lic.unitLabel} in the high-demand case
            </>
          ) : (
            <>
              Yes — {lic.product} stays within capacity for {horizon} weeks
            </>
          )}
        </h2>
        <p>
          {short && critical.length ? `${critical.map((p) => p!.shortName).join(', ')} is critical and needs this tool in the shortage window. ` : ''}
          {best ? (
            <>
              Cheapest plan that protects critical work: <b>{best.label}</b> ({inrShort(best.evaluation.totalCost)} total cost).
            </>
          ) : short ? (
            'See the options to compare plans.'
          ) : (
            'No action needed for supply; check the renewal option on Options.'
          )}
        </p>
      </div>
      <dl className="answer-cells">
        {cells.map((c) => (
          <div key={c.label}>
            <dt>{c.label}</dt>
            <dd className="mono">{c.value}</dd>
            <span>{c.note}</span>
          </div>
        ))}
      </dl>
      <div className="answer-go">
        <button className="btn ink" onClick={() => onGo('forecast')}>
          Why this forecast <ArrowRight />
        </button>
        {perms.seesCosts && (
          <button className="btn ink primary" onClick={() => onGo('optimise')}>
            Compare options <ArrowRight />
          </button>
        )}
      </div>
    </section>
  );
}

export default function PlanningPage() {
  const { ds, perms } = useApp();
  const { tab, licenceId, horizon, pools, set, params } = usePlanning();
  const lic = ds.licences.find((l) => l.id === licenceId)!;

  const visiblePools = perms.deptScope ? pools.filter((l) => (l.allocations[perms.deptScope!] ?? 0) > 0) : pools;

  // A what-if can be seeded from an optimiser option (?seed=) or a project move (?project=&shift=).
  const seed: ScenarioParams | null = useMemo(() => {
    const raw = params.get('seed');
    if (raw) {
      try {
        const p = JSON.parse(raw) as ScenarioParams;
        if (p.licenceId === licenceId) return { ...p, horizonWeeks: horizon };
      } catch {
        /* ignore malformed seed */
      }
    }
    const project = params.get('project');
    const shift = Number(params.get('shift'));
    if (project && shift) return { ...baselineParams(licenceId, lic.seats, horizon), projectShifts: { [project]: shift } };
    return null;
  }, [params, licenceId, lic.seats, horizon]);

  const openWhatIf = (o: PlanOption) => {
    const i = o.evaluation.input;
    const p: ScenarioParams = {
      licenceId: i.licenceId,
      seats: lic.seats + i.seatsDelta,
      temporarySeats: i.tempSeats,
      temporaryWeeks: i.tempWeeks,
      ...(i.tempStart ? { temporaryStart: i.tempStart } : {}),
      projectShifts: i.projectShifts,
      projectDurationPct: i.durationPct,
      teamSizePct: i.teamSizePct,
      recoverIdle: i.recoverIdle,
      reallocateSeats: i.reallocate,
      horizonWeeks: horizon,
    };
    set({ tab: 'whatif', seed: JSON.stringify(p), project: null, shift: null });
  };

  const tabs: { id: PlanTab; label: string; hidden?: boolean }[] = [
    { id: 'forecast', label: 'Forecast' },
    { id: 'supply', label: 'Supply vs demand' },
    { id: 'optimise', label: 'Options', hidden: !perms.seesCosts },
    { id: 'whatif', label: 'What-if', hidden: perms.runWhatIf === 'none' },
    { id: 'assistant', label: 'Assistant' },
  ];
  const active = tabs.find((t) => t.id === tab && !t.hidden)?.id ?? 'forecast';

  return (
    <>
      <PageHead
        title="Planning Studio"
        sub="Forecast demand, compare options and test what-ifs before anything changes."
        actions={
          <>
            <label className="field-inline">
              <span>Pool</span>
              <select className="select" value={licenceId} onChange={(e) => set({ licence: e.target.value, seed: null, project: null, shift: null })} aria-label="Licence pool">
                {visiblePools.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.product} ({l.id})
                  </option>
                ))}
              </select>
            </label>
            <label className="field-inline">
              <span>Horizon</span>
              <select className="select" value={horizon} onChange={(e) => set({ h: e.target.value })} aria-label="Forecast horizon">
                {HORIZONS.map((h) => (
                  <option key={h} value={h}>
                    {h} weeks
                  </option>
                ))}
              </select>
            </label>
          </>
        }
      />
      {active !== 'supply' && active !== 'assistant' && <AnswerBand licenceId={licenceId} horizon={horizon} onGo={(t) => set({ tab: t })} />}
      <Tabs tabs={tabs} value={active} onChange={(t) => set({ tab: t })} label="Planning views" />
      <div className="section-gap">
        {active === 'forecast' && <ForecastTab licenceId={licenceId} horizon={horizon} />}
        {active === 'supply' && <SupplyTab horizon={horizon} onOpen={(id) => set({ tab: 'forecast', licence: id })} />}
        {active === 'optimise' && <OptimiseTab licenceId={licenceId} horizon={horizon} onWhatIf={openWhatIf} />}
        {active === 'whatif' && <WhatIfTab licenceId={licenceId} horizon={horizon} seed={seed} focusProject={params.get('project')} />}
        {active === 'assistant' && (
          <div className="grid-side" style={{ gridTemplateColumns: 'minmax(0, 760px) 1fr' }}>
            <div className="panel">
              <div className="panel-body">
                <Assistant />
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
