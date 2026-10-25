/**
 * Domain model shared by all four workspaces.
 * Money is stored in whole rupees. Dates are ISO strings (YYYY-MM-DD).
 */

export type ISODate = string;
export type MonthKey = string; // YYYY-MM

/** The four sign-in profiles: Admin (Head), Department Head, Project Head, Engineer. Set by the employee record. */
export type RoleId = 'admin' | 'deptHead' | 'projectLead' | 'engineer';

export type LicenceType = 'floating' | 'named' | 'node-locked' | 'token';

/**
 * Approval steps by tier: tier 1 = administrator; tier 2 = owning department head, then administrator;
 * tier 3 = department head, administrator, then a final sign-off by a second administrator ('leadership').
 */
export type ApprovalStep = 'deptHead' | 'admin' | 'leadership';

export interface Department {
  id: string;
  name: string;
  fullName: string;
  costCentre: string;
  headUserId: string;
  annualBudget: number;
  headcount: number;
  headcountNextYear: number;
}

export interface Vendor {
  id: string;
  name: string;
  accountManager: string;
  paymentTerms: string;
}

export interface Licence {
  id: string;
  product: string;
  feature: string;
  family: string; // used for "Software" filter grouping
  vendorId: string;
  type: LicenceType;
  seats: number; // concurrent capacity (seat-equivalents for token pools)
  unitLabel: string;
  costPerSeat: number; // annual, rupees
  ownerDeptId: string;
  allocations: Record<string, number>; // deptId -> seats allocated or reserved
  contractRef: string;
  poRef: string;
  startDate: ISODate;
  renewalDate: ISODate;
  noticeDays: number;
  contractMinSeats: number;
  server: string;
  status: 'active' | 'renewal-due' | 'under-review' | 'retiring';
  baseLicenceId?: string; // add-on modules depend on a base product
  rehostableWith?: string[]; // same product on other servers; contract allows re-hosting
  forecastable: boolean;
}

export interface User {
  id: string;
  name: string;
  username: string;
  deptId: string;
  team: string;
  grade: 'E1' | 'E2' | 'E3' | 'M1' | 'M2';
  title: string;
}

export interface NamedAssignment {
  licenceId: string;
  userId: string;
  assignedOn: ISODate;
  lastActive: ISODate;
  activeHours12m: number;
}

export interface MonthlyUsage {
  licenceId: string;
  deptId: string;
  month: MonthKey;
  availableHours: number; // allocated seats x working hours in the month
  activeHours: number; // checked out AND active
  idleCheckoutHours: number; // checked out, no activity
  checkouts: number;
  denials: number;
  blockedHours: number;
  distinctUsers: number;
}

export interface UserToolUsage {
  userId: string;
  licenceId: string;
  activeHours12m: number;
  idleHours12m: number;
  lastActive: ISODate;
  denials12m: number;
}

export interface WeeklyDemand {
  licenceId: string;
  weekStart: ISODate; // Monday
  demand: number; // unconstrained peak concurrent requests
  observedPeak: number; // min(demand, capacity)
  capacity: number;
  denials: number;
  blockedHours: number;
}

export type PhaseKind = 'concept' | 'detailed-design' | 'simulation' | 'validation' | 'release';

export interface PhaseDemand {
  licenceId: string;
  seats: number;
}

export interface ProjectPhase {
  id: string;
  name: string;
  kind: PhaseKind;
  start: ISODate;
  end: ISODate;
  demand: PhaseDemand[];
  actualPeak?: Record<string, number>; // completed phases: licenceId -> actual peak seats
}

export interface Project {
  id: string;
  code: string;
  name: string;
  shortName: string;
  deptId: string;
  ownerDeptName: string;
  leaderUserId: string;
  priority: 'high' | 'medium' | 'low';
  critical: boolean;
  status: 'completed' | 'active' | 'planned';
  dateStatus: 'confirmed' | 'tentative';
  confidence: number; // 0..1 for pipeline projects
  teams: string[];
  phases: ProjectPhase[];
  productFamily: string;
}

export type RequestStatus =
  | 'submitted'
  | 'more-info'
  | 'approved'
  | 'rejected'
  | 'fulfilled'
  | 'cancelled';

