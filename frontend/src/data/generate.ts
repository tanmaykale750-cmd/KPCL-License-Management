/**
 * Deterministic synthetic-data generator.
 * Produces two years of weekly licence demand, monthly usage per department,
 * named-seat activity and per-user usage — all derived from the same weekly series,
 * so every total on every screen reconciles.
 */
import type {
  Department,
  Licence,
  MonthlyUsage,
  NamedAssignment,
  Project,
  User,
  UserToolUsage,
  WeeklyDemand,
} from '../domain/types';
import { DEMO_TODAY, addDays, addWeeks, daysBetween, monthKey, weekStart } from '../lib/dates';
import { gauss, hashString, mulberry32 } from '../lib/rng';
import { DEPARTMENTS, LICENCES, PROJECTS, ROUTINE, SEASON, WORK_HOURS_PER_WEEK } from './catalog';
import { FIRST, KEY_USERS, LAST, TEAMS } from './people';

export const HISTORY_WEEKS = 104;
export const CURRENT_WEEK = weekStart(DEMO_TODAY); // 2026-10-19
export const FIRST_WEEK = addWeeks(CURRENT_WEEK, -(HISTORY_WEEKS - 1));
export const FORECAST_START = addWeeks(CURRENT_WEEK, 1);

/** Capacity history: two ANSYS seats were re-hosted from Nashik to Hadapsar on 6 Jul 2026. */
export const REHOST_DATE = '2026-07-06';
export function capacityAt(lic: Licence, week: string): number {
  if (lic.id === 'ANS-MECH') return week < REHOST_DATE ? 8 : 10;
  if (lic.id === 'ANS-MECH-NSK') return week < REHOST_DATE ? 5 : 3;
  return lic.seats;
}

export function historyWeeks(): string[] {
  return Array.from({ length: HISTORY_WEEKS }, (_, i) => addWeeks(FIRST_WEEK, i));
}

/** Contribution of a phase to weekly peak demand: ramps in and out over two weeks. */
export function phaseShape(phaseStart: string, phaseEnd: string, week: string): number {
  if (week < weekStart(phaseStart) || week > phaseEnd) return 0;
  const total = Math.max(1, Math.round(daysBetween(phaseStart, phaseEnd) / 7));
  const pos = Math.round(daysBetween(phaseStart, week) / 7);
  if (pos < 1 || pos > total - 1) return 0.6;
  return 1;
}

function pastProjectLoad(projects: Project[], licenceId: string, week: string): number {
  let load = 0;
  for (const p of projects) {
    if (p.status !== 'completed') continue;
    for (const ph of p.phases) {
      const actual = ph.actualPeak?.[licenceId];
      if (!actual) continue;
      load += actual * phaseShape(ph.start, ph.end, week);
    }
  }
  return load;
}

function generateUsers(): User[] {
  const r = mulberry32(42);
  const users: User[] = [...KEY_USERS];
  const used = new Set(users.map((u) => u.name));
  for (const d of DEPARTMENTS) {
    const already = users.filter((u) => u.deptId === d.id).length;
    for (let i = already; i < d.headcount; i++) {
      let name = '';
      do {
        name = `${FIRST[Math.floor(r() * FIRST.length)]} ${LAST[Math.floor(r() * LAST.length)]}`;
      } while (used.has(name));
      used.add(name);
      const [f, l] = name.split(' ');
      const team = TEAMS[d.id][i % TEAMS[d.id].length];
      users.push({
        id: `u-${d.id}-${i}`,
        name,
        username: `${f[0]}${l}`.toLowerCase(),
        deptId: d.id,
        team,
        grade: (['E1', 'E2', 'E2', 'E3'] as const)[i % 4],
        title: d.id === 'sim' ? 'CAE Engineer' : d.id === 'rnd' ? 'R&D Engineer' : d.id === 'it' ? 'PLM Analyst' : 'Design Engineer',
      });
    }
  }
  return users;
}

