/**
 * Review & Savings maths (Module 4).
 *
 *   invoice change = q_new·p_new − q_old·p_old = (q_new − q_old)·p_old  +  (p_new − p_old)·q_new
 *                                                  └─ volume effect ─┘      └─ price effect ─┘
 * Only the volume effect (and any cost avoided) is credited as a verified saving.
 */
import type { FinanceInputs, InvoiceLine, ReviewRecord } from '../domain/types';

export interface Bridge {
  before: number;
  volume: number;
  price: number;
  after: number;
  invoiceChange: number;
}

export function priceVolume(qOld: number, pOld: number, qNew: number, pNew: number): Bridge {
  const before = qOld * pOld;
  const after = qNew * pNew;
  const volume = (qNew - qOld) * pOld;
  const price = (pNew - pOld) * qNew;
  return { before, volume, price, after, invoiceChange: after - before };
}

export function bridgeFor(r: ReviewRecord): Bridge | null {
  if (r.qtyAfter === undefined || r.priceAfter === undefined) return null;
  // Re-hosting has no invoice change; a token mix changes the product, so price and volume are not comparable.
  if (r.kind === 'reallocation' || r.kind === 'token-mix') return null;
  return priceVolume(r.qtyBefore, r.priceBefore, r.qtyAfter, r.priceAfter);
}

/** Savings the platform may claim: verified volume effect, or cost avoided. */
export function verifiedSaving(r: ReviewRecord): number {
  if (r.state === 'verified-cost-avoided') return r.costAvoided ?? 0;
  if (r.state === 'verified') {
    const b = bridgeFor(r);
    return b ? Math.max(0, -b.volume) : 0;
  }
  if (r.state === 'partly-verified') {
    // Partial implementation: credit only the spend reduction visible on invoices.
    return Math.max(0, r.baselineSpend - (r.recordedSpend ?? r.baselineSpend));
  }
  return 0;
}

export interface LedgerTotals {
  potential: number;
  approved: number;
  realised: number;
  verified: number;
}

export function isSavingRecord(r: ReviewRecord): boolean {
  return r.approvedValue > 0 && r.kind !== 'purchase' && r.kind !== 'temporary';
}

export function ledgerTotals(records: ReviewRecord[], potential: number): LedgerTotals {
  let approved = 0;
  let realised = 0;
  let verified = 0;
  // Spend approved to protect projects (purchases, temporary access) is not a saving and is excluded here.
  for (const r of records.filter(isSavingRecord)) {
    approved += r.approvedValue;
    if (r.state !== 'awaiting-implementation' && r.state !== 'not-implemented') {
      realised += r.state === 'partly-verified' ? verifiedSaving(r) : r.approvedValue;
    }
    verified += verifiedSaving(r);
  }
  return { potential, approved, realised, verified };
}

export function breakEvenHourly(annualSaving: number, extraBlockedHours: number, lossFactor: number): number {
  if (extraBlockedHours <= 0 || lossFactor <= 0) return Infinity;
  return annualSaving / (extraBlockedHours * lossFactor);
}

export type Confidence = 'High' | 'Medium' | 'Low';

/** How far the cost of blocked time can be trusted (Module 4 rules). */
export function costConfidence(fin: FinanceInputs, blockedMeasured: boolean, hasDenialData: boolean): Confidence {
  if (!fin.rateApproved || !hasDenialData) return 'Low';
  if (blockedMeasured && fin.lossFactorMeasured) return 'High';
  return 'Medium';
}

export function robustness(breakEven: number, rate: number): 'robust' | 'sensitive' {
  return breakEven >= rate * 2 ? 'robust' : 'sensitive';
}

export function invoiceTotal(lines: InvoiceLine[]): number {
  return lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
}
