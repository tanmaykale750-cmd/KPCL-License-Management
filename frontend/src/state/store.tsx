import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Filters } from '../calc/metrics';
import { getBaseDataset, type Dataset } from '../data/dataset';
import { KEY_USERS } from '../data/people';
import { useSessionOptional } from '../api/session';
import { fetchTeam, type RosterPerson, type TeamReply } from '../api/client';
import type {
  AccessRequest,
  ApprovalLimits,
  AssignmentChange,
  AuditEntry,
  FinanceInputs,
  ImportBatch,
  InvoiceLine,
  Licence,
  ProjectChange,
  Recommendation,
  ReviewRecord,
  RoleId,
  Scenario,
  User,
} from '../domain/types';
import { nowStamp } from '../lib/dates';
import { inrShort } from '../lib/format';
import { permissionsFor, personaFor, type Permissions } from './roles';
import { initialState, type Thresholds } from './seed';
import { canDecideRecommendation, nextStep, requiredSteps, stepName, tierFor } from './workflow';

export interface AppState {
  version: number;
  role: RoleId;
  filters: Filters;
  requests: AccessRequest[];
  recommendations: Recommendation[];
  review: ReviewRecord[];
  invoices: InvoiceLine[];
  audit: AuditEntry[];
  scenarios: Scenario[];
  imports: ImportBatch[];
  importedRows: number;
  limits: ApprovalLimits;
  finance: FinanceInputs[];
  licenceEdits: Record<string, Partial<Licence>>;
  assignmentChanges: AssignmentChange[];
  projectChanges: ProjectChange[];
  readNotifications: string[];
  budgetUse: Record<string, { committed: number; spent: number }>;
  thresholds: Thresholds;
  seq: number;
}

const STORAGE_KEY = 'kpcl-eli-demo-state';

function load(): AppState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AppState;
      if (parsed.version === initialState().version) return parsed;
    }
  } catch {
    /* storage unavailable — fall back to sample data */
  }
  return initialState();
}

export interface Toast {
  id: number;
  tone: 'ok' | 'warn' | 'crit' | 'info';
  text: string;
}

interface Ctx {
  state: AppState;
  ds: Dataset;
  perms: Permissions;
  me: { id: string; name: string; title: string; deptId: string; employeeId: string | null };
  /** HR-roster people in the signed-in employee's scope, with their contacts (GET /api/team) */
  team: TeamReply | null;
  toasts: Toast[];
  toast: (text: string, tone?: Toast['tone']) => void;
  dismissToast: (id: number) => void;
  actions: ReturnType<typeof buildActions>;
}

const AppContext = createContext<Ctx | null>(null);

type Set = (fn: (s: AppState) => AppState) => void;

/** Number ranges match the seeded records (REC-1041, RV-2604, AR-3107…) so new ids read naturally. */
const ID_BASE: Record<string, number> = { REC: 1000, RV: 2600, AR: 3100, IL: 2600, SC: 0, PC: 0, IMP: 0 };

function nextId(s: AppState, prefix: string): [string, AppState] {
  const n = s.seq + 1;
  return [`${prefix}-${(ID_BASE[prefix] ?? 0) + n}`, { ...s, seq: n }];
}

function personaName(role: RoleId): string {
  const p = personaFor(role);
  return KEY_USERS.find((u) => u.id === p.userId)?.name ?? p.roleLabel;
}

/** Who is acting and with which permissions (the signed-in employee; the persona only when there is no session). */
interface Actor {
  name: () => string;
  perms: () => Permissions;
}

