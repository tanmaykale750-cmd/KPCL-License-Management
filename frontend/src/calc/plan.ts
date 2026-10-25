/**
 * Decision logic for the Planning Studio — deterministic scenario enumeration, not a trained optimiser.
 *
 * Every candidate plan is evaluated the same way:
 *   total cost = extra licence cost in the horizon + expected blocked hours × loaded hourly cost × productivity-loss factor
 * Plans that leave a forecast (P90) shortage in weeks when a critical project needs the tool are infeasible.
 * The cheapest feasible plan is ranked first; the alternatives stay visible with their cost and risk.
 */
import type { Dataset } from '../data/dataset';
import type { ActionKind, FinanceInputs, Licence, Project, ScenarioParams } from '../domain/types';
import { DEMO_TODAY, addWeeks, daysBetween, fmtDate, toDate } from '../lib/dates';
import { inrShort } from '../lib/format';
import { FORECAST_START, adjustProjects, expectedShortfall, forecast, growthFactor, shortageSummary, type ForecastResult, type ShortageSummary } from './forecast';
import { idleCheckoutShare, periodMonths, totals } from './metrics';

/** Assumption: short-term / elastic access costs a 60% premium over the annual seat's weekly rate. */
export const TEMP_PREMIUM = 1.6;
/** Assumption: tightening the idle time-out recovers half of the idle check-out time at peak. */
export const IDLE_RECOVERY_SHARE = 0.5;

export interface PlanInput {
  licenceId: string;
  seatsDelta: number; // + buy now, − reduce at renewal
  tempSeats: number;
  tempStart?: string;
  tempWeeks: number;
  recoverIdle: boolean;
  reallocate: number;
  projectShifts: Record<string, number>;
  durationPct: Record<string, number>;
  teamSizePct: number;
  horizonWeeks: number;
}

export interface PlanEvaluation {
  input: PlanInput;
  licence: Licence;
  forecast: ForecastResult;
  shortage: ShortageSummary;
  capacityAt: (week: string) => number;
  idleGain: number;
  licenceCostAnnual: number; // owned seats after change × cost
  extraCost: number; // horizon licence spend vs today (buy annual + temporary)
  saving: number; // annual saving from a reduction at renewal
  blockedHours: number;
  blockedRange: [number, number]; // demand half a σ lower / higher
  blockedCost: number;
  totalCost: number;
  criticalBreaches: { projectId: string; weeks: string[] }[];
  donorImpact?: { licenceId: string; blockedHours: number; shortWeeks: number };
  projects: Project[];
  utilisationProjected: number;
}

export function weeklyTempRate(l: Licence): number {
  return (l.costPerSeat / 52) * TEMP_PREMIUM;
}

export function idleGainFor(ds: Dataset, l: Licence): number {
  const rows = ds.monthly.filter((r) => r.licenceId === l.id && periodMonths(12).includes(r.month));
  return Math.round(l.seats * idleCheckoutShare(totals(rows)) * IDLE_RECOVERY_SHARE * 10) / 10;
}

export function emptyPlan(licenceId: string, horizonWeeks = 26): PlanInput {
  return { licenceId, seatsDelta: 0, tempSeats: 0, tempWeeks: 0, recoverIdle: false, reallocate: 0, projectShifts: {}, durationPct: {}, teamSizePct: 100, horizonWeeks };
}

export function fromScenario(p: ScenarioParams, owned: number): PlanInput {
  return {
    licenceId: p.licenceId,
    seatsDelta: p.seats - owned,
    tempSeats: p.temporarySeats,
    tempWeeks: p.temporaryWeeks,
    tempStart: p.temporaryStart,
    recoverIdle: p.recoverIdle,
    reallocate: p.reallocateSeats,
    projectShifts: p.projectShifts,
    durationPct: p.projectDurationPct,
    teamSizePct: p.teamSizePct,
    horizonWeeks: p.horizonWeeks,
  };
}

