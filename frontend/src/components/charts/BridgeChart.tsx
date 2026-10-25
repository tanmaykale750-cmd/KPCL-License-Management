import type { Bridge } from '../../calc/review';
import { inrShort } from '../../lib/format';

/**
 * Price–volume bridge (waterfall): last cycle's invoice → volume effect → price effect → this cycle's invoice.
 * Only the volume effect is a saving the platform may claim; the price effect is the vendor's price change.
 */
export function BridgeChart({ b, height = 200, compact = false, width }: { b: Bridge; height?: number; compact?: boolean; width?: number }) {
  // `width` widens the drawing (not its height) for wide panels; without it the chart keeps its original 400-unit layout.
  const W = width ?? 400;
  const top = 22;
  const bottom = 34;
  const left = 8;
  const plotH = height - top - bottom;
  const bars = [
    { key: 'before', label: 'Last cycle', from: 0, to: b.before, tone: 'base' },
    { key: 'volume', label: 'Volume effect', from: b.before, to: b.before + b.volume, tone: b.volume <= 0 ? 'save' : 'cost' },
    { key: 'price', label: 'Price effect', from: b.before + b.volume, to: b.before + b.volume + b.price, tone: 'price' },
    { key: 'after', label: 'This cycle', from: 0, to: b.after, tone: 'base' },
  ];
  const max = Math.max(...bars.map((x) => Math.max(x.from, x.to))) * 1.08 || 1;
  const min = Math.min(0, ...bars.map((x) => Math.min(x.from, x.to)));
  const y = (v: number) => top + plotH - ((v - min) / (max - min)) * plotH;
  const slot = (W - left * 2) / bars.length;
  const bw = Math.min(70, slot * 0.52);
  const fill: Record<string, string> = { base: 'var(--chart-actual)', save: 'var(--teal)', cost: 'var(--crit)', price: 'var(--copper)' };
  const delta = (k: string, v: number) => (k === 'before' || k === 'after' ? inrShort(v) : inrShort(v, { sign: true }));

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${height}`} role="img" aria-label={`Invoice bridge: ${inrShort(b.before)} last cycle, volume effect ${inrShort(b.volume, { sign: true })}, price effect ${inrShort(b.price, { sign: true })}, ${inrShort(b.after)} this cycle`} style={{ display: 'block', maxWidth: width ? undefined : 460 }}>
      <defs>
        <pattern id="bridge-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="var(--copper-tint)" />
          <line x1="0" y1="0" x2="0" y2="6" stroke="var(--copper)" strokeWidth="1.5" />
        </pattern>
      </defs>
      <line x1={left} x2={W - left} y1={y(0)} y2={y(0)} stroke="var(--border-strong)" />
      {bars.map((bar, i) => {
        const cx = left + slot * i + slot / 2;
        const y1 = y(Math.max(bar.from, bar.to));
        const y2 = y(Math.min(bar.from, bar.to));
        const h = Math.max(1.5, y2 - y1);
        const next = bars[i + 1];
        return (
          <g key={bar.key}>
            <rect x={cx - bw / 2} y={y1} width={bw} height={h} fill={bar.tone === 'price' ? 'url(#bridge-hatch)' : fill[bar.tone]} stroke={bar.tone === 'price' ? 'var(--copper)' : 'none'} />
            {next && <line x1={cx + bw / 2} x2={left + slot * (i + 1) + slot / 2 - bw / 2} y1={y(bar.to)} y2={y(bar.to)} stroke="var(--text-3)" strokeDasharray="2 2" />}
            <text x={cx} y={y1 - 6} textAnchor="middle" fontSize="11.5" fontWeight="600" className="mono" fill={bar.tone === 'save' ? 'var(--teal-strong)' : bar.tone === 'price' ? 'var(--copper)' : bar.tone === 'cost' ? 'var(--crit)' : 'var(--text)'}>
              {delta(bar.key, bar.key === 'volume' ? b.volume : bar.key === 'price' ? b.price : bar.to)}
            </text>
            <text x={cx} y={height - (compact ? 10 : 16)} textAnchor="middle" fontSize="11" fill="var(--text-2)">
              {bar.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