function buildActions(set: Set, ds: Dataset, toast: (t: string, tone?: Toast['tone']) => void, lockedRole: RoleId | null = null, who?: Actor) {
  const actorName = (s: AppState): string => who?.name() ?? personaName(s.role);
  const permsOf = (s: AppState): Permissions => who?.perms() ?? permissionsFor(s.role);
  const audit = (s: AppState, e: Omit<AuditEntry, 'id' | 'at' | 'actor' | 'role'>): AppState => {
    const entry: AuditEntry = { id: `AU-${String(s.seq + 1).padStart(4, '0')}`, at: nowStamp(), actor: actorName(s), role: s.role, ...e };
    return { ...s, seq: s.seq + 1, audit: [entry, ...s.audit] };
  };
  return {
    setRole(role: RoleId) {
      // The role comes from the server-verified employee record; it cannot be switched in the browser.
      if (lockedRole && role !== lockedRole) return;
      set((s) => ({ ...s, role }));
    },
    setFilters(f: Partial<Filters>) {
      set((s) => ({ ...s, filters: { ...s.filters, ...f } }));
    },
    reset() {
      set((s) => initialState(s.role));
      toast('Sample data restored. All demo changes were cleared.', 'info');
    },
    markNotificationsRead(ids: string[]) {
      set((s) => ({ ...s, readNotifications: [...new Set([...s.readNotifications, ...ids])] }));
    },

    // ---------- Access requests ----------
    submitRequest(r: Omit<AccessRequest, 'id' | 'status' | 'submittedAt' | 'history'>) {
      let newId = '';
      set((s0) => {
        const [id, s] = nextId(s0, 'AR');
        newId = id;
        const at = nowStamp();
        const req: AccessRequest = { ...r, id, status: 'submitted', submittedAt: at, history: [{ at, actor: actorName(s), action: 'Submitted' }] };
        return audit({ ...s, requests: [req, ...s.requests] }, { entity: 'Access request', entityId: id, action: 'Submitted', after: 'submitted' });
      });
      toast(`Request ${newId} submitted. Your department head will review it.`, 'ok');
      return newId;
    },
    decideRequest(id: string, decision: 'approved' | 'rejected' | 'more-info', reason: string) {
      set((s) => {
        const name = actorName(s);
        const requests = s.requests.map((r) =>
          r.id === id
            ? { ...r, status: decision, decidedBy: name, decisionReason: reason || undefined, history: [...r.history, { at: nowStamp(), actor: name, action: decision === 'approved' ? 'Approved' : decision === 'rejected' ? 'Rejected' : 'Asked for more information', note: reason || undefined }] }
            : r,
        );
        return audit({ ...s, requests }, { entity: 'Access request', entityId: id, action: decision === 'more-info' ? 'More information requested' : decision === 'approved' ? 'Approved' : 'Rejected', before: 'submitted', after: decision });
      });
      toast(decision === 'approved' ? `${id} approved. The administrator will fulfil it.` : decision === 'rejected' ? `${id} rejected with reason recorded.` : `${id} returned to the requester for more information.`, decision === 'rejected' ? 'warn' : 'ok');
    },
    fulfilRequest(id: string, route: string) {
      set((s) => {
        const name = actorName(s);
        const requests = s.requests.map((r) => (r.id === id ? { ...r, status: 'fulfilled' as const, fulfilment: route, history: [...r.history, { at: nowStamp(), actor: name, action: 'Fulfilled', note: route }] } : r));
        return audit({ ...s, requests }, { entity: 'Access request', entityId: id, action: 'Fulfilled', before: 'approved', after: route });
      });
      toast(`${id} fulfilled (recorded in the prototype only; no licence server was changed).`, 'ok');
    },
    cancelRequest(id: string) {
      set((s) => {
        const name = actorName(s);
        const requests = s.requests.map((r) => (r.id === id ? { ...r, status: 'cancelled' as const, history: [...r.history, { at: nowStamp(), actor: name, action: 'Cancelled' }] } : r));
        return audit({ ...s, requests }, { entity: 'Access request', entityId: id, action: 'Cancelled', after: 'cancelled' });
      });
      toast(`${id} cancelled.`, 'info');
    },
    respondMoreInfo(id: string, note: string) {
      set((s) => {
        const name = actorName(s);
        const requests = s.requests.map((r) => (r.id === id ? { ...r, status: 'submitted' as const, justification: `${r.justification}\n\nAdded: ${note}`, history: [...r.history, { at: nowStamp(), actor: name, action: 'Information added', note }] } : r));
        return audit({ ...s, requests }, { entity: 'Access request', entityId: id, action: 'Information added', before: 'more-info', after: 'submitted' });
      });
      toast(`${id} resubmitted with the added information.`, 'ok');
    },

    // ---------- Recommendations & approvals ----------
    submitRecommendation(rec: Omit<Recommendation, 'id' | 'status' | 'approvalTier' | 'requiredApprovers' | 'approvals' | 'createdAt' | 'history' | 'submittedBy' | 'createdBy'>, ownerDeptId: string) {
      let newId = '';
      set((s0) => {
        const [id, s] = nextId(s0, 'REC');
        newId = id;
        const name = actorName(s);
        const tier = tierFor(rec.annualImpact, rec.oneOffCost, s.limits);
        const at = nowStamp();
        const autoEndorse = s.role === 'deptHead' && permsOf(s).deptScope === ownerDeptId;
        const full: Recommendation = {
          ...rec,
          id,
          status: 'pending',
          approvalTier: tier,
          requiredApprovers: requiredSteps(tier),
          approvals: autoEndorse ? [{ step: 'deptHead', by: name, at, decision: 'approved', reason: 'Endorsed on submission' }] : [],
          createdBy: name,
          submittedBy: name,
          createdAt: at,
          history: [{ at, actor: name, action: 'Submitted for approval', note: `Tier ${tier}: ${requiredSteps(tier).map(stepName).join(' → ')}` }, ...(autoEndorse ? [{ at, actor: name, action: 'Endorsed (department head)' }] : [])],
        };
        return audit({ ...s, recommendations: [full, ...s.recommendations] }, { entity: 'Recommendation', entityId: id, action: 'Submitted for approval', after: `Tier ${tier}` });
      });
      toast(`${newId} submitted for approval. Nothing changes until it is approved.`, 'ok');
      return newId;
    },
    decideRecommendation(id: string, decision: 'approved' | 'rejected', reason: string) {
      let message = '';
      let tone: Toast['tone'] = 'ok';
      set((s) => {
        const rec = s.recommendations.find((r) => r.id === id);
        if (!rec) return s;
        const name = actorName(s);
        const perms = permsOf(s);
        const lic = ds.licences.find((l) => l.id === rec.licenceId);
        const check = canDecideRecommendation(rec, s.role, name, perms.approvalSteps, perms.deptScope, lic?.ownerDeptId ?? '');
        if (!check.ok || !check.step) {
          message = check.reason ?? 'You cannot decide this step.';
          tone = 'warn';
          return s;
        }
        const at = nowStamp();
        const approvals = [...rec.approvals, { step: check.step, by: name, at, decision, reason: reason || undefined }];
        let updated: Recommendation = { ...rec, approvals, history: [...rec.history, { at, actor: name, action: `${decision === 'approved' ? 'Approved' : 'Rejected'} (${stepName(check.step)})`, note: reason || undefined }] };
        let next = s;
        if (check.step === 'deptHead' && check.blocking && decision === 'rejected') {
          // tier 2/3: the department head's approval is a required step, so a rejection ends the recommendation
          updated = { ...updated, status: 'rejected' };
          message = `${id} rejected by the department head. The reason is recorded and fed back to the planning engine.`;
          tone = 'warn';
        } else if (check.step === 'deptHead') {
          message = decision === 'approved'
            ? `${id} ${check.blocking ? 'approved for the department' : 'endorsed for the department'}. The licence administrator decides next.`
            : `Objection recorded on ${id}. The administrator will see it before deciding.`;
          tone = decision === 'approved' ? 'ok' : 'warn';
        } else if (decision === 'rejected') {
          updated = { ...updated, status: 'rejected' };
          message = `${id} rejected. The reason is recorded and fed back to the planning engine.`;
          tone = 'warn';
        } else if (!nextStep({ ...updated })) {
          updated = { ...updated, status: 'approved' };
          // Approved actions flow into Review & Savings as an implementation record.
          const [rid, s2] = nextId(s, 'RV');
          next = s2;
          const record: ReviewRecord = {
            id: rid,
            recommendationId: id,
            cycle: `FY27 · ${rec.dueDate.slice(0, 7)}`,
            title: rec.title,
            licenceId: rec.licenceId,
            projectIds: rec.projectIds,
            kind: rec.actions.includes('reduce') ? 'reduction' : rec.actions.includes('buy') ? 'purchase' : rec.actions.includes('reallocate') && rec.actions.length === 1 ? 'reallocation' : 'temporary',
            approvedValue: rec.annualImpact,
            approvedBy: name,
            approvedAt: at,
            qtyBefore: rec.seatsBefore ?? lic?.seats ?? 0,
            qtyApproved: rec.seatsAfter ?? lic?.seats ?? 0,
            priceBefore: lic?.costPerSeat ?? 0,
            baselineSpend: (rec.seatsBefore ?? lic?.seats ?? 0) * (lic?.costPerSeat ?? 0),
            expectedSpend: (rec.seatsAfter ?? lic?.seats ?? 0) * (lic?.costPerSeat ?? 0) + rec.oneOffCost,
            invoiceLineIds: [],
            state: 'awaiting-implementation',
            shortagesAfter: null,
            estBlockedHours: rec.blockedHoursExpected,
            history: [{ at, actor: name, action: 'Approved — implementation record opened' }],
          };
          next = { ...next, review: [record, ...next.review] };
          message = `${id} fully approved. Implementation record ${rid} opened in Review & Savings.`;
        } else {
          message = `${stepName(check.step)} recorded. Next: ${stepName(nextStep(updated)!)}.`;
        }
        next = { ...next, recommendations: next.recommendations.map((r) => (r.id === id ? updated : r)) };
        return audit(next, { entity: 'Recommendation', entityId: id, action: `${decision} (${stepName(check.step)})`, before: 'pending', after: updated.status });
      });
      if (message) toast(message, tone);
    },

    // ---------- Review & Savings ----------
    markImplemented(recordId: string, poRef: string, qtyAfter: number) {
      set((s) => {
        const name = actorName(s);
        const review = s.review.map((r) =>
          r.id === recordId ? { ...r, state: 'awaiting-invoice' as const, poRef, qtyAfter, history: [...r.history, { at: nowStamp(), actor: name, action: 'Marked implemented', note: `${poRef} · ${qtyAfter} seats` }] } : r,
        );
        return audit({ ...s, review }, { entity: 'Review record', entityId: recordId, action: 'Marked implemented', before: 'awaiting-implementation', after: 'awaiting-invoice' });
      });
      toast(`${recordId} marked implemented. Savings stay “approved” until invoice evidence is verified.`, 'ok');
    },
    recordNotImplemented(recordId: string, reason: string) {
      set((s) => {
        const name = actorName(s);
        const review = s.review.map((r) => (r.id === recordId ? { ...r, state: 'not-implemented' as const, notImplementedReason: reason, history: [...r.history, { at: nowStamp(), actor: name, action: 'Not implemented', note: reason }] } : r));
        return audit({ ...s, review }, { entity: 'Review record', entityId: recordId, action: 'Not implemented', after: reason });
      });
      toast(`${recordId} recorded as not implemented. The reason feeds the next planning cycle.`, 'warn');
    },
    attachInvoiceAndVerify(recordId: string, line: Omit<InvoiceLine, 'id'>) {
      let msg = '';
      set((s0) => {
        const [lid, s] = nextId(s0, 'IL');
        const name = actorName(s);
        const inv: InvoiceLine = { ...line, id: lid };
        const review = s.review.map((r) => {
          if (r.id !== recordId) return r;
          const qtyAfter = line.quantity;
          const full = qtyAfter === r.qtyApproved;
          const state = full ? ('verified' as const) : ('partly-verified' as const);
          msg = full ? `${recordId} verified against ${line.invoiceNo}.` : `${recordId} partly verified: invoice shows ${qtyAfter} seats against ${r.qtyApproved} approved.`;
          return {
            ...r,
            qtyAfter,
            priceAfter: line.unitPrice,
            recordedSpend: qtyAfter * line.unitPrice,
            invoiceLineIds: [...r.invoiceLineIds, lid],
            state,
            reviewer: name,
            history: [...r.history, { at: nowStamp(), actor: name, action: full ? 'Verified' : 'Partly verified', note: `${line.invoiceNo} · ${qtyAfter} × ${inrShort(line.unitPrice)}` }],
          };
        });
        return audit({ ...s, invoices: [...s.invoices, inv], review }, { entity: 'Review record', entityId: recordId, action: 'Invoice attached and verified', after: line.invoiceNo });
      });
      toast(msg || 'Invoice recorded.', 'ok');
    },

    verifyCostAvoided(recordId: string, evidenceRef: string, note: string) {
      let msg = '';
      set((s) => {
        const name = actorName(s);
        const review = s.review.map((r) => {
          if (r.id !== recordId) return r;
          msg = `${recordId} verified as cost avoided (${inrShort(r.approvedValue)}). No purchase was needed.`;
          return { ...r, state: 'verified-cost-avoided' as const, costAvoided: r.approvedValue, reviewer: name, poRef: r.poRef ?? evidenceRef, history: [...r.history, { at: nowStamp(), actor: name, action: 'Verified as cost avoided', note: `${evidenceRef}${note ? ` · ${note}` : ''}` }] };
        });
        return audit({ ...s, review }, { entity: 'Review record', entityId: recordId, action: 'Verified as cost avoided', after: evidenceRef });
      });
      toast(msg, 'ok');
    },

    // ---------- Scenarios ----------
    saveScenario(sc: Omit<Scenario, 'id' | 'rev' | 'savedAt' | 'savedBy'>) {
      let rev = '';
      let newId = '';
      set((s0) => {
        const [id, s] = nextId(s0, 'SC');
        newId = id;
        const same = s.scenarios.filter((x) => x.params.licenceId === sc.params.licenceId).length;
        rev = `Rev ${String.fromCharCode(66 + same)}`; // Rev A is always the baseline
        const full: Scenario = { ...sc, id, rev, savedAt: nowStamp(), savedBy: actorName(s) };
        return audit({ ...s, scenarios: [...s.scenarios, full] }, { entity: 'Scenario', entityId: id, action: 'Saved', after: `${rev} · ${sc.name}` });
      });
      toast(`Scenario saved as ${rev}. The registry is unchanged.`, 'ok');
      return { id: newId, rev };
    },
    deleteScenario(id: string) {
      set((s) => ({ ...s, scenarios: s.scenarios.filter((x) => x.id !== id) }));
    },
    linkScenario(id: string, recId: string) {
      set((s) => ({ ...s, scenarios: s.scenarios.map((x) => (x.id === id ? { ...x, submittedRecommendationId: recId } : x)) }));
    },

    // ---------- Registry administration ----------
    editLicence(id: string, patch: Partial<Licence>, reason: string) {
      set((s) => {
        const before = ds.licences.find((l) => l.id === id);
        const prev = { ...before, ...s.licenceEdits[id] };
        const changes = Object.entries(patch).map(([k, v]) => `${k}: ${String((prev as Record<string, unknown>)[k])} → ${String(v)}`).join('; ');
        return audit({ ...s, licenceEdits: { ...s.licenceEdits, [id]: { ...s.licenceEdits[id], ...patch } } }, { entity: 'Licence', entityId: id, action: `Edited (${reason})`, after: changes });
      });
      toast(`${id} updated in the prototype registry. Change logged in the audit trail.`, 'ok');
    },
    changeAssignment(c: Omit<AssignmentChange, 'id' | 'by' | 'at'>) {
      set((s0) => {
        const [id, s] = nextId(s0, 'AS');
        const full: AssignmentChange = { ...c, id, by: actorName(s), at: nowStamp() };
        return audit({ ...s, assignmentChanges: [full, ...s.assignmentChanges] }, { entity: 'Assignment', entityId: c.licenceId, action: c.action === 'revoke' ? 'Seat released' : 'Seat assigned', after: `${c.userId} · ${c.reason}` });
      });
      toast(c.action === 'revoke' ? 'Seat released back to the pool (prototype record).' : 'Seat assigned (prototype record).', 'ok');
    },
    commitImport(batch: Omit<ImportBatch, 'id' | 'importedAt' | 'importedBy'>) {
      set((s0) => {
        const [id, s] = nextId(s0, 'IMP');
        const full: ImportBatch = { ...batch, id, importedAt: nowStamp(), importedBy: actorName(s) };
        return audit({ ...s, imports: [full, ...s.imports], importedRows: s.importedRows + batch.rowsCommitted }, { entity: 'Import', entityId: id, action: 'Committed', after: `${batch.rowsCommitted} rows · quality ${(batch.qualityScore * 100).toFixed(0)}%` });
      });
      toast(`${batch.rowsCommitted} validated rows committed to the prototype store (not to any licence server).`, 'ok');
    },
    updateThresholds(t: Thresholds) {
      set((s) => audit({ ...s, thresholds: t }, { entity: 'Alert thresholds', entityId: 'THRESHOLDS', action: 'Changed', before: `${s.thresholds.shortageLeadWeeks} wk / ${s.thresholds.renewalWindowDays} d / ${s.thresholds.denialLimit}`, after: `${t.shortageLeadWeeks} wk / ${t.renewalWindowDays} d / ${t.denialLimit}` }));
      toast('Alert thresholds saved. Notifications now use the new values.', 'ok');
    },
    updateLimits(l: Pick<ApprovalLimits, 'tier1' | 'tier2'>) {
      set((s) => audit({ ...s, limits: { ...s.limits, ...l, updatedBy: actorName(s), updatedAt: nowStamp() } }, { entity: 'Approval limits', entityId: 'LIMITS', action: 'Limits changed', before: `${inrShort(s.limits.tier1)} / ${inrShort(s.limits.tier2)}`, after: `${inrShort(l.tier1)} / ${inrShort(l.tier2)}` }));
      toast('Approval limits updated and logged.', 'ok');
    },
    updateFinance(f: Omit<FinanceInputs, 'version' | 'owner'>) {
      set((s) => {
        const version = `FIN-2026.${s.finance.length}`;
        const entry: FinanceInputs = { ...f, version, owner: `${actorName(s)} (Admin (Head))` };
        return audit({ ...s, finance: [entry, ...s.finance] }, { entity: 'Finance inputs', entityId: version, action: 'New version', after: `₹${f.loadedHourlyCost}/h · loss ${f.productivityLoss}` });
      });
      toast('New finance input version saved. Earlier decisions keep the version in force when they were made.', 'ok');
    },

    // ---------- Project changes (leader → department head → administrator) ----------
    proposeProjectChange(c: Omit<ProjectChange, 'id' | 'status' | 'proposedBy' | 'proposedAt' | 'history'>) {
      set((s0) => {
        const [id, s] = nextId(s0, 'PC');
        const at = nowStamp();
        const full: ProjectChange = { ...c, id, status: 'pending-dept', proposedBy: actorName(s), proposedAt: at, history: [{ at, actor: actorName(s), action: 'Proposed', note: c.reason }] };
        return audit({ ...s, projectChanges: [full, ...s.projectChanges] }, { entity: 'Project change', entityId: id, action: 'Proposed', before: c.before, after: c.after });
      });
      toast('Change proposed. The department head approves it, then the administrator confirms it before the forecast uses it.', 'ok');
    },
    decideProjectChange(id: string, decision: 'approve' | 'reject', reason: string) {
      set((s) => {
        const name = actorName(s);
        const projectChanges = s.projectChanges.map((c) => {
          if (c.id !== id) return c;
          const status: ProjectChange['status'] = decision === 'reject' ? 'rejected' : c.status === 'pending-dept' ? 'pending-admin' : 'applied';
          return { ...c, status, history: [...c.history, { at: nowStamp(), actor: name, action: decision === 'reject' ? 'Rejected' : c.status === 'pending-dept' ? 'Approved (department head)' : 'Confirmed (administrator)', note: reason || undefined }] };
        });
        return audit({ ...s, projectChanges }, { entity: 'Project change', entityId: id, action: decision, after: projectChanges.find((c) => c.id === id)?.status });
      });
      toast(decision === 'reject' ? 'Project change rejected.' : 'Project change decision recorded.', decision === 'reject' ? 'warn' : 'ok');
    },
  };
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(load);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);
  // Apply updates synchronously so actions can report outcomes immediately.
  const stateRef = useRef(state);
  const set = useCallback<Set>((fn) => {
    const next = fn(stateRef.current);
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }, [state]);

  const toast = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t.slice(-3), { id, tone, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5200);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const base = getBaseDataset();
  const session = useSessionOptional();
  const [team, setTeam] = useState<TeamReply | null>(null);
  useEffect(() => {
    if (!session) return;
    let alive = true;
    fetchTeam()
      .then((t) => alive && setTeam(t))
      .catch(() => alive && setTeam(null));
    return () => {
      alive = false;
    };
  }, [session]);

  const ds = useMemo<Dataset>(() => {
    const licences = base.licences.map((l) => (state.licenceEdits[l.id] ? { ...l, ...state.licenceEdits[l.id] } : l));
    const applied = state.projectChanges.filter((c) => c.status === 'applied');
    const projects = applied.length
      ? base.projects.map((p) => ({
          ...p,
          phases: p.phases.map((ph) => {
            let out = ph;
            for (const c of applied.filter((x) => x.projectId === p.id && x.phaseId === ph.id)) {
              if (c.field === 'dates' && c.newStart && c.newEnd) out = { ...out, start: c.newStart, end: c.newEnd };
              if (c.field === 'seats' && c.licenceId && c.newSeats !== undefined) out = { ...out, demand: out.demand.map((d) => (d.licenceId === c.licenceId ? { ...d, seats: c.newSeats! } : d)) };
            }
            return out;
          }),
        }))
      : base.projects;
    let assignments = base.assignments;
    for (const c of state.assignmentChanges) {
      if (c.action === 'revoke') assignments = assignments.filter((a) => !(a.licenceId === c.licenceId && a.userId === c.userId));
    }
    // People from the HR roster join the sample dataset, so their requests, decisions and seats resolve by id.
    const known = new Set(base.users.map((u) => u.id));
    const extra: User[] = [];
    const people = [...(team?.members ?? []), ...(team?.contacts ?? [])];
    if (session && !people.some((p) => p.employee_id === session.employee_id)) people.push(selfAsPerson(session));
    for (const p of people) {
      const u = rosterUser(p);
      if (!known.has(u.id)) {
        known.add(u.id);
        extra.push(u);
      }
    }
    return { ...base, licences, projects, assignments, users: extra.length ? [...base.users, ...extra] : base.users };
  }, [base, state.licenceEdits, state.projectChanges, state.assignmentChanges, team, session]);

  const lockedRole = session?.role ?? null;
  useEffect(() => {
    if (lockedRole && stateRef.current.role !== lockedRole) set((s) => ({ ...s, role: lockedRole }));
  }, [lockedRole, set]);
  const role = lockedRole ?? state.role;
  const persona = personaFor(role);
  const personaUser = KEY_USERS.find((u) => u.id === persona.userId)!;
  const perms = useMemo(() => permissionsFor(role, session?.scope, personaUser.deptId), [role, session, personaUser.deptId]);
  // The signed-in employee. Sample-data ownership follows the roster link (org_scope.json app_users) when there is one.
  const me = session
    ? { id: session.scope?.app_user_id ?? session.employee_id, name: session.name, title: session.designation, deptId: session.scope?.app_dept_id ?? personaUser.deptId, employeeId: session.employee_id }
    : { id: personaUser.id, name: personaUser.name, title: personaUser.title, deptId: personaUser.deptId, employeeId: null };
  const actorRef = useRef({ name: me.name, perms });
  actorRef.current = { name: me.name, perms };
  const actions = useMemo(
    () => buildActions(set, ds, toast, lockedRole, { name: () => actorRef.current.name, perms: () => actorRef.current.perms }),
    [set, ds, toast, lockedRole],
  );
  const effState = state.role === role ? state : { ...state, role };

  const value = useMemo<Ctx>(() => ({ state: effState, ds, perms, me, team, toasts, toast, dismissToast, actions }), [effState, ds, perms, me.id, me.name, me.deptId, team, toasts, toast, dismissToast, actions]); // eslint-disable-line react-hooks/exhaustive-deps
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

