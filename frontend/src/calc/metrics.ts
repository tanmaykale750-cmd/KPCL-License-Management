/**
 * Shared metric definitions. Every figure on every screen comes from these functions.
 *
 * Utilisation      = active licence-hours ÷ available licence-hours (working-hours basis, 50 h/seat/week)
 * Idle spend       = annual spend × (1 − utilisation)
 * Idle check-out   = hours a licence stayed checked out with no activity
 * Denial rate      = denied requests ÷ (check-outs + denied requests)
 * Blocked hours    = Σ over denials of the wait until the same user got a licence
 * Renewal exposure = annual value of contracts renewing within N days
 */
import type { Dataset } from '../data/dataset';
import type { Licence, LicenceType, MonthKey, MonthlyUsage, User } from '../domain/types';
import { DEMO_TODAY, addDays, addMonths, daysBetween, monthKey, monthsBack } from '../lib/dates';

export interface Filters {
  months: 3 | 6 | 12;
  deptId: string; // 'all' or department id
  family: string; // 'all' or software family
  type: 'all' | LicenceType;
}

export const DEFAULT_FILTERS: Filters = { months: 6, deptId: 'all', family: 'all', type: 'all' };

export const CURRENT_MONTH: MonthKey = monthKey(DEMO_TODAY);

export function periodMonths(months: number, offset = 0): MonthKey[] {
  return monthsBack(addMonths(CURRENT_MONTH, -offset * months), months);
}

export function licenceMatches(l: Licence, f: Pick<Filters, 'family' | 'type'>): boolean {
  return (f.family === 'all' || l.family === f.family) && (f.type === 'all' || l.type === f.type);
}

export function filterLicences(ds: Dataset, f: Filters): Licence[] {
  return ds.licences.filter((l) => licenceMatches(l, f) && (f.deptId === 'all' || (l.allocations[f.deptId] ?? 0) > 0));
}

/** Annual spend attributable to a department (allocated seats × cost) or the whole licence. */
export function licenceSpend(l: Licence, deptId = 'all'): number {
  if (deptId === 'all') return l.seats * l.costPerSeat;
  return (l.allocations[deptId] ?? 0) * l.costPerSeat;
}

export function seatsFor(l: Licence, deptId = 'all'): number {
  return deptId === 'all' ? l.seats : l.allocations[deptId] ?? 0;
}

export function usageRows(ds: Dataset, f: Filters, months: MonthKey[]): MonthlyUsage[] {
  const ids = new Set(filterLicences(ds, f).map((l) => l.id));
  const ms = new Set(months);
  return ds.monthly.filter((r) => ids.has(r.licenceId) && ms.has(r.month) && (f.deptId === 'all' || r.deptId === f.deptId));
}

export interface UsageTotals {
  available: number;
  active: number;
  idleCheckout: number;
  checkouts: number;
  denials: number;
  blocked: number;
}

export function totals(rows: MonthlyUsage[]): UsageTotals {
  const t: UsageTotals = { available: 0, active: 0, idleCheckout: 0, checkouts: 0, denials: 0, blocked: 0 };
  for (const r of rows) {
    t.available += r.availableHours;
    t.active += r.activeHours;
    t.idleCheckout += r.idleCheckoutHours;
    t.checkouts += r.checkouts;
    t.denials += r.denials;
    t.blocked += r.blockedHours;
  }
  return t;
}

export const utilisation = (t: UsageTotals) => (t.available > 0 ? t.active / t.available : 0);
export const idleCheckoutShare = (t: UsageTotals) => (t.available > 0 ? t.idleCheckout / t.available : 0);
export const denialRate = (t: UsageTotals) => (t.checkouts + t.denials > 0 ? t.denials / (t.checkouts + t.denials) : 0);
export const idleSpend = (annualSpend: number, util: number) => annualSpend * (1 - util);

export interface PortfolioSummary {
  licences: Licence[];
  seats: number;
  seatsByType: Record<LicenceType, number>;
  annualSpend: number;
  util: number;
  idleSpend: number;
  idleCheckoutShare: number;
  blockedHours: number;
  denials: number;
  denialRate: number;
  renewal90: number;
  split: { inUse: number; idleCheckout: number; unused: number };
}

