import { Copy, Lock, Play, RotateCcw, Save, Send, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { evaluatePlan, fromScenario, idleGainFor, weeklyTempRate, type PlanEvaluation } from '../../calc/plan';
import { CanvasLegend, PlanningCanvas } from '../../components/charts/PlanningCanvas';
import { makeScale } from '../../components/charts/Gantt';
import { Callout, Field, Panel } from '../../components/ui/basics';
import { StatusChip } from '../../components/ui/StatusChip';
import type { ScenarioParams } from '../../domain/types';
import { useWidth } from '../../hooks/useWidth';
import { addWeeks, fmtDate } from '../../lib/dates';
import { hours, inrShort, pct } from '../../lib/format';
import { useApp } from '../../state/store';

export function baselineParams(licenceId: string, seats: number, horizon: number): ScenarioParams {
  return { licenceId, seats, temporarySeats: 0, temporaryWeeks: 0, projectShifts: {}, projectDurationPct: {}, teamSizePct: 100, recoverIdle: false, reallocateSeats: 0, horizonWeeks: horizon };
}

function changes(p: ScenarioParams, base: ScenarioParams, name: (id: string) => string): string[] {
  const out: string[] = [];
  if (p.seats !== base.seats) out.push(`Owned ${base.seats} → ${p.seats}${p.seats < base.seats ? ' (at renewal)' : ''}`);
  if (p.temporarySeats && p.temporaryWeeks) out.push(`+${p.temporarySeats} temporary × ${p.temporaryWeeks} wk${p.temporaryStart ? ` from ${fmtDate(p.temporaryStart).slice(0, 6)}` : ''}`);
  if (p.reallocateSeats) out.push(`Re-host +${p.reallocateSeats}`);
  if (p.recoverIdle) out.push('Idle time-out on');
  if (p.teamSizePct !== 100) out.push(`Team size ${p.teamSizePct}%`);
  for (const [id, w] of Object.entries(p.projectShifts)) if (w) out.push(`${name(id)} ${w > 0 ? '+' : ''}${w} wk`);
  for (const [id, d] of Object.entries(p.projectDurationPct)) if (d !== 100) out.push(`${name(id)} duration ${d}%`);
  return out;
}

export function WhatIfTab({ licenceId, horizon, seed, focusProject }: { licenceId: string; horizon: number; seed?: ScenarioParams | null; focusProject?: string | null }) {
  const { ds, state, perms, actions, me } = useApp();
  const fin = state.finance[0];
  const lic = ds.licences.find((l) => l.id === licenceId)!;
  const base = useMemo(() => baselineParams(licenceId, lic.seats, horizon), [licenceId, lic.seats, horizon]);
  const [draft, setDraft] = useState<ScenarioParams>(seed && seed.licenceId === licenceId ? seed : base);
  const [applied, setApplied] = useState<ScenarioParams>(draft);
  const [auto, setAuto] = useState(true);
  const [name, setName] = useState('');
  const [compare, setCompare] = useState<string[]>([]);
  const [ref, width] = useWidth<HTMLDivElement>(900);

  useEffect(() => {
    const p = seed && seed.licenceId === licenceId ? seed : baselineParams(licenceId, lic.seats, horizon);
    setDraft(p);
    setApplied(p);
  }, [licenceId, seed, horizon, lic.seats]);
  useEffect(() => {
    if (auto) setApplied(draft);
  }, [draft, auto]);

  const projName = (id: string) => ds.projects.find((p) => p.id === id)?.shortName ?? id;
  const evalOf = (p: ScenarioParams): PlanEvaluation => evaluatePlan(ds, fromScenario(p, lic.seats), fin);
  const baseEval = useMemo(() => evalOf(base), [ds, base, fin]); // eslint-disable-line react-hooks/exhaustive-deps
  const cur = useMemo(() => evalOf(applied), [ds, applied, fin]); // eslint-disable-line react-hooks/exhaustive-deps
  const saved = state.scenarios.filter((s) => s.params.licenceId === licenceId);
  const compared = saved.filter((s) => compare.includes(s.id)).map((s) => ({ s, e: evalOf(s.params) }));
  const projects = ds.projects.filter((p) => p.status !== 'completed' && p.phases.some((ph) => ph.demand.some((d) => d.licenceId === licenceId)));
  const canEdit = (projectId: string) => perms.runWhatIf === 'all' || (perms.runWhatIf === 'own-projects' && !!perms.projectScope?.includes(projectId));
  const fullControls = perms.runWhatIf === 'all';
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied);
  const changed = changes(applied, base, projName);
  const nextRev = `Rev ${String.fromCharCode(66 + saved.length)}`;
  const gain = idleGainFor(ds, lic);

  const scale = makeScale(addWeeks(cur.forecast.points[0].week, -12), addWeeks(cur.forecast.points[cur.forecast.points.length - 1].week, 1), 60, Math.max(300, width - 60 - 70));
  const set = (patch: Partial<ScenarioParams>) => setDraft((d) => ({ ...d, ...patch }));

  const col = (label: string, e: PlanEvaluation, p: ScenarioParams, tone: 'base' | 'cur' | 'saved') => ({ label, e, p, tone });
  const cols = [col('Rev A · baseline', baseEval, base, 'base'), col(`${nextRev} · draft`, cur, applied, 'cur'), ...compared.map(({ s, e }) => col(`${s.rev} · ${s.name}`, e, s.params, 'saved'))];
  const rows: { label: string; v: (c: (typeof cols)[number]) => string; cost?: boolean; diff?: (c: (typeof cols)[number]) => boolean }[] = [
    { label: 'Owned seats (after renewal)', v: (c) => String(c.p.seats), diff: (c) => c.p.seats !== base.seats },
    { label: 'Temporary seat-weeks', v: (c) => String(c.p.temporarySeats * c.p.temporaryWeeks), diff: (c) => c.p.temporarySeats * c.p.temporaryWeeks > 0 },
    { label: 'Peak demand P90', v: (c) => Math.max(...c.e.forecast.points.map((x) => x.p90)).toFixed(1) },
    { label: 'Forecast shortage weeks', v: (c) => String(c.e.shortage.forecastShortWeeks.length) },
    { label: 'Expected blocked hours', v: (c) => `${Math.round(c.e.blockedHours)} (${Math.round(c.e.blockedRange[0])}–${Math.round(c.e.blockedRange[1])})` },
    { label: 'Critical-project rule', v: (c) => (c.e.criticalBreaches.length ? `Breached (${c.e.criticalBreaches.map((b) => projName(b.projectId)).join(', ')})` : 'Met') },
    { label: 'Projected utilisation', v: (c) => pct(c.e.utilisationProjected) },
    { label: 'Annual licence cost', v: (c) => inrShort(c.e.licenceCostAnnual), cost: true },
    { label: 'Extra cost in horizon', v: (c) => inrShort(c.e.extraCost), cost: true },
    { label: 'Saving from reduction (a year)', v: (c) => inrShort(c.e.saving), cost: true },
    { label: 'Cost of blocked time', v: (c) => inrShort(c.e.blockedCost), cost: true },
    { label: 'Total cost', v: (c) => inrShort(c.e.totalCost), cost: true },
    { label: 'Δ total vs Rev A', v: (c) => (c.tone === 'base' ? '—' : inrShort(c.e.totalCost - baseEval.totalCost, { sign: true })), cost: true },
  ];
  const better = cur.criticalBreaches.length === 0 && cur.totalCost < baseEval.totalCost;

  const submit = () => {
    const { id: scId, rev } = actions.saveScenario({ name: name.trim() || 'What-if plan', params: applied });
    const id = actions.submitRecommendation(
      {
        title: `${lic.product}: ${changed.join('; ') || 'scenario'}`,
        licenceId,
        projectIds: projects.map((p) => p.id),
        actions: [
          ...(applied.seats > lic.seats ? (['buy'] as const) : applied.seats < lic.seats ? (['reduce'] as const) : []),
          ...(applied.temporarySeats ? (['temporary'] as const) : []),
          ...(applied.reallocateSeats ? (['reallocate'] as const) : []),
          ...(applied.recoverIdle ? (['recover-idle'] as const) : []),
          ...(Object.values(applied.projectShifts).some(Boolean) ? (['stagger'] as const) : []),
        ],
        rationale: `What-if ${rev}: ${changed.join('; ')}. Expected blocked hours ${Math.round(cur.blockedHours)} vs ${Math.round(baseEval.blockedHours)} in Rev A; total cost ${inrShort(cur.totalCost)} vs ${inrShort(baseEval.totalCost)}. Project date changes still need the project leader, department head and administrator to update the registry.`,
        evidence: [`Scenario ${rev}`, 'Forecast P50/P90', 'Blocked hours per seat-week from history'],
        annualImpact: Math.round(cur.saving - cur.extraCost),
        oneOffCost: 0,
        blockedHoursExpected: Math.round(cur.blockedHours),
        confidence: 'medium',
        source: 'scenario',
        scenarioRev: rev,
        dueDate: cur.shortage.firstShortWeek ?? baseEval.shortage.firstShortWeek ?? lic.renewalDate,
        seatsBefore: lic.seats,
        seatsAfter: applied.seats,
      },
      lic.ownerDeptId,
    );
    if (id) actions.linkScenario(scId, id);
  };

  return (
    <div className="grid-side" style={{ gridTemplateColumns: '330px minmax(0,1fr)' }}>
      <Panel title="Scenario inputs" sub="Changes here never touch the registry" footer={
        <div className="row" style={{ flexWrap: 'wrap', width: '100%' }}>
          <label className="checkbox small">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto-run
          </label>
          <span className="grow" />
          <button className="btn sm" onClick={() => { setDraft(base); setApplied(base); }}>
            <RotateCcw /> Reset
          </button>
          <button className="btn sm primary" disabled={!dirty} onClick={() => setApplied(draft)}>
            <Play /> Run
          </button>
        </div>
      }>
        <div className="stack" style={{ gap: 14 }}>
          {fullControls ? (
            <>
              <Field label={`Owned ${lic.unitLabel}: ${draft.seats}`} hint={`Increase applies now (12-month term); reduction applies at renewal ${fmtDate(lic.renewalDate)} · contract minimum ${lic.contractMinSeats}`} htmlFor="wi-seats">
                <input id="wi-seats" type="range" min={lic.contractMinSeats} max={lic.seats + 8} value={draft.seats} onChange={(e) => set({ seats: Number(e.target.value) })} />
              </Field>
              <div className="form-grid" style={{ gap: 10 }}>
                <Field label="Temporary seats" htmlFor="wi-ts">
                  <input id="wi-ts" type="number" className="input" min={0} max={10} value={draft.temporarySeats} onChange={(e) => set({ temporarySeats: Math.max(0, Math.min(10, Number(e.target.value))) })} />
                </Field>
                <Field label="for weeks" htmlFor="wi-tw" hint={perms.seesCosts ? `${inrShort(weeklyTempRate(lic))}/seat-wk` : undefined}>
                  <input id="wi-tw" type="number" className="input" min={0} max={26} value={draft.temporaryWeeks} onChange={(e) => set({ temporaryWeeks: Math.max(0, Math.min(26, Number(e.target.value))) })} />
                </Field>
              </div>
              {draft.temporarySeats > 0 && draft.temporaryWeeks > 0 && (
                <Field label="Temporary seats start" htmlFor="wi-tstart">
                  <select id="wi-tstart" className="select" value={draft.temporaryStart ?? ''} onChange={(e) => set({ temporaryStart: e.target.value || undefined })}>
                    <option value="">First shortage week (auto)</option>
                    {baseEval.forecast.points.map((p) => (
                      <option key={p.week} value={p.week}>
                        Week of {fmtDate(p.week)}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {lic.rehostableWith?.length ? (
                <Field label={`Re-host from ${lic.rehostableWith[0]}: ${draft.reallocateSeats}`} htmlFor="wi-rh" hint="Takes seats away from the other pool">
                  <input id="wi-rh" type="range" min={0} max={3} value={draft.reallocateSeats} onChange={(e) => set({ reallocateSeats: Number(e.target.value) })} />
                </Field>
              ) : null}
              <label className="checkbox">
                <input type="checkbox" checked={draft.recoverIdle} onChange={(e) => set({ recoverIdle: e.target.checked })} /> Idle time-out (recovers ≈ {gain.toFixed(1)} seat)
              </label>
              <Field label={`Project team size: ${draft.teamSizePct}%`} hint="Scales planned project seat demand" htmlFor="wi-team">
                <input id="wi-team" type="range" min={50} max={150} step={5} value={draft.teamSizePct} onChange={(e) => set({ teamSizePct: Number(e.target.value) })} />
              </Field>
            </>
          ) : (
            <Callout icon={Lock}>You can move your own project’s phases to see whether a shortage appears or clears. Seats and costs are managed by the administrator.</Callout>
          )}
          <div>
            <div className="field-label" style={{ marginBottom: 6 }}>
              Project dates and duration
            </div>
            {projects.map((p) => {
              const editable = canEdit(p.id);
              const shift = draft.projectShifts[p.id] ?? 0;
              const dur = draft.projectDurationPct[p.id] ?? 100;
              return (
                <div key={p.id} style={{ padding: '8px 0', borderTop: '1px solid var(--border)', opacity: editable ? 1 : 0.55, background: focusProject === p.id ? 'var(--teal-wash)' : undefined }}>
                  <div className="row-between small">
                    <b style={{ fontWeight: 600 }}>
                      {p.shortName} {p.critical && <StatusChip status="critical-project">Critical</StatusChip>}
                    </b>
                    <span className="mono muted">{shift > 0 ? `+${shift}` : shift} wk · {dur}%</span>
                  </div>
                  <div className="small muted" style={{ marginTop: 4 }}>Start shift</div>
                  <input aria-label={`${p.shortName} start shift in weeks`} type="range" min={-8} max={12} value={shift} disabled={!editable} onChange={(e) => set({ projectShifts: { ...draft.projectShifts, [p.id]: Number(e.target.value) } })} />
                  <div className="small muted">Duration</div>
                  <input aria-label={`${p.shortName} duration percent`} type="range" min={60} max={150} step={10} value={dur} disabled={!editable} onChange={(e) => set({ projectDurationPct: { ...draft.projectDurationPct, [p.id]: Number(e.target.value) } })} />
                </div>
              );
            })}
          </div>
          {dirty && !auto && <Callout tone="warn">Inputs changed — run the simulation to update the results.</Callout>}
        </div>
      </Panel>

      <div className="stack-lg">
        <Panel
          title={!changed.length ? `Rev A baseline · ${lic.product}${cur.criticalBreaches.length ? ' — a critical project is short' : ''}` : better ? `${nextRev} beats the baseline${perms.seesCosts ? ` by ${inrShort(baseEval.totalCost - cur.totalCost)}` : ''}` : cur.criticalBreaches.length ? `${nextRev} still leaves a critical project short` : `${nextRev} clears the critical-project rule`}
          sub={changed.length ? 'Changed assumptions: ' : 'No changes yet — Rev A is the baseline'}
          actions={changed.map((c) => (
            <span key={c} className="chip" style={{ color: 'var(--copper)', borderStyle: 'dashed' }}>
              {c}
            </span>
          ))}
          footer={<CanvasLegend baseline="Rev A capacity / P50" />}
        >
          <div ref={ref}>
            <PlanningCanvas
              f={cur.forecast}
              scale={scale}
              height={260}
              historyWeeks={12}
              capacityAt={cur.capacityAt}
              baseline={changed.length ? { points: baseEval.forecast.points, capacityAt: baseEval.capacityAt, label: 'Rev A' } : undefined}
              projectName={projName}
              unit={lic.unitLabel}
            />
          </div>
        </Panel>

        <Panel
          flush
          title="Scenario comparison"
          sub="Proposed results are estimates · Rev A is today’s plan"
          actions={
            <>
              <input className="input" style={{ width: 170 }} placeholder="Scenario name" aria-label="Scenario name" value={name} onChange={(e) => setName(e.target.value)} />
              <button className="btn" disabled={!changed.length} onClick={() => { actions.saveScenario({ name: name.trim() || 'What-if', params: applied }); setName(''); }}>
                <Save /> Save as {nextRev}
              </button>
              {perms.submitRecommendations && (
                <button className="btn primary" disabled={!changed.length || cur.criticalBreaches.length > 0} onClick={submit} title={cur.criticalBreaches.length ? 'Fix the critical-project shortage first' : 'Save and submit for approval'}>
                  <Send /> Submit for approval
                </button>
              )}
            </>
          }
        >
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Measure</th>
                  {cols.map((c) => (
                    <th key={c.label} className="num" style={c.tone === 'cur' ? { color: 'var(--teal-strong)', boxShadow: 'inset 0 -2px 0 var(--teal)' } : undefined}>
                      <span className="mono">{c.label}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows
                  .filter((r) => !r.cost || perms.seesCosts)
                  .map((r) => (
                    <tr key={r.label}>
                      <td>{r.label}</td>
                      {cols.map((c) => (
                        <td key={c.label} className="num" style={{ ...(c.tone === 'cur' ? { background: 'var(--teal-wash)' } : {}), ...(r.diff?.(c) && c.tone !== 'base' ? { textDecoration: 'underline', textDecorationColor: 'var(--copper)', textDecorationStyle: 'dashed', textUnderlineOffset: 3 } : {}) }}>
                          {r.label === 'Critical-project rule' ? (c.e.criticalBreaches.length ? <StatusChip status="forecast-shortage">Breached</StatusChip> : <StatusChip status="healthy">Met</StatusChip>) : c.tone === 'base' ? r.v(c) : <span className={r.cost ? 'est' : ''}>{r.v(c)}</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel flush title={`Saved scenarios for ${lic.id}`} sub="Tick to compare side by side · duplicate to start from one">
          {saved.length === 0 ? (
            <div className="empty">No saved scenarios yet. Save the current draft as {nextRev}.</div>
          ) : (
            <table className="table">
              <tbody>
                {saved.map((s) => (
                  <tr key={s.id}>
                    <td style={{ width: 30 }}>
                      <input type="checkbox" aria-label={`Compare ${s.rev}`} checked={compare.includes(s.id)} onChange={(e) => setCompare((c) => (e.target.checked ? [...c, s.id].slice(-2) : c.filter((x) => x !== s.id)))} />
                    </td>
                    <td>
                      <span className="mono">{s.rev}</span> · {s.name}
                      <span className="sub">{changes(s.params, base, projName).join(' · ') || 'Baseline copy'}</span>
                    </td>
                    <td className="small muted">
                      {s.savedBy} · {s.savedAt}
                    </td>
                    <td>{s.submittedRecommendationId ? <StatusChip status="pending">Submitted {s.submittedRecommendationId}</StatusChip> : null}</td>
                    <td className="num nowrap">
                      <button className="btn sm" onClick={() => { setDraft({ ...s.params, horizonWeeks: horizon }); setApplied({ ...s.params, horizonWeeks: horizon }); }}>
                        <Copy /> Duplicate
                      </button>{' '}
                      {s.savedBy === me.name && (
                        <button className="btn sm danger" aria-label={`Delete ${s.rev}`} onClick={() => actions.deleteScenario(s.id)}>
                          <Trash2 />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <p className="small muted">Blocked hours are an estimate: expected seats short each week × {cur.forecast.beta.toFixed(1)} h per seat-week measured from past denials ({hours(cur.blockedHours)} central). Costs use finance inputs {fin.version}.</p>
      </div>
    </div>
  );
}
