/**
 * Demand forecast — transparent, deterministic demonstration method (not a trained ML model).
 *
 *   baseline(w)  = mean routine demand in the same week ±1 of the previous two years × headcount growth
 *   routine(h)   = observed weekly peak demand − known completed-project load in that week
 *   project(w)   = Σ planned seats × calibration ratio × phase shape × confidence
 *   P50(w)       = baseline(w) + project(w)
 *   P90(w)       = P50(w) + 1.28 × σ + tentative-project upside
 *   σ            = standard deviation of backtest errors over the last 52 history weeks
 *
 * Calibration ratio = Σ actual peak ÷ Σ planned seats over completed phases for the tool.
 */
import type { Dataset } from '../data/dataset';
import { CURRENT_WEEK, FORECAST_START, historyWeeks, phaseShape } from '../data/generate';
import type { Licence, Project, ProjectPhase, WeeklyDemand } from '../domain/types';
import { addDays, addWeeks, daysBetween } from '../lib/dates';

export interface ProjectContribution {
  projectId: string;
  phaseId: string;
  phaseName: string;
  planned: number;
  seats: number; // planned × ratio × shape × confidence
  tentative: boolean;
}

export interface ForecastPoint {
  week: string;
  baseline: number;
  p50: number;
  p90: number;
  capacity: number;
  projects: ProjectContribution[];
}

export interface HistoryPoint {
  week: string;
  demand: number;
  observed: number;
  capacity: number;
  denials: number;
  blocked: number;
  routine: number;
}

export interface Backtest {
  weeks: number;
  mae: number;
  wape: number;
  naiveMae: number;
  mase: number;
  coverage: number;
  sigma: number;
  beatsNaive: boolean;
}

export interface ForecastResult {
  licence: Licence;
  history: HistoryPoint[];
  points: ForecastPoint[];
  ratio: { value: number; source: CalibrationRow[]; fallback: boolean };
  growth: number;
  backtest: Backtest;
  beta: number; // blocked hours per seat-week short, measured from history
}

export interface CalibrationRow {
  projectId: string;
  projectName: string;
  phaseName: string;
  planned: number;
  actual: number;
}

export interface ProjectAdjust {
  shiftWeeks?: Record<string, number>;
  durationPct?: Record<string, number>;
  teamSizePct?: number;
}

/** Apply what-if shifts / duration / team-size to a copy of the project list. Never mutates the registry. */
export function adjustProjects(projects: Project[], adj: ProjectAdjust = {}): Project[] {
  return projects.map((p) => {
    const shift = adj.shiftWeeks?.[p.id] ?? 0;
    const dur = (adj.durationPct?.[p.id] ?? 100) / 100;
    if (shift === 0 && dur === 1 && (adj.teamSizePct ?? 100) === 100) return p;
    if (p.status === 'completed') return p;
    const anchor = p.phases[0]?.start;
    const team = (adj.teamSizePct ?? 100) / 100;
    const phases: ProjectPhase[] = p.phases.map((ph) => {
      const startOff = Math.round(daysBetween(anchor, ph.start) * dur);
      const len = Math.max(7, Math.round(daysBetween(ph.start, ph.end) * dur));
      const start = addDays(addWeeks(anchor, shift), startOff);
      return { ...ph, start, end: addDays(start, len), demand: ph.demand.map((d) => ({ ...d, seats: d.seats * team })) };
    });
    return { ...p, phases };
  });
}

export function calibration(ds: Dataset, licenceId: string): { value: number; source: CalibrationRow[]; fallback: boolean } {
  const rows: CalibrationRow[] = [];
  for (const p of ds.projects) {
    if (p.status !== 'completed') continue;
    for (const ph of p.phases) {
      const actual = ph.actualPeak?.[licenceId];
      const planned = ph.demand.find((d) => d.licenceId === licenceId)?.seats;
      if (actual !== undefined && planned) rows.push({ projectId: p.id, projectName: p.shortName, phaseName: ph.name, planned, actual });
    }
  }
  if (rows.length === 0) {
    // Fall back to all tools combined.
    let pl = 0;
    let ac = 0;
    for (const p of ds.projects)
      for (const ph of p.phases)
        for (const d of ph.demand) {
          const a = ph.actualPeak?.[d.licenceId];
          if (a !== undefined) {
            pl += d.seats;
            ac += a;
          }
        }
    return { value: pl ? ac / pl : 1, source: [], fallback: true };
  }
  const planned = rows.reduce((s, r) => s + r.planned, 0);
  const actual = rows.reduce((s, r) => s + r.actual, 0);
  return { value: actual / planned, source: rows, fallback: false };
}

