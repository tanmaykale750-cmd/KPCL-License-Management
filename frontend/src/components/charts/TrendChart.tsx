import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { TrendPoint } from '../../calc/metrics';
import { monthLabel } from '../../lib/dates';

function Tip({ active, payload }: { active?: boolean; payload?: { payload: TrendPoint & { label: string } }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="chart-tooltip">
      <div className="t">{monthLabel(p.month, true)}</div>
      <div className="r">
        Utilisation <b>{Math.round(p.util * 100)}%</b>
      </div>
      <div className="r">
        Idle check-out share <b>{Math.round(p.idleCheckoutShare * 100)}%</b>
      </div>
      <div className="r">
        Blocked hours <b>{Math.round(p.blocked)} h</b>
      </div>
    </div>
  );
}

export function TrendChart({ data, height = 200 }: { data: TrendPoint[]; height?: number }) {
  const rows = data.map((d) => ({ ...d, label: monthLabel(d.month), utilPct: d.util * 100, idlePct: d.idleCheckoutShare * 100 }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={rows} margin={{ top: 6, right: 0, bottom: 0, left: -14 }}>
        <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--chart-axis)' }} axisLine={{ stroke: 'var(--border)' }} tickLine={false} interval={0} />
        <YAxis yAxisId="pct" domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11, fill: 'var(--chart-axis)' }} axisLine={false} tickLine={false} />
        <YAxis yAxisId="h" orientation="right" tick={{ fontSize: 11, fill: 'var(--chart-axis)' }} axisLine={false} tickLine={false} width={40} tickFormatter={(v) => `${v}h`} />
        <Tooltip content={<Tip />} />
        <Bar yAxisId="h" dataKey="blocked" fill="var(--copper-soft)" barSize={10} isAnimationActive={false} />
        <Line yAxisId="pct" dataKey="utilPct" stroke="var(--chart-used)" strokeWidth={2} dot={{ r: 2.5, fill: 'var(--chart-used)' }} isAnimationActive={false} />
        <Line yAxisId="pct" dataKey="idlePct" stroke="var(--teal-mid)" strokeDasharray="0" strokeWidth={1.25} dot={false} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