export function evaluatePlan(ds: Dataset, input: PlanInput, fin: FinanceInputs): PlanEvaluation {
  const lic = ds.licences.find((l) => l.id === input.licenceId)!;
  const projects = adjustProjects(ds.projects, { shiftWeeks: input.projectShifts, durationPct: input.durationPct, teamSizePct: input.teamSizePct });
  const base = forecast(ds, lic.id, { horizonWeeks: input.horizonWeeks, projects });
  const baseShort = shortageSummary(base);
  const tempStart = input.tempStart ?? baseShort.firstShortWeek ?? FORECAST_START;
  const tempEnd = addWeeks(tempStart, Math.max(0, input.tempWeeks - 1));
  const idleGain = input.recoverIdle ? idleGainFor(ds, lic) : 0;
  const reduceFrom = lic.renewalDate;

  const capacityAt = (week: string) => {
    let cap = lic.seats + input.reallocate + idleGain;
    if (input.seatsDelta > 0) cap += input.seatsDelta;
    if (input.seatsDelta < 0 && week >= reduceFrom) cap += input.seatsDelta;
    if (input.tempSeats > 0 && input.tempWeeks > 0 && week >= tempStart && week <= tempEnd) cap += input.tempSeats;
    return cap;
  };

  const f = forecast(ds, lic.id, { horizonWeeks: input.horizonWeeks, projects, capacityFn: capacityAt });
  const shortage = shortageSummary(f);

  // Critical-project rule: no P90 shortage in weeks where a critical project needs this tool.
  const criticalBreaches: { projectId: string; weeks: string[] }[] = [];
  for (const p of projects.filter((x) => x.critical && x.status !== 'completed')) {
    const weeks = f.points
      .filter((pt) => pt.projects.some((c) => c.projectId === p.id) && pt.p90 > pt.capacity + 0.05)
      .map((pt) => pt.week);
    if (weeks.length) criticalBreaches.push({ projectId: p.id, weeks });
  }

  // Donor pool impact when seats are re-hosted.
  let donorImpact: PlanEvaluation['donorImpact'];
  let donorBlocked = 0;
  if (input.reallocate > 0 && lic.rehostableWith?.length) {
    const donor = ds.licences.find((l) => l.id === lic.rehostableWith![0])!;
    const df = forecast(ds, donor.id, { horizonWeeks: input.horizonWeeks, projects, capacityFn: () => donor.seats - input.reallocate });
    const ds2 = shortageSummary(df);
    donorBlocked = ds2.blockedHours;
    donorImpact = { licenceId: donor.id, blockedHours: ds2.blockedHours, shortWeeks: ds2.forecastShortWeeks.length };
  }

  const buyCost = Math.max(0, input.seatsDelta) * lic.costPerSeat; // 12-month minimum term
  const tempCost = input.tempSeats * input.tempWeeks * weeklyTempRate(lic);
  const saving = input.seatsDelta < 0 ? -input.seatsDelta * lic.costPerSeat : 0;
  const extraCost = buyCost + tempCost;
  const blockedHours = shortage.blockedHours + donorBlocked;
  const sig = f.backtest.sigma;
  const blockedRange: [number, number] = [
    f.points.reduce((a, p) => a + expectedShortfall(p.p50 - 0.5 * sig, sig, p.capacity), 0) * f.beta + donorBlocked * 0.7,
    f.points.reduce((a, p) => a + expectedShortfall(p.p50 + 0.5 * sig, sig, p.capacity), 0) * f.beta + donorBlocked * 1.4,
  ];
  const blockedCost = blockedHours * fin.loadedHourlyCost * fin.productivityLoss;
  const ownedAfter = lic.seats + input.seatsDelta;
  const utilisationProjected =
    f.points.reduce((s, p) => s + Math.min(p.p50, p.capacity), 0) / Math.max(1, f.points.reduce((s, p) => s + p.capacity, 0));

  return {
    input,
    licence: lic,
    forecast: f,
    shortage,
    capacityAt,
    idleGain,
    licenceCostAnnual: ownedAfter * lic.costPerSeat,
    extraCost,
    saving,
    blockedHours,
    blockedRange,
    blockedCost,
    totalCost: extraCost + blockedCost - saving,
    criticalBreaches,
    donorImpact,
    projects,
    utilisationProjected,
  };
}