export function summarise(ds: Dataset, f: Filters, offset = 0): PortfolioSummary {
  const lics = filterLicences(ds, f);
  const rows = usageRows(ds, f, periodMonths(f.months, offset));
  const t = totals(rows);
  const util = utilisation(t);
  const ics = idleCheckoutShare(t);
  const annualSpend = lics.reduce((s, l) => s + licenceSpend(l, f.deptId), 0);
  const seatsByType: Record<LicenceType, number> = { floating: 0, named: 0, 'node-locked': 0, token: 0 };
  let seats = 0;
  for (const l of lics) {
    const n = seatsFor(l, f.deptId);
    seats += n;
    seatsByType[l.type] += n;
  }
  return {
    licences: lics,
    seats,
    seatsByType,
    annualSpend,
    util,
    idleSpend: idleSpend(annualSpend, util),
    idleCheckoutShare: ics,
    blockedHours: t.blocked,
    denials: t.denials,
    denialRate: denialRate(t),
    renewal90: renewalExposure(lics, 90, f.deptId),
    split: {
      inUse: annualSpend * util,
      idleCheckout: annualSpend * ics,
      unused: annualSpend * Math.max(0, 1 - util - ics),
    },
  };
}

export function renewalExposure(lics: Licence[], withinDays: number, deptId = 'all'): number {
  return lics
    .filter((l) => {
      const d = daysBetween(DEMO_TODAY, l.renewalDate);
      return d >= 0 && d <= withinDays;
    })
    .reduce((s, l) => s + licenceSpend(l, deptId), 0);
}

export function daysToRenewal(l: Licence): number {
  return daysBetween(DEMO_TODAY, l.renewalDate);
}

export interface DeptRow {
  deptId: string;
  name: string;
  spend: number;
  util: number;
  usedSpend: number;
  idleSpend: number;
  seats: number;
  blocked: number;
}

/** Spend vs use per department. */
export function departmentBreakdown(ds: Dataset, f: Filters): DeptRow[] {
  return ds.departments.map((d) => {
    const fd: Filters = { ...f, deptId: d.id };
    const s = summarise(ds, fd);
    return { deptId: d.id, name: d.name, spend: s.annualSpend, util: s.util, usedSpend: s.annualSpend * s.util, idleSpend: s.idleSpend, seats: s.seats, blocked: s.blockedHours };
  });
}

export interface TrendPoint {
  month: MonthKey;
  spend: number; // monthly run-rate (annual ÷ 12)
  util: number;
  blocked: number;
  idleCheckoutShare: number;
}

export function monthlyTrend(ds: Dataset, f: Filters, count = 12): TrendPoint[] {
  const lics = filterLicences(ds, f);
  return monthsBack(CURRENT_MONTH, count).map((m) => {
    const t = totals(usageRows(ds, f, [m]));
    // Seats changed during the year only for the ANSYS re-host, which nets to zero across the two pools.
    const spend = lics.reduce((s, l) => s + licenceSpend(l, f.deptId), 0) / 12;
    return { month: m, spend, util: utilisation(t), blocked: t.blocked, idleCheckoutShare: idleCheckoutShare(t) };
  });
}

export interface LicenceRow {
  licence: Licence;
  seats: number;
  spend: number;
  util: number;
  idleShare: number;
  idleHours: number;
  idleSpend: number;
  peak: number;
  avgPeak: number;
  denials: number;
  blocked: number;
  daysToRenewal: number;
  users: number;
}

export function licenceRows(ds: Dataset, f: Filters): LicenceRow[] {
  const months = periodMonths(f.months);
  const firstWeek = `${months[0]}-01`;
  return filterLicences(ds, f).map((l) => {
    const rows = usageRows(ds, { ...f, family: 'all', type: 'all' }, months).filter((r) => r.licenceId === l.id);
    const t = totals(rows);
    const util = utilisation(t);
    const spend = licenceSpend(l, f.deptId);
    const wk = ds.weekly.filter((w) => w.licenceId === l.id && w.weekStart >= firstWeek);
    const peak = wk.reduce((m, w) => Math.max(m, w.observedPeak), 0);
    const avgPeak = wk.length ? wk.reduce((s, w) => s + w.observedPeak, 0) / wk.length : 0;
    const users = new Set(ds.userUsage.filter((u) => u.licenceId === l.id).map((u) => u.userId)).size;
    return {
      licence: l,
      seats: seatsFor(l, f.deptId),
      spend,
      util,
      idleShare: idleCheckoutShare(t),
      idleHours: t.idleCheckout,
      idleSpend: idleSpend(spend, util),
      peak,
      avgPeak,
      denials: t.denials,
      blocked: t.blocked,
      daysToRenewal: daysToRenewal(l),
      users,
    };
  });
}

export interface UnusedBucket {
  label: '30–60 days' | '60–90 days' | '90+ days';
  seats: number;
  value: number;
  holders: { userId: string; licenceId: string; lastActive: string; days: number }[];
}

