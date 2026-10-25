import type { ISODate, MonthKey } from '../domain/types';

/** The prototype runs on a fixed "today" so every figure is reproducible. */
export const DEMO_TODAY: ISODate = '2026-10-25';

const DAY = 86_400_000;

export function toDate(d: ISODate): Date {
  return new Date(`${d}T00:00:00Z`);
}

export function toISO(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: ISODate, n: number): ISODate {
  return toISO(new Date(toDate(d).getTime() + n * DAY));
}

export function addWeeks(d: ISODate, n: number): ISODate {
  return addDays(d, n * 7);
}

export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((toDate(b).getTime() - toDate(a).getTime()) / DAY);
}

/** Monday of the week containing d. */
export function weekStart(d: ISODate): ISODate {
  const dt = toDate(d);
  const dow = (dt.getUTCDay() + 6) % 7; // 0 = Monday
  return toISO(new Date(dt.getTime() - dow * DAY));
}

export function monthKey(d: ISODate): MonthKey {
  return d.slice(0, 7);
}

export function addMonths(m: MonthKey, n: number): MonthKey {
  const [y, mo] = m.split('-').map(Number);
  const idx = y * 12 + (mo - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

export function monthsBack(end: MonthKey, count: number): MonthKey[] {
  return Array.from({ length: count }, (_, i) => addMonths(end, i - count + 1));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function monthLabel(m: MonthKey, withYear = false): string {
  const [y, mo] = m.split('-').map(Number);
  const base = MONTHS[mo - 1];
  return withYear ? `${base} ${String(y).slice(2)}` : base;
}

export function fmtDate(d: ISODate | undefined, style: 'short' | 'long' = 'short'): string {
  if (!d) return '—';
  const [y, m, day] = d.split('-').map(Number);
  if (style === 'long') return `${day} ${MONTHS[m - 1]} ${y}`;
  return `${String(day).padStart(2, '0')} ${MONTHS[m - 1]} ${String(y).slice(2)}`;
}

export function fmtDateTime(iso: string): string {
  const d = iso.slice(0, 10);
  const t = iso.length > 10 ? iso.slice(11, 16) : '';
  return t ? `${fmtDate(d)} ${t}` : fmtDate(d);
}

export function isoWeekOfYear(d: ISODate): number {
  const dt = toDate(d);
  const target = new Date(dt.getTime());
  const dayNr = (dt.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const diff = target.getTime() - firstThursday.getTime();
  return 1 + Math.round((diff / DAY - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}

/** Inclusive overlap test for two ISO date ranges. */
export function overlaps(aStart: ISODate, aEnd: ISODate, bStart: ISODate, bEnd: ISODate): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

export function nowStamp(): string {
  // Real wall-clock time for audit entries made during the demo.
  return new Date().toISOString().slice(0, 16).replace('T', ' ');
}