// ---------------- Option enumeration ----------------

export interface PlanOption {
  id: string;
  label: string;
  actions: ActionKind[];
  summary: string;
  evaluation: PlanEvaluation;
  feasible: boolean;
  feasibilityNote: string;
  assumptions: string[];
  risks: string[];
  evidence: string[];
  leadTime: string;
  rank?: number;
}

function bestStagger(ds: Dataset, licenceId: string, base: PlanInput, fin: FinanceInputs): { projectId: string; weeks: number } | null {
  const candidates = ds.projects.filter(
    (p) => !p.critical && p.status !== 'completed' && p.phases.some((ph) => ph.demand.some((d) => d.licenceId === licenceId)),
  );
  let best: { projectId: string; weeks: number; cost: number } | null = null;
  for (const p of candidates) {
    for (const w of [2, 4, 6, 8]) {
      const ev = evaluatePlan(ds, { ...base, projectShifts: { ...base.projectShifts, [p.id]: w } }, fin);
      if (!best || ev.totalCost < best.cost - 1) best = { projectId: p.id, weeks: w, cost: ev.totalCost };
    }
  }
  return best ? { projectId: best.projectId, weeks: best.weeks } : null;
}

export function enumerateOptions(ds: Dataset, licenceId: string, fin: FinanceInputs, horizonWeeks = 26): PlanOption[] {
  const lic = ds.licences.find((l) => l.id === licenceId)!;
  const base = emptyPlan(licenceId, horizonWeeks);
  const baseEval = evaluatePlan(ds, base, fin);
  const opts: PlanOption[] = [];
  const short = baseEval.shortage;
  const window = short.firstShortWeek ? `${fmtDate(short.firstShortWeek)} – ${fmtDate(addWeeks(short.lastShortWeek!, 1))}` : 'none';
  const projName = (id: string) => ds.projects.find((p) => p.id === id)?.shortName ?? id;

  const mk = (id: string, label: string, actions: ActionKind[], input: PlanInput, extra: Partial<PlanOption>): PlanOption => {
    const ev = evaluatePlan(ds, input, fin);
    const feasible = ev.criticalBreaches.length === 0 && (extra.feasible ?? true);
    return {
      id,
      label,
      actions,
      summary: extra.summary ?? '',
      evaluation: ev,
      feasible,
      feasibilityNote:
        ev.criticalBreaches.length > 0
          ? `Leaves a forecast shortage while ${ev.criticalBreaches.map((b) => projName(b.projectId)).join(', ')} (critical) needs ${lic.product}.`
          : extra.feasibilityNote ?? 'Feasible within licence and contract constraints.',
      assumptions: extra.assumptions ?? [],
      risks: extra.risks ?? [],
      evidence: extra.evidence ?? [],
      leadTime: extra.leadTime ?? '—',
    };
  };

  opts.push(
    mk('do-nothing', 'Do nothing', [], base, {
      summary: short.forecastShortWeeks.length ? `Accept the forecast shortage (${window}).` : 'Capacity covers the forecast.',
      risks: short.forecastShortWeeks.length ? [`${Math.round(short.blockedHours)} expected blocked engineer-hours`] : [],
      evidence: ['Forecast P50/P90 vs owned seats'],
      leadTime: 'None',
    }),
  );

  if (!short.forecastShortWeeks.length) return opts;
  const gap = Math.ceil(short.maxGapP90 - 0.05);

  // A — re-host idle seats from a compatible pool
  if (lic.rehostableWith?.length) {
    const donor = ds.licences.find((l) => l.id === lic.rehostableWith![0])!;
    const df = forecast(ds, donor.id, { horizonWeeks, projects: ds.projects });
    const donorPeak = Math.max(...df.points.map((p) => p.p90));
    const movable = Math.max(0, Math.floor(donor.seats - donorPeak));
    if (movable > 0) {
      const n = Math.min(movable, gap);
      opts.push(
        mk('reallocate', `Re-host ${n} idle seat${n > 1 ? 's' : ''} from ${donor.server.split('.')[0]}`, ['reallocate'], { ...base, reallocate: n }, {
          summary: `${donor.product} on ${donor.server} peaks at ${donorPeak.toFixed(1)} of ${donor.seats} seats (P90).`,
          assumptions: ['Contract CTR-ANS-2024-017 permits re-hosting between KPCL sites (confirm with vendor)', 'Re-host takes about one week'],
          risks: ['Nashik demand above forecast would then be blocked'],
          evidence: [`${donor.id} 26-week P90 peak ${donorPeak.toFixed(1)} seats`, 'Re-host precedent RV-2603 (Jul 2026)'],
          leadTime: '≈ 1 week',
        }),
      );
    }
  }

  // B — recover idle check-outs
  const gain = idleGainFor(ds, lic);
  if (gain >= 0.2) {
    opts.push(
      mk('recover-idle', 'Tighten idle time-out (recover idle check-outs)', ['recover-idle'], { ...base, recoverIdle: true }, {
        summary: `Recovers about ${gain.toFixed(1)} seat-equivalents at peak.`,
        assumptions: [`${Math.round(IDLE_RECOVERY_SHARE * 100)}% of idle check-out time is recoverable`, 'Solver and batch jobs are exempt from the time-out'],
        risks: ['Users lose an open session after the time-out; communicate first'],
        evidence: ['Idle check-out hours, last 12 months'],
        leadTime: '1–2 days (licence server options file)',
      }),
    );
  }

  // C — stagger a non-critical project
  const st = bestStagger(ds, licenceId, base, fin);
  if (st) {
    opts.push(
      mk('stagger', `Move ${projName(st.projectId)} ${st.weeks} weeks later`, ['stagger'], { ...base, projectShifts: { [st.projectId]: st.weeks } }, {
        summary: `${projName(st.projectId)} is not critical; its phase overlaps the shortage window.`,
        assumptions: ['Project leader and department head agree to the new dates'],
        risks: [`${projName(st.projectId)} finishes ${st.weeks} weeks later`],
        evidence: ['Project phase overlap on the shared timeline'],
        leadTime: 'Registry change + approval',
      }),
    );
  }

  // D — temporary / elastic access for the shortage weeks
  const tempWeeks = Math.max(1, Math.round((toDate(short.lastShortWeek!).getTime() - toDate(short.firstShortWeek!).getTime()) / (7 * 86400000)) + 1);
  opts.push(
    mk('temporary', `Temporary access: ${gap} seat${gap > 1 ? 's' : ''} for ${tempWeeks} weeks`, ['temporary'], { ...base, tempSeats: gap, tempWeeks, tempStart: short.firstShortWeek }, {
      summary: `Covers the P90 gap only while it lasts (${window}).`,
      assumptions: [`Short-term or pay-per-use access priced at ${TEMP_PREMIUM}× the annual seat's weekly rate (${inrShort(weeklyTempRate(lic))} per seat-week; confirm quote)`],
      risks: ['Vendor lead time for elastic units'],
      evidence: ['Forecast P90 gap per week'],
      leadTime: '1–2 weeks (quote + PO)',
    }),
  );

  // E — buy seats
  opts.push(
    mk('buy', `Buy ${gap} additional seat${gap > 1 ? 's' : ''}`, ['buy'], { ...base, seatsDelta: gap }, {
      summary: `Permanent capacity; 12-month minimum term at ${inrShort(lic.costPerSeat)} per seat.`,
      assumptions: ['12-month minimum term; no pro-rating'],
      risks: ['Seats likely idle after the peak; raises next renewal'],
      evidence: ['Forecast P90 gap', 'Vendor price list (sample)'],
      leadTime: '2–4 weeks (approval + PO)',
    }),
  );

  // Combined plans: cheapest zero-cost levers first, then temporary access for whatever remains.
  const lever: PlanInput = {
    ...base,
    reallocate: opts.find((o) => o.id === 'reallocate')?.evaluation.input.reallocate ?? 0,
    recoverIdle: gain >= 0.2,
    projectShifts: st ? { [st.projectId]: st.weeks } : {},
  };
  const leverEval = evaluatePlan(ds, lever, fin);
  if (leverEval.shortage.forecastShortWeeks.length) {
    const g2 = Math.ceil(leverEval.shortage.maxGapP90 - 0.05);
    const s2 = leverEval.shortage;
    const w2 = Math.max(1, Math.round((toDate(s2.lastShortWeek!).getTime() - toDate(s2.firstShortWeek!).getTime()) / (7 * 86400000)) + 1);
    opts.push(
      mk('combined', 'Combined: no-cost levers + temporary access for the remainder', ['reallocate', 'recover-idle', 'stagger', 'temporary'].filter((a) =>
        (a === 'reallocate' && lever.reallocate > 0) || (a === 'recover-idle' && lever.recoverIdle) || (a === 'stagger' && st) || a === 'temporary',
      ) as ActionKind[], { ...lever, tempSeats: g2, tempWeeks: w2, tempStart: s2.firstShortWeek }, {
        summary: `Uses every no-cost lever, then ${g2} temporary seat${g2 > 1 ? 's' : ''} for ${w2} weeks.`,
        assumptions: ['All assumptions of the individual levers apply'],
        risks: ['Several changes to coordinate'],
        evidence: ['Each lever evaluated on the same forecast'],
        leadTime: '1–2 weeks',
      }),
    );
  } else {
    opts.push(
      mk('combined', 'Combined: no-cost levers only', (['reallocate', 'recover-idle', 'stagger'] as ActionKind[]).filter((a) =>
        (a === 'reallocate' && lever.reallocate > 0) || (a === 'recover-idle' && lever.recoverIdle) || (a === 'stagger' && !!st),
      ), lever, {
        summary: 'The no-cost levers together cover the forecast gap.',
        assumptions: ['All assumptions of the individual levers apply'],
        risks: ['Several changes to coordinate'],
        evidence: ['Each lever evaluated on the same forecast'],
        leadTime: '≈ 1 week',
      }),
    );
  }

  const ranked = [...opts].sort((a, b) => (a.feasible === b.feasible ? a.evaluation.totalCost - b.evaluation.totalCost : a.feasible ? -1 : 1));
  ranked.forEach((o, i) => (o.rank = i + 1));
  return ranked;
}

