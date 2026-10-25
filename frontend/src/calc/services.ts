/**
 * Module 5 — Other Services Tracking. Measurement only: no forecasting, optimisation or recommendations.
 *
 * Idle spend is judged by how each service is billed (see IdleBasis):
 *   commitment   idle = fixed fee × (1 − used ÷ committed capacity)   — usage above the commitment is billed overage, never idle
 *   provisioned  idle = spend × (1 − busy share)                      — VMs, GPUs, databases, block/file storage
 *   consumption  idle = 0                                              — pay-as-you-go calls, tokens, object storage, serverless
 * Utilisation is measured on paid capacity only: 1 − idle ÷ capacity spend. Pay-as-you-go spend is reported separately.
 */
import type { IdleBasis, MonthKey, ServiceBilling, ServiceCategory, ServiceKey, ServiceRecord } from '../domain/types';
import { SERVICES_CURRENT_MONTH } from '../data/services';
import { addMonths, daysBetween, DEMO_TODAY, monthsBack } from '../lib/dates';

export interface ServiceFilters {
  months: 3 | 6 | 12;
  deptId: string; // 'all' | department id | 'unallocated'
  category: 'all' | ServiceCategory;
  billing: 'all' | ServiceBilling;
}

export const DEFAULT_SERVICE_FILTERS: ServiceFilters = { months: 12, deptId: 'all', category: 'all', billing: 'all' };

export const CATEGORY_LABEL: Record<ServiceCategory, string> = { api: 'API service', ai: 'AI tokens', cloud: 'Cloud' };
export const SUBTYPE_LABEL: Record<ServiceRecord['subType'], string> = { api: 'API', ai: 'AI model', vm: 'Virtual machine', gpu: 'GPU instance', database: 'Database', storage: 'Storage' };
export const BILLING_LABEL: Record<ServiceBilling, string> = {
  subscription: 'Subscription',
  prepaid: 'Prepaid credits',
  reserved: 'Reserved / committed',
  'on-demand': 'Provisioned (on-demand)',
  payg: 'Pay-as-you-go',
};
export const BASIS_RULE: Record<IdleBasis, string> = {
  commitment: 'Fixed fee buys a capacity: idle = fee × unused share. Usage above it is billed overage, not idle.',
  provisioned: 'Billed while provisioned: idle = spend × (1 − busy share from telemetry).',
  consumption: 'Billed only for what is used: no idle spend, utilisation not applicable.',
};

export const RARE_KEY_DAYS = 30;
export const RENEWAL_WINDOW_DAYS = 90;

export function servicePeriod(months: number, offset = 0): MonthKey[] {
  return monthsBack(addMonths(SERVICES_CURRENT_MONTH, -offset * months), months);
}

export function filterServices(all: ServiceRecord[], f: Pick<ServiceFilters, 'deptId' | 'category' | 'billing'>): ServiceRecord[] {
  return all.filter(
    (s) =>
      (f.deptId === 'all' || (f.deptId === 'unallocated' ? s.deptId === null : s.deptId === f.deptId)) &&
      (f.category === 'all' || s.category === f.category) &&
      (f.billing === 'all' || s.billing === f.billing),
  );
}

export interface ServiceStats {
  spend: number; // ₹ in the period
  capacitySpend: number; // part of spend that buys capacity (commitment fees, provisioned resources)
  meteredSpend: number; // pay-as-you-go spend plus overage above commitments
  idle: number; // ₹ of capacity spend not used
  util: number | null; // null for pay-as-you-go
  avgUsage: number; // per month
  avgCapacity: number | null; // per month
  quotaHits: number;
  blockedHours: number;
  activeMonths: number;
}

export function statsFor(s: ServiceRecord, months: MonthKey[]): ServiceStats {
  const rows = s.months.filter((m) => months.includes(m.month));
  const active = rows.filter((m) => m.spend > 0);
  const spend = rows.reduce((a, m) => a + m.spend, 0);
  const idle = rows.reduce((a, m) => a + m.idle, 0);
  let capacitySpend = 0;
  if (s.basis === 'commitment') capacitySpend = active.length * s.fixedMonthly;
  else if (s.basis === 'provisioned') capacitySpend = spend;
  const meteredSpend = spend - capacitySpend;
  const n = Math.max(1, active.length);
  return {
    spend,
    capacitySpend,
    meteredSpend,
    idle,
    util: s.basis === 'consumption' ? null : capacitySpend > 0 ? 1 - idle / capacitySpend : 0,
    avgUsage: active.reduce((a, m) => a + m.usage, 0) / n,
    avgCapacity: s.basis === 'consumption' ? null : active.reduce((a, m) => a + (m.capacity ?? 0), 0) / n,
    quotaHits: rows.reduce((a, m) => a + m.quotaHits, 0),
    blockedHours: rows.reduce((a, m) => a + m.blockedHours, 0),
    activeMonths: active.length,
  };
}

