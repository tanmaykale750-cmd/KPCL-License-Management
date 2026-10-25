import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DeptRow } from '../../calc/metrics';
import { inrShort } from '../../lib/format';

interface Row {
  id: string;
  name: string;
  used: number;
  idle: number;
  util: number;
  spend: number;
  utilLabel: string;
  muted?: boolean;
}

function TipBox({ active, payload }: { active?: boolean; payload?: { payload: Row }[] }) {
  if (!active || !payload?.length) return null;
  const r = payload[0].payload;
  return (
    <div className="chart-tooltip">
      <div className="t">{r.name}</div>
      <div className="r">
        Annual spend <b>{inrShort(r.spend * 1e5)}</b>
      </div>
      <div className="r">
        Actively used <b>{Math.round(r.util * 100)}%</b>
      </div>
      <div className="r">
        Used spend <b>{inrShort(r.used * 1e5)}</b>
      </div>
      <div className="r">
        Idle spend <b>{inrShort(r.idle * 1e5)}</b>
      </div>
      {!r.muted && <div className="small muted" style={{ marginTop: 4 }}>Click to filter the page</div>}
    </div>
  );
}

export function DeptSpendBars({ rows, onSelect, selected, height = 222 }: { rows: (DeptRow & { muted?: boolean })[]; onSelect?: (deptId: string) => void; selected?: string; height?: number }) {
  const data: Row[] = rows.map((r) => ({
    id: r.deptId,
    name: r.name,
    used: r.usedSpend / 1e5,
    idle: r.idleSpend / 1e5,
    spend: r.spend / 1e5,
    util: r.util,
    utilLabel: `${Math.round(r.util * 100)}%`,
    muted: r.muted,
  }));
  const max = Math.max(...data.map((d) => d.spend), 1);
  const step = max > 120 ? 50 : max > 60 ? 25 : max > 20 ? 10 : 5;
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step);
  const dim = (id: string) => (selected && selected !== 'all' && selected !== id ? 0.35 : 1);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap={9}>
        <CartesianGrid horizontal={false} stroke="var(--chart-grid)" />
        <XAxis type="number" domain={[0, top]} ticks={ticks} tickFormatter={(v) => `${v}`} tick={{ fontSize: 11, fill: 'var(--chart-axis)' }} axisLine={{ stroke: 'var(--border)' }} tickLine={false} />
        <YAxis type="category" dataKey="name" width={96} tick={{ fontSize: 12, fill: 'var(--text)' }} axisLine={false} tickLine={false} />
        <YAxis yAxisId="r" orientation="right" type="category" dataKey="utilLabel" width={40} tick={{ fontSize: 12, fill: 'var(--text)', fontWeight: 600 }} axisLine={false} tickLine={false} />
        <Tooltip content={<TipBox />} cursor={{ fill: 'rgba(14,107,104,0.06)' }} />
        <Bar dataKey="used" stackId="s" fill="var(--chart-used)" isAnimationActive={false} onClick={(d: { payload?: Row }) => d.payload && !d.payload.muted && onSelect?.(d.payload.id)} style={{ cursor: onSelect ? 'pointer' : undefined }}>
          {data.map((d) => (
            <Cell key={d.id} fillOpacity={dim(d.id)} fill={d.muted ? '#7d8a8c' : 'var(--chart-used)'} />
          ))}
        </Bar>
        <Bar dataKey="idle" stackId="s" fill="var(--chart-idle)" isAnimationActive={false} onClick={(d: { payload?: Row }) => d.payload && !d.payload.muted && onSelect?.(d.payload.id)} style={{ cursor: onSelect ? 'pointer' : undefined }}>
          {data.map((d) => (
            <Cell key={d.id} fillOpacity={dim(d.id)} fill={d.muted ? '#d3d9d8' : 'var(--chart-idle)'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
