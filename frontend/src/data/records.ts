/**
 * Seeded workflow records (sample data): access requests, recommendations awaiting decisions,
 * invoice lines and last cycle's review records. The live demo adds to these through the UI.
 */
import type {
  AccessRequest,
  ApprovalLimits,
  AuditEntry,
  FinanceInputs,
  InvoiceLine,
  ReviewRecord,
} from '../domain/types';

export const SEED_FINANCE_INPUTS: FinanceInputs[] = [
  {
    version: 'FIN-2026.1', effectiveFrom: '2026-04-01', owner: 'Rohit Agarwal (Finance Controller)',
    loadedHourlyCost: 1500, productivityLoss: 0.5, lossFactorMeasured: false, rateApproved: true,
    basis: '(Salary + benefits + allocated overhead) ÷ 1,800 productive hours, CAE grade E2. Loss factor is the 50% default until a denial follow-up survey is completed.',
  },
  {
    version: 'FIN-2025.2', effectiveFrom: '2025-10-01', owner: 'Rohit Agarwal (Finance Controller)',
    loadedHourlyCost: 1350, productivityLoss: 0.5, lossFactorMeasured: false, rateApproved: true,
    basis: 'FY26 pay structure, before the April 2026 revision.',
  },
];

export const SEED_LIMITS: ApprovalLimits = {
  tier1: 10_00_000,
  tier2: 30_00_000,
  updatedBy: 'Rohit Agarwal',
  updatedAt: '2026-04-02 10:15',
};

export const SEED_INVOICES: InvoiceLine[] = [
  // FY26 (previous cycle) — baselines
  { id: 'IL-2501', invoiceNo: 'INV-AD-2025-1187', poRef: 'PO-4500017710', vendorId: 'v-autodesk', licenceId: 'ACAD-MECH', date: '2025-04-03', quantity: 34, unitPrice: 90_000, description: 'AutoCAD Mechanical — named user, 12 months' },
  { id: 'IL-2502', invoiceNo: 'INV-AD-2025-2410', poRef: 'PO-4500018866', vendorId: 'v-autodesk', licenceId: 'INV-PRO', date: '2025-12-12', quantity: 52, unitPrice: 2_40_000, description: 'Inventor Professional — named user, 12 months' },
  { id: 'IL-2503', invoiceNo: 'INV-CD-2025-0044', poRef: 'PO-4500016201', vendorId: 'v-cadence', licenceId: 'CAD-ALG', date: '2025-02-05', quantity: 8, unitPrice: 4_60_000, description: 'Allegro PCB Designer — node-locked, 12 months' },
  // FY27 (current cycle) — evidence for review
  { id: 'IL-2601', invoiceNo: 'INV-AD-2026-0412', poRef: 'PO-4500021042', vendorId: 'v-autodesk', licenceId: 'ACAD-MECH', date: '2026-04-06', quantity: 30, unitPrice: 95_000, description: 'AutoCAD Mechanical — named user, 12 months' },
  { id: 'IL-2602', invoiceNo: 'INV-AD-2026-0538', poRef: 'PO-4500024410', vendorId: 'v-autodesk', licenceId: 'ADSK-FLEX', date: '2026-04-16', quantity: 2, unitPrice: 60_000, description: 'Autodesk Flex — prepaid tokens (2 seat-equivalents)' },
  { id: 'IL-2603', invoiceNo: 'INV-CD-2026-0019', poRef: 'PO-4500019773', vendorId: 'v-cadence', licenceId: 'CAD-ALG', date: '2026-02-03', quantity: 8, unitPrice: 4_80_000, description: 'Allegro PCB Designer — node-locked, 12 months' },
  { id: 'IL-2604', invoiceNo: 'INV-AN-2026-0302', poRef: 'PO-4500023315', vendorId: 'v-ansys', licenceId: 'ANS-MECH', date: '2026-07-08', quantity: 0, unitPrice: 0, description: 'Re-host 2 seats Nashik → Hadapsar (no charge; vendor confirmation ref ANS-RH-0711)' },
];