function gradeFor(p: Pick<RosterPerson, 'role' | 'role_category'>): User['grade'] {
  if (p.role === 'deptHead') return 'M2';
  if (p.role === 'admin' || p.role === 'projectLead') return 'M1';
  return p.role_category === 'Project Worker' ? 'E1' : 'E2';
}

/** A roster person as a dataset user (id = the linked sample person, else the employee ID). */
export function rosterUser(p: RosterPerson): User {
  return { id: p.app_user_id ?? p.employee_id, name: p.name, username: p.email.split('@')[0], deptId: p.app_dept_id ?? 'it', team: p.department, grade: gradeFor(p), title: p.designation };
}

function selfAsPerson(s: NonNullable<ReturnType<typeof useSessionOptional>>): RosterPerson {
  return {
    employee_id: s.employee_id, name: s.name, email: s.email, designation: s.designation, role_category: s.role_category, role: s.role,
    profile_label: s.profile_label, department: s.department, app_dept_id: s.scope?.app_dept_id ?? null, projects: s.scope?.projects ?? [],
    app_project_ids: s.scope?.app_project_ids ?? [], primary_tool: s.scope?.primary_tool ?? null, app_licence_id: s.scope?.app_licence_ids?.[0] ?? null,
    app_user_id: s.scope?.app_user_id ?? null, assigned_admin: null, assigned_admin_id: null, sessions: [],
  };
}

export function useApp(): Ctx {
  const c = useContext(AppContext);
  if (!c) throw new Error('useApp outside provider');
  return c;
}

export function useFinance(): FinanceInputs {
  return useApp().state.finance[0];
}

export function scopedFilters(f: Filters, perms: Permissions): Filters {
  return perms.deptScope ? { ...f, deptId: perms.deptScope } : f;
}
