/** Indian-number formatting for money and counts. */

const inGroup = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const inGroup1 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

/** Exact rupees with Indian grouping: ₹12,34,567 */
export function inr(v: number): string {
  const sign = v < 0 ? '−' : '';
  return `${sign}₹${inGroup.format(Math.round(Math.abs(v)))}`;
}

/** Summary rupees in lakh / crore: ₹4.40 Cr, ₹12.5 L, ₹45,000 */
export function inrShort(v: number, opts: { sign?: boolean } = {}): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? '−' : opts.sign && v > 0 ? '+' : '';
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(1)} L`;
  return `${sign}₹${inGroup.format(Math.round(abs))}`;
}

/** Ledger-style negative: ₹(3.0) L */
export function inrLedger(v: number): string {
  if (v >= 0) return inrShort(v);
  const abs = -v;
  if (abs >= 1e7) return `₹(${(abs / 1e7).toFixed(2)}) Cr`;
  if (abs >= 1e5) return `₹(${(abs / 1e5).toFixed(1)}) L`;
  return `₹(${inGroup.format(Math.round(abs))})`;
}

export function lakh(v: number): number {
  return v / 1e5;
}

export function num(v: number, digits = 0): string {
  return digits === 0 ? inGroup.format(Math.round(v)) : inGroup1.format(v);
}

export function pct(v: number, digits = 0): string {
  return `${(v * 100).toFixed(digits)}%`;
}

export function signedPct(v: number, digits = 0): string {
  const s = (v * 100).toFixed(digits);
  return v > 0 ? `+${s}%` : `${s.replace('-', '−')}%`;
}

export function hours(v: number): string {
  return `${inGroup.format(Math.round(v))} h`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${num(n)} ${n === 1 ? one : many}`;
}
