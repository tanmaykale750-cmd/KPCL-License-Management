import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ServiceDeptRow, ServiceTrendPoint } from '../../calc/services';
import { monthLabel } from '../../lib/dates';
import { inrShort } from '../../lib/format';

/** Colours for the three parts of service spend. */
export const SERVICE_COLORS = { used: 'var(--chart-used)', idle: 'var(--chart-idle)', metered: 'var(--copper-soft)' };
export const CATEGORY_COLORS = { api: '#5f8f8c', ai: '#0e6b68', cloud: '#2a3236' };

interface BarRow {
  id: string;
  name: string;
  used: number;
  idle: number;
  metered: number;
  spend: number;
  util: number;
  utilLabel: string;
  muted?: boolean;
}

function DeptTip({ active, payload }: { active?: boolean; payload?: { payload: BarRow }[] }) {
  if (!active || !payload?.length) return null;
  const r = payload[0].payload;
  return (
    <div className="chart-tooltip">
      <div className="t">{r.name}</div>
      <div className="r">
        Annual spend <b>{inrShort(r.spend * 1e5)}</b>
      </div>
      <div className="r">
        Paid capacity in use <b>{inrShort(r.used * 1e5)}</b>
      </div>
      <div className="r">
        Idle capacity <b>{inrShort(r.idle * 1e5)}</b>
      </div>
      <div className="r">
        Pay-as-you-go &amp; overage <b>{inrShort(r.metered * 1e5)}</b>
      </div>
      <div className="r">
        Utilisation of paid capacity <b>{r.utilLabel}</b>
      </div>
      {!r.muted && <div className="small muted" style={{ marginTop: 4 }}>Click to filter the page</div>}
    </div>
  );
}