export interface ServicesSummary {
  services: number;
  keys: number;
  byCategory: Record<ServiceCategory, number>;
  spend: number; // period
  annualSpend: number; // annualised run-rate from the period
  capacitySpend: number;
  meteredSpend: number;
  idle: number;
  annualIdle: number;
  util: number; // on paid capacity
  blockedHours: number;
  quotaHits: number;
}

export function annualise(v: number, months: number): number {
  return (v * 12) / months;
}

export function summariseServices(list: ServiceRecord[], months: number, offset = 0): ServicesSummary {
  const period = servicePeriod(months, offset);
  const byCategory: Record<ServiceCategory, number> = { api: 0, ai: 0, cloud: 0 };
  let spend = 0;
  let cap = 0;
  let metered = 0;
  let idle = 0;
  let blocked = 0;
  let hits = 0;
  let keys = 0;
  for (const s of list) {
    const st = statsFor(s, period);
    byCategory[s.category]++;
    keys += s.keys.length;
    spend += st.spend;
    cap += st.capacitySpend;
    metered += st.meteredSpend;
    idle += st.idle;
    blocked += st.blockedHours;
    hits += st.quotaHits;
  }
  return {
    services: list.length,
    keys,
    byCategory,
    spend,
    annualSpend: annualise(spend, months),
    capacitySpend: cap,
    meteredSpend: metered,
    idle,
    annualIdle: annualise(idle, months),
    util: cap > 0 ? 1 - idle / cap : 0,
    blockedHours: blocked,
    quotaHits: hits,
  };
}

export interface ServiceDeptRow {
  deptId: string; // department id or 'unallocated' or 'others'
  name: string;
  spend: number; // annualised
  usedCapacity: number;
  idle: number;
  metered: number;
  util: number; // on paid capacity
  services: number;
}

export function serviceDeptRows(list: ServiceRecord[], months: number, departments: { id: string; name: string }[]): ServiceDeptRow[] {
  const period = servicePeriod(months);
  const groups: { id: string; name: string; match: (s: ServiceRecord) => boolean }[] = [
    ...departments.map((d) => ({ id: d.id, name: d.name, match: (s: ServiceRecord) => s.deptId === d.id })),
    { id: 'unallocated', name: 'Unallocated', match: (s: ServiceRecord) => s.deptId === null },
  ];
  return groups
    .map((g) => {
      const items = list.filter(g.match);
      let cap = 0;
      let idle = 0;
      let metered = 0;
      for (const s of items) {
        const st = statsFor(s, period);
        cap += st.capacitySpend;
        idle += st.idle;
        metered += st.meteredSpend;
      }
      const a = (v: number) => annualise(v, months);
      return { deptId: g.id, name: g.name, spend: a(cap + metered), usedCapacity: a(cap - idle), idle: a(idle), metered: a(metered), util: cap > 0 ? 1 - idle / cap : 0, services: items.length };
    })
    .filter((r) => r.services > 0);
}

export interface ServiceTrendPoint {
  month: MonthKey;
  api: number;
  ai: number;
  cloud: number;
  idle: number;
  util: number;
  blockedHours: number;
}

export function serviceTrend(list: ServiceRecord[], count = 12): ServiceTrendPoint[] {
  return monthsBack(SERVICES_CURRENT_MONTH, count).map((m) => {
    const p: ServiceTrendPoint = { month: m, api: 0, ai: 0, cloud: 0, idle: 0, util: 0, blockedHours: 0 };
    let cap = 0;
    for (const s of list) {
      const row = s.months.find((x) => x.month === m);
      if (!row) continue;
      p[s.category] += row.spend;
      p.idle += row.idle;
      p.blockedHours += row.blockedHours;
      if (s.basis === 'commitment' && row.spend > 0) cap += s.fixedMonthly;
      else if (s.basis === 'provisioned') cap += row.spend;
    }
    p.util = cap > 0 ? 1 - p.idle / cap : 0;
    return p;
  });
}

// ---------------- Detail sections (all measured; no recommendations) ----------------

export interface ServiceRow {
  s: ServiceRecord;
  st: ServiceStats;
}

export function serviceRows(list: ServiceRecord[], months: number): ServiceRow[] {
  const period = servicePeriod(months);
  return list.map((s) => ({ s, st: statsFor(s, period) }));
}

/** Paid capacity under 40% used in the period (excludes pay-as-you-go). */
export function idleServices(rows: ServiceRow[], threshold = 0.4): ServiceRow[] {
  return rows.filter((r) => r.st.util !== null && r.st.util < threshold && r.st.capacitySpend > 0).sort((a, b) => b.st.idle - a.st.idle);
}

/**
 * Cloud resources with almost no measured use in the latest three months (under 15% busy) — stopped VMs
 * whose disks are still billed, unattached storage, idle GPUs. Uses the current state, not the selected period.
 */
