/** Pure workflow rules shared by the store and the UI. */
import type { AccessRequest, ApprovalLimits, ApprovalStep, Recommendation, RoleId } from '../domain/types';

/** Tier by financial commitment: annual impact plus any one-off cost. */
export function tierFor(annualImpact: number, oneOffCost: number, limits: ApprovalLimits): 1 | 2 | 3 {
  const value = Math.abs(annualImpact) + Math.abs(oneOffCost);
  if (value <= limits.tier1) return 1;
  if (value <= limits.tier2) return 2;
  return 3;
}

/**
 * Blocking steps, in order.
 *   Tier 1: licence administrator (the owning department head may still endorse or object; it does not block).
 *   Tier 2: owning department head, then licence administrator.
 *   Tier 3: owning department head, licence administrator, then a final sign-off by a second administrator.
 */
export function requiredSteps(tier: 1 | 2 | 3): ApprovalStep[] {
  if (tier === 1) return ['admin'];
  if (tier === 2) return ['deptHead', 'admin'];
  return ['deptHead', 'admin', 'leadership'];
}

/** Next step still waiting for a decision, in order. */
export function nextStep(rec: Recommendation): ApprovalStep | null {
  if (rec.status !== 'pending') return null;
  for (const s of rec.requiredApprovers) if (!rec.approvals.some((a) => a.step === s && a.decision === 'approved')) return s;
  return null;
}

export interface CanDecide {
  ok: boolean;
  step?: ApprovalStep;
  /** true when the department head's decision is a required (blocking) step, not just an endorsement */
  blocking?: boolean;
  reason?: string;
}

/**
 * Nobody approves their own submission; steps go in order; each profile signs only its own step; the final sign-off
 * must come from a different administrator than the one who approved.
 */
export function canDecideRecommendation(rec: Recommendation, role: RoleId, actorName: string, roleSteps: ApprovalStep[], deptScope: string | null, ownerDeptId: string): CanDecide {
  if (rec.status !== 'pending') return { ok: false, reason: 'No decision pending.' };
  if (roleSteps.includes('deptHead')) {
    if (deptScope !== ownerDeptId) return { ok: false, reason: 'Only the owning department head decides on this recommendation.' };
    if (rec.approvals.some((a) => a.step === 'deptHead')) return { ok: false, reason: 'Your decision is already recorded.' };
    if (rec.submittedBy === actorName) return { ok: false, step: 'deptHead', reason: 'You submitted this recommendation; it was endorsed on submission.' };
    return { ok: true, step: 'deptHead', blocking: rec.requiredApprovers.includes('deptHead') };
  }
  const step = nextStep(rec);
  if (!step) return { ok: false, reason: 'No decision pending.' };
  if (!roleSteps.includes(step)) return { ok: false, step, reason: `Waiting for ${stepName(step)}.` };
  if (rec.submittedBy === actorName) return { ok: false, step, reason: 'You submitted this recommendation; another person must approve it.' };
  if (step === 'leadership' && rec.approvals.some((a) => a.step === 'admin' && a.by === actorName))
    return { ok: false, step, reason: 'You gave the administrator approval; a second administrator must give the final sign-off.' };
  void role;
  return { ok: true, step };
}

export function stepName(s: ApprovalStep): string {
  return s === 'deptHead' ? 'department head approval' : s === 'admin' ? 'licence administrator approval' : 'final sign-off by a second administrator';
}

export function requestCanBeDecided(r: AccessRequest): boolean {
  return r.status === 'submitted' || r.status === 'more-info';
}
