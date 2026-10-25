import { useMemo } from 'react';
import { licenceRows, summarise, type Filters } from '../../calc/metrics';
import { hours, inr, inrShort, num, pct } from '../../lib/format';
import { useApp } from '../../state/store';
import { DataTable } from '../../components/ui/DataTable';
import { Drawer } from '../../components/ui/Overlay';

export type MetricKey = 'licences' | 'spend' | 'util' | 'idle' | 'blocked';

const TITLES: Record<MetricKey, { title: string; formula: string; meaning: string }> = {
  licences: { title: 'Total licences', formula: 'Σ seats (or seat-equivalents for token pools) across selected tools', meaning: 'Capacity KPCL owns today, split by licence type.' },
  spend: { title: 'Annual spend', formula: 'Σ seats × annual cost per seat (allocated seats when a department is selected)', meaning: 'Run-rate cost of the current portfolio.' },
  util: { title: 'Utilisation', formula: 'Active licence-hours ÷ (seats × 50 working hours a week) for the period', meaning: 'Share of paid capacity actually in use. Checked out but inactive does not count as use.' },
  idle: { title: 'Idle spend', formula: 'Annual spend × (1 − utilisation)', meaning: '₹ paid for capacity nobody used. Includes peak buffer, so it is not all removable.' },
  blocked: { title: 'Blocked engineer-hours', formula: 'Σ over denials of the wait until the same user got a licence', meaning: 'Engineering time lost because no licence was free.' },
};

export function MetricDrawer({ metric, filters, onClose }: { metric: MetricKey; filters: Filters; onClose: () => void }) {
  const { ds } = useApp();
  const s = useMemo(() => summarise(ds, filters), [ds, filters]);
  const rows = useMemo(() => licenceRows(ds, filters), [ds, filters]);
  const meta = TITLES[metric];
  const valueOf = (r: (typeof rows)[number]) =>
    metric === 'licences' ? r.seats : metric === 'spend' ? r.spend : metric === 'util' ? r.util : metric === 'idle' ? r.idleSpend : r.blocked;
  const fmt = (v: number) => (metric === 'licences' ? num(v) : metric === 'util' ? pct(v) : metric === 'blocked' ? hours(v) : inrShort(v));
  return (
    <Drawer eyebrow="Calculation trail" title={meta.title} onClose={onClose}>
      <dl className="dl">
        <dt>Formula</dt>
        <dd className="mono" style={{ fontSize: 12 }}>
          {meta.formula}
        </dd>
        <dt>Meaning</dt>
        <dd>{meta.meaning}</dd>
        <dt>Period</dt>
        <dd>Last {filters.months} months, working-hours basis (50 h per seat a week)</dd>
        <dt>Result</dt>
        <dd>
          <b className="num">
            {metric === 'licences' ? `${num(s.seats)} seats` : metric === 'spend' ? inr(s.annualSpend) : metric === 'util' ? pct(s.util, 1) : metric === 'idle' ? inr(s.idleSpend) : hours(s.blockedHours)}
          </b>
        </dd>
        {metric === 'licences' && (
          <>
            <dt>By type</dt>
            <dd>
              Floating {s.seatsByType.floating} · Named {s.seatsByType.named} · Node-locked {s.seatsByType['node-locked']} · Token {s.seatsByType.token}
            </dd>
          </>
        )}
        {metric === 'idle' && (
          <>
            <dt>Split</dt>
            <dd>
              Idle check-outs {inrShort(s.split.idleCheckout)} · Unused capacity {inrShort(s.split.unused)}
            </dd>
          </>
        )}
      </dl>
      <div className="block">
        <h3>Contribution by tool</h3>
        <DataTable
          compact
          rows={rows}
          rowKey={(r) => r.licence.id}
          initialSort={{ key: 'v', dir: metric === 'util' ? 'asc' : 'desc' }}
          columns={[
            { key: 'p', header: 'Software', render: (r) => r.licence.product, sort: (r) => r.licence.product },
            { key: 's', header: 'Seats', num: true, render: (r) => num(r.seats), sort: (r) => r.seats },
            { key: 'v', header: meta.title, num: true, render: (r) => fmt(valueOf(r)), sort: valueOf },
          ]}
        />
      </div>
    </Drawer>
  );
}