interface GeneratedData {
  departments: Department[];
  licences: Licence[];
  projects: Project[];
  users: User[];
  weekly: WeeklyDemand[];
  monthly: MonthlyUsage[];
  assignments: NamedAssignment[];
  userUsage: UserToolUsage[];
}

/** Which users plausibly use a floating pool, by department. */
const POOL_USERS: Record<string, Record<string, number>> = {
  'ANS-MECH': { sim: 12, rnd: 3, engg: 2 },
  'ANS-MECH-NSK': { engg: 3, mfg: 2 },
  'ANS-HPC': { sim: 2 },
  'ANS-CFD': { sim: 5, rnd: 1 },
  'SW-PREM': { design: 14, engg: 9, mfg: 6 },
  'ALT-HW': { sim: 7, rnd: 3 },
  'CAD-ALG': { rnd: 7, engg: 2 },
};

/** Named seats: how many assigned holders are dormant or irregular. */
const NAMED_PROFILE: Record<string, { dormant90: number; d60: number; d30: number }> = {
  'INV-PRO': { dormant90: 9, d60: 3, d30: 4 },
  'ACAD-MECH': { dormant90: 4, d60: 1, d30: 2 },
  'ADSK-VAULT': { dormant90: 2, d60: 1, d30: 1 },
  'ADSK-FLEX': { dormant90: 0, d60: 0, d30: 2 },
};