export const SEED_REVIEW: ReviewRecord[] = [
  {
    id: 'RV-2601', cycle: 'FY27 renewal (Apr 2026)', title: 'Reduce AutoCAD Mechanical from 34 to 30 seats', licenceId: 'ACAD-MECH', projectIds: [],
    kind: 'reduction', approvedValue: 3_60_000, approvedBy: 'Priya Nair', approvedAt: '2026-02-20 11:40', reviewer: 'Rohit Agarwal',
    qtyBefore: 34, qtyApproved: 30, qtyAfter: 30, priceBefore: 90_000, priceAfter: 95_000,
    baselineSpend: 30_60_000, expectedSpend: 27_00_000, recordedSpend: 28_50_000,
    invoiceLineIds: ['IL-2501', 'IL-2601'], poRef: 'PO-4500021042', state: 'verified',
    shortagesAfter: { blockedHours: 0, denials: 0, limitHours: 40 }, estBlockedHours: 10, measuredBlockedHours: 0,
    history: [
      { at: '2026-02-20 11:40', actor: 'Priya Nair', action: 'Approved' },
      { at: '2026-04-06 09:10', actor: 'Priya Nair', action: 'Marked implemented', note: 'PO-4500021042 for 30 seats' },
      { at: '2026-07-15 16:20', actor: 'Rohit Agarwal', action: 'Verified', note: 'Volume effect confirmed on INV-AD-2026-0412' },
    ],
  },
  {
    id: 'RV-2602', cycle: 'FY27 (Apr 2026)', title: 'Move 6 occasional Inventor users to Flex tokens', licenceId: 'ADSK-FLEX', projectIds: [],
    kind: 'token-mix', approvedValue: 3_60_000, approvedBy: 'Priya Nair', approvedAt: '2026-03-12 15:05', reviewer: 'Rohit Agarwal',
    qtyBefore: 6, qtyApproved: 6, qtyAfter: 4, priceBefore: 2_40_000, priceAfter: 60_000,
    baselineSpend: 14_40_000, expectedSpend: 10_80_000, recordedSpend: 12_30_000,
    invoiceLineIds: ['IL-2602'], poRef: 'PO-4500024410', state: 'partly-verified',
    shortagesAfter: { blockedHours: 0, denials: 0, limitHours: 20 }, estBlockedHours: 0, measuredBlockedHours: 0,
    history: [
      { at: '2026-03-12 15:05', actor: 'Priya Nair', action: 'Approved' },
      { at: '2026-04-16 12:00', actor: 'Priya Nair', action: 'Partly implemented', note: '4 of 6 users moved; 2 kept named seats for a customer drawing release' },
      { at: '2026-08-02 10:30', actor: 'Rohit Agarwal', action: 'Partly verified', note: '₹2.1 L visible on invoices' },
    ],
  },
  {
    id: 'RV-2603', cycle: 'Q2 FY27 (Jul 2026)', title: 'Re-host 2 ANSYS Mechanical seats from Nashik to Hadapsar', licenceId: 'ANS-MECH', projectIds: ['PRJ-P3'],
    kind: 'reallocation', approvedValue: 22_00_000, approvedBy: 'Priya Nair', approvedAt: '2026-06-18 14:00', reviewer: 'Rohit Agarwal',
    qtyBefore: 8, qtyApproved: 10, qtyAfter: 10, priceBefore: 11_00_000, priceAfter: 11_00_000,
    baselineSpend: 0, expectedSpend: 0, recordedSpend: 0, costAvoided: 22_00_000,
    invoiceLineIds: ['IL-2604'], poRef: 'PO-4500023315', state: 'verified-cost-avoided',
    shortagesAfter: { blockedHours: 6, denials: 4, limitHours: 40 }, estBlockedHours: 12, measuredBlockedHours: 6,
    history: [
      { at: '2026-06-18 14:00', actor: 'Priya Nair', action: 'Approved', note: 'Instead of buying 2 seats (₹22.0 L)' },
      { at: '2026-07-06 09:00', actor: 'Priya Nair', action: 'Marked implemented', note: 'Vendor re-host confirmation ANS-RH-0711' },
      { at: '2026-10-05 17:45', actor: 'Rohit Agarwal', action: 'Verified as cost avoided', note: 'No purchase order raised; 6 blocked hours since, within limit' },
    ],
  },
  {
    id: 'RV-2604', cycle: 'FY27 renewal (Jan 2026)', title: 'Reduce Cadence Allegro from 8 to 6 seats', licenceId: 'CAD-ALG', projectIds: [],
    kind: 'reduction', approvedValue: 9_20_000, approvedBy: 'Priya Nair', approvedAt: '2025-12-02 10:00', reviewer: 'Rohit Agarwal',
    qtyBefore: 8, qtyApproved: 6, qtyAfter: 8, priceBefore: 4_60_000, priceAfter: 4_80_000,
    baselineSpend: 36_80_000, expectedSpend: 27_60_000, recordedSpend: 38_40_000,
    invoiceLineIds: ['IL-2503', 'IL-2603'], poRef: 'PO-4500019773', state: 'not-implemented',
    notImplementedReason: 'Department head kept 8 seats for an unplanned customer controller project; added to the registry as demand.',
    shortagesAfter: null, estBlockedHours: 0,
    history: [
      { at: '2025-12-02 10:00', actor: 'Priya Nair', action: 'Approved' },
      { at: '2026-01-20 13:30', actor: 'Anjali Rao', action: 'Not implemented', note: 'Unplanned customer project (sample)' },
    ],
  },
];