export interface HistoryEntry {
  at: string; // ISO datetime
  actor: string;
  action: string;
  note?: string;
}

export interface AccessRequest {
  id: string;
  requesterId: string;
  licenceId: string;
  projectId: string;
  phaseId?: string;
  from: ISODate;
  until: ISODate;
  expectedUse: 'daily' | 'few-days-month' | 'one-off';
  justification: string;
  urgency: 'normal' | 'blocking';
  status: RequestStatus;
  submittedAt: string;
  decidedBy?: string;
  decisionReason?: string;
  fulfilment?: string;
  history: HistoryEntry[];
}

export type RecommendationStatus =
  | 'draft'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'implemented'
  | 'verified'
  | 'partly-verified'
  | 'not-implemented';

export type ActionKind =
  | 'reallocate'
  | 'recover-idle'
  | 'stagger'
  | 'temporary'
  | 'buy'
  | 'reduce'
  | 'token-mix';

export interface Recommendation {
  id: string;
  title: string;
  licenceId: string;
  projectIds: string[];
  actions: ActionKind[];
  rationale: string;
  evidence: string[];
  annualImpact: number; // positive = saving, negative = extra cost
  oneOffCost: number;
  blockedHoursExpected: number;
  confidence: 'high' | 'medium' | 'low';
  source: 'optimiser' | 'scenario' | 'renewal-review' | 'seed';
  scenarioRev?: string;
  status: RecommendationStatus;
  approvalTier: 1 | 2 | 3;
  requiredApprovers: ApprovalStep[];
  approvals: { step: ApprovalStep; by: string; at: string; decision: 'approved' | 'rejected'; reason?: string }[];
  submittedBy?: string;
  createdBy: string;
  createdAt: string;
  dueDate: ISODate;
  seatsBefore?: number;
  seatsAfter?: number;
  history: HistoryEntry[];
}

export interface InvoiceLine {
  id: string;
  invoiceNo: string;
  poRef: string;
  vendorId: string;
  licenceId: string;
  date: ISODate;
  quantity: number;
  unitPrice: number;
  description: string;
}

export type OutcomeState =
  | 'awaiting-implementation'
  | 'awaiting-invoice'
  | 'verified'
  | 'partly-verified'
  | 'not-implemented'
  | 'verified-cost-avoided';

export interface ReviewRecord {
  id: string;
  recommendationId?: string;
  cycle: string;
  title: string;
  licenceId: string;
  projectIds: string[];
  kind: 'reduction' | 'token-mix' | 'reallocation' | 'temporary' | 'purchase';
  approvedValue: number; // annual rupees
  approvedBy: string;
  approvedAt: string;
  reviewer?: string;
  qtyBefore: number;
  qtyApproved: number;
  qtyAfter?: number;
  priceBefore: number;
  priceAfter?: number;
  baselineSpend: number;
  expectedSpend: number;
  recordedSpend?: number;
  invoiceLineIds: string[];
  poRef?: string;
  state: OutcomeState;
  notImplementedReason?: string;
  costAvoided?: number;
  shortagesAfter: { blockedHours: number; denials: number; limitHours: number } | null;
  estBlockedHours: number;
  measuredBlockedHours?: number;
  history: HistoryEntry[];
}

export interface FinanceInputs {
  version: string;
  effectiveFrom: ISODate;
  owner: string;
  loadedHourlyCost: number;
  productivityLoss: number;
  lossFactorMeasured: boolean;
  rateApproved: boolean;
  basis: string;
}

export interface ApprovalLimits {
  tier1: number; // up to: department head + administrator
  tier2: number; // up to: department head + administrator; above: + final sign-off by a second administrator
  updatedBy: string;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  role: RoleId;
  entity: string;
  entityId: string;
  action: string;
  before?: string;
  after?: string;
}

export interface Notification {
  id: string;
  at: string;
  kind: 'shortage' | 'renewal' | 'denials' | 'unused' | 'approval' | 'request' | 'import' | 'review' | 'drift';
  title: string;
  detail: string;
  link: string;
  roles: RoleId[];
  severity: 'info' | 'warn' | 'crit';
}