export function generateDataset(): GeneratedData {
  const users = generateUsers();
  const weeks = historyWeeks();
  const weekly: WeeklyDemand[] = [];
  const monthlyMap = new Map<string, MonthlyUsage>();
  const assignments: NamedAssignment[] = [];
  const userUsage: UserToolUsage[] = [];

  const mkey = (lic: string, dept: string, m: string) => `${lic}|${dept}|${m}`;
  const bucket = (licenceId: string, deptId: string, month: string): MonthlyUsage => {
    const k = mkey(licenceId, deptId, month);
    let row = monthlyMap.get(k);
    if (!row) {
      row = { licenceId, deptId, month, availableHours: 0, activeHours: 0, idleCheckoutHours: 0, checkouts: 0, denials: 0, blockedHours: 0, distinctUsers: 0 };
      monthlyMap.set(k, row);
    }
    return row;
  };

  // ---- Shared pools (floating, token, node-locked): weekly demand drives everything ----
  for (const lic of LICENCES) {
    const routine = ROUTINE[lic.id];
    if (!routine) continue;
    const r = mulberry32(hashString(lic.id));
    const deptIds = Object.keys(lic.allocations);
    const allocTotal = deptIds.reduce((s, d) => s + lic.allocations[d], 0);
    const poolUserCounts = POOL_USERS[lic.id] ?? {};
    const deptHoursTotals: Record<string, { active: number; idle: number; denials: number }> = {};

    weeks.forEach((w, i) => {
      const m = Number(w.slice(5, 7)) - 1;
      const years = i / 52;
      const raw = routine.base * (1 + routine.trend * years) * (1 + SEASON[m]) + routine.sd * gauss(r) + pastProjectLoad(PROJECTS, lic.id, w);
      const demand = Math.max(0, Math.round(raw));
      const cap = capacityAt(lic, w);
      const observed = Math.min(demand, cap);
      const short = Math.max(0, demand - cap);
      // A weekly peak that reaches capacity usually means a few requests were turned away at the busiest moments.
      let denials = short > 0 ? Math.round(short * (5 + 3 * r())) : demand === cap && r() < 0.65 ? 1 + Math.floor(3 * r()) : 0;
      if (lic.id === 'ANS-HPC') denials = 0;
      const blocked = Math.round(denials * (1.5 + 0.7 * r()) * 10) / 10;
      weekly.push({ licenceId: lic.id, weekStart: w, demand, observedPeak: observed, capacity: cap, denials, blockedHours: blocked });

      // Average concurrency is a share of the weekly peak.
      const avgConc = observed * routine.activeShare * (0.88 + 0.24 * r());
      const active = Math.min(avgConc * WORK_HOURS_PER_WEEK, cap * WORK_HOURS_PER_WEEK * 0.96);
      const idle = Math.min(active * routine.idleRatio * (0.8 + 0.4 * r()), cap * WORK_HOURS_PER_WEEK - active);
      const month = monthKey(w);
      const scale = cap / lic.seats;
      deptIds.forEach((d, di) => {
        const weight = lic.allocations[d] / allocTotal;
        const jitter = 0.9 + 0.2 * mulberry32(hashString(`${lic.id}${w}${di}`))();
        const row = bucket(lic.id, d, month);
        row.availableHours += lic.allocations[d] * scale * WORK_HOURS_PER_WEEK;
        const a = active * weight * jitter;
        const idl = idle * weight * (d === 'rnd' || d === 'engg' ? 1.25 : 0.95);
        row.activeHours += a;
        row.idleCheckoutHours += idl;
        row.checkouts += Math.round(a / 3.4);
        const dn = Math.round(denials * weight);
        row.denials += dn;
        row.blockedHours += blocked * weight;
        row.distinctUsers = Math.max(row.distinctUsers, poolUserCounts[d] ?? 0);
        if (w >= addWeeks(CURRENT_WEEK, -51)) {
          const t = (deptHoursTotals[d] ??= { active: 0, idle: 0, denials: 0 });
          t.active += a;
          t.idle += idl;
          t.denials += dn;
        }
      });
    });

    // Per-user usage over the last 12 months for this pool.
    for (const d of deptIds) {
      const tot = deptHoursTotals[d];
      if (!tot) continue;
      const pool = users.filter((u) => u.deptId === d && u.id !== 'u-priya' && u.id !== 'u-rohit' && !u.title.startsWith('Head'));
      const n = Math.min(poolUserCounts[d] ?? 2, pool.length);
      const ur = mulberry32(hashString(`${lic.id}-${d}-users`));
      const chosen = [...pool].sort((a, b) => hashString(a.id + lic.id) - hashString(b.id + lic.id)).slice(0, n);
      if (lic.id === 'ANS-MECH' && d === 'sim' && !chosen.some((u) => u.id === 'u-rahul')) chosen[0] = users.find((u) => u.id === 'u-rahul')!;
      const weights = chosen.map((_, i) => Math.pow(0.78, i) * (0.8 + 0.4 * ur()));
      const idleWeights = chosen.map((_, i) => (i === 1 || i === 3 ? 3.2 : 1) * (0.6 + 0.8 * ur()));
      const wsum = weights.reduce((s, x) => s + x, 0);
      const isum = idleWeights.reduce((s, x) => s + x, 0);
      chosen.forEach((u, i) => {
        userUsage.push({
          userId: u.id,
          licenceId: lic.id,
          activeHours12m: Math.round((tot.active * weights[i]) / wsum),
          idleHours12m: Math.round((tot.idle * idleWeights[i]) / isum),
          lastActive: addDays(DEMO_TODAY, -Math.floor(ur() * (lic.id === 'ANS-HPC' ? 70 : 18))),
          denials12m: Math.round((tot.denials * weights[i]) / wsum),
        });
      });
    }
  }

  // ---- Named-user pools: per-holder activity ----
  for (const lic of LICENCES) {
    if (ROUTINE[lic.id]) continue;
    const prof = NAMED_PROFILE[lic.id] ?? { dormant90: 0, d60: 0, d30: 0 };
    const r = mulberry32(hashString(`${lic.id}-named`));
    const holders: { user: User; deptId: string; lastActive: string; weeklyHours: number }[] = [];
    for (const [deptId, seats] of Object.entries(lic.allocations)) {
      const pool = users
        .filter((u) => u.deptId === deptId && u.id !== 'u-rohit')
        .sort((a, b) => hashString(a.id + lic.id) - hashString(b.id + lic.id));
      for (let i = 0; i < seats && i < pool.length; i++) holders.push({ user: pool[i], deptId, lastActive: DEMO_TODAY, weeklyHours: 0 });
    }
    // Assign dormancy deterministically, spread across departments.
    const order = [...holders].sort((a, b) => hashString(a.user.id + 'dorm') - hashString(b.user.id + 'dorm'));
    order.forEach((h, i) => {
      if (h.user.id === 'u-amit' || h.user.id === 'u-meera') {
        h.lastActive = addDays(DEMO_TODAY, -1);
      } else if (i < prof.dormant90) h.lastActive = addDays(DEMO_TODAY, -(95 + Math.floor(r() * 140)));
      else if (i < prof.dormant90 + prof.d60) h.lastActive = addDays(DEMO_TODAY, -(62 + Math.floor(r() * 25)));
      else if (i < prof.dormant90 + prof.d60 + prof.d30) h.lastActive = addDays(DEMO_TODAY, -(33 + Math.floor(r() * 25)));
      else h.lastActive = addDays(DEMO_TODAY, -Math.floor(r() * 9));
      const heavy = r();
      h.weeklyHours = lic.id === 'ADSK-FLEX' ? 6 + 6 * r() : heavy < 0.5 ? 32 + 7 * r() : heavy < 0.82 ? 20 + 7 * r() : 7 + 5 * r();
    });

    let fullYearActive = 0;
    holders.forEach((h) => {
      let yearHours = 0;
      let yearIdle = 0;
      weeks.forEach((w) => {
        const month = monthKey(w);
        const row = bucket(lic.id, h.deptId, month);
        row.availableHours += WORK_HOURS_PER_WEEK;
        if (w > h.lastActive) return;
        const m = Number(w.slice(5, 7)) - 1;
        const hrs = Math.max(0, h.weeklyHours * (1 + SEASON[m]) * (0.85 + 0.3 * r()));
        const idle = hrs * (0.16 + 0.1 * r());
        row.activeHours += hrs;
        row.idleCheckoutHours += Math.min(idle, WORK_HOURS_PER_WEEK - hrs);
        row.checkouts += Math.round(hrs / 4);
        if (w >= addWeeks(CURRENT_WEEK, -51)) {
          yearHours += hrs;
          yearIdle += idle;
        }
      });
      fullYearActive += yearHours;
      assignments.push({ licenceId: lic.id, userId: h.user.id, assignedOn: lic.startDate, lastActive: h.lastActive, activeHours12m: Math.round(yearHours) });
      userUsage.push({ userId: h.user.id, licenceId: lic.id, activeHours12m: Math.round(yearHours), idleHours12m: Math.round(yearIdle), lastActive: h.lastActive, denials12m: 0 });
    });
    void fullYearActive;

    // Weekly distinct-holder peaks for named pools (used by the Software view).
    weeks.forEach((w) => {
      const active = holders.filter((h) => w <= h.lastActive).length;
      const observed = Math.min(lic.seats, Math.round(active * (0.86 + 0.08 * r())));
      weekly.push({ licenceId: lic.id, weekStart: w, demand: observed, observedPeak: observed, capacity: lic.seats, denials: 0, blockedHours: 0 });
    });
    // Distinct users per dept-month
    for (const row of monthlyMap.values()) {
      if (row.licenceId !== lic.id) continue;
      row.distinctUsers = holders.filter((h) => h.deptId === row.deptId && `${row.month}-01` <= h.lastActive).length;
    }
  }

  const monthly = [...monthlyMap.values()].map((row) => ({
    ...row,
    activeHours: Math.round(row.activeHours),
    idleCheckoutHours: Math.round(row.idleCheckoutHours),
    availableHours: Math.round(row.availableHours),
    blockedHours: Math.round(row.blockedHours * 10) / 10,
  }));

  return { departments: DEPARTMENTS, licences: LICENCES, projects: PROJECTS, users, weekly, monthly, assignments, userUsage };
}