export const SEED_REQUESTS: AccessRequest[] = [
  {
    id: 'AR-3107', requesterId: 'u-rahul', licenceId: 'ANS-HPC', projectId: 'PRJ-X', phaseId: 'PRJ-X-3', from: '2027-01-18', until: '2027-03-26',
    expectedUse: 'few-days-month', justification: 'Fatigue analysis for the new compressor housing needs parallel solves on the HPC pack.', urgency: 'normal',
    status: 'submitted', submittedAt: '2026-10-22 10:12',
    history: [{ at: '2026-10-22 10:12', actor: 'Rahul Patil', action: 'Submitted' }],
  },
  {
    id: 'AR-3104', requesterId: 'u-sim-5', licenceId: 'ALT-HW', projectId: 'PRJ-X', phaseId: 'PRJ-X-3', from: '2027-01-18', until: '2027-02-26',
    expectedUse: 'daily', justification: 'Topology optimisation of the housing ribs (OptiStruct).', urgency: 'normal',
    status: 'submitted', submittedAt: '2026-10-21 16:40',
    history: [{ at: '2026-10-21 16:40', actor: 'Requester', action: 'Submitted' }],
  },
  {
    id: 'AR-3101', requesterId: 'u-engg-4', licenceId: 'SW-PREM', projectId: 'PRJ-Y', phaseId: 'PRJ-Y-1', from: '2026-11-16', until: '2027-01-08',
    expectedUse: 'daily', justification: 'Gear housing redesign in detailed design.', urgency: 'normal',
    status: 'fulfilled', submittedAt: '2026-10-14 09:30', decidedBy: 'Sanjay Deshpande', fulfilment: 'Floating pool — capacity available (peak 14 of 20)',
    history: [
      { at: '2026-10-14 09:30', actor: 'Requester', action: 'Submitted' },
      { at: '2026-10-14 15:02', actor: 'Sanjay Deshpande', action: 'Approved' },
      { at: '2026-10-15 10:10', actor: 'Priya Nair', action: 'Fulfilled', note: 'Added to SolidWorks floating group ENGG' },
    ],
  },
  {
    id: 'AR-3098', requesterId: 'u-mfg-3', licenceId: 'INV-PRO', projectId: 'PRJ-FIX', phaseId: 'PRJ-FIX-1', from: '2026-10-20', until: '2026-12-18',
    expectedUse: 'few-days-month', justification: 'Occasional edits to fixture assemblies.', urgency: 'normal',
    status: 'fulfilled', submittedAt: '2026-10-08 11:00', decidedBy: 'Vikram Patil', fulfilment: 'Autodesk Flex tokens (occasional use) — cheaper than a named seat',
    history: [
      { at: '2026-10-08 11:00', actor: 'Requester', action: 'Submitted' },
      { at: '2026-10-09 09:45', actor: 'Vikram Patil', action: 'Approved' },
      { at: '2026-10-09 14:20', actor: 'Priya Nair', action: 'Fulfilled', note: 'Assigned to Flex (24-hour token use)' },
    ],
  },
  {
    id: 'AR-3092', requesterId: 'u-rnd-6', licenceId: 'ANS-CFD', projectId: 'PRJ-CFD', from: '2026-10-12', until: '2026-12-31',
    expectedUse: 'one-off', justification: 'Exploratory study before the project is confirmed.', urgency: 'normal',
    status: 'rejected', submittedAt: '2026-10-01 12:15', decidedBy: 'Anjali Rao', decisionReason: 'Project still tentative; resubmit once the CFD optimisation dates are confirmed.',
    history: [
      { at: '2026-10-01 12:15', actor: 'Requester', action: 'Submitted' },
      { at: '2026-10-02 10:05', actor: 'Anjali Rao', action: 'Rejected', note: 'Project still tentative; resubmit once dates are confirmed.' },
    ],
  },
];

export const SEED_AUDIT: AuditEntry[] = [
  { id: 'AU-0001', at: '2026-10-20 06:00', actor: 'Planning engine', role: 'admin', entity: 'Recommendation', entityId: 'REC-1041', action: 'Drafted', after: 'pending' },
  { id: 'AU-0002', at: '2026-10-15 10:10', actor: 'Priya Nair', role: 'admin', entity: 'Access request', entityId: 'AR-3101', action: 'Fulfilled', before: 'approved', after: 'fulfilled' },
  { id: 'AU-0003', at: '2026-10-05 17:45', actor: 'Rohit Agarwal', role: 'admin', entity: 'Review record', entityId: 'RV-2603', action: 'Verified as cost avoided', before: 'awaiting-invoice', after: 'verified-cost-avoided' },
  { id: 'AU-0004', at: '2026-07-06 09:00', actor: 'Priya Nair', role: 'admin', entity: 'Licence', entityId: 'ANS-MECH', action: 'Seats changed (re-host)', before: '8', after: '10' },
  { id: 'AU-0005', at: '2026-04-02 10:15', actor: 'Rohit Agarwal', role: 'admin', entity: 'Approval limits', entityId: 'LIMITS', action: 'Limits set', after: 'Tier 1 ₹10.0 L · Tier 2 ₹30.0 L' },
];

/** Spend already committed or invoiced this financial year, per department (sample). */
export const SEED_BUDGET_USE: Record<string, { committed: number; spent: number }> = {
  design: { committed: 12_00_000, spent: 1_38_40_000 },
  engg: { committed: 4_80_000, spent: 76_20_000 },
  sim: { committed: 0, spent: 1_21_60_000 },
  rnd: { committed: 0, spent: 61_20_000 },
  mfg: { committed: 0, spent: 35_70_000 },
  it: { committed: 0, spent: 8_40_000 },
};
