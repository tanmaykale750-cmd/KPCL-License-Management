import { describe, expect, it } from 'vitest';
import { getBaseDataset } from '../../data/dataset';
import { SEED_FINANCE_INPUTS, SEED_LIMITS, SEED_REVIEW } from '../../data/records';
import type { Recommendation, ReviewRecord } from '../../domain/types';
import { inr, inrShort } from '../../lib/format';
import { canDecideRecommendation, nextStep, requiredSteps, tierFor } from '../../state/workflow';
import { PERMISSIONS, permissionsFor } from '../../state/roles';
import { calibration, expectedShortfall, forecast, shortageSummary } from '../forecast';
import { autoMap, parseCSVRows, qualityScoreFor } from './helpers';
import { DEFAULT_FILTERS, summarise } from '../metrics';
import { emptyPlan, enumerateOptions, evaluatePlan, fromScenario, renewalAdvice } from '../plan';
import { breakEvenHourly, ledgerTotals, priceVolume, robustness, verifiedSaving } from '../review';

const ds = getBaseDataset();
const fin = SEED_FINANCE_INPUTS[0];

describe('Indian number formatting', () => {
  it('groups rupees in lakh/crore style', () => {
    expect(inr(1234567)).toBe('₹12,34,567');
    expect(inrShort(48_30_00_000)).toBe('₹48.30 Cr');
    expect(inrShort(14_40_000)).toBe('₹14.4 L');
    expect(inrShort(-3_60_000)).toBe('−₹3.6 L');
    expect(inrShort(1_50_000, { sign: true })).toBe('+₹1.5 L');
  });
});

describe('sample dataset', () => {
  it('is deterministic', () => {
    const a = forecast(ds, 'ANS-MECH', { horizonWeeks: 26 });
    const b = forecast(getBaseDataset(), 'ANS-MECH', { horizonWeeks: 26 });
    expect(a.points.map((p) => p.p90)).toEqual(b.points.map((p) => p.p90));
  });
  it('summarises the portfolio consistently', () => {
    const s = summarise(ds, { ...DEFAULT_FILTERS, months: 12 });
    expect(s.seats).toBeGreaterThan(100);
    expect(s.util).toBeGreaterThan(0.2);
    expect(s.util).toBeLessThan(0.9);
    expect(s.idleSpend).toBeCloseTo(s.annualSpend * (1 - s.util), -3);
  });
});

describe('forecast', () => {
  const f = forecast(ds, 'ANS-MECH', { horizonWeeks: 26 });
  it('keeps P90 at or above P50 every week', () => {
    for (const p of f.points) expect(p.p90).toBeGreaterThanOrEqual(p.p50);
  });
  it('shows the ANSYS shortage in Q1 2027 driven by Project X', () => {
    const s = shortageSummary(f);
    expect(s.firstShortWeek! >= '2027-01-01' && s.firstShortWeek! <= '2027-02-01').toBe(true);
    const feb = f.points.filter((p) => p.week.startsWith('2027-02'));
    expect(Math.max(...feb.map((p) => p.p90))).toBeGreaterThan(10);
    expect(feb.some((p) => p.projects.some((c) => c.projectId === 'PRJ-X'))).toBe(true);
  });
  it('calibrates planned seats with completed projects', () => {
    const c = calibration(ds, 'ANS-MECH');
    expect(c.fallback).toBe(false);
    expect(c.value).toBeCloseTo(11 / 14, 2);
  });
  it('expected shortfall grows as capacity falls', () => {
    expect(expectedShortfall(10, 1, 8)).toBeGreaterThan(expectedShortfall(10, 1, 10));
    expect(expectedShortfall(10, 1, 14)).toBeLessThan(0.01);
  });
});