export function unusedCloud(list: ServiceRecord[], threshold = 0.15): (ServiceRow & { recentUtil: number; monthlyIdle: number })[] {
  const recent = servicePeriod(3);
  return list
    .filter((s) => s.category === 'cloud' && s.basis !== 'consumption')
    .map((s) => {
      const st = statsFor(s, recent);
      return { s, st, recentUtil: st.util ?? 0, monthlyIdle: st.idle / 3 };
    })
    .filter((r) => r.recentUtil < threshold)
    .sort((a, b) => b.monthlyIdle - a.monthlyIdle);
}

export interface KeyRow {
  key: ServiceKey;
  service: ServiceRecord;
  daysSinceUse: number;
}

export function allKeys(list: ServiceRecord[]): KeyRow[] {
  return list.flatMap((s) => s.keys.map((key) => ({ key, service: s, daysSinceUse: daysBetween(key.lastUsed, DEMO_TODAY) })));
}

/** Not used for 30+ days, or fewer than 50 calls in the last 30 days. */
export function rarelyUsedKeys(list: ServiceRecord[]): KeyRow[] {
  return allKeys(list)
    .filter((k) => k.daysSinceUse >= RARE_KEY_DAYS || k.key.calls30d < 50)
    .sort((a, b) => b.daysSinceUse - a.daysSinceUse);
}

export function quotaHitRows(rows: ServiceRow[]): ServiceRow[] {
  return rows.filter((r) => r.st.quotaHits > 0).sort((a, b) => b.st.blockedHours - a.st.blockedHours);
}

export interface Outlier {
  service: ServiceRecord;
  month: MonthKey;
  spend: number;
  baseline: number; // median of the six months before
  ratio: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** A month's spend at least 1.5× the median of the previous six months and ₹25,000 above it. */
export function spendOutliers(list: ServiceRecord[], months: number): Outlier[] {
  const period = servicePeriod(months);
  const out: Outlier[] = [];
  for (const s of list) {
    s.months.forEach((m, i) => {
      if (!period.includes(m.month) || i < 6) return;
      const prior = s.months.slice(i - 6, i).map((x) => x.spend).filter((x) => x > 0);
      if (prior.length < 3) return;
      const base = median(prior);
      if (m.spend >= base * 1.5 && m.spend - base >= 25_000) out.push({ service: s, month: m.month, spend: m.spend, baseline: base, ratio: m.spend / base });
    });
  }
  return out.sort((a, b) => b.spend - b.baseline - (a.spend - a.baseline));
}

export interface RenewalRow {
  kind: 'service' | 'key';
  id: string;
  label: string;
  service: ServiceRecord;
  date: string;
  days: number;
  what: string;
  annualValue: number;
}

export function upcomingRenewals(list: ServiceRecord[], withinDays = RENEWAL_WINDOW_DAYS): RenewalRow[] {
  const out: RenewalRow[] = [];
  for (const s of list) {
    if (s.renewalDate) {
      const d = daysBetween(DEMO_TODAY, s.renewalDate);
      if (d >= 0 && d <= withinDays) out.push({ kind: 'service', id: s.id, label: s.name, service: s, date: s.renewalDate, days: d, what: s.renewalKind ?? 'renewal', annualValue: s.fixedMonthly * 12 });
    }
    for (const k of s.keys) {
      if (!k.expires) continue;
      const d = daysBetween(DEMO_TODAY, k.expires);
      if (d >= 0 && d <= withinDays) out.push({ kind: 'key', id: k.id, label: `${k.label} · ${k.masked}`, service: s, date: k.expires, days: d, what: 'key expires', annualValue: 0 });
    }
  }
  return out.sort((a, b) => a.days - b.days);
}

export interface OwnerRow {
  ownerUserId: string;
  services: number;
  keys: number;
  rareKeys: number;
  spend: number; // annualised
  idle: number; // annualised
  quotaHits: number;
  depts: string[];
}

export function ownerRows(list: ServiceRecord[], months: number): OwnerRow[] {
  const period = servicePeriod(months);
  const rare = new Set(rarelyUsedKeys(list).map((k) => k.key.id));
  const map = new Map<string, OwnerRow>();
  const get = (id: string) => {
    if (!map.has(id)) map.set(id, { ownerUserId: id, services: 0, keys: 0, rareKeys: 0, spend: 0, idle: 0, quotaHits: 0, depts: [] });
    return map.get(id)!;
  };
  for (const s of list) {
    const st = statsFor(s, period);
    const o = get(s.ownerUserId);
    o.services++;
    o.spend += annualise(st.spend, months);
    o.idle += annualise(st.idle, months);
    o.quotaHits += st.quotaHits;
    const d = s.deptId ?? 'unallocated';
    if (!o.depts.includes(d)) o.depts.push(d);
    for (const k of s.keys) {
      const ko = get(k.ownerUserId);
      ko.keys++;
      if (rare.has(k.id)) ko.rareKeys++;
    }
  }
  return [...map.values()].sort((a, b) => b.spend - a.spend);
}

export function formatQty(v: number, unit: string): string {
  const n = v >= 100 ? Math.round(v).toLocaleString('en-IN') : v >= 10 ? v.toFixed(0) : v.toFixed(1);
  return `${n} ${unit}`;
}
