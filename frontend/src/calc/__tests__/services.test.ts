import { describe, expect, it } from 'vitest';
import { DEPARTMENTS } from '../../data/catalog';
import { getServices } from '../../data/services';
import { PERMISSIONS } from '../../state/roles';
import {
  filterServices,
  idleServices,
  ownerRows,
  quotaHitRows,
  rarelyUsedKeys,
  serviceDeptRows,
  serviceRows,
  servicePeriod,
  serviceTrend,
  spendOutliers,
  statsFor,
  summariseServices,
  unusedCloud,
  upcomingRenewals,
} from '../services';

const all = getServices();

describe('Other Services — data', () => {
  it('covers the three categories with an unallocated segment', () => {
    expect(new Set(all.map((s) => s.category))).toEqual(new Set(['api', 'ai', 'cloud']));
    expect(new Set(all.filter((s) => s.category === 'cloud').map((s) => s.subType))).toEqual(new Set(['vm', 'gpu', 'database', 'storage']));
    expect(all.some((s) => s.deptId === null)).toBe(true);
  });
  it('never holds an API secret — only a masked identifier and the last four characters', () => {
    for (const s of all)
      for (const k of s.keys) {
        expect(k.last4).toMatch(/^[A-Za-z0-9]{4}$/);
        expect(k.masked).toMatch(/^[A-Za-z0-9._-]{1,9}••••[A-Za-z0-9]{4}$/);
        expect(k.masked.endsWith(k.last4)).toBe(true);
        expect(Object.keys(k).some((f) => /secret|token|value/i.test(f))).toBe(false);
      }
  });
});

describe('Other Services — idle spend rules', () => {
  const period = servicePeriod(12);
  it('never counts pay-as-you-go spend as idle', () => {
    for (const s of all.filter((x) => x.basis === 'consumption')) {
      const st = statsFor(s, period);
      expect(st.idle).toBe(0);
      expect(st.util).toBeNull();
      expect(st.meteredSpend).toBeCloseTo(st.spend, 6);
    }
  });
  it('commitments: idle = fee × unused share; overage is metered, not idle', () => {
    for (const s of all.filter((x) => x.basis === 'commitment'))
      for (const m of s.months.filter((x) => x.spend > 0)) {
        const unused = Math.max(0, 1 - Math.min(m.usage, m.capacity!) / m.capacity!);
        expect(m.idle).toBeCloseTo(s.fixedMonthly * unused, 4);
        expect(m.idle).toBeLessThanOrEqual(s.fixedMonthly + 1e-6);
      }
  });
  it('provisioned resources: idle = spend × (1 − busy share)', () => {
    for (const s of all.filter((x) => x.basis === 'provisioned'))
      for (const m of s.months.filter((x) => x.spend > 0 && x.capacity)) expect(m.idle).toBeCloseTo(m.spend * (1 - m.usage / m.capacity!), 4);
  });
  it('spend = capacity in use + idle + metered, and utilisation = 1 − idle ÷ capacity spend', () => {
    const sum = summariseServices(all, 12);
    expect(sum.capacitySpend + sum.meteredSpend).toBeCloseTo(sum.spend, 2);
    expect(sum.util).toBeCloseTo(1 - sum.idle / sum.capacitySpend, 8);
    expect(sum.annualSpend).toBeCloseTo(sum.spend, 2); // 12-month period is already annual
    expect(summariseServices(all, 6).annualSpend).toBeCloseTo(summariseServices(all, 6).spend * 2, 2);
  });
  it('department rows (with Unallocated) add up to the company total', () => {
    const rows = serviceDeptRows(all, 12, DEPARTMENTS);
    const total = rows.reduce((a, r) => a + r.spend, 0);
    expect(total).toBeCloseTo(summariseServices(all, 12).annualSpend, 0);
    expect(rows.some((r) => r.deptId === 'unallocated')).toBe(true);
    for (const r of rows) expect(r.usedCapacity + r.idle + r.metered).toBeCloseTo(r.spend, 2);
  });
  it('trend totals match the 12-month summary', () => {
    const t = serviceTrend(all, 12);
    const spend = t.reduce((a, p) => a + p.api + p.ai + p.cloud, 0);
    expect(spend).toBeCloseTo(summariseServices(all, 12).spend, 2);
  });
});

describe('Other Services — filters and detail sections', () => {
  it('filters by department, unallocated, category and billing', () => {
    expect(filterServices(all, { deptId: 'sim', category: 'all', billing: 'all' }).every((s) => s.deptId === 'sim')).toBe(true);
    expect(filterServices(all, { deptId: 'unallocated', category: 'all', billing: 'all' }).every((s) => s.deptId === null)).toBe(true);
    expect(filterServices(all, { deptId: 'all', category: 'ai', billing: 'payg' }).every((s) => s.category === 'ai' && s.billing === 'payg')).toBe(true);
  });
  const rows = serviceRows(all, 12);
  it('idle services exclude pay-as-you-go and are under 40% used', () => {
    for (const r of idleServices(rows)) {
      expect(r.s.basis).not.toBe('consumption');
      expect(r.st.util!).toBeLessThan(0.4);
    }
  });
  it('finds the stopped VM, unattached disks and idle render GPUs as unused cloud', () => {
    const ids = unusedCloud(all).map((r) => r.s.id);
    expect(ids).toEqual(expect.arrayContaining(['SV-CL-03', 'SV-CL-06', 'SV-CL-12']));
  });
  it('rarely used keys: 30+ days since use or under 50 calls in 30 days', () => {
    const rare = rarelyUsedKeys(all);
    expect(rare.length).toBeGreaterThan(0);
    for (const k of rare) expect(k.daysSinceUse >= 30 || k.key.calls30d < 50).toBe(true);
  });
  it('flags the August Gemini batch as a spend outlier and records limit hits', () => {
    expect(spendOutliers(all, 12).some((o) => o.service.id === 'SV-AI-04' && o.month === '2026-08')).toBe(true);
    const hits = quotaHitRows(rows);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.reduce((a, r) => a + r.st.blockedHours, 0)).toBeCloseTo(summariseServices(all, 12).blockedHours, 6);
  });
  it('lists renewals and key expiries within 90 days, soonest first', () => {
    const r = upcomingRenewals(all);
    expect(r.length).toBeGreaterThan(0);
    for (let i = 1; i < r.length; i++) expect(r[i].days).toBeGreaterThanOrEqual(r[i - 1].days);
    expect(r.every((x) => x.days >= 0 && x.days <= 90)).toBe(true);
  });
  it('owner view totals match the service totals', () => {
    const o = ownerRows(all, 12);
    expect(o.reduce((a, x) => a + x.spend, 0)).toBeCloseTo(summariseServices(all, 12).annualSpend, 0);
    expect(o.reduce((a, x) => a + x.keys, 0)).toBe(all.reduce((a, s) => a + s.keys.length, 0));
  });
});

describe('Other Services — role access', () => {
  it('is open to administrators and department heads only', () => {
    expect(PERMISSIONS.admin.areas).toContain('services');
    expect(PERMISSIONS.deptHead.areas).toContain('services');
    expect(PERMISSIONS.projectLead.areas).not.toContain('services');
    expect(PERMISSIONS.engineer.areas).not.toContain('services');
  });
});