/** Named seats unused for 30, 60 or 90+ days. */
export function unusedBuckets(ds: Dataset, f: Filters): UnusedBucket[] {
  const lics = new Map(filterLicences(ds, f).map((l) => [l.id, l]));
  const users = new Map(ds.users.map((u) => [u.id, u]));
  const b: UnusedBucket[] = [
    { label: '30–60 days', seats: 0, value: 0, holders: [] },
    { label: '60–90 days', seats: 0, value: 0, holders: [] },
    { label: '90+ days', seats: 0, value: 0, holders: [] },
  ];
  for (const a of ds.assignments) {
    const l = lics.get(a.licenceId);
    if (!l) continue;
    const u = users.get(a.userId);
    if (f.deptId !== 'all' && u?.deptId !== f.deptId) continue;
    const days = daysBetween(a.lastActive, DEMO_TODAY);
    const idx = days >= 90 ? 2 : days >= 60 ? 1 : days >= 30 ? 0 : -1;
    if (idx < 0) continue;
    b[idx].seats += 1;
    b[idx].value += l.costPerSeat;
    b[idx].holders.push({ userId: a.userId, licenceId: a.licenceId, lastActive: a.lastActive, days });
  }
  return b;
}

export interface RareRow {
  licence: Licence;
  users: number;
  hoursPerSeatMonth: number;
  spend: number;
  reason: string;
}

/** Rarely used: 2 users or fewer, or under 10 active hours per seat per month (defaults from the solution). */
export function rarelyUsed(ds: Dataset, f: Filters): RareRow[] {
  const rows = licenceRows(ds, f);
  return rows
    .map((r) => {
      const users = ds.userUsage.filter((u) => u.licenceId === r.licence.id && u.activeHours12m > 0).length;
      const t = totals(usageRows(ds, { ...f, family: 'all', type: 'all' }, periodMonths(12)).filter((x) => x.licenceId === r.licence.id));
      const hrs = r.seats > 0 ? t.active / 12 / r.licence.seats : 0;
      const reason = users <= 2 ? `${users} users` : hrs < 10 ? `${hrs.toFixed(1)} h per seat a month` : '';
      return { licence: r.licence, users, hoursPerSeatMonth: hrs, spend: r.spend, reason };
    })
    .filter((r) => r.reason !== '' || r.hoursPerSeatMonth < 25)
    .sort((a, b) => a.hoursPerSeatMonth - b.hoursPerSeatMonth);
}

export interface TeamIdle {
  team: string;
  deptId: string;
  idleHours: number;
  idleCost: number;
  users: number;
}

/** Idle check-out hours by team, priced at the licence's hourly cost on a working-hours basis. */
export function idleByTeam(ds: Dataset, f: Filters): TeamIdle[] {
  const lics = new Map(filterLicences(ds, f).map((l) => [l.id, l]));
  const users = new Map(ds.users.map((u) => [u.id, u] as [string, User]));
  const map = new Map<string, TeamIdle>();
  for (const uu of ds.userUsage) {
    const l = lics.get(uu.licenceId);
    const u = users.get(uu.userId);
    if (!l || !u) continue;
    if (f.deptId !== 'all' && u.deptId !== f.deptId) continue;
    const key = `${u.deptId}|${u.team}`;
    const row = map.get(key) ?? { team: u.team, deptId: u.deptId, idleHours: 0, idleCost: 0, users: 0 };
    row.idleHours += uu.idleHours12m;
    row.idleCost += uu.idleHours12m * (l.costPerSeat / (52 * 50));
    row.users += uu.idleHours12m > 120 ? 1 : 0;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.idleHours - a.idleHours);
}

/** Denials by weekday × hour for a pool. Timestamps are synthetic, spread over a working-day profile. */
export function denialHeatmap(ds: Dataset, licenceId: string, months: MonthKey[]): number[][] {
  const total = ds.monthly.filter((r) => r.licenceId === licenceId && months.includes(r.month)).reduce((s, r) => s + r.denials, 0);
  const dayW = [0.17, 0.27, 0.26, 0.18, 0.12];
  const hourW = [0.03, 0.07, 0.1, 0.12, 0.08, 0.05, 0.12, 0.16, 0.15, 0.12]; // 08:00–17:00
  return dayW.map((dw) => hourW.map((hw) => Math.round(total * dw * hw)));
}

export function nextRenewals(ds: Dataset, f: Filters, withinDays = 183): Licence[] {
  return filterLicences(ds, f)
    .filter((l) => {
      const d = daysToRenewal(l);
      return d >= 0 && d <= withinDays;
    })
    .sort((a, b) => a.renewalDate.localeCompare(b.renewalDate));
}

export function lastActiveBand(lastActive: string): string {
  const d = daysBetween(lastActive, DEMO_TODAY);
  if (d >= 90) return '90+ days';
  if (d >= 60) return '60–90 days';
  if (d >= 30) return '30–60 days';
  return 'Active';
}

export function addDaysFromToday(n: number): string {
  return addDays(DEMO_TODAY, n);
}
