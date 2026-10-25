/**
 * The four profiles and what each one sees and may do in the app.
 *
 *   admin        Admin (Head)      everything: all departments, projects, licences and costs; registry, imports,
 *                                  fulfilment, budgets, approval limits, finance inputs, savings verification and the
 *                                  final sign-off on the largest decisions
 *   deptHead     Department Head   their department: decides access requests, sees and releases the department's
 *                                  seats, approves tier-2/3 recommendations and project changes for the department
 *   projectLead  Project Head      their projects: timelines and phase demand, the project team's access, schedule
 *                                  what-ifs and project change proposals
 *   engineer     Engineer          their own licences, availability of their tools and their own access requests
 *
 * The profile and the department / project scope come from the employee record (server-verified at sign-in); the
 * API enforces the same split on every call (backend/auth.py). Hiding screens here is for usability, not security.
 */
import type { ApprovalStep, RoleId } from '../domain/types';
import { PERSONAS } from '../data/people';

export type Area =
  | 'overview'
  | 'registry'
  | 'planning'
  | 'review'
  | 'software'
  | 'projects'
  | 'requests'
  | 'services'
  | 'vendors'
  | 'reports'
  | 'settings'
  | 'team'
  | 'mylicences';

export interface Permissions {
  areas: Area[];
  landing: string;
  seesCosts: boolean;
  seesIndividuals: boolean; // named people and their seats (within the scope below)
  deptScope: string | null; // null = all departments
  projectScope: string[] | null; // null = all projects
  editRegistry: boolean;
  editAssignments: boolean; // release / reassign named seats (department heads: their department only)
  importData: boolean;
  approveRequests: boolean; // department head decision
  fulfilRequests: boolean; // administrator fulfilment
  submitRequests: boolean;
  submitRecommendations: boolean;
  approvalSteps: ApprovalStep[];
  editFinanceInputs: boolean;
  setLimits: boolean;
  prepareReview: boolean;
  verifySavings: boolean;
  proposeProjectChanges: boolean;
  approveProjectChanges: boolean;
  confirmProjectChanges: boolean;
  runWhatIf: 'all' | 'own-projects' | 'none';
}

export const PERMISSIONS: Record<RoleId, Permissions> = {
  admin: {
    areas: ['overview', 'registry', 'planning', 'review', 'software', 'projects', 'requests', 'team', 'services', 'vendors', 'reports', 'settings'],
    landing: '/overview',
    seesCosts: true,
    seesIndividuals: true,
    deptScope: null,
    projectScope: null,
    editRegistry: true,
    editAssignments: true,
    importData: true,
    approveRequests: false,
    fulfilRequests: true,
    submitRequests: false,
    submitRecommendations: true,
    approvalSteps: ['admin', 'leadership'],
    editFinanceInputs: true,
    setLimits: true,
    prepareReview: true,
    verifySavings: true,
    proposeProjectChanges: false,
    approveProjectChanges: false,
    confirmProjectChanges: true,
    runWhatIf: 'all',
  },
  deptHead: {
    areas: ['overview', 'team', 'requests', 'registry', 'planning', 'review', 'software', 'projects', 'services', 'reports'],
    landing: '/overview',
    seesCosts: true,
    seesIndividuals: true,
    deptScope: null, // set from the signed-in employee's department
    projectScope: null,
    editRegistry: false,
    editAssignments: true,
    importData: false,
    approveRequests: true,
    fulfilRequests: false,
    submitRequests: false,
    submitRecommendations: true,
    approvalSteps: ['deptHead'],
    editFinanceInputs: false,
    setLimits: false,
    prepareReview: false,
    verifySavings: false,
    proposeProjectChanges: false,
    approveProjectChanges: true,
    confirmProjectChanges: false,
    runWhatIf: 'all',
  },
  projectLead: {
    areas: ['projects', 'team', 'planning', 'requests'],
    landing: '/projects',
    seesCosts: false,
    seesIndividuals: true,
    deptScope: null,
    projectScope: [], // set from the signed-in employee's projects
    editRegistry: false,
    editAssignments: false,
    importData: false,
    approveRequests: false,
    fulfilRequests: false,
    submitRequests: false,
    submitRecommendations: false,
    approvalSteps: [],
    editFinanceInputs: false,
    setLimits: false,
    prepareReview: false,
    verifySavings: false,
    proposeProjectChanges: true,
    approveProjectChanges: false,
    confirmProjectChanges: false,
    runWhatIf: 'own-projects',
  },
  engineer: {
    areas: ['mylicences', 'requests'],
    landing: '/my-licences',
    seesCosts: false,
    seesIndividuals: false,
    deptScope: null,
    projectScope: [],
    editRegistry: false,
    editAssignments: false,
    importData: false,
    approveRequests: false,
    fulfilRequests: false,
    submitRequests: true,
    submitRecommendations: false,
    approvalSteps: [],
    editFinanceInputs: false,
    setLimits: false,
    prepareReview: false,
    verifySavings: false,
    proposeProjectChanges: false,
    approveProjectChanges: false,
    confirmProjectChanges: false,
    runWhatIf: 'none',
  },
};

/** Scope fields of the signed-in employee (backend/auth.py `_scope`). */
export interface SessionScope {
  level: 'all' | 'department' | 'project' | 'self';
  department: string;
  app_dept_id: string | null;
  projects: string[];
  app_project_ids: string[];
  primary_tool: string | null;
  app_licence_ids: string[];
  app_user_id: string | null;
}

/** The profile's permissions with the department / project scope of the signed-in employee filled in. */
export function permissionsFor(role: RoleId, scope?: SessionScope | null, fallbackDept?: string): Permissions {
  const base = PERMISSIONS[role];
  if (role === 'deptHead') return { ...base, deptScope: scope?.app_dept_id ?? fallbackDept ?? 'sim' };
  if (role === 'projectLead') return { ...base, projectScope: scope?.app_project_ids?.length ? scope.app_project_ids : ['PRJ-X'] };
  return base;
}

export function personaFor(role: RoleId) {
  return PERSONAS.find((p) => p.role === role)!;
}

export const STEP_LABEL: Record<ApprovalStep, string> = {
  deptHead: 'Department head',
  admin: 'Licence administrator',
  leadership: 'Final sign-off (second administrator)',
};
