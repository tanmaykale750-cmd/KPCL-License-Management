/**
 * Import validation for licence-server log exports and Excel/CSV usage files.
 * Problem rows are held for the administrator to fix — never silently dropped.
 */
import type { Licence, User } from '../domain/types';
import { hashString } from '../lib/rng';

export const FIELDS = ['username', 'feature', 'machine', 'checkout', 'checkin', 'timezone'] as const;
export type FieldKey = (typeof FIELDS)[number];

const SYNONYMS: Record<FieldKey, string[]> = {
  username: ['username', 'user', 'user_name', 'login', 'userid', 'user id'],
  feature: ['feature', 'feature_code', 'product', 'licence', 'license', 'feature name'],
  machine: ['machine', 'host', 'hostname', 'computer', 'workstation'],
  checkout: ['checkout', 'check_out', 'checkout_time', 'start', 'start_time', 'out'],
  checkin: ['checkin', 'check_in', 'checkin_time', 'end', 'end_time', 'in'],
  timezone: ['timezone', 'tz', 'time_zone', 'zone'],
};

/** Feature codes seen in licence-server logs mapped to inventory records. */
export const FEATURE_CODES: Record<string, string> = {
  mech_ent: 'ANS-MECH',
  ansys_mechanical: 'ANS-MECH',
  cfd_base: 'ANS-CFD',
  fluent: 'ANS-CFD',
  anshpc_pack: 'ANS-HPC',
  solidworks_premium: 'SW-PREM',
  swpremium: 'SW-PREM',
  hwu: 'ALT-HW',
  hyperworks: 'ALT-HW',
  allegro_pcb: 'CAD-ALG',
  inventor_pro: 'INV-PRO',
  inventor: 'INV-PRO',
  acad_mech: 'ACAD-MECH',
  vault_pro: 'ADSK-VAULT',
};

export function autoMap(headers: string[]): Partial<Record<FieldKey, number>> {
  const m: Partial<Record<FieldKey, number>> = {};
  headers.forEach((h, i) => {
    const n = h.trim().toLowerCase();
    for (const f of FIELDS) if (m[f] === undefined && SYNONYMS[f].includes(n)) m[f] = i;
  });
  return m;
}

export type IssueKind = 'missing' | 'invalid-date' | 'ambiguous-date' | 'duplicate' | 'unknown-user' | 'unknown-feature' | 'missing-timezone';

export const ISSUE_LABEL: Record<IssueKind, string> = {
  missing: 'Missing fields',
  'invalid-date': 'Invalid dates',
  'ambiguous-date': 'DD/MM vs MM/DD conflict',
  duplicate: 'Duplicate records',
  'unknown-user': 'Unknown usernames',
  'unknown-feature': 'Unknown software or features',
  'missing-timezone': 'Missing time zones',
};

export interface Issue {
  kind: IssueKind;
  field: FieldKey;
  message: string;
  suggestion?: string;
  suggestionLabel?: string;
}

export interface ImportRow {
  line: number;
  values: Record<FieldKey, string>;
  issues: Issue[];
  excluded?: string;
  corrected: number;
}

export interface ParsedTime {
  iso: string;
  hasZone: boolean;
  ambiguous: boolean;
}