// ---------------- Renewal advice (surplus) ----------------

export interface RenewalAdvice {
  licence: Licence;
  keep: number;
  reduceBy: number;
  annualSaving: number;
  reason: string;
  evidence: string[];
}

export function renewalAdvice(ds: Dataset, licenceId: string): RenewalAdvice {
  const lic = ds.licences.find((l) => l.id === licenceId)!;
  if (lic.type === 'named') {
    const holders = ds.assignments.filter((a) => a.licenceId === lic.id);
    const dormant = holders.filter((a) => daysBetween(a.lastActive, DEMO_TODAY) >= 90).length;
    const buffer = Math.max(1, Math.round(lic.seats * (growthFactor(ds, lic) - 1)));
    const keep = Math.max(lic.contractMinSeats, holders.length - dormant + buffer);
    const reduceBy = Math.max(0, lic.seats - keep);
    return {
      licence: lic,
      keep,
      reduceBy,
      annualSaving: reduceBy * lic.costPerSeat,
      reason: `${dormant} of ${holders.length} holders have not used ${lic.product} for 90+ days. Keep ${holders.length - dormant} active holders plus ${buffer} for planned hires.`,
      evidence: ['Named-seat last-active dates', 'Department headcount plan'],
    };
  }
  const f = forecast(ds, lic.id, { horizonWeeks: 52 });
  const peak = Math.max(...f.points.map((p) => p.p90));
  const keep = Math.max(lic.contractMinSeats, Math.ceil(peak - 0.05));
  const reduceBy = Math.max(0, lic.seats - keep);
  return {
    licence: lic,
    keep,
    reduceBy,
    annualSaving: reduceBy * lic.costPerSeat,
    reason: `52-week high-demand (P90) peak is ${peak.toFixed(1)} ${lic.unitLabel}; P90 already includes the uncertainty buffer.`,
    evidence: ['52-week forecast P90', `Contract minimum ${lic.contractMinSeats}`],
  };
}
