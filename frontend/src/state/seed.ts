import { renewalAdvice } from '../calc/plan';
import { getBaseDataset } from '../data/dataset';
import {
  SEED_AUDIT,
  SEED_BUDGET_USE,
  SEED_FINANCE_INPUTS,
  SEED_INVOICES,
  SEED_LIMITS,
  SEED_REQUESTS,
  SEED_REVIEW,
} from '../data/records';
import type { Recommendation, RoleId } from '../domain/types';
import { DEFAULT_FILTERS } from '../calc/metrics';
import { requiredSteps, tierFor } from './workflow';
import type { AppState } from './store';

/** Recommendations drafted by the scheduled renewal review — values come from the same calculation the UI shows. */
export function seedRecommendations(): Recommendation[] {
  const ds = getBaseDataset();
  const out: Recommendation[] = [];
  const mk = (id: string, licenceId: string, projects: string[], due: string): void => {
    const a = renewalAdvice(ds, licenceId);
    if (a.reduceBy <= 0) return;
    const tier = tierFor(a.annualSaving, 0, SEED_LIMITS);
    out.push({
      id,
      title: `${a.licence.product}: renew ${a.keep} seats, not ${a.licence.seats}`,
      licenceId,
      projectIds: projects,
      actions: ['reduce'],
      rationale: a.reason,
      evidence: a.evidence,
      annualImpact: a.annualSaving,
      oneOffCost: 0,
      blockedHoursExpected: 0,
      confidence: 'high',
      source: 'renewal-review',
      status: 'pending',
      approvalTier: tier,
      requiredApprovers: requiredSteps(tier),
      approvals: [],
      createdBy: 'Planning engine (scheduled run)',
      createdAt: '2026-10-20 06:00',
      dueDate: due,
      seatsBefore: a.licence.seats,
      seatsAfter: a.keep,
      history: [{ at: '2026-10-20 06:00', actor: 'Planning engine', action: 'Drafted from renewal review' }],
    });
  };
  mk('REC-1041', 'INV-PRO', ['PRJ-X', 'PRJ-Y'], '2026-11-09');
  mk('REC-1042', 'ADSK-VAULT', [], '2026-11-09');
  return out;
}

export interface Thresholds {
  shortageLeadWeeks: number; // alert when a P90 shortage starts within this many weeks
  renewalWindowDays: number; // alert when a renewal is this close
  denialLimit: number; // denied requests in the last 4 weeks that trigger an alert
}

export const DEFAULT_THRESHOLDS: Thresholds = { shortageLeadWeeks: 16, renewalWindowDays: 90, denialLimit: 3 };

export function initialState(role: RoleId = 'admin'): AppState {
  return {
    version: 7,
    role,
    filters: DEFAULT_FILTERS,
    requests: structuredClone(SEED_REQUESTS),
    recommendations: seedRecommendations(),
    review: structuredClone(SEED_REVIEW),
    invoices: structuredClone(SEED_INVOICES),
    audit: structuredClone(SEED_AUDIT),
    scenarios: [],
    imports: [],
    importedRows: 0,
    limits: structuredClone(SEED_LIMITS),
    finance: structuredClone(SEED_FINANCE_INPUTS),
    licenceEdits: {},
    assignmentChanges: [],
    projectChanges: [],
    readNotifications: [],
    budgetUse: structuredClone(SEED_BUDGET_USE),
    thresholds: { ...DEFAULT_THRESHOLDS },
    seq: 50,
  };
}