function completedLoad(projects: Project[], licenceId: string, week: string): number {
  let s = 0;
  for (const p of projects) {
    if (p.status !== 'completed') continue;
    for (const ph of p.phases) {
      const a = ph.actualPeak?.[licenceId];
      if (a) s += a * phaseShape(ph.start, ph.end, week);
    }
  }
  return s;
}

function plannedLoadAsOfThen(projects: Project[], licenceId: string, week: string, ratio: number): number {
  // What the forecaster would have known at the time: planned seats of those projects × ratio.
  let s = 0;
  for (const p of projects) {
    if (p.status !== 'completed') continue;
    for (const ph of p.phases) {
      const d = ph.demand.find((x) => x.licenceId === licenceId);
      if (d) s += d.seats * ratio * phaseShape(ph.start, ph.end, week);
    }
  }
  return s;
}

export function growthFactor(ds: Dataset, lic: Licence): number {
  let now = 0;
  let next = 0;
  for (const [deptId, seats] of Object.entries(lic.allocations)) {
    const d = ds.departments.find((x) => x.id === deptId);
    if (!d) continue;
    now += seats * d.headcount;
    next += seats * d.headcountNextYear;
  }
  return now ? next / now : 1;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function sd(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

export interface ForecastOptions {
  horizonWeeks?: number;
  projects?: Project[];
  capacityFn?: (week: string) => number;
}

export function forecast(ds: Dataset, licenceId: string, opts: ForecastOptions = {}): ForecastResult {
  const lic = ds.licences.find((l) => l.id === licenceId)!;
  const horizon = opts.horizonWeeks ?? 26;
  const projects = opts.projects ?? ds.projects;
  const weeks = historyWeeks();
  const wk = new Map<string, WeeklyDemand>(ds.weekly.filter((w) => w.licenceId === licenceId).map((w) => [w.weekStart, w]));
  const ratio = calibration(ds, licenceId);
  const growth = growthFactor(ds, lic);

  const history: HistoryPoint[] = weeks.map((w) => {
    const row = wk.get(w);
    const demand = row?.demand ?? 0;
    return {
      week: w,
      demand,
      observed: row?.observedPeak ?? 0,
      capacity: row?.capacity ?? lic.seats,
      denials: row?.denials ?? 0,
      blocked: row?.blockedHours ?? 0,
      routine: Math.max(0, demand - completedLoad(ds.projects, licenceId, w)),
    };
  });
  const routineAt = new Map(history.map((h) => [h.week, h.routine]));
  const routineNear = (week: string) => {
    const vals: number[] = [];
    for (const d of [-1, 0, 1]) {
      const v = routineAt.get(addWeeks(week, d));
      if (v !== undefined) vals.push(v);
    }
    return vals;
  };

  // ---- Backtest over the last 52 history weeks: baseline from one year earlier ----
  const errors: number[] = [];
  const naiveErrors: number[] = [];
  let absSum = 0;
  let actualSum = 0;
  const btPoints: { actual: number; f: number }[] = [];
  for (const h of history.slice(-52)) {
    const prior = routineNear(addWeeks(h.week, -52));
    if (!prior.length) continue;
    const f = mean(prior) * growth + plannedLoadAsOfThen(ds.projects, licenceId, h.week, ratio.value);
    const naive = wk.get(addWeeks(h.week, -52))?.demand ?? h.demand;
    errors.push(h.demand - f);
    naiveErrors.push(Math.abs(h.demand - naive));
    absSum += Math.abs(h.demand - f);
    actualSum += h.demand;
    btPoints.push({ actual: h.demand, f });
  }
  const sigma = Math.max(0.5, sd(errors));
  const mae = errors.length ? absSum / errors.length : 0;
  const naiveMae = mean(naiveErrors);
  const coverage = btPoints.length ? btPoints.filter((p) => p.actual <= p.f + 1.28 * sigma).length / btPoints.length : 0;
  const backtest: Backtest = {
    weeks: errors.length,
    mae,
    wape: actualSum ? absSum / actualSum : 0,
    naiveMae,
    mase: naiveMae ? mae / naiveMae : 0,
    coverage,
    sigma,
    beatsNaive: mae < naiveMae,
  };

  // ---- Blocked hours per seat-week short (β), measured from history ----
  let shortSeatWeeks = 0;
  let blockedSum = 0;
  for (const h of history) {
    const short = Math.max(0, h.demand - h.capacity);
    shortSeatWeeks += short;
    blockedSum += h.blocked;
  }
  const beta = shortSeatWeeks > 0 ? blockedSum / shortSeatWeeks : 9;

  // ---- Forward forecast ----
  const points: ForecastPoint[] = [];
  for (let i = 0; i < horizon; i++) {
    const week = addWeeks(FORECAST_START, i);
    const y1 = routineNear(addWeeks(week, -52));
    const y2 = routineNear(addWeeks(week, -104));
    const baseline = mean([...y1, ...y2]) * growth;
    const contribs: ProjectContribution[] = [];
    let upside = 0;
    for (const p of projects) {
      if (p.status === 'completed') continue;
      for (const ph of p.phases) {
        const d = ph.demand.find((x) => x.licenceId === licenceId);
        if (!d) continue;
        const shape = phaseShape(ph.start, ph.end, week);
        if (!shape) continue;
        const full = d.seats * ratio.value * shape;
        const seats = full * p.confidence;
        upside += full - seats;
        contribs.push({ projectId: p.id, phaseId: ph.id, phaseName: ph.name, planned: d.seats, seats, tentative: p.dateStatus === 'tentative' });
      }
    }
    const p50 = baseline + contribs.reduce((s, c) => s + c.seats, 0);
    const p90 = p50 + 1.28 * sigma + upside;
    const capacity = opts.capacityFn ? opts.capacityFn(week) : lic.seats;
    points.push({ week, baseline, p50, p90, capacity, projects: contribs });
  }

  return { licence: lic, history, points, ratio, growth, backtest, beta };
}

// ---- Shortage maths ----

function phi(z: number): number {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

function Phi(z: number): number {
  // Abramowitz–Stegun approximation of the standard normal CDF.
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/** Expected seats short in a week when demand ~ Normal(p50, σ) and capacity is fixed. */
export function expectedShortfall(p50: number, sigma: number, capacity: number): number {
  const z = (capacity - p50) / sigma;
  return Math.max(0, sigma * phi(z) + (p50 - capacity) * (1 - Phi(z)));
}

export interface ShortageSummary {
  forecastShortWeeks: string[]; // P90 above capacity
  expectedShortWeeks: string[]; // P50 above capacity
  seatWeeksShort: number; // expected
  maxGapP90: number;
  maxGapP50: number;
  blockedHours: number;
  firstShortWeek?: string;
  lastShortWeek?: string;
}

export function shortageSummary(f: ForecastResult, capacityFn?: (week: string) => number): ShortageSummary {
  const fs: string[] = [];
  const es: string[] = [];
  let sw = 0;
  let g90 = 0;
  let g50 = 0;
  for (const p of f.points) {
    const cap = capacityFn ? capacityFn(p.week) : p.capacity;
    if (p.p90 > cap + 0.05) fs.push(p.week);
    if (p.p50 > cap + 0.05) es.push(p.week);
    sw += expectedShortfall(p.p50, f.backtest.sigma, cap);
    g90 = Math.max(g90, p.p90 - cap);
    g50 = Math.max(g50, p.p50 - cap);
  }
  return {
    forecastShortWeeks: fs,
    expectedShortWeeks: es,
    seatWeeksShort: sw,
    maxGapP90: g90,
    maxGapP50: g50,
    blockedHours: sw * f.beta,
    firstShortWeek: fs[0],
    lastShortWeek: fs[fs.length - 1],
  };
}

/** Contiguous runs of weeks, for drawing shortage bands. */
export function runs(weeks: string[]): { start: string; end: string; count: number }[] {
  const out: { start: string; end: string; count: number }[] = [];
  for (const w of weeks) {
    const last = out[out.length - 1];
    if (last && addWeeks(last.end, 1) === w) {
      last.end = w;
      last.count += 1;
    } else out.push({ start: w, end: w, count: 1 });
  }
  return out;
}

export { CURRENT_WEEK, FORECAST_START };

/** The numbers behind one week's baseline, for the "Explain this forecast" panel. */
export function baselineDetail(f: ForecastResult, week: string): { y1: number | null; y2: number | null; avg: number; growth: number; baseline: number } {
  const at = new Map(f.history.map((h) => [h.week, h.routine]));
  const near = (w: string) => {
    const v = [-1, 0, 1].map((d) => at.get(addWeeks(w, d))).filter((x): x is number => x !== undefined);
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  };
  const y1 = near(addWeeks(week, -52));
  const y2 = near(addWeeks(week, -104));
  const vals = [y1, y2].filter((x): x is number => x !== null);
  const avg = vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : 0;
  const pt = f.points.find((p) => p.week === week);
  return { y1, y2, avg, growth: f.growth, baseline: pt?.baseline ?? avg * f.growth };
}
