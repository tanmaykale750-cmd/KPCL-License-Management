/**
 * Client for the KPCL integration API (backend/server.py). The session token comes from the employee sign-in; the
 * role and scopes are decided by the server from the employee record, never chosen in the browser.
 */
import type { RoleId } from '../domain/types';
import type { SessionScope } from '../state/roles';

export interface SessionUser {
  employee_id: string;
  name: string;
  email: string;
  designation: string;
  role_category: string;
  department: string;
  role: RoleId;
  profile_label: string;
  profile_summary: string;
  scopes: string[];
  scope: SessionScope;
}

/** A person from the HR roster, as returned by GET /api/team (already limited to the caller's scope). */
export interface RosterPerson {
  employee_id: string;
  name: string;
  email: string;
  designation: string;
  role_category: string;
  role: RoleId | null;
  profile_label: string | null;
  department: string;
  app_dept_id: string | null;
  projects: string[];
  app_project_ids: string[];
  primary_tool: string | null;
  app_licence_id: string | null;
  app_user_id: string | null;
  assigned_admin: string | null;
  assigned_admin_id: string | null;
  /** logged licence sessions from the roster workbook (sheet ML_Training_Dataset), newest first */
  sessions: RosterSession[];
  relation?: string;
}

export interface RosterSession {
  Software_Tool: string;
  License_Type: string;
  Project_ID: string;
  Project_Phase: string;
  Session_Start: string;
  Session_Duration_Hrs: number;
  Active_Usage_Hrs: number;
  Idle_Duration_Hrs: number;
  CPU_GPU_Utilization_Pct: number;
  Keyboard_Mouse_Activity_Pct: number;
  Idle_Session_Flag: number;
  Recommended_Action: string;
}

export interface TeamReply {
  level: SessionScope['level'];
  members: RosterPerson[];
  contacts: RosterPerson[];
}

export interface DemoAccount {
  employee_id: string;
  name: string;
  email: string;
  designation: string;
  profile_label: string;
  department: string;
}

const KEY = 'kpcl.session.v1';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export function storedToken(): string | null {
  try {
    return window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function storeToken(t: string | null) {
  try {
    if (t) window.sessionStorage.setItem(KEY, t);
    else window.sessionStorage.removeItem(KEY);
  } catch {
    /* private mode: session lasts for this page only */
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = storedToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'offline', 'The KPCL API is not reachable. Start it with `python -m backend.server`.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') storeToken(null);
    throw new ApiError(res.status, data.error ?? 'error', data.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T>(path: string, body: unknown) => call<T>('POST', path, body),
};

export async function signIn(employee_id: string, email: string, designation: string): Promise<SessionUser> {
  const r = await api.post<{ token: string; user: SessionUser }>('/auth/login', { employee_id, email, designation });
  storeToken(r.token);
  return r.user;
}

export async function currentUser(): Promise<SessionUser | null> {
  if (!storedToken()) return null;
  try {
    return (await api.get<{ user: SessionUser }>('/auth/me')).user;
  } catch {
    storeToken(null);
    return null;
  }
}

export function signOut() {
  storeToken(null);
  window.location.assign('/');
}

export const fetchTeam = () => api.get<TeamReply>('/team');
export const fetchDemoAccounts = () => api.get<{ accounts: DemoAccount[] }>('/auth/demo-accounts').then((r) => r.accounts);