describe('optimisation (deterministic enumeration)', () => {
  const options = enumerateOptions(ds, 'ANS-MECH', fin, 26);
  it('ranks feasible plans first, cheapest first', () => {
    const feasible = options.filter((o) => o.feasible);
    expect(feasible.length).toBeGreaterThan(0);
    expect(options[0].feasible).toBe(true);
    for (let i = 1; i < feasible.length; i++) expect(feasible[i].evaluation.totalCost).toBeGreaterThanOrEqual(feasible[i - 1].evaluation.totalCost);
  });
  it('marks doing nothing as breaking the critical-project rule', () => {
    const none = options.find((o) => o.id === 'do-nothing')!;
    expect(none.feasible).toBe(false);
    expect(none.evaluation.criticalBreaches.some((b) => b.projectId === 'PRJ-X')).toBe(true);
  });
  it('total cost = extra licence cost + blocked hours × rate × loss factor', () => {
    const e = options[0].evaluation;
    expect(e.totalCost).toBeCloseTo(e.extraCost + e.blockedHours * fin.loadedHourlyCost * fin.productivityLoss - e.saving, 0);
  });
  it('re-evaluating the best option from scenario parameters gives the same result', () => {
    const i = options[0].evaluation.input;
    const lic = ds.licences.find((l) => l.id === 'ANS-MECH')!;
    const again = evaluatePlan(
      ds,
      fromScenario({ licenceId: i.licenceId, seats: lic.seats + i.seatsDelta, temporarySeats: i.tempSeats, temporaryWeeks: i.tempWeeks, temporaryStart: i.tempStart, projectShifts: i.projectShifts, projectDurationPct: i.durationPct, teamSizePct: i.teamSizePct, recoverIdle: i.recoverIdle, reallocateSeats: i.reallocate, horizonWeeks: i.horizonWeeks }, lic.seats),
      fin,
    );
    expect(again.totalCost).toBeCloseTo(options[0].evaluation.totalCost, 0);
  });
  it('an empty plan costs nothing extra', () => {
    expect(evaluatePlan(ds, emptyPlan('ANS-MECH'), fin).extraCost).toBe(0);
  });
  it('recommends keeping 46 Inventor seats at renewal', () => {
    const a = renewalAdvice(ds, 'INV-PRO');
    expect(a.keep).toBe(46);
    expect(a.annualSaving).toBe(6 * ds.licences.find((l) => l.id === 'INV-PRO')!.costPerSeat);
  });
});

describe('review maths', () => {
  it('splits an invoice change into volume and price', () => {
    const b = priceVolume(34, 90_000, 30, 95_000);
    expect(b.volume).toBe(-3_60_000);
    expect(b.price).toBe(1_50_000);
    expect(b.volume + b.price).toBe(b.invoiceChange);
  });
  it('credits only the volume effect or cost avoided', () => {
    const byId = (id: string) => SEED_REVIEW.find((r) => r.id === id)!;
    expect(verifiedSaving(byId('RV-2601'))).toBe(3_60_000);
    expect(verifiedSaving(byId('RV-2602'))).toBe(2_10_000);
    expect(verifiedSaving(byId('RV-2603'))).toBe(22_00_000);
    expect(verifiedSaving(byId('RV-2604'))).toBe(0);
  });
  it('excludes spend approved to protect projects from the savings ledger', () => {
    const purchase: ReviewRecord = { ...SEED_REVIEW[0], id: 'RV-X', kind: 'temporary', approvedValue: -9_00_000, state: 'awaiting-implementation' };
    const t = ledgerTotals([...SEED_REVIEW, purchase], 0);
    expect(t.approved).toBe(SEED_REVIEW.reduce((a, r) => a + r.approvedValue, 0));
    expect(t.verified).toBeLessThanOrEqual(t.realised);
    expect(t.realised).toBeLessThanOrEqual(t.approved);
  });
  it('computes break-even and robustness', () => {
    const be = breakEvenHourly(3_00_000, 100, 0.5);
    expect(be).toBe(6000);
    expect(robustness(be, 1500)).toBe('robust');
    expect(robustness(be, 4000)).toBe('sensitive');
    expect(breakEvenHourly(1, 0, 0.5)).toBe(Infinity);
  });
});