export function ServiceDeptBars({ rows, onSelect, selected, height = 210 }: { rows: (ServiceDeptRow & { muted?: boolean })[]; onSelect?: (id: string) => void; selected?: string; height?: number }) {
  const data: BarRow[] = rows.map((r) => ({
    id: r.deptId,
    name: r.name,
    used: r.usedCapacity / 1e5,
    idle: r.idle / 1e5,
    metered: r.metered / 1e5,
    spend: r.spend / 1e5,
    util: r.util,
    utilLabel: r.usedCapacity + r.idle > 0 ? `${Math.round(r.util * 100)}%` : '—',
    muted: r.muted,
  }));
  const max = Math.max(...data.map((d) => d.spend), 1);
  const step = max > 120 ? 25 : max > 60 ? 20 : max > 20 ? 10 : 5;
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step);
  const dim = (id: string) => (selected && selected !== 'all' && selected !== id ? 0.35 : 1);
  const click = (d: { payload?: BarRow }) => d.payload && !d.payload.muted && onSelect?.(d.payload.id);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap={8}>
        <CartesianGrid horizontal={false} stroke="var(--chart-grid)" />
        <XAxis type="number" domain={[0, top]} ticks={ticks} tick={{ fontSize: 11, fill: 'var(--chart-axis)' }} axisLine={{ stroke: 'var(--border)' }} tickLine={false} />
        <YAxis type="category" dataKey="name" width={96} tick={{ fontSize: 12, fill: 'var(--text)' }} axisLine={false} tickLine={false} />
        <YAxis yAxisId="r" orientation="right" type="category" dataKey="utilLabel" width={40} tick={{ fontSize: 12, fill: 'var(--text)', fontWeight: 600 }} axisLine={false} tickLine={false} />
        <Tooltip content={<DeptTip />} cursor={{ fill: 'rgba(14,107,104,0.06)' }} />
        {(['used', 'idle', 'metered'] as const).map((k) => (
          <Bar key={k} dataKey={k} stackId="s" fill={SERVICE_COLORS[k]} isAnimationActive={false} onClick={click} style={{ cursor: onSelect ? 'pointer' : undefined }}>
            {data.map((d) => (
              <Cell key={d.id} fillOpacity={dim(d.id)} fill={d.muted ? (k === 'used' ? '#7d8a8c' : k === 'idle' ? '#d3d9d8' : '#e6ddd4') : SERVICE_COLORS[k]} />
            ))}
          </Bar>
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

function TrendTip({ active, payload }: { active?: boolean; payload?: { payload: ServiceTrendPoint }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="chart-tooltip">
      <div className="t">{monthLabel(p.month, true)}</div>
      <div className="r">
        API services <b>{inrShort(p.api)}</b>
      </div>
      <div className="r">
        AI tokens <b>{inrShort(p.ai)}</b>
      </div>
      <div className="r">
        Cloud <b>{inrShort(p.cloud)}</b>
      </div>
      <div className="r">
        Idle capacity <b>{inrShort(p.idle)}</b>
      </div>
      <div className="r">
        Utilisation of paid capacity <b>{Math.round(p.util * 100)}%</b>
      </div>
      <div className="r">
        Engineer-hours blocked <b>{Math.round(p.blockedHours)} h</b>
      </div>
    </div>
  );
}

/** 12-month history: spend by category (stacked bars, ₹ lakh) and utilisation of paid capacity (line). */
export function ServiceTrendChart({ data, height = 220 }: { data: ServiceTrendPoint[]; height?: number }) {
  const rows = data.map((d) => ({ ...d, label: monthLabel(d.month), apiL: d.api / 1e5, aiL: d.ai / 1e5, cloudL: d.cloud / 1e5, utilPct: d.util * 100 }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={rows} margin={{ top: 6, right: 0, bottom: 0, left: -10 }}>
        <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--chart-axis)' }} axisLine={{ stroke: 'var(--border)' }} tickLine={false} interval={0} />
        <YAxis yAxisId="inr" tick={{ fontSize: 11, fill: 'var(--chart-axis)' }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}L`} />
        <YAxis yAxisId="pct" orientation="right" domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11, fill: 'var(--chart-axis)' }} axisLine={false} tickLine={false} width={40} />
        <Tooltip content={<TrendTip />} />
        <Bar yAxisId="inr" dataKey="cloudL" stackId="c" fill={CATEGORY_COLORS.cloud} barSize={16} isAnimationActive={false} />
        <Bar yAxisId="inr" dataKey="aiL" stackId="c" fill={CATEGORY_COLORS.ai} barSize={16} isAnimationActive={false} />
        <Bar yAxisId="inr" dataKey="apiL" stackId="c" fill={CATEGORY_COLORS.api} barSize={16} isAnimationActive={false} />
        <Line yAxisId="pct" dataKey="utilPct" stroke="var(--copper)" strokeWidth={2} dot={{ r: 2.5, fill: 'var(--copper)' }} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/** Per-service monthly history used in the drawer: spend split into used and idle (₹ thousand). */
export function ServiceHistoryBars({ months, height = 150 }: { months: { month: string; spend: number; idle: number }[]; height?: number }) {
  const rows = months.map((m) => ({ label: monthLabel(m.month), used: (m.spend - m.idle) / 1e3, idle: m.idle / 1e3, month: m.month, spend: m.spend }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 6, right: 0, bottom: 0, left: -12 }}>
        <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
        <XAxis dataKey="label" tick={{ fontSize: 10.5, fill: 'var(--chart-axis)' }} axisLine={{ stroke: 'var(--border)' }} tickLine={false} interval={0} />
        <YAxis tick={{ fontSize: 10.5, fill: 'var(--chart-axis)' }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}k`} />
        <Tooltip
          formatter={(v: number, n: string) => [inrShort(v * 1e3), n === 'used' ? 'Used / metered' : 'Idle capacity']}
          labelFormatter={(l: string) => l}
          contentStyle={{ fontSize: 12, borderRadius: 4, border: '1px solid var(--border)' }}
        />
        <Bar dataKey="used" stackId="s" fill={SERVICE_COLORS.used} isAnimationActive={false} />
        <Bar dataKey="idle" stackId="s" fill={SERVICE_COLORS.idle} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}