export interface ImportBatch {
  id: string;
  fileName: string;
  importedAt: string;
  importedBy: string;
  rowsTotal: number;
  rowsCommitted: number;
  rowsExcluded: number;
  qualityScore: number;
  corrections: number;
  fingerprint: string;
}

export interface ScenarioParams {
  licenceId: string;
  seats: number;
  temporarySeats: number;
  temporaryWeeks: number;
  temporaryStart?: string; // week the temporary seats begin; default first shortage week
  projectShifts: Record<string, number>; // projectId -> weeks shifted
  projectDurationPct: Record<string, number>; // projectId -> duration multiplier %
  teamSizePct: number; // project seat demand multiplier %
  recoverIdle: boolean;
  reallocateSeats: number;
  horizonWeeks: number;
}

export interface Scenario {
  id: string;
  rev: string;
  name: string;
  params: ScenarioParams;
  savedAt: string;
  savedBy: string;
  submittedRecommendationId?: string;
}

export interface ProjectChange {
  id: string;
  projectId: string;
  phaseId: string;
  field: 'dates' | 'seats';
  before: string;
  after: string;
  newStart?: ISODate;
  newEnd?: ISODate;
  licenceId?: string;
  newSeats?: number;
  reason: string;
  proposedBy: string;
  proposedAt: string;
  status: 'pending-dept' | 'pending-admin' | 'applied' | 'rejected';
  history: HistoryEntry[];
}

export interface AssignmentChange {
  id: string;
  licenceId: string;
  userId: string;
  action: 'assign' | 'revoke';
  reason: string;
  by: string;
  at: string;
}

// ---------------- Module 5: Other Services Tracking ----------------

export type ServiceCategory = 'api' | 'ai' | 'cloud';
export type ServiceSubType = 'api' | 'ai' | 'vm' | 'gpu' | 'database' | 'storage';
export type ServiceBilling = 'subscription' | 'prepaid' | 'reserved' | 'on-demand' | 'payg';
/**
 * How idle spend is judged for the service:
 *  - commitment: a fixed fee buys a capacity (subscription quota, prepaid credits, reserved hours) → idle = fee × unused share
 *  - provisioned: billed for running/provisioned capacity whether busy or not (VMs, GPUs, DBs, block/file storage) → idle = spend × (1 − busy share)
 *  - consumption: billed only for what is used (pay-as-you-go API calls, tokens, object storage, serverless) → never idle
 */
export type IdleBasis = 'commitment' | 'provisioned' | 'consumption';

export interface ServiceKey {
  id: string;
  label: string;
  /** Masked identifier only, e.g. "sk-ant-••••7Q2c". The secret itself is never stored in the demo. */
  masked: string;
  last4: string;
  ownerUserId: string;
  environment: 'prod' | 'dev' | 'test';
  created: ISODate;
  lastUsed: ISODate;
  expires: ISODate | null;
  calls30d: number;
}

export interface ServiceMonth {
  month: MonthKey;
  usage: number; // in the service's unit
  capacity: number | null; // paid capacity for the month (null = pay-as-you-go)
  spend: number; // ₹ billed for the month
  idle: number; // ₹ of that spend that bought capacity nobody used (0 for consumption billing)
  quotaHits: number; // requests refused by a quota, rate limit or instance limit
  blockedHours: number; // engineer-hours waiting because of those limits (measured, sample)
}

export interface ServiceRecord {
  id: string;
  name: string;
  provider: string;
  category: ServiceCategory;
  subType: ServiceSubType;
  deptId: string | null; // null = unallocated (shared, not charged to a department)
  ownerUserId: string;
  billing: ServiceBilling;
  basis: IdleBasis;
  unit: string;
  capacity: number | null; // monthly paid capacity, current
  quota: number | null; // monthly quota / rate limit for pay-as-you-go services
  unitPrice: number; // ₹ per unit (pay-as-you-go price, or overage price above a commitment)
  fixedMonthly: number; // ₹ per month for commitment / provisioned capacity
  environment: 'prod' | 'dev' | 'test' | 'shared';
  startDate: ISODate;
  renewalDate: ISODate | null;
  renewalKind: 'renewal' | 'commitment ends' | 'reservation ends' | null;
  note?: string;
  keys: ServiceKey[];
  months: ServiceMonth[]; // 24 months, oldest first
}
