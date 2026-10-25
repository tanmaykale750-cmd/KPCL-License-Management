/** How a person gets a licence, and when its pool is forecast to be short (shared by Team & Access and My Licences). */
import type { Dataset } from '../data/dataset';
import type { Licence } from '../domain/types';
import { fmtDate } from '../lib/dates';
import { forecast, runs } from './forecast';

export function accessRoute(lic: Licence, deptId: string | null, deptName: string): string {
  if (lic.type === 'named') return 'Named seat, assigned per person';
  const alloc = deptId ? lic.allocations[deptId] ?? 0 : Object.values(lic.allocations).reduce((a, b) => a + b, 0);
  if (lic.type === 'node-locked') return `Node-locked workstations · ${alloc} of ${lic.seats} for the ${deptName} group`;
  if (lic.type === 'token') return `Token pool · ${alloc} of ${lic.seats} ${lic.unitLabel} for the ${deptName} group`;
  return `Floating pool · ${alloc} of ${lic.seats} seats reserved for the ${deptName} group`;
}

/** Weeks in the horizon where the forecast high case (P90) exceeds the pool, compressed into ranges; '—' = not forecast. */
export function shortWeeks(ds: Dataset, lic: Licence, horizon = 26): string {
  if (!lic.forecastable) return '—';
  const f = forecast(ds, lic.id, { horizonWeeks: horizon });
  const short = f.points.filter((p) => p.p90 > p.capacity).map((p) => p.week);
  if (!short.length) return 'none';
  return runs(short).map((r) => `${fmtDate(r.start).slice(0, 6)}–${fmtDate(r.end).slice(0, 6)}`).join(', ');
}