/** Accepts ISO (2026-10-14T09:30[:00][Z|+05:30]) and day-first or month-first slash dates (14/10/2026 09:30). */
export function parseTime(raw: string): ParsedTime | null {
  const s = raw.trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?$/);
  if (m) {
    const [, y, mo, d, h, mi, sec = '00', zone] = m;
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${sec}`;
    if (Number.isNaN(Date.parse(`${iso}Z`)) || Number(mo) > 12 || Number(d) > 31 || Number(h) > 23) return null;
    return { iso, hasZone: !!zone, ambiguous: false };
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})$/);
  if (m) {
    const [, a, b, y, h, mi] = m;
    const A = Number(a);
    const B = Number(b);
    if (A > 31 || B > 31 || (A > 12 && B > 12) || Number(h) > 23) return null;
    const dayFirst = A > 12 || B <= 12; // default to Indian day-first unless impossible
    const day = dayFirst ? A : B;
    const mon = dayFirst ? B : A;
    if (mon > 12) return null;
    const iso = `${y}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:${mi}:00`;
    if (Number.isNaN(Date.parse(`${iso}Z`))) return null;
    return { iso, hasZone: false, ambiguous: A <= 12 && B <= 12 && A !== B };
  }
  return null;
}

function lev(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

/** Likely directory match, e.g. "patilr" or "r.patil" → Rahul Patil (rpatil). */
export function suggestUser(raw: string, users: User[]): User | null {
  const n = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (!n) return null;
  let best: { u: User; d: number } | null = null;
  for (const u of users) {
    const [first, ...rest] = u.name.toLowerCase().split(' ');
    const last = rest.join('');
    const variants = [u.username, `${first[0]}${last}`, `${last}${first[0]}`, `${first}${last}`, `${first}.${last}`.replace('.', '')];
    for (const v of variants) {
      const d = lev(n, v);
      if (!best || d < best.d) best = { u, d };
    }
  }
  return best && best.d <= 2 ? best.u : null;
}

export interface ValidationContext {
  users: User[];
  licences: Licence[];
  today: string;
  maxSessionHours: number;
  serverZone: string;
  extraUsernames?: string[]; // marked by the administrator as shared or service accounts
  extraFeatures?: Record<string, string>; // feature codes mapped by the administrator
}

export function validateRows(rows: ImportRow[], ctx: ValidationContext): ImportRow[] {
  const known = new Set([...ctx.users.map((u) => u.username.toLowerCase()), ...(ctx.extraUsernames ?? []).map((x) => x.toLowerCase())]);
  const features = { ...FEATURE_CODES, ...(ctx.extraFeatures ?? {}) };
  const seen = new Map<string, number>();
  return rows.map((r) => {
    if (r.excluded) return { ...r, issues: [] };
    const v = r.values;
    const issues: Issue[] = [];
    for (const f of ['username', 'feature', 'checkout'] as FieldKey[]) if (!v[f]?.trim()) issues.push({ kind: 'missing', field: f, message: `No ${f === 'checkout' ? 'check-out time' : f}` });
    const out = v.checkout ? parseTime(v.checkout) : null;
    const inn = v.checkin ? parseTime(v.checkin) : null;
    if (v.checkout && !out) issues.push({ kind: 'invalid-date', field: 'checkout', message: `Unreadable date “${v.checkout}”` });
    if (v.checkin && !inn) issues.push({ kind: 'invalid-date', field: 'checkin', message: `Unreadable date “${v.checkin}”` });
    if (out) {
      if (out.iso.slice(0, 10) > ctx.today) issues.push({ kind: 'invalid-date', field: 'checkout', message: 'Check-out is in the future' });
      if (out.ambiguous) issues.push({ kind: 'ambiguous-date', field: 'checkout', message: `“${v.checkout}” could be day-first or month-first`, suggestion: out.iso.replace('T', ' ').slice(0, 16), suggestionLabel: 'Confirm day-first (DD/MM)' });
      if (!out.hasZone && !v.timezone?.trim()) issues.push({ kind: 'missing-timezone', field: 'timezone', message: 'Timestamp has no time zone', suggestion: ctx.serverZone, suggestionLabel: `Apply server zone ${ctx.serverZone}` });
    }
    if (out && inn) {
      const hrs = (Date.parse(`${inn.iso}Z`) - Date.parse(`${out.iso}Z`)) / 3_600_000;
      if (hrs < 0) issues.push({ kind: 'invalid-date', field: 'checkin', message: 'Check-in is before check-out' });
      else if (hrs > ctx.maxSessionHours) issues.push({ kind: 'invalid-date', field: 'checkin', message: `Session of ${hrs.toFixed(0)} h exceeds the ${ctx.maxSessionHours} h maximum` });
    }
    if (v.username?.trim() && !known.has(v.username.trim().toLowerCase())) {
      const s = suggestUser(v.username, ctx.users);
      issues.push({ kind: 'unknown-user', field: 'username', message: `“${v.username}” is not in the company directory`, suggestion: s?.username, suggestionLabel: s ? `Map to ${s.name} (${s.username})` : undefined });
    }
    if (v.feature?.trim() && !features[v.feature.trim().toLowerCase()]) issues.push({ kind: 'unknown-feature', field: 'feature', message: `Feature code “${v.feature}” is not in the licence inventory` });
    const key = [v.username, v.feature, v.machine, v.checkout].map((x) => (x ?? '').trim().toLowerCase()).join('|');
    if (v.username && v.checkout) {
      const first = seen.get(key);
      if (first !== undefined) issues.push({ kind: 'duplicate', field: 'checkout', message: `Duplicate of line ${first}` });
      else seen.set(key, r.line);
    }
    return { ...r, issues };
  });
}

export function qualityScore(rows: ImportRow[]): number {
  if (!rows.length) return 0;
  return rows.filter((r) => !r.excluded && r.issues.length === 0).length / rows.length;
}

export function fingerprint(text: string): string {
  return hashString(text).toString(16).padStart(8, '0');
}

export function rowsFromTable(table: string[][], mapping: Partial<Record<FieldKey, number>>): ImportRow[] {
  return table.slice(1).map((cells, i) => {
    const values = Object.fromEntries(FIELDS.map((f) => [f, mapping[f] !== undefined ? String(cells[mapping[f]!] ?? '').trim() : ''])) as Record<FieldKey, string>;
    return { line: i + 2, values, issues: [], corrected: 0 };
  });
}

/** A sample export with deliberate problems, for demonstrating validation. */
export const SAMPLE_IMPORT = `username,feature,machine,checkout,checkin,timezone
rpatil,mech_ent,WS-CAE-07,2026-10-12T09:05:00+05:30,2026-10-12T13:40:00+05:30,
rpatil,mech_ent,WS-CAE-07,2026-10-12T09:05:00+05:30,2026-10-12T13:40:00+05:30,
sbhosale,cfd_base,WS-CFD-02,2026-10-12T10:15:00+05:30,2026-10-12T17:55:00+05:30,
patilr,anshpc_pack,WS-CAE-07,2026-10-13T08:50:00+05:30,2026-10-13T16:20:00+05:30,
,solidworks_premium,WS-DES-11,2026-10-13T09:30:00+05:30,2026-10-13T12:00:00+05:30,
agokhale,inventor_pro,WS-DES-04,13/10/2026 09:10,13/10/2026 18:05,IST
agokhale,inventor_pro,WS-DES-04,03/10/2026 09:00,03/10/2026 17:30,IST
kshinde,solidworks_premium,WS-ENG-09,2026-10-14T11:00:00,2026-10-14T15:30:00,
kshinde,solidworks_premium,WS-ENG-09,2026-10-14T16:00:00+05:30,2026-10-14T15:10:00+05:30,
amenon,allegro_pcb,WS-RND-03,2026-10-15T09:00:00+05:30,2026-10-18T09:00:00+05:30,
amenon,allegro_pcb,WS-RND-03,2026-13-15T09:00:00+05:30,2026-10-15T12:00:00+05:30,
gpawar,acad_mech,WS-MFG-02,2026-10-15T10:20:00+05:30,2026-10-15T12:45:00+05:30,
gpawar,acad_mechanical,WS-MFG-02,2026-10-16T10:20:00+05:30,2026-10-16T12:45:00+05:30,
mjoshi,inventor_pro,WS-DES-01,2026-10-16T09:00:00+05:30,2026-10-16T18:30:00+05:30,
hkulkarni,hwu,WS-CAE-01,2026-10-16T14:00:00+05:30,2026-10-16T17:20:00+05:30,
sbhosale,cfd_base,WS-CFD-02,2026-11-20T10:00:00+05:30,2026-11-20T12:00:00+05:30,
svc_batch,mech_ent,HPC-NODE-2,2026-10-17T22:00:00+05:30,2026-10-18T05:30:00+05:30,
pnair,vault_pro,WS-IT-03,2026-10-17T09:30:00+05:30,2026-10-17T10:15:00+05:30,
rpatil,hwu,WS-CAE-07,2026-10-19T09:20:00+05:30,2026-10-19T12:10:00+05:30,
sbhosale,fluent,WS-CFD-02,2026-10-19T13:00:00+05:30,2026-10-19T18:00:00+05:30,
`;
