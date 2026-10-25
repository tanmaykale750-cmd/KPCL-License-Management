import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { inrShort } from '../../lib/format';

export interface DonutSlice {
  key: string;
  label: string;
  value: number;
  color: string;
  note: string;
}

function Tip({ active, payload, total }: { active?: boolean; payload?: { payload: DonutSlice }[]; total: number }) {
  if (!active || !payload?.length) return null;
  const s = payload[0].payload;
  return (
    <div className="chart-tooltip">
      <div className="t">{s.label}</div>
      <div className="r">
        Annual value <b>{inrShort(s.value)}</b>
      </div>
      <div className="r">
        Share of spend <b>{Math.round((s.value / total) * 100)}%</b>
      </div>
      <div className="small muted" style={{ marginTop: 4, maxWidth: 220 }}>
        {s.note}
      </div>
    </div>
  );
}

export function SpendDonut({ slices, centreLabel, centreValue, size = 168 }: { slices: DonutSlice[]; centreLabel: string; centreValue: string; size?: number }) {
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <div style={{ position: 'relative', height: size }}>
      <ResponsiveContainer width="100%" height={size}>
        <PieChart>
          <Pie data={slices} dataKey="value" nameKey="label" innerRadius="66%" outerRadius="96%" startAngle={90} endAngle={-270} paddingAngle={1} stroke="var(--panel)" strokeWidth={1.5} isAnimationActive={false}>
            {slices.map((s) => (
              <Cell key={s.key} fill={s.color} />
            ))}
          </Pie>
          <Tooltip content={<Tip total={total} />} />
        </PieChart>
      </ResponsiveContainer>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
        <span style={{ fontSize: 11.5, color: 'var(--text-2)', fontWeight: 600 }}>{centreLabel}</span>
        <span className="num" style={{ fontSize: 19, fontWeight: 600, marginTop: 1 }}>
          {centreValue}
        </span>
      </div>
    </div>
  );
}