describe('approval workflow', () => {
  it('assigns tiers by limits', () => {
    expect(tierFor(5_00_000, 0, SEED_LIMITS)).toBe(1);
    expect(tierFor(-14_40_000, 0, SEED_LIMITS)).toBe(2);
    expect(tierFor(25_00_000, 10_00_000, SEED_LIMITS)).toBe(3);
    expect(requiredSteps(1)).toEqual(['admin']);
    expect(requiredSteps(2)).toEqual(['deptHead', 'admin']);
    expect(requiredSteps(3)).toEqual(['deptHead', 'admin', 'leadership']);
  });
  const rec: Recommendation = {
    id: 'REC-T', title: 't', licenceId: 'INV-PRO', projectIds: [], actions: ['reduce'], rationale: '', evidence: [], annualImpact: 14_40_000, oneOffCost: 0,
    blockedHoursExpected: 0, confidence: 'medium', source: 'optimiser', status: 'pending', approvalTier: 2, requiredApprovers: ['deptHead', 'admin'],
    approvals: [], submittedBy: 'Priya Nair', createdBy: 'Priya Nair', createdAt: '', dueDate: '2026-11-09', history: [],
  };
  it('enforces order: the department head decides tier 2 before the administrator', () => {
    const admin = canDecideRecommendation({ ...rec, submittedBy: 'Planning engine' }, 'admin', 'Suresh Kulkarni', ['admin', 'leadership'], null, 'design');
    expect(admin.ok).toBe(false);
    expect(admin.reason).toMatch(/department head/);
    const dh = canDecideRecommendation(rec, 'deptHead', 'Meera Joshi', ['deptHead'], 'design', 'design');
    expect(dh.ok && dh.blocking).toBe(true);
    const afterDept = { ...rec, submittedBy: 'Planning engine', approvals: [{ step: 'deptHead' as const, by: 'Meera Joshi', at: '', decision: 'approved' as const }] };
    expect(nextStep(afterDept)).toBe('admin');
    expect(canDecideRecommendation(afterDept, 'admin', 'Suresh Kulkarni', ['admin', 'leadership'], null, 'design').ok).toBe(true);
  });
  it('blocks self-approval', () => {
    const afterDept = { ...rec, approvals: [{ step: 'deptHead' as const, by: 'Meera Joshi', at: '', decision: 'approved' as const }] };
    expect(canDecideRecommendation(afterDept, 'admin', 'Priya Nair', ['admin', 'leadership'], null, 'design').ok).toBe(false);
  });
  it('needs a second administrator for the tier-3 final sign-off', () => {
    const t3: Recommendation = { ...rec, approvalTier: 3, requiredApprovers: ['deptHead', 'admin', 'leadership'], submittedBy: 'Planning engine',
      approvals: [{ step: 'deptHead', by: 'Meera Joshi', at: '', decision: 'approved' }, { step: 'admin', by: 'Suresh Kulkarni', at: '', decision: 'approved' }] };
    expect(nextStep(t3)).toBe('leadership');
    expect(canDecideRecommendation(t3, 'admin', 'Suresh Kulkarni', ['admin', 'leadership'], null, 'design').ok).toBe(false);
    expect(canDecideRecommendation(t3, 'admin', 'Prakash Varma', ['admin', 'leadership'], null, 'design').ok).toBe(true);
  });
  it('lets only the owning department head decide; tier 1 is an endorsement', () => {
    expect(canDecideRecommendation(rec, 'deptHead', 'Harish Kulkarni', ['deptHead'], 'sim', 'design').ok).toBe(false);
    const t1: Recommendation = { ...rec, approvalTier: 1, requiredApprovers: ['admin'] };
    const e = canDecideRecommendation(t1, 'deptHead', 'Meera Joshi', ['deptHead'], 'design', 'design');
    expect(e.ok).toBe(true);
    expect(e.blocking).toBe(false);
  });
});

describe('profiles', () => {
  it('fills the department and project scope from the signed-in employee', () => {
    const scope = { level: 'department' as const, department: 'Tooling & Plant', app_dept_id: 'mfg', projects: [], app_project_ids: [], primary_tool: null, app_licence_ids: [], app_user_id: 'u-vikram' };
    expect(permissionsFor('deptHead', scope).deptScope).toBe('mfg');
    expect(permissionsFor('projectLead', { ...scope, level: 'project', app_project_ids: ['PRJ-FIX'] }).projectScope).toEqual(['PRJ-FIX']);
    expect(permissionsFor('admin', scope).deptScope).toBeNull();
  });
  it('gives each profile its own landing page and views', () => {
    expect(PERMISSIONS.engineer.landing).toBe('/my-licences');
    expect(PERMISSIONS.engineer.areas).toEqual(['mylicences', 'requests']);
    expect(PERMISSIONS.projectLead.areas).toContain('team');
    expect(PERMISSIONS.deptHead.areas).toContain('team');
    expect(PERMISSIONS.deptHead.editAssignments && !PERMISSIONS.deptHead.editRegistry).toBe(true);
    expect(PERMISSIONS.admin.setLimits && PERMISSIONS.admin.verifySavings && PERMISSIONS.admin.editFinanceInputs).toBe(true);
    expect(PERMISSIONS.projectLead.seesCosts || PERMISSIONS.engineer.seesCosts).toBe(false);
  });
});

describe('import validation', () => {
  it('maps headers and finds the deliberate problems in the sample file', () => {
    const { table, mapping } = parseCSVRows();
    expect(mapping.username).toBe(0);
    const score = qualityScoreFor(table, mapping, ds);
    expect(score.issues).toBeGreaterThan(3);
    expect(score.quality).toBeGreaterThan(0);
    expect(score.quality).toBeLessThan(1);
    expect(autoMap(['User Name', 'Feature', 'Host', 'Checkout', 'Checkin', 'TZ']).feature).toBe(1);
  });
});
